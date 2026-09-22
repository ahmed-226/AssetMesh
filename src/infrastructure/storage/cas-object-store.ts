import { randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { access, mkdir, open as openFile, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { NotFoundError, PayloadTooLargeError } from "../../domain/errors.js"
import type { ObjectRepository, ReadableSource, StoredFile, StoredObject } from "../../domain/objects.js"
import { validateHash } from "../../domain/objects.js"
import type { ByteRange } from "../../domain/range.js"
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

const isEnoent = (err: unknown): boolean =>
  err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"

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

  // Lookup by id ignores the extension: the shard dir may hold <id>.<ext> for
  // whatever extension the magic bytes imply. List and match the id prefix.
  async open(id: string): Promise<StoredFile> {
    validateHash(id) // defense-in-depth: never build a path from unvalidated input
    const path = await this.findPath(id)
    if (path === null) throw new NotFoundError(`no object with id '${id}'`)
    const { size } = await stat(path)
    const { extension, mimeType } = await this.sniffMeta(path)
    return { path, size, extension, mimeType }
  }

  read(file: StoredFile, range: ByteRange | null): Readable {
    return createReadStream(file.path, range === null ? undefined : { start: range.start, end: range.end })
  }

  private async findPath(id: string): Promise<string | null> {
    const shardDir = join(this.originalsDir, id.slice(0, 2), id.slice(2, 4))
    let entries: string[]
    try {
      entries = await readdir(shardDir)
    } catch (err) {
      // Only a missing shard means "no object"; other failures (EACCES…) are
      // real errors and must surface as 500, not 404.
      if (isEnoent(err)) return null
      throw err
    }
    const match = entries.find((entry) => entry.startsWith(`${id}.`))
    return match === undefined ? null : join(shardDir, match)
  }

  // MIME + extension on read are re-derived from the magic bytes, never the
  // filename. This keeps downloads (and transform output format) honest even
  // when a file was renamed on disk.
  private async sniffMeta(path: string): Promise<{ extension: string; mimeType: string }> {
    const handle = await openFile(path, "r")
    try {
      const head = Buffer.alloc(16) // allow-buffer: magic head only, not payload
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      return sniffFormat(head.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
  }
}