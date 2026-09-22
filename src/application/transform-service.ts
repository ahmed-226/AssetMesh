import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { CacheKey } from "../domain/cache-key.js"
import { BadRequestError, ServiceUnavailableError } from "../domain/errors.js"
import type { StoredFile } from "../domain/objects.js"
import { mimeForFormat, TransformOptions } from "../domain/transform-options.js"
import type { DiskCacheStore } from "../infrastructure/cache/disk-cache-store.js"
import type { WorkerPoolProcessor } from "../infrastructure/image/worker-pool-processor.js"

export interface VariantResult {
  headers: Record<string, string>
  stream: Readable
}

// Use-case orchestration for on-the-fly transforms. Resolves a canonical cache
// key, serves a hit, otherwise coordinates exactly one generation job.
// Identical concurrent misses coalesce onto the same in-flight promise; failed
// jobs are dropped from the map so errors are never cached.
export class TransformService {
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(
    private readonly cache: DiskCacheStore,
    private readonly pool: WorkerPoolProcessor,
    private readonly tmpDir: string,
  ) {}

  async resolve(id: string, file: StoredFile, options: TransformOptions): Promise<VariantResult> {
    // No explicit fmt → re-encode into the original's own format.
    const fmt = options.fmt ?? file.extension
    const key = CacheKey.create(id, options, fmt)

    if (await this.cache.exists(key)) {
      const { stream, size } = await this.cache.open(key)
      return { headers: this.variantHeaders(fmt, size), stream }
    }

    await this.generate(key, file.path, options, fmt)
    const { stream, size } = await this.cache.open(key)
    return { headers: this.variantHeaders(fmt, size), stream }
  }

  private variantHeaders(fmt: string, size: number): Record<string, string> {
    return { "Content-Type": mimeForFormat(fmt), "Content-Length": String(size) }
  }

  private generate(
    key: CacheKey,
    originalPath: string,
    options: TransformOptions,
    fmt: string,
  ): Promise<void> {
    const existing = this.inflight.get(key.basename)
    if (existing !== undefined) return existing

    const job = this.runGeneration(key, originalPath, options, fmt).finally(() => {
      this.inflight.delete(key.basename)
    })
    this.inflight.set(key.basename, job)
    return job
  }

  private async runGeneration(
    key: CacheKey,
    originalPath: string,
    options: TransformOptions,
    fmt: string,
  ): Promise<void> {
    const tmpPath = join(this.tmpDir, randomUUID())
    try {
      const outcome = await this.pool.transform({
        originalPath,
        tmpPath,
        width: options.width,
        height: options.height,
        quality: options.effectiveQuality,
        fmt,
      })

      if (!outcome.ok) {
        if (outcome.code === "NOT_IMAGE") {
          throw new BadRequestError("stored object is not a supported image")
        }
        throw new Error(`image transform I/O failure: ${outcome.message}`)
      }

      try {
        await this.cache.store(key, tmpPath)
      } catch (err) {
        await rm(tmpPath, { force: true }) // never leave a stray tmp artifact
        throw err
      }
    } catch (err) {
      // 503 from a saturated pool must pass through untouched; the coalesced
      // promise is still dropped by generate()'s finally, so the client retries.
      if (err instanceof ServiceUnavailableError) throw err
      await rm(tmpPath, { force: true })
      throw err
    }
  }
}