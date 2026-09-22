import { createReadStream } from "node:fs"
import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Readable } from "node:stream"
import type { CacheKey } from "../../domain/cache-key.js"
import type { WalkEntry } from "./lru-index.js"

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const isEnoent = (err: unknown): boolean =>
  err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"

// Disk tier of the variant cache (data/cache/ab/cd/<key>). It mirrors the CAS
// sharding so the M4 GC can bound its scan to 2/2-sharded directories. There's
// no LRU bookkeeping yet — that's M4; here "cache" is existence + streaming.
// Cache is disposable: definitions live in originals/, so a deleted or corrupt
// variant is regenerated on the next request.
export class DiskCacheStore {
  constructor(private readonly cacheDir: string) {}

  pathFor(key: CacheKey): string {
    return join(this.cacheDir, key.dir, key.basename)
  }

  // The id (64 hex chars) is a prefix of every basename, so a basename alone
  // resolves to its shard — index eviction needs no other context. Keys are
  // validated here (single choke point) so a corrupt index key can never
  // escape the cache tree via join().
  pathForBasename(basename: string): string {
    if (!/^[a-f0-9]{64}(?:_[whq]\d+)*\.[a-z0-9]{2,5}$/.test(basename)) {
      throw new Error(`refusing to address invalid cache key '${basename}'`)
    }
    return join(this.cacheDir, basename.slice(0, 2), basename.slice(2, 4), basename)
  }

  async exists(key: CacheKey): Promise<boolean> {
    return exists(this.pathFor(key))
  }

  // Streams a variant that exists() confirmed. The stream is opened lazily, so
  // a concurrent GC deleting the file (M4) is fine on Linux — reads continue on
  // the open fd.
  async open(key: CacheKey): Promise<{ stream: Readable; size: number }> {
    const path = this.pathFor(key)
    const { size } = await stat(path)
    return { stream: createReadStream(path), size }
  }

  // Atomic publish: the worker already wrote <tmp>/<uuid> on the same
  // filesystem; rename into place so a partial variant never appears at the
  // final path.
  async store(key: CacheKey, tmpPath: string): Promise<void> {
    const finalPath = this.pathFor(key)
    await mkdir(dirname(finalPath), { recursive: true })
    await rename(tmpPath, finalPath)
  }

  // Eviction: unlink a variant by name. `force` makes absence a no-op, so
  // index and disk can drift without failing the GC tick.
  async remove(basename: string): Promise<void> {
    await rm(this.pathForBasename(basename), { force: true })
  }

  // Lists every cached variant with size + mtime — used to rebuild the LRU
  // index when index.json is missing or corrupt. Only walks the two shard
  // levels (index.json sits at the cache root and is never scanned).
  async walk(): Promise<WalkEntry[]> {
    let shards
    try {
      shards = await readdir(this.cacheDir, { withFileTypes: true })
    } catch (err) {
      // First boot / deleted cache dir: nothing to rebuild from. EACCES and
      // friends surface as real errors instead of being swallowed.
      if (isEnoent(err)) return []
      throw err
    }
    const files: WalkEntry[] = []
    for (const shard of shards) {
      if (!shard.isDirectory() || shard.name.length !== 2) continue
      const subdir = await readdir(join(this.cacheDir, shard.name), { withFileTypes: true })
      for (const dir of subdir) {
        if (!dir.isDirectory() || dir.name.length !== 2) continue
        const dirPath = join(this.cacheDir, shard.name, dir.name)
        for (const file of await readdir(dirPath, { withFileTypes: true })) {
          if (!file.isFile()) continue
          const { size, mtimeMs } = await stat(join(dirPath, file.name))
          files.push({ basename: file.name, size, mtimeMs })
        }
      }
    }
    return files
  }
}