import { pipeline } from "node:stream/promises"
import { Router } from "express"
import busboy from "busboy"
import type { ReadableSource } from "../domain/objects.js"
import type { UploadService, UploadResult } from "../application/upload-service.js"
import { BadRequestError } from "../domain/errors.js"

// Streaming multipart ingest. The request body is handed to busboy which never
// buffers it; the file part goes straight into UploadService → HashingWritable.
export const uploadRoute = (uploads: UploadService, maxBytes: number): Router => {
  const router = Router()

  router.post("/api/v1/upload", (req, res, next) => {
    const bb = busboy({
      headers: req.headers,
      limits: {
        fileSize: maxBytes > 0 ? maxBytes : Infinity,
        fields: 0,
        files: 1,
        fieldSize: 4096,
      },
    })

    let upload: Promise<UploadResult> | undefined
    let premature: Error | undefined

    const rejectPremature = (err: Error): void => {
      if (premature) return
      premature = err
      next(err)
    }

    bb.on("file", (_name, stream) => {
      upload = uploads.upload(stream as ReadableSource)
      // If we error out early (e.g. filesLimit) the pipeline is still running;
      // without a rejection handler it would become an unhandled promise.
      upload.catch(() => {})
    })
    bb.on("fieldsLimit", () => rejectPremature(new BadRequestError("multipart field 'file' is required")))
    bb.on("filesLimit", () => rejectPremature(new BadRequestError("exactly one file part expected")))
    bb.on("error", (err) =>
      rejectPremature(err instanceof Error ? err : new Error(String(err))),
    )
    bb.on("close", () => {
      if (premature) return
      if (upload === undefined) {
        next(new BadRequestError("multipart field 'file' is required"))
        return
      }
      // The parser finished; the pipeline may still be flushing to disk, so
      // await it before responding.
      upload.then((result) => res.status(200).json(result), (err) => next(err))
    })

    // pipeline() (not req.pipe) so a client abort mid-body destroys busboy →
    // its active file stream errors → the store removes the partial temp file.
    void pipeline(req, bb).catch((err) =>
      rejectPremature(err instanceof Error ? err : new Error(String(err))),
    )
  })

  return router
}