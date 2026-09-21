export interface SniffedFormat {
  extension: string
  mimeType: string
}

const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff])
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Signature sniffing by magic bytes. Only a handful of common formats — an
// unrecognized stream falls back to a binary blob. Never trust names.
const signatures: ReadonlyArray<{ match: (b: Buffer) => boolean; format: SniffedFormat }> = [
  {
    match: (b) => b.length >= 3 && b.subarray(0, 3).equals(JPEG_HEAD),
    format: { extension: "jpg", mimeType: "image/jpeg" },
  },
  {
    match: (b) => b.length >= 8 && b.subarray(0, 8).equals(PNG_HEAD),
    format: { extension: "png", mimeType: "image/png" },
  },
  {
    match: (b) => b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
    format: { extension: "webp", mimeType: "image/webp" },
  },
  {
    match: (b) => b.length >= 6 && b.toString("latin1", 0, 4) === "GIF8",
    format: { extension: "gif", mimeType: "image/gif" },
  },
  {
    match: (b) => {
      if (b.length < 12) return false
      const brand = b.toString("latin1", 8, 12)
      return b.toString("latin1", 4, 8) === "ftyp" && (brand === "avif" || brand === "avis")
    },
    format: { extension: "avif", mimeType: "image/avif" },
  },
]

export const sniffFormat = (firstBytes: Buffer): SniffedFormat =>
  signatures.find((s) => s.match(firstBytes))?.format ?? {
    extension: "bin",
    mimeType: "application/octet-stream",
  }