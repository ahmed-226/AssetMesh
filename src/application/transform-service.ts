import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { CacheKey } from "../domain/cache-key.js"
import { BadRequestError, ServiceUnavailableError } from "../domain/errors.js"
import type { StoredFile } from "../domain/objects.js"
import { mimeForFormat, TransformOptions } from "../domain/transform-options.js"
import type { DiskCacheStore } from "../infrastructure/cache/disk-cache-store.js"
import type { LruIndex } from "../infrastructure/cache/lru-index.js"
import type { WorkerPoolProcessor } from "../infrastructure/image/worker-pool-processor.js"

export interface VariantResult {
  headers: Record<string, string>
  stream: Readable
}

// Use-case orchestration for on-the-fly transforms. Resolves a canonical cache
// key, serves a hit, otherwise coordinates exactly one generation job.
// Identical concurrent misses coalesce onto the same in-flight promise; failed
// jobs are dropped from the map so errors are never cached. The LRU index is
// bookkeeping only — it never gates a request (a stale/missing entry just
// gets re-touched or rebuilt).
export class TransformService {
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(
    private readonly cache: DiskCacheStore,
    private readonly index: LruIndex,
    private readonly pool: WorkerPoolProcessor,
    private readonly tmpDir: string,
  ) {}

  async resolve(id: string, file: StoredFile, options: TransformOptions): Promise<VariantResult> {
    // No explicit fmt → re-encode into the original's own format.
    const fmt = options.fmt ?? file.extension
    const key = CacheKey.create(id, options, fmt)

    // A single open() (instead of exists→open) keeps the hit/miss decision
    // atomic: ENOENT reads as a miss, and a GC eviction racing in between can
    // no longer 500 a request — it simply regenerates.
    const hit = await this.openOrMiss(key)
    if (hit !== null) return this.serve(key, hit, fmt)

    await this.generate(key, file.path, options, fmt)
    const fresh = await this.openOrMiss(key)
    if (fresh !== null) return this.serve(key, fresh, fmt)

    // Evicted again between generation and open (cache is disposable):
    // regenerate once; if it still isn't there something is actually wrong.
    await this.generate(key, file.path, options, fmt)
    const again = await this.openOrMiss(key)
    if (again === null) throw new Error(`variant '${key.basename}' missing right after generation`)
    return this.serve(key, again, fmt)
  }

  private async openOrMiss(key: CacheKey): Promise<{ stream: Readable; size: number } | null> {
    try {
      return await this.cache.open(key)
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  }

  private serve(
    key: CacheKey,
    loaded: { stream: Readable; size: number },
    fmt: string,
  ): VariantResult {
    this.index.touch(key.basename, loaded.size)
    return { headers: this.variantHeaders(fmt, loaded.size), stream: loaded.stream }
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