import { pipeline } from "node:stream/promises"
import { Router } from "express"
import type { FetchService } from "../application/fetch-service.js"

// query params → string|undefined so the domain parser sees one shape.
const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

// GET /media/:id serves the original blob, or a JIT-transformed variant when
// any of w/h/q/fmt are present. Range requests are honoured on originals:
// 206 with Content-Range, 416 for unsatisfiable ranges. The body is a raw
// stream — the file (or generated variant) is never read into memory.
export const mediaRoute = (fetches: FetchService): Router => {
  const router = Router()

  router.get("/media/:id", async (req, res, next) => {
    try {
      const result = await fetches.fetch(req.params.id, req.headers.range, {
        w: asString(req.query.w),
        h: asString(req.query.h),
        q: asString(req.query.q),
        fmt: asString(req.query.fmt),
      })
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