import { createHash, randomBytes } from "node:crypto"
import { Readable, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { describe, expect, it } from "vitest"
import { PayloadTooLargeError } from "../../../src/domain/errors.js"
import { HashingWritable } from "../../../src/infrastructure/storage/hashing-writable.js"

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex")

const collect = (chunks: Buffer[]): Writable =>
  new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null) => void) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })

describe("HashingWritable", () => {
  it("passes every byte through unchanged (multi-chunk, byte-exact)", async () => {
    const parts = [randomBytes(16 * 1024), randomBytes(7), randomBytes(1024)]
    const input = Buffer.concat(parts)
    const out: Buffer[] = []
    await pipeline(Readable.from(parts), new HashingWritable(0), collect(out))
    expect(Buffer.concat(out).equals(input)).toBe(true)
  })

  it("hashes the full stream (digest === sha256 of all bytes)", async () => {
    const parts = [randomBytes(10 * 1024), randomBytes(2048), randomBytes(3)]
    const hasher = new HashingWritable(0)
    await pipeline(Readable.from(parts), hasher, collect([]))
    expect(hasher.digest).toBe(sha256(Buffer.concat(parts)))
  })

  it("counts every byte that passed through", async () => {
    const parts = [randomBytes(1000), randomBytes(24)]
    const hasher = new HashingWritable(0)
    await pipeline(Readable.from(parts), hasher, collect([]))
    expect(hasher.byteCount).toBe(1024)
  })

  it("keeps at most 16 bytes of head for magic sniffing", async () => {
    const head = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(24)])
    const hasher = new HashingWritable(0)
    await pipeline(Readable.from([head]), hasher, collect([]))
    expect(hasher.magic.length).toBe(16)
    expect(hasher.magic.equals(head.subarray(0, 16))).toBe(true)
  })

  it("keeps the whole head when the stream is shorter than 16 bytes", async () => {
    const head = Buffer.from("GIF89a")
    const hasher = new HashingWritable(0)
    await pipeline(Readable.from([head]), hasher, collect([]))
    expect(hasher.magic.equals(head)).toBe(true)
  })

  it("rejects mid-stream with PayloadTooLargeError once the cap is exceeded", async () => {
    const hasher = new HashingWritable(10)
    await expect(
      pipeline(Readable.from([Buffer.alloc(5), Buffer.alloc(6)]), hasher, collect([])),
    ).rejects.toBeInstanceOf(PayloadTooLargeError)
  })

  it("accepts a stream that exactly matches the cap", async () => {
    const hasher = new HashingWritable(10)
    await pipeline(Readable.from([Buffer.alloc(7), Buffer.alloc(3)]), hasher, collect([]))
    expect(hasher.byteCount).toBe(10)
    expect(hasher.digest).toBe(sha256(Buffer.alloc(10)))
  })

  it("treats maxBytes 0 as no limit", async () => {
    const input = randomBytes(1024 * 1024)
    const hasher = new HashingWritable(0)
    await pipeline(Readable.from([input]), hasher, collect([]))
    expect(hasher.byteCount).toBe(input.length)
    expect(hasher.digest).toBe(sha256(input))
  })
})