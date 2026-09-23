import type { ObjectRepository } from "../domain/objects.js"
import { validateHash } from "../domain/objects.js"
import type { DiskCacheStore } from "../infrastructure/cache/disk-cache-store.js"
import { isCacheBasename } from "../infrastructure/cache/disk-cache-store.js"
import type { LruIndex } from "../infrastructure/cache/lru-index.js"

export interface PurgeResult {
  removedOriginal: boolean
  removedVariants: number
}

// Use-case for DELETE /api/v1/media/{id}: unlink the original blob and every
// cached variant derived from it. Purely orchestration — deletion of originals
// and cache files is delegated to the stores. Idempotent on purpose: a missing
// original is a no-op, not an error, so a retried delete is not a 404.
export class PurgeService {
  constructor(
    private readonly objects: ObjectRepository,
    private readonly cache: DiskCacheStore,
    private readonly index: LruIndex,
  ) {}

  async purge(id: string): Promise<PurgeResult> {
    validateHash(id) // 400 for a malformed id, before any filesystem access
    const removedOriginal = await this.objects.delete(id)

    // Variants share the id's shard and are named `<id>_…`; drop each from both
    // disk and the LRU index. Unlink first, index-remove after — same order as
    // the GC, so a crash between the two leaves the file tracked (evictable)
    // instead of stranding a permanently untracked orphan.
    let removedVariants = 0
    for (const basename of await this.cache.listByPrefix(id)) {
      if (!isCacheBasename(basename)) {
        // A tampered/anomalous file in the shard must not 500 the whole purge
        // (the original is already gone by now); skip it and carry on.
        process.stderr.write(`[purge] skipping non-cache file '${basename}'\n`)
        continue
      }
      await this.cache.remove(basename)
      this.index.remove(basename)
      removedVariants += 1
    }

    return { removedOriginal, removedVariants }
  }
}