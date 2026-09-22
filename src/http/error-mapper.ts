import type { NextFunction, Request, Response } from "express"
import { AppError } from "../domain/errors.js"

// Single place where domain errors become HTTP responses (AGENTS rule).
// Anything that is not a known AppError is a bug → 500.
export const errorMapper = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (next === undefined) return
  if (res.headersSent || res.destroyed) {
    // A streamed response already started (or the client is gone); too late to
    // change status or write a JSON body.
    res.destroy()
    return
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message })
    return
  }
  console.error("[http] unhandled error", err)
  res.status(500).json({ error: "internal server error" })
}