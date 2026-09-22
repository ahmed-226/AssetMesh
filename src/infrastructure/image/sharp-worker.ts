import sharp, { type FormatEnum, type ResizeOptions } from "sharp"

// Runs inside a piscina worker thread — the only process that ever executes
// sharp. The pool size is the concurrency control, so libvips's own thread pool
// is pinned to 1 and its RAM cache disabled; otherwise workers multiply threads
// and cache per process (skill: thread × worker explosion).
sharp.cache(false)
sharp.concurrency(1)

export interface TransformRequest {
  originalPath: string
  tmpPath: string
  width?: number
  height?: number
  quality: number
  fmt: string
}

// Discriminated outcome instead of throwing: Error instances don't survive the
// piscina structured-clone boundary reliably, so the failure reason is carried
// back as data and mapped to HTTP by TransformService.
export type TransformOutcome =
  | { ok: true; width: number; height: number; size: number }
  | { ok: false; code: "NOT_IMAGE" | "IO"; message: string }

export default async function transform(request: TransformRequest): Promise<TransformOutcome> {
  try {
    const image = sharp(request.originalPath).rotate() // honor EXIF orientation
    if (request.width !== undefined || request.height !== undefined) {
      // fit 'inside' + withoutEnlargement: shrink to fit the box, never upscale.
      const resize: ResizeOptions = { fit: "inside", withoutEnlargement: true }
      if (request.width !== undefined) resize.width = request.width
      if (request.height !== undefined) resize.height = request.height
      image.resize(resize)
    }
    image.toFormat(request.fmt as keyof FormatEnum, { quality: request.quality })
    const info = await image.toFile(request.tmpPath)
    return { ok: true, width: info.width ?? 0, height: info.height ?? 0, size: info.size }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    // Node fs errors carry E* codes (ENOENT, EACCES…) — anything else is sharp
    // rejecting the bytes, i.e. the stored object isn't a decodable image.
    return {
      ok: false,
      code: typeof code === "string" && code.startsWith("E") ? "IO" : "NOT_IMAGE",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}