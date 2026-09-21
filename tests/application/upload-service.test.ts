import { createHash, randomBytes } from "node:crypto"
import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import { UploadService } from "../../src/application/upload-service.js"
import type { ObjectRepository, ReadableSource, StoredObject } from "../../src/domain/objects.js"

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex")

describe("UploadService", () => {
  it("returns { id, url } and forwards the size guard to the repository", async () => {
    const bytes = randomBytes(512)
    const seen: { source?: ReadableSource; maxBytes?: number } = {}

    const repo: ObjectRepository = {
      async store(source: ReadableSource, maxBytes: number): Promise<StoredObject> {
        seen.source = source
        seen.maxBytes = maxBytes
        const chunks: Buffer[] = []
        for await (const chunk of source) chunks.push(Buffer.from(chunk))
        const all = Buffer.concat(chunks)
        return { id: sha256(all), extension: "bin", mimeType: "application/octet-stream", size: all.length }
      },
    }

    const service = new UploadService(repo, 512)
    const result = await service.upload(Readable.from([bytes]) as ReadableSource)

    expect(result.id).toBe(sha256(bytes))
    expect(result.url).toBe(`/media/${result.id}`)
    expect(seen.maxBytes).toBe(512)
  })

  it("passes the exact source stream through to the repository (no buffering in between)", async () => {
    const bytes = randomBytes(1024)
    const source = Readable.from([bytes]) as ReadableSource
    let received: ReadableSource | undefined

    const repo: ObjectRepository = {
      async store(src: ReadableSource): Promise<StoredObject> {
        received = src
        const chunks: Buffer[] = []
        for await (const chunk of src) chunks.push(Buffer.from(chunk))
        const all = Buffer.concat(chunks)
        return { id: sha256(all), extension: "png", mimeType: "image/png", size: all.length }
      },
    }

    const service = new UploadService(repo, 0)
    const result = await service.upload(source)

    expect(received).toBe(source)
    expect(result.id).toBe(sha256(bytes))
  })

  it("propagates repository errors (e.g. 413) unchanged", async () => {
    const repo: ObjectRepository = {
      async store(): Promise<StoredObject> {
        throw new Error("boom")
      },
    }
    const service = new UploadService(repo, 0)
    await expect(service.upload(Readable.from([]) as ReadableSource)).rejects.toThrow("boom")
  })
})