import express, { type Express } from "express"
import type { FetchService } from "../application/fetch-service.js"
import type { PurgeService } from "../application/purge-service.js"
import type { UploadService } from "../application/upload-service.js"
import type { Config } from "../config/config.js"
import { deleteRoute } from "./delete-route.js"
import { errorMapper } from "./error-mapper.js"
import { mediaRoute } from "./media-route.js"
import { uploadRoute } from "./upload-route.js"

// Builds the Express app from injected dependencies. Routes are added per
// milestone; the error mapper is registered last so domain errors surface as
// HTTP responses from a single place.
export const createApp = (
  config: Config,
  uploads: UploadService,
  fetches: FetchService,
  purges: PurgeService,
): Express => {
  const app = express()
  app.disable("x-powered-by")

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" })
  })

  app.use(uploadRoute(uploads, config.maxUploadSizeBytes))
  app.use(mediaRoute(fetches))
  app.use(deleteRoute(purges))
  app.use(errorMapper)

  return app
}