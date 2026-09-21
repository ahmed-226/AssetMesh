import { createHash } from "node:crypto"
import { Transform, type TransformCallback } from "node:stream"
import { PayloadTooLargeError } from "../../domain/errors.js"

// Only this much of the head is kept for magic-number sniffing — the payload
// itself is never buffered, only hashed and passed through.
const MAGIC_LOOKAHEAD = 16

export class HashingWritable extends Transform {
  private readonly hasher = createHash("sha256")
  private bytesWritten = 0
  private readonly firstChunks: Buffer[] = []
  private captured = 0

  constructor(private readonly maxBytes: number) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytesWritten += chunk.length
    if (this.maxBytes > 0 && this.bytesWritten > this.maxBytes) {
      // Abort a runaway stream as early as possible so a huge file never
      // reaches the temp file in the first place.
      callback(new PayloadTooLargeError())
      return
    }
    if (this.captured < MAGIC_LOOKAHEAD) {
      const take = Math.min(MAGIC_LOOKAHEAD - this.captured, chunk.length)
      this.firstChunks.push(chunk.subarray(0, take))
      this.captured += take
    }
    this.hasher.update(chunk)
    callback(null, chunk)
  }

  get byteCount(): number {
    return this.bytesWritten
  }

  get digest(): string {
    return this.hasher.digest("hex")
  }

  get magic(): Buffer {
    // lookahead is at most MAGIC_LOOKAHEAD bytes, never the payload
    return Buffer.concat(this.firstChunks) // allow-buffer: magic sniffing head (≤16B) only
  }
}