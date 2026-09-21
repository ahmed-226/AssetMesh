import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { access, mkdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pipeline } from "node:stream/promises"
import { PayloadTooLargeError } from "../../domain/errors.js"
import type { ObjectRepository, ReadableSource, StoredObject } from "../../domain/objects.js"
import { HashingWritable } from "./hashing-writable.js"
import { sniffFormat } from "./magic.js"

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// Content-addressable store: bytes are streamed to a temp file while being
// hashed; the digest then becomes the final path (atomic rename). Same bytes
// always land on the same path, so dedup is just an existence check.
export class CasObjectStore implements ObjectRepository {
  constructor(
    private readonly originalsDir: string,
    private readonly tmpDir: string,
  ) {}

  async store(source: ReadableSource, maxBytes: number): Promise<StoredObject> {
    const tmpPath = join(this.tmpDir, randomUUID())
    const hasher = new HashingWritable(maxBytes)
    try {
      await pipeline(source, hasher, createWriteStream(tmpPath, { flags: "wx" }))
      // busboy truncates at its own fileSize limit; treat that as oversize too.
      if (source.truncated) throw new PayloadTooLargeError()

      const { extension, mimeType } = sniffFormat(hasher.magic)
      const id = hasher.digest
      const finalPath = join(this.originalsDir, id.slice(0, 2), id.slice(2, 4), `${id}.${extension}`)

      if (await exists(finalPath)) {
        await rm(tmpPath, { force: true })
        return { id, extension, mimeType, size: hasher.byteCount }
      }

      await mkdir(dirname(finalPath), { recursive: true })
      await rename(tmpPath, finalPath)
      return { id, extension, mimeType, size: hasher.byteCount }
    } catch (err) {
      await rm(tmpPath, { force: true })
      throw err
    }
  }
}