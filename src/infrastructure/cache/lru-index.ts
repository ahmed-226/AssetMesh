import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export interface IndexEntry {
  size: number
  lastAccessedAt: number
}

export interface WalkEntry {
  basename: string
  size: number
  mtimeMs: number
}

const isIndexEntry = (value: unknown): value is IndexEntry => {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.size === "number" && typeof entry.lastAccessedAt === "number"
}

// Persisted LRU bookkeeping for the variant cache: cache/ab/cd/<key> →
// { size, lastAccessedAt }. During requests the map is only touched in memory —
// index.json is written on the GC tick and on shutdown so request throughput
// never pays for bookkeeping I/O. It's authoritative bookkeeping only: if the
// file is deleted or corrupt, the caller rebuilds from stat (walk) and the
// cache keeps serving.
export class LruIndex {
  private readonly entries = new Map<string, IndexEntry>()

  constructor(private readonly indexPath: string) {}

  get totalSize(): number {
    let sum = 0
    for (const entry of this.entries.values()) sum += entry.size
    return sum
  }

  get count(): number {
    return this.entries.size
  }

  lastAccessedAt(key: string): number | undefined {
    return this.entries.get(key)?.lastAccessedAt
  }

  // Records (or refreshes) a variant as most-recently-accessed.
  touch(key: string, size: number): void {
    this.entries.set(key, { size, lastAccessedAt: Date.now() })
  }

  remove(key: string): void {
    this.entries.delete(key)
  }

  // Returns and removes the least-recently-accessed entry, or undefined when
  // the index is empty. Straight linear scan over a bounded cache — fine here.
  evictOldest(): (IndexEntry & { key: string }) | undefined {
    const oldest = this.peekOldest()
    if (oldest === undefined) return undefined
    this.entries.delete(oldest.key)
    return oldest
  }

  // Least-recently-accessed entry WITHOUT removing it — used by the GC so an
  // entry is only dropped from the index once its file is actually unlinked.
  peekOldest(): (IndexEntry & { key: string }) | undefined {
    let oldestKey: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.entries) {
      if (entry.lastAccessedAt < oldestAt) {
        oldestAt = entry.lastAccessedAt
        oldestKey = key
      }
    }
    if (oldestKey === undefined) return undefined
    const entry = this.entries.get(oldestKey)
    if (entry === undefined) return undefined
    return { key: oldestKey, ...entry }
  }

  // Atomic write: temp file on the same filesystem, then rename into place, so
  // a crash never leaves a partially-written index that looks valid.
  async save(): Promise<void> {
    const payload = {
      version: 1,
      entries: Object.fromEntries(this.entries.entries()),
    }
    const tmpPath = join(dirname(this.indexPath), `.index-${randomUUID()}.tmp`)
    try {
      await mkdir(dirname(this.indexPath), { recursive: true })
      await writeFile(tmpPath, JSON.stringify(payload), "utf8") // allow-buffer: small index.json
      await rename(tmpPath, this.indexPath)
    } catch (err) {
      await rm(tmpPath, { force: true })
      throw err
    }
  }

  // Loads a persisted index. Throws when missing or malformed (caller rebuilds).
  async load(): Promise<void> {
    const raw = await readFile(this.indexPath, "utf8") // allow-buffer: small index.json
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) throw new Error("index.json is not an object")
    const entries = (parsed as { entries?: unknown }).entries
    if (typeof entries !== "object" || entries === null) throw new Error("index.json has no entries")
    const next = new Map<string, IndexEntry>()
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      if (!isIndexEntry(value)) throw new Error(`index.json entry '${key}' is malformed`)
      next.set(key, value)
    }
    this.entries.clear()
    for (const [key, value] of next) this.entries.set(key, value)
  }

  // Rebuilds the index from a disk walk (used when index.json is missing or
  // corrupt). Access times come from file mtimes so LRU order survives restarts.
  rebuild(walk: readonly WalkEntry[]): void {
    this.entries.clear()
    for (const file of walk) {
      this.entries.set(file.basename, { size: file.size, lastAccessedAt: file.mtimeMs })
    }
  }

  // Adds walk entries that the index doesn't know about yet — closes the drift
  // left when the process dies between a variant store() and the next index
  // save (a stale-but-valid index.json would otherwise let untracked files grow
  // past CACHE_LIMIT_GB forever). Existing entries keep their access time.
  mergeMissing(walk: readonly WalkEntry[]): void {
    for (const file of walk) {
      if (!this.entries.has(file.basename)) {
        this.entries.set(file.basename, { size: file.size, lastAccessedAt: file.mtimeMs })
      }
    }
  }
}