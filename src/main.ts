import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { FetchService } from "./application/fetch-service.js"
import { UploadService } from "./application/upload-service.js"
import { loadConfig } from "./config/config.js"
import type { Config } from "./config/config.js"
import { createApp } from "./http/app.js"
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
  const fetches = new FetchService(objects)
  const app = createApp(config, uploads, fetches)

  const server = app.listen(config.port, () => {
    console.log(`AssetMesh ready on http://localhost:${config.port}`)
  })

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received — shutting down`)
    server.close(() => process.exit(0))
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