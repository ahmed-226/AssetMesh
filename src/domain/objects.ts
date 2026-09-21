import type { Readable } from "node:stream"

// Busboy marks a file stream `truncated` when the configured fileSize limit
// was hit mid-upload. The store treats that like an oversize payload.
export type ReadableSource = Readable & { truncated?: boolean }

export interface StoredObject {
  id: string
  extension: string
  mimeType: string
  size: number
}

export interface ObjectRepository {
  store(source: ReadableSource, maxBytes: number): Promise<StoredObject>
}