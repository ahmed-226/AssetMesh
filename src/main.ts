import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { FetchService } from "./application/fetch-service.js"
import { PurgeService } from "./application/purge-service.js"
import { TransformService } from "./application/transform-service.js"
import { UploadService } from "./application/upload-service.js"
import { loadConfig } from "./config/config.js"
import type { Config } from "./config/config.js"
import { createApp } from "./http/app.js"
import { DiskCacheStore } from "./infrastructure/cache/disk-cache-store.js"
import { GarbageCollector } from "./infrastructure/cache/garbage-collector.js"
import { LruIndex } from "./infrastructure/cache/lru-index.js"
import { WorkerPoolProcessor } from "./infrastructure/image/worker-pool-processor.js"
import { CasObjectStore } from "./infrastructure/storage/cas-object-store.js"

// Entrypoint. Manual DI: assemble config + storage + services, then listen.
// Fails fast when the environment is invalid so a broken container never
// serves traffic.
const loadConfigOrExit = (): Config => {
  try {
    return loadConfig()
  } catch (err) {
    console.error(`[config] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

const main = async (): Promise<void> => {
  const config = loadConfigOrExit()
  const originalsDir = join(config.storageDir, "originals")
  const tmpDir = join(config.storageDir, "tmp")

  // tmp lives on the same filesystem as originals — required for atomic rename.
  await mkdir(tmpDir, { recursive: true })

  const objects = new CasObjectStore(originalsDir, tmpDir)
  const uploads = new UploadService(objects, config.maxUploadSizeBytes)

  // JIT transform pipeline: bounded worker pool fronted by the disk cache.
  // The queue cap keeps a backflash of transforms from buffering indefinitely.
  const cacheDir = join(config.storageDir, "cache")
  const cache = new DiskCacheStore(cacheDir)
  const index = new LruIndex(join(cacheDir, "index.json"))
  // Boot reconciliation: if index.json parsed, absorb any files written after
  // its last save (crash between store() and save()); if missing/corrupt,
  // rebuild the whole index from disk (mtime = access order). Either way the
  // GC's byte count matches disk before the first tick.
  const walk = await cache.walk()
  await index.load().catch(async () => {
    console.warn("[cache] index.json missing or corrupt — rebuilding from disk")
    index.rebuild(walk)
    return
  })
  index.mergeMissing(walk)
  const pool = new WorkerPoolProcessor({
    maxThreads: config.workerPoolSize,
    maxQueue: Math.max(4, config.workerPoolSize * 2),
  })
  const transforms = new TransformService(cache, index, pool, tmpDir)
  const fetches = new FetchService(objects, transforms, config.allowedFormats)
  const purges = new PurgeService(objects, cache, index)
  const gc = new GarbageCollector({ cache, index, limitBytes: config.cacheLimitBytes, intervalMs: config.gcIntervalMs })
  gc.start()
  const app = createApp(config, uploads, fetches, purges)

  const server = app.listen(config.port, () => {
    console.log(`AssetMesh ready on http://localhost:${config.port}`)
  })

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received — shutting down`)
    server.close(async () => {
      await pool.close() // wait for in-flight sharp jobs before process exit
      gc.stop()
      try {
        await index.save() // flush LRU bookkeeping so next boot is warm
      } catch (err) {
        console.error(`[shutdown] index flush failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      process.exit(0)
    })
    // Force-exit if connections keep the server from closing (e.g. long hangs).
    setTimeout(() => process.exit(1), 5_000).unref()
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

void main().catch((err: unknown) => {
  console.error(`[boot] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})