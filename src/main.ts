import { loadConfig } from "./config/config.js"
import type { Config } from "./config/config.js"
import { createApp } from "./http/app.js"

// Entrypoint. Manual DI: assemble config + app, then listen. Fails fast when
// the environment is invalid so a broken container never serves traffic.
const loadConfigOrExit = (): Config => {
  try {
    return loadConfig()
  } catch (err) {
    console.error(`[config] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

const main = (): void => {
  const config = loadConfigOrExit()
  const app = createApp(config)

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

void main()