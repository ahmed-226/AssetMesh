import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TransformService } from "../../src/application/transform-service.js"
import { CacheKey } from "../../src/domain/cache-key.js"
import { BadRequestError, ServiceUnavailableError } from "../../src/domain/errors.js"
import type { StoredFile } from "../../src/domain/objects.js"
import { TransformOptions } from "../../src/domain/transform-options.js"
import { DiskCacheStore } from "../../src/infrastructure/cache/disk-cache-store.js"
import { LruIndex } from "../../src/infrastructure/cache/lru-index.js"
import type {
  TransformOutcome,
  TransformRequest,
} from "../../src/infrastructure/image/sharp-worker.js"
import type { WorkerPoolProcessor } from "../../src/infrastructure/image/worker-pool-processor.js"

const ALLOWED = ["jpg", "png", "webp", "avif"]
const ID = "ab".repeat(32)

const FILE: StoredFile = {
  path: join("originals", ID.slice(0, 2), ID.slice(2, 4), `${ID}.png`),
  size: 4096,
  extension: "png",
  mimeType: "image/png",
}

// Whatever the fake worker "writes" to tmpPath; must match outcome.size.
const VARIANT_BYTES = randomBytes(2412)

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const OK_OUTCOME: TransformOutcome = {
  ok: true,
  width: 300,
  height: 200,
  size: VARIANT_BYTES.length,
}

// Simulates the sharp worker: writes the variant to the requested tmpPath and
// reports back. The finished tmp file is what DiskCacheStore.store renames.
const writingWorker = async (req: TransformRequest): Promise<TransformOutcome> => {
  await writeFile(req.tmpPath, VARIANT_BYTES)
  return OK_OUTCOME
}

// Same shape as WorkerPoolProcessor but observable via the vitest spy; the
// service only ever awaits pool.transform(request).
interface FakePool {
  transform: ReturnType<typeof vi.fn>
}

const makePool = (impl: (req: TransformRequest) => Promise<TransformOutcome>): FakePool => ({
  transform: vi.fn(impl),
})

const asPool = (pool: FakePool): WorkerPoolProcessor => pool as unknown as WorkerPoolProcessor

describe("TransformService", () => {
  let root: string
  let tmpDir: string
  let cache: DiskCacheStore
  let index: LruIndex
  let pool: FakePool
  let service: TransformService

  const parse = (query: Record<string, string | undefined>): TransformOptions =>
    TransformOptions.parse(query, ALLOWED)

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "assetmesh-transform-"))
    tmpDir = join(root, "tmp")
    await mkdir(tmpDir, { recursive: true })
    cache = new DiskCacheStore(join(root, "cache"))
    // Never persisted/loaded in this suite — touch/save-only bookkeeping.
    index = new LruIndex(join(root, "cache", "index.json"))
    pool = makePool(writingWorker)
    service = new TransformService(cache, index, asPool(pool), tmpDir)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("miss: generates via the pool with default quality + fmt, publishes the cache file and streams it", async () => {
    const options = parse({ w: "300", fmt: "webp" })

    const result = await service.resolve(ID, FILE, options)

    expect(pool.transform).toHaveBeenCalledTimes(1)
    const req = pool.transform.mock.calls[0]?.[0] as TransformRequest
    expect(req.originalPath).toBe(FILE.path)
    expect(req.width).toBe(300)
    expect(req.quality).toBe(80) // default, since the query carried no q
    expect(req.fmt).toBe("webp")
    expect(req.tmpPath.startsWith(tmpDir)).toBe(true)

    const key = CacheKey.create(ID, options, "webp")
    expect(key.dir).toBe("ab/ab")
    expect(await cache.exists(key)).toBe(true) // cache/ab/ab/<id>_w300_q80.webp

    expect(result.headers["Content-Type"]).toBe("image/webp")
    expect(result.headers["Content-Length"]).toBe(String(VARIANT_BYTES.length))
    expect(await readAll(result.stream)).toEqual(VARIANT_BYTES)

    // a miss touches the LRU index once with the stored variant's size
    expect(index.count).toBe(1)
    expect(index.totalSize).toBe(VARIANT_BYTES.length)
    expect(index.lastAccessedAt(key.basename)).toBeGreaterThan(0)
  })

  it("hit: a second resolve with identical options is served from cache — pool not invoked again", async () => {
    const options = parse({ w: "300", fmt: "webp" })
    const key = CacheKey.create(ID, options, "webp")

    await readAll((await service.resolve(ID, FILE, options)).stream)
    const touchedAfterMiss = index.lastAccessedAt(key.basename)
    expect(index.count).toBe(1)

    const again = await service.resolve(ID, FILE, options)

    expect(pool.transform).toHaveBeenCalledTimes(1)
    expect(await readAll(again.stream)).toEqual(VARIANT_BYTES)
    expect(again.headers["Content-Length"]).toBe(String(VARIANT_BYTES.length))

    // a hit re-touches the existing entry instead of adding a duplicate
    expect(index.count).toBe(1)
    expect(index.totalSize).toBe(VARIANT_BYTES.length)
    expect(index.lastAccessedAt(key.basename)).toBeGreaterThanOrEqual(touchedAfterMiss ?? 0)
  })

  it("coalesces concurrent identical misses onto one generation job", async () => {
    pool = makePool(async (req) => {
      // Keep the first job in flight long enough that both resolves observe the
      // same in-flight promise instead of a completed cache hit.
      await new Promise((resolve) => setTimeout(resolve, 25))
      await writeFile(req.tmpPath, VARIANT_BYTES)
      return OK_OUTCOME
    })
    service = new TransformService(cache, index, asPool(pool), tmpDir)
    const options = parse({ w: "300", fmt: "webp" })

    const [first, second] = await Promise.all([
      service.resolve(ID, FILE, options),
      service.resolve(ID, FILE, options),
    ])

    expect(pool.transform).toHaveBeenCalledTimes(1)
    expect(await readAll(first.stream)).toEqual(VARIANT_BYTES)
    expect(await readAll(second.stream)).toEqual(VARIANT_BYTES)
  })

  it("maps a NOT_IMAGE worker outcome to BadRequestError 400 and leaves no tmp artifacts", async () => {
    pool = makePool(async () => ({ ok: false, code: "NOT_IMAGE", message: "not an image" }))
    service = new TransformService(cache, index, asPool(pool), tmpDir)

    await expect(service.resolve(ID, FILE, parse({ w: "300", fmt: "webp" }))).rejects.toBeInstanceOf(
      BadRequestError,
    )
    await expect(service.resolve(ID, FILE, parse({ w: "300", fmt: "webp" }))).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(await readdir(tmpDir)).toEqual([])
  })

  it("lets a saturated-pool ServiceUnavailableError through as 503 and cleans tmp", async () => {
    pool = makePool(async () => {
      throw new ServiceUnavailableError("image worker queue is full")
    })
    service = new TransformService(cache, index, asPool(pool), tmpDir)

    await expect(service.resolve(ID, FILE, parse({ w: "300" }))).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    )
    await expect(service.resolve(ID, FILE, parse({ w: "300" }))).rejects.toMatchObject({
      statusCode: 503,
    })
    expect(await readdir(tmpDir)).toEqual([])
  })

  it("falls back to the original file.extension for fmt (non-image original)", async () => {
    const binFile: StoredFile = { ...FILE, extension: "bin" }
    const options = parse({ w: "300" })

    const result = await service.resolve(ID, binFile, options)

    const req = pool.transform.mock.calls[0]?.[0] as TransformRequest
    expect(req.fmt).toBe("bin") // options.fmt ?? file.extension
    const key = CacheKey.create(ID, options, "bin")
    expect(key.basename.endsWith(".bin")).toBe(true)
    expect(await cache.exists(key)).toBe(true)
    expect(result.headers["Content-Type"]).toBe("application/octet-stream")
    await readAll(result.stream)
  })

  it("sets Content-Type from an explicit fmt (png → image/png)", async () => {
    const result = await service.resolve(ID, FILE, parse({ fmt: "png" }))

    expect(pool.transform.mock.calls[0]?.[0]).toMatchObject({ fmt: "png" })
    expect(result.headers["Content-Type"]).toBe("image/png")
    await readAll(result.stream)
  })
})