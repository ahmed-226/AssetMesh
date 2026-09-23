import { Router } from "express"
import type { PurgeService } from "../application/purge-service.js"

// DELETE /api/v1/media/:id purges the original blob and every cached variant.
// Returns 204 even when the id was already gone — delete is idempotent; only a
// malformed id (caught by validateHash in the service) is a 400.
export const deleteRoute = (purges: PurgeService): Router => {
  const router = Router()

  router.delete("/api/v1/media/:id", async (req, res, next) => {
    try {
      await purges.purge(req.params.id)
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })

  return router
}