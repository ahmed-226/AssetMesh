import { BadRequestError } from "./errors.js"

// Output format → Content-Type. The same four formats are sniffable at upload
// (magic.ts); this map covers the transform output side.
const FORMAT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
}

export const mimeForFormat = (format: string): string =>
  FORMAT_MIME[format] ?? "application/octet-stream"

// Cap on w/h so a request like ?w=100000 can't exhaust CPU/RAM (skill: DoS cap).
const MAX_DIMENSION = 4096

const parseDimension = (name: string, raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestError(`invalid ${name}='${raw}' — expected a positive integer`)
  }
  const value = Number(raw)
  if (value < 1 || value > MAX_DIMENSION) {
    throw new BadRequestError(`invalid ${name}='${raw}' — expected 1..${MAX_DIMENSION}`)
  }
  return value
}

const parseQuality = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestError(`invalid q='${raw}' — expected an integer 1..100`)
  }
  const value = Number(raw)
  if (value < 1 || value > 100) {
    throw new BadRequestError(`invalid q='${raw}' — expected 1..100`)
  }
  return value
}

const parseFormat = (raw: string | undefined, allowed: readonly string[]): string | undefined => {
  if (raw === undefined) return undefined
  const format = raw.trim().toLowerCase()
  if (!allowed.includes(format)) {
    throw new BadRequestError(`invalid fmt='${raw}' — expected one of ${allowed.join(", ")}`)
  }
  return format
}

// Parsed + validated transform options from a GET query string. `q` defaults to
// 80 for encoding but only counts as "an option" when the client sent it —
// `?q=50` re-encodes, whereas no query at all serves the original unchanged.
export class TransformOptions {
  private constructor(
    readonly width: number | undefined,
    readonly height: number | undefined,
    readonly quality: number | undefined,
    readonly fmt: string | undefined,
  ) {}

  static parse(
    query: Record<string, string | undefined>,
    allowedFormats: readonly string[],
  ): TransformOptions {
    return new TransformOptions(
      parseDimension("w", query.w),
      parseDimension("h", query.h),
      parseQuality(query.q),
      parseFormat(query.fmt, allowedFormats),
    )
  }

  get hasOptions(): boolean {
    return (
      this.width !== undefined ||
      this.height !== undefined ||
      this.quality !== undefined ||
      this.fmt !== undefined
    )
  }

  get effectiveQuality(): number {
    return this.quality ?? 80
  }
}