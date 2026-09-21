import express, { type Express } from "express"
import type { Config } from "../config/config.js"

// Builds the Express app from injected dependencies. No routes are registered
// yet beyond health; upload/download will be added by the http layer in M1+.
export const createApp = (_config: Config): Express => {
  const app = express()
  app.disable("x-powered-by")

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" })
  })

  return app
}