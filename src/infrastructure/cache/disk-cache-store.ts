import { createReadStream } from "node:fs"
import { access, mkdir, rename, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Readable } from "node:stream"
import type { CacheKey } from "../../domain/cache-key.js"

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

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
}