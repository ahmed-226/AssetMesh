import type { DiskCacheStore } from "./disk-cache-store.js"
import type { LruIndex } from "./lru-index.js"

export interface GcOptions {
  cache: DiskCacheStore
  index: LruIndex
  /** Size cap in bytes; 0 disables eviction (config warns on CACHE_LIMIT_GB=0). */
  limitBytes: number
  intervalMs: number
  /** Evict until this fraction of the limit so it doesn't re-trip next tick. */
  targetRatio?: number
}

// Background task: on a fixed interval, size the cache against CACHE_LIMIT_GB
// and, when over, evict least-recently-accessed variants until ~90% of the
// limit (a little headroom). The timer is unref'd so it can't hold the process
// open at shutdown; overlapping ticks are skipped.
export class GarbageCollector {
  private readonly targetRatio: number
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private readonly opts: GcOptions) {
    this.targetRatio = opts.targetRatio ?? 0.9
  }

  start(): void {
    if (this.opts.limitBytes <= 0) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.opts.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  // Also exported publicly so shutdown can flush the index from one place.
  async tick(): Promise<void> {
    if (this.running) return // never overlap with a still-running tick
    // A zero limit means "eviction disabled" (see config warning); targeting
    // floor(0 × ratio) = 0 would otherwise purge the whole cache.
    if (this.opts.limitBytes <= 0) return
    this.running = true
    try {
      // Persist before and after so the on-disk index never lags a full tick.
      await this.opts.index.save()
      const target = Math.floor(this.opts.limitBytes * this.targetRatio)
      while (this.opts.index.totalSize > target) {
        const oldest = this.opts.index.peekOldest()
        if (oldest === undefined) break // index empty but still over? nothing to evict
        // Unlink first, drop from the index only on success: if the unlink
        // fails (e.g. a Windows open-file), the entry stays indexed and the
        // byte count stays honest instead of drifting from disk.
        await this.opts.cache.remove(oldest.key)
        this.opts.index.remove(oldest.key)
      }
      await this.opts.index.save()
    } catch (err) {
      // GC must never take the process down; a failed tick retries next round.
      console.error("[gc] tick failed:", err instanceof Error ? err.message : String(err))
    } finally {
      this.running = false
    }
  }
}