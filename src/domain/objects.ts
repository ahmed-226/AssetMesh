import type { Readable } from "node:stream"
import { BadRequestError } from "./errors.js"
import type { ByteRange } from "./range.js"

// Busboy marks a file stream `truncated` when the configured fileSize limit
// was hit mid-upload. The store treats that like an oversize payload.
export type ReadableSource = Readable & { truncated?: boolean }

export const HASH_PATTERN = /^[a-f0-9]{64}$/

// Non-negotiables rule: never build a path from user input without checking the
// id first. This is the single gate for every id that arrives from a URL.
export const validateHash = (id: string): string => {
  if (!HASH_PATTERN.test(id)) {
    throw new BadRequestError(`invalid id '${id}' — expected a 64-char lowercase hex sha256`)
  }
  return id
}

export interface StoredObject {
  id: string
  extension: string
  mimeType: string
  size: number
}

export interface StoredFile {
  path: string
  size: number
  extension: string
  mimeType: string
}

export interface ObjectRepository {
  store(source: ReadableSource, maxBytes: number): Promise<StoredObject>
  open(id: string): Promise<StoredFile>
  read(file: StoredFile, range: ByteRange | null): Readable
  // Purge: unlink the original blob. Returns whether a file was actually
  // removed — a missing id is a no-op (delete is idempotent), not an error.
  delete(id: string): Promise<boolean>
}