import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FetchService } from "../../src/application/fetch-service.js"
import type { TransformService } from "../../src/application/transform-service.js"
import { BadRequestError, NotFoundError } from "../../src/domain/errors.js"
import type { ReadableSource, StoredFile } from "../../src/domain/objects.js"
import type { TransformOptions } from "../../src/domain/transform-options.js"
import { CasObjectStore } from "../../src/infrastructure/storage/cas-object-store.js"

const collect = async (stream: NodeJS.ReadableStream | null): Promise<Buffer> => {
  if (stream === null) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const truncatableSource = (chunks: Buffer[]): ReadableSource =>
  Object.assign(Readable.from(chunks), { truncated: false }) as ReadableSource

// Real PNG magic so open() re-sniffs image/png from the bytes themselves.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(2048),
])

describe("FetchService", () => {
  let root: string
  let store: CasObjectStore
  let fetches: FetchService
  let id: string
  let size: number
  let transforms: { resolve: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "assetmesh-fetch-"))
    await mkdir(join(root, "tmp"), { recursive: true })
    store = new CasObjectStore(join(root, "originals"), join(root, "tmp"))
    // Spy only — the no-option byte-range path must never touch it. Asserting
    // call counts proves the query-option branch is the only entry point.
    transforms = { resolve: vi.fn() }
    fetches = new FetchService(
      store,
      transforms as unknown as TransformService,
      ["jpg", "png", "webp", "avif"],
    )
    const stored = await store.store(truncatableSource([PNG_BYTES]), 0)
    id = stored.id
    size = stored.size
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("rejects an invalid id with BadRequestError (400)", async () => {
    await expect(fetches.fetch("nope")).rejects.toBeInstanceOf(BadRequestError)
    await expect(fetches.fetch("nope")).rejects.toMatchObject({ statusCode: 400 })
  })

  it("rejects a well-formed but missing id with NotFoundError (404)", async () => {
    await expect(fetches.fetch("0".repeat(64))).rejects.toBeInstanceOf(NotFoundError)
    await expect(fetches.fetch("0".repeat(64))).rejects.toMatchObject({ statusCode: 404 })
  })

  it("serves the whole file: 200, magic Content-Type, exact bytes", async () => {
    const result = await fetches.fetch(id, undefined)

    expect(result.status).toBe(200)
    expect(result.headers["Accept-Ranges"]).toBe("bytes")
    expect(result.headers["Content-Length"]).toBe(String(size))
    expect(result.headers["Content-Type"]).toBe("image/png")
    expect(await collect(result.stream)).toEqual(PNG_BYTES)
  })

  it("serves an explicit range: 206 with Content-Range and byte-exact slice", async () => {
    const result = await fetches.fetch(id, "bytes=0-1023")

    expect(result.status).toBe(206)
    expect(result.headers["Content-Range"]).toBe(`bytes 0-1023/${size}`)
    expect(result.headers["Content-Length"]).toBe("1024")
    expect(await collect(result.stream)).toEqual(PNG_BYTES.subarray(0, 1024))
  })

  it("serves an open-ended range from offset to EOF", async () => {
    const result = await fetches.fetch(id, "bytes=1024-")

    expect(result.status).toBe(206)
    expect(result.headers["Content-Range"]).toBe(`bytes 1024-${size - 1}/${size}`)
    expect(result.headers["Content-Length"]).toBe(String(size - 1024))
    expect(await collect(result.stream)).toEqual(PNG_BYTES.subarray(1024))
  })

  it("serves a suffix range as the last N bytes", async () => {
    const result = await fetches.fetch(id, "bytes=-10")

    expect(result.status).toBe(206)
    expect(result.headers["Content-Range"]).toBe(`bytes ${size - 10}-${size - 1}/${size}`)
    expect(result.headers["Content-Length"]).toBe("10")
    expect(await collect(result.stream)).toEqual(PNG_BYTES.subarray(size - 10))
  })

  it("answers an unsatisfiable range with 416 and no stream", async () => {
    const result = await fetches.fetch(id, "bytes=999999999999-")

    expect(result.status).toBe(416)
    expect(result.headers["Content-Range"]).toBe(`bytes */${size}`)
    expect(result.headers["Accept-Ranges"]).toBe("bytes")
    expect(result.stream).toBeNull()
  })

  it("ignores multi-range headers and serves the whole file (200)", async () => {
    const result = await fetches.fetch(id, "bytes=0-1,2-3")

    expect(result.status).toBe(200)
    expect(result.headers["Content-Length"]).toBe(String(size))
    expect(await collect(result.stream)).toEqual(PNG_BYTES)
  })

  it("clamps an over-long range end to the file size", async () => {
    const result = await fetches.fetch(id, `bytes=0-${size + 1000}`)

    expect(result.status).toBe(206)
    expect(result.headers["Content-Range"]).toBe(`bytes 0-${size - 1}/${size}`)
    expect(await collect(result.stream)).toEqual(PNG_BYTES)
  })

  it("routes a request with options to the transform pipeline and returns its stream", async () => {
    const payload = randomBytes(64)
    transforms.resolve.mockResolvedValue({
      headers: { "Content-Type": "image/webp", "Content-Length": String(payload.length) },
      stream: Readable.from([payload]),
    })

    const result = await fetches.fetch(id, undefined, { w: "300", fmt: "webp" })

    expect(result.status).toBe(200)
    expect(transforms.resolve).toHaveBeenCalledTimes(1)
    const [calledId, file, options] = transforms.resolve.mock.calls[0] as unknown as [
      string,
      StoredFile,
      TransformOptions,
    ]
    expect(calledId).toBe(id)
    expect(file.path).toContain(join("originals", id.slice(0, 2)))
    expect(options.width).toBe(300)
    expect(options.fmt).toBe("webp")
    expect(result.headers["Content-Type"]).toBe("image/webp")
    expect(await collect(result.stream)).toEqual(payload)
  })

  it("serves the original when the query carries no options (pipeline untouched)", async () => {
    const result = await fetches.fetch(id, undefined, {})

    expect(result.status).toBe(200)
    expect(transforms.resolve).not.toHaveBeenCalled()
    expect(result.headers["Content-Type"]).toBe("image/png")
    expect(await collect(result.stream)).toEqual(PNG_BYTES)
  })

  it("rejects invalid transform options with BadRequestError (400)", async () => {
    await expect(fetches.fetch(id, undefined, { w: "abc" })).rejects.toBeInstanceOf(
      BadRequestError,
    )
    await expect(fetches.fetch(id, undefined, { w: "abc" })).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(transforms.resolve).not.toHaveBeenCalled() // parse threw before the pipeline
  })
})