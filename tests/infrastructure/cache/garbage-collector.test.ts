import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CacheKey } from "../../../src/domain/cache-key.js"
import { TransformOptions } from "../../../src/domain/transform-options.js"
import { DiskCacheStore } from "../../../src/infrastructure/cache/disk-cache-store.js"
import { GarbageCollector } from "../../../src/infrastructure/cache/garbage-collector.js"
import { LruIndex } from "../../../src/infrastructure/cache/lru-index.js"

const ALLOWED = ["jpg", "png", "webp", "avif"]
const ID = "ab".repeat(32)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Writes a real variant file into the sharded cache via DiskCacheStore.store
// (tmp file on the same filesystem, then rename) and returns its CacheKey.
const storeVariant = async (
  cache: DiskCacheStore,
  tmpDir: string,
  query: Record<string, string>,
  bytes: Buffer,
): Promise<CacheKey> => {
  const key = CacheKey.create(ID, TransformOptions.parse(query, ALLOWED), "webp")
  const tmpPath = join(tmpDir, randomUUID())
  await writeFile(tmpPath, bytes)
  await cache.store(key, tmpPath)
  return key
}

describe("GarbageCollector", () => {
  let root: string
  let tmpDir: string
  let cacheDir: string
  let cache: DiskCacheStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "assetmesh-gc-"))
    tmpDir = join(root, "tmp")
    cacheDir = join(root, "cache")
    cache = new DiskCacheStore(cacheDir)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("evicts the oldest variants until under the limit and deletes their files", async () => {
    const index = new LruIndex(join(cacheDir, "index.json"))
    const keyA = await storeVariant(cache, tmpDir, { w: "300", fmt: "webp" }, randomBytes(1000))
    await sleep(5)
    const keyB = await storeVariant(cache, tmpDir, { w: "400", fmt: "webp" }, randomBytes(2000))

    // LRU order on the index: A oldest, B newest. Cached sizes mirror the files.
    index.touch(keyA.basename, 1000)
    await sleep(5)
    index.touch(keyB.basename, 2000)

    const gc = new GarbageCollector({ cache, index, limitBytes: 2500, intervalMs: 60_000 })
    await gc.tick()

    // target = floor(2500 * 0.9) = 2250 → A (1000) evicted, B (2000) kept.
    expect(index.count).toBe(1)
    expect(index.totalSize).toBe(2000)
    expect(index.totalSize).toBeLessThanOrEqual(2500)
    expect(index.lastAccessedAt(keyA.basename)).toBeUndefined()
    expect(index.lastAccessedAt(keyB.basename)).toBeGreaterThan(0)
    expect(await cache.exists(keyA)).toBe(false)
    expect(await cache.exists(keyB)).toBe(true)
  })

  it("evicts repeatedly until the index fits under the target", async () => {
    const index = new LruIndex(join(cacheDir, "index.json"))
    const keys: CacheKey[] = []
    const sizes = [1000, 1000, 1000]
    for (const size of sizes) {
      const key = await storeVariant(cache, tmpDir, { w: String(100 + keys.length), fmt: "webp" }, randomBytes(size))
      await sleep(5)
      index.touch(key.basename, size)
      keys.push(key)
    }

    // totalSize 3000, target floor(1500*0.9)=1350 → evicts two of three.
    const gc = new GarbageCollector({ cache, index, limitBytes: 1500, intervalMs: 60_000 })
    await gc.tick()

    expect(index.count).toBe(1)
    expect(index.totalSize).toBe(1000)
    const remaining = keys.find((k) => index.lastAccessedAt(k.basename) !== undefined)
    expect(remaining?.basename).toBe(keys[2]?.basename) // the newest survives
    for (const k of keys.slice(0, 2)) {
      expect(await cache.exists(k)).toBe(false)
    }
  })

  it("limitBytes=0 leaves every file in place (eviction disabled)", async () => {
    const index = new LruIndex(join(cacheDir, "index.json"))
    const key = await storeVariant(cache, tmpDir, { w: "300", fmt: "webp" }, randomBytes(500))
    index.touch(key.basename, 500)

    const gc = new GarbageCollector({ cache, index, limitBytes: 0, intervalMs: 60_000 })
    await gc.tick()

    expect(index.count).toBe(1)
    expect(index.totalSize).toBe(500)
    expect(await cache.exists(key)).toBe(true)
  })

  it("skips an overlapping tick: a second tick while one is running evicts nothing", async () => {
    const index = new LruIndex(join(cacheDir, "index.json"))
    index.touch("a", 10) // totalSize 10 > target floor(5*0.9)=4 → one eviction

    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const remove = vi.fn(async () => {
      markStarted()
      await gate
    })

    const gc = new GarbageCollector({
      cache: { remove } as unknown as DiskCacheStore,
      index,
      limitBytes: 5,
      intervalMs: 60_000,
    })

    const first = gc.tick()
    await started // first tick is now blocked inside cache.remove
    const second = gc.tick() // sees running=true → returns without evicting
    release()
    await first
    await second

    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith("a")
    expect(index.count).toBe(0)
  })

  it("persists index.json on tick even when there is nothing to evict", async () => {
    const index = new LruIndex(join(cacheDir, "index.json"))
    const key = await storeVariant(cache, tmpDir, { w: "300", fmt: "webp" }, randomBytes(100))
    index.touch(key.basename, 100)

    const gc = new GarbageCollector({ cache, index, limitBytes: 10_000, intervalMs: 60_000 })
    await gc.tick()

    const raw = await readFile(join(cacheDir, "index.json"), "utf8")
    const persisted = JSON.parse(raw) as unknown as {
      version: number
      entries: Record<string, { size: number; lastAccessedAt: number }>
    }
    expect(persisted.version).toBe(1)
    expect(persisted.entries[key.basename]?.size).toBe(100)
    expect(persisted.entries[key.basename]?.lastAccessedAt).toBe(index.lastAccessedAt(key.basename))
  })

  it("leaves no *.tmp artifacts behind after a tick", async () => {
    const index = new LruIndex(join(cacheDir, "index.json"))
    const key = await storeVariant(cache, tmpDir, { w: "300", fmt: "webp" }, randomBytes(100))
    index.touch(key.basename, 100)

    const gc = new GarbageCollector({ cache, index, limitBytes: 10_000, intervalMs: 60_000 })
    await gc.tick()

    const leftover = (await readdir(cacheDir)).filter((name) => name.endsWith(".tmp"))
    expect(leftover).toEqual([])
    expect(await readdir(tmpDir)).toEqual([]) // store() consumed each tmp via rename
  })
})