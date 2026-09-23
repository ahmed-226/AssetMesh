import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { PurgeService } from "../../src/application/purge-service.js"
import { CacheKey } from "../../src/domain/cache-key.js"
import { BadRequestError, NotFoundError } from "../../src/domain/errors.js"
import type { ReadableSource } from "../../src/domain/objects.js"
import { TransformOptions } from "../../src/domain/transform-options.js"
import { DiskCacheStore } from "../../src/infrastructure/cache/disk-cache-store.js"
import { LruIndex } from "../../src/infrastructure/cache/lru-index.js"
import { CasObjectStore } from "../../src/infrastructure/storage/cas-object-store.js"

const ALLOWED = ["jpg", "png", "webp", "avif"]

const truncatableSource = (chunks: Buffer[]): ReadableSource =>
  Object.assign(Readable.from(chunks), { truncated: false }) as ReadableSource

// Real PNG magic so open() re-sniffs image/png from the bytes themselves.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(2048),
])

const VARIANT_BYTES = randomBytes(1024)

describe("PurgeService", () => {
  let root: string
  let tmpDir: string
  let objects: CasObjectStore
  let cache: DiskCacheStore
  let index: LruIndex
  let purges: PurgeService
  let id: string

  // Seeds one cached variant for the given options: fake worker writes the tmp
  // file, DiskCacheStore.store renames it into the cache tree, index.touch
  // records it — exactly the transform miss path, minus the worker pool.
  const seedVariant = async (options: TransformOptions, fmt: string): Promise<CacheKey> => {
    const key = CacheKey.create(id, options, fmt)
    const tmpPath = join(tmpDir, randomUUID())
    await writeFile(tmpPath, VARIANT_BYTES)
    await cache.store(key, tmpPath)
    index.touch(key.basename, VARIANT_BYTES.length)
    return key
  }

  const parse = (query: Record<string, string | undefined>): TransformOptions =>
    TransformOptions.parse(query, ALLOWED)

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "assetmesh-purge-"))
    tmpDir = join(root, "tmp")
    await mkdir(tmpDir, { recursive: true })
    objects = new CasObjectStore(join(root, "originals"), tmpDir)
    cache = new DiskCacheStore(join(root, "cache"))
    index = new LruIndex(join(root, "cache", "index.json"))
    purges = new PurgeService(objects, cache, index)

    const stored = await objects.store(truncatableSource([PNG_BYTES]), 0)
    id = stored.id
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("removes the original and every cached variant from disk and from the LRU index", async () => {
    const w100 = await seedVariant(parse({ w: "100" }), "webp")
    const w200 = await seedVariant(parse({ w: "200", fmt: "png" }), "png")
    expect(index.count).toBe(2)
    expect(index.totalSize).toBe(2 * VARIANT_BYTES.length)

    const result = await purges.purge(id)

    expect(result).toEqual({ removedOriginal: true, removedVariants: 2 })

    // Original blob gone: open() can no longer resolve the id.
    await expect(objects.open(id)).rejects.toBeInstanceOf(NotFoundError)
    // Variants gone from the cache tree — the id's shard is now empty.
    expect(await readdir(join(root, "cache", id.slice(0, 2), id.slice(2, 4)))).toEqual([])
    expect(await cache.exists(w100)).toBe(false)
    expect(await cache.exists(w200)).toBe(false)
    // LRU bookkeeping back to empty.
    expect(index.count).toBe(0)
    expect(index.totalSize).toBe(0)
  })

  it("is idempotent: purging the same id again removes nothing and does not throw", async () => {
    await seedVariant(parse({ w: "100" }), "webp")

    await purges.purge(id)
    const again = await purges.purge(id)

    expect(again).toEqual({ removedOriginal: false, removedVariants: 0 })
  })

  it("treats a well-formed but unknown id as a no-op (no original, no variants)", async () => {
    const unknownId = "0".repeat(64)

    const result = await purges.purge(unknownId)

    expect(result).toEqual({ removedOriginal: false, removedVariants: 0 })
  })

  it("rejects a malformed id with BadRequestError before touching the filesystem", async () => {
    await expect(purges.purge("not-a-hash")).rejects.toBeInstanceOf(BadRequestError)
    await expect(purges.purge("not-a-hash")).rejects.toMatchObject({ statusCode: 400 })
  })

  it("lists no variants for an id that never had any generated", async () => {
    expect(await cache.listByPrefix(id)).toEqual([])
  })
})