export interface ByteRange {
  start: number
  end: number
}

// Parses an HTTP Range header into an inclusive byte range.
//   bytes=0-1023      -- explicit start/end
//   bytes=1024-       -- from offset to EOF
//   bytes=-500        -- last 500 bytes (suffix form)
// Returns:
//   ByteRange          -- a satisfiable range (end clamped to size-1)
//   "invalid"          -- syntactically bad or unsatisfiable (→ 416)
//   null               -- no/ignored header, or a multi-range request (serve the
//                         whole file, out of scope)
export const parseRange = (header: string | undefined, size: number): ByteRange | "invalid" | null => {
  if (header === undefined) return null
  if (header.includes(",")) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (match === null) return size > 0 ? "invalid" : null

  const startRaw = match[1] ?? ""
  const endRaw = match[2] ?? ""
  if (startRaw === "" && endRaw === "") return "invalid"

  let start: number
  let end: number
  if (startRaw === "") {
    // Suffix form: the LAST n bytes.
    const last = Number(endRaw)
    if (last <= 0) return size > 0 ? "invalid" : null
    start = Math.max(0, size - last)
    end = size - 1
  } else if (endRaw === "") {
    start = Number(startRaw)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = Math.min(Number(endRaw), size - 1)
  }

  if (start >= size || start > end) return "invalid"
  return { start, end }
}