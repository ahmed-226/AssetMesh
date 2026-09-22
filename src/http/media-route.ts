import { pipeline } from "node:stream/promises"
import { Router } from "express"
import type { FetchService } from "../application/fetch-service.js"

// GET /media/:id serves the original blob (transforms are M3). Range requests
// are honoured: 206 with Content-Range, 416 for unsatisfiable ranges. The body
// is a raw stream — the file is never read into memory.
export const mediaRoute = (fetches: FetchService): Router => {
  const router = Router()

  router.get("/media/:id", async (req, res, next) => {
    try {
      const result = await fetches.fetch(req.params.id, req.headers.range)
      res.status(result.status)
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value)
      }
      if (result.stream === null) {
        res.end()
        return
      }
      await pipeline(result.stream, res)
    } catch (err) {
      if (res.headersSent || res.destroyed) {
        // Headers already flushed (or the socket already died) — likely a
        // client abort mid-download. Nothing more can be sent; cutting the
        // socket is the correct outcome.
        res.destroy()
        return
      }
      next(err)
    }
  })

  return router
}