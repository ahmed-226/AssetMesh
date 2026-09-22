import { once } from "node:events"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FetchService } from "../../src/application/fetch-service.js"
import type { TransformService } from "../../src/application/transform-service.js"
import { UploadService } from "../../src/application/upload-service.js"
import type { Config } from "../../src/config/config.js"
import type { ObjectRepository, ReadableSource } from "../../src/domain/objects.js"
import { createApp } from "../../src/http/app.js"
import { CasObjectStore } from "../../src/infrastructure/storage/cas-object-store.js"

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex")

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(2048), // > 1024 so range slices are meaningful
])
const BLOB_BYTES = randomBytes(2048)

// Route can leave a store() promise dangling after responding; track them so
// teardown can wait before deleting the temp root (same pattern as app.test.ts).
const servers: Server[] = []
const roots: string[] = []
const inflight = new Set<Promise<unknown>>()

interface FakeTransforms {
  resolve: ReturnType<typeof vi.fn>
}

// The default spy is never invoked by the no-option/range cases; the variant
// tests inject their own implementation. Since src/ isn't typechecked from
// tests/, the cast only documents intent.
const start = async (
  opts: { transforms?: FakeTransforms } = {},
): Promise<{ baseUrl: string; root: string; transforms: FakeTransforms }> => {
  const root = await mkdtemp(join(tmpdir(), "assetmesh-media-"))
  roots.push(root)
  await mkdir(join(root, "tmp"), { recursive: true })
  const config: Config = {
    port: 0,
    storageDir: root,
    maxUploadSizeBytes: 16 * 1024 * 1024,
    cacheLimitBytes: 1024 * 1024,
    allowedFormats: ["png"],
    workerPoolSize: 1,
    gcIntervalMs: 60_000,
  }
  const underlying = new CasObjectStore(join(root, "originals"), join(root, "tmp"))
  const repo: ObjectRepository = {
    async store(source: ReadableSource, maxBytes: number) {
      const work = Promise.resolve().then(() => underlying.store(source, maxBytes))
      inflight.add(work)
      try {
        return await work
      } finally {
        inflight.delete(work)
      }
    },
    open: (id) => underlying.open(id),
    read: (file, range) => underlying.read(file, range),
  }
  const transforms = opts.transforms ?? { resolve: vi.fn() }
  const uploads = new UploadService(repo, config.maxUploadSizeBytes)
  const fetches = new FetchService(
    repo,
    transforms as unknown as TransformService,
    ["jpg", "png", "webp", "avif"],
  )
  const app = createApp(config, uploads, fetches)
  const server = app.listen(0)
  servers.push(server)
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("expected a TCP port")
  return { baseUrl: `http://127.0.0.1:${address.port}`, root, transforms }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (let i = 0; i < 200 && inflight.size > 0; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

const upload = async (
  baseUrl: string,
  bytes: Buffer,
  filename: string,
  mime: string,
): Promise<string> => {
  const form = new FormData()
  form.append("file", new Blob([bytes], { type: mime }), filename)
  const res = await fetch(`${baseUrl}/api/v1/upload`, { method: "POST", body: form })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { id: string; url: string }
  expect(body.url).toBe(`/media/${body.id}`)
  return body.id
}

const get = (baseUrl: string, id: string, range?: string): Promise<Response> =>
  fetch(`${baseUrl}/media/${id}`, { headers: range === undefined ? {} : { range } })

describe("GET /media/:id — full and range requests over HTTP", () => {
  it("serves a PNG with magic-derived Content-Type and the exact bytes", async () => {
    const { baseUrl } = await start()
    const id = await upload(baseUrl, PNG_BYTES, "a.png", "image/png")

    const res = await get(baseUrl, id)

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("accept-ranges")).toBe("bytes")
    expect(res.headers.get("content-length")).toBe(String(PNG_BYTES.length))
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true)
  })

  it("serves a raw blob as application/octet-stream (magic beats the filename)", async () => {
    const { baseUrl } = await start()
    // Innocent filename, random bytes → must be detected as a binary blob.
    const id = await upload(baseUrl, BLOB_BYTES, "a.png", "image/png")

    const res = await get(baseUrl, id)

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/octet-stream")
    expect(Buffer.from(await res.arrayBuffer()).equals(BLOB_BYTES)).toBe(true)
  })

  it("serves Range: bytes=0-1023 as 206 with the exact prefix slice", async () => {
    const { baseUrl } = await start()
    const id = await upload(baseUrl, PNG_BYTES, "a.png", "image/png")

    const res = await get(baseUrl, id, "bytes=0-1023")

    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe(`bytes 0-1023/${PNG_BYTES.length}`)
    expect(res.headers.get("content-length")).toBe("1024")
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES.subarray(0, 1024))).toBe(true)
  })

  it("serves Range: bytes=1024- as 206 with the remainder", async () => {
    const { baseUrl } = await start()
    const id = await upload(baseUrl, PNG_BYTES, "a.png", "image/png")

    const res = await get(baseUrl, id, "bytes=1024-")

    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe(`bytes 1024-${PNG_BYTES.length - 1}/${PNG_BYTES.length}`)
    expect(res.headers.get("content-length")).toBe(String(PNG_BYTES.length - 1024))
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES.subarray(1024))).toBe(true)
  })

  it("serves Range: bytes=-10 as 206 with the last 10 bytes", async () => {
    const { baseUrl } = await start()
    const id = await upload(baseUrl, PNG_BYTES, "a.png", "image/png")

    const res = await get(baseUrl, id, "bytes=-10")

    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe(
      `bytes ${PNG_BYTES.length - 10}-${PNG_BYTES.length - 1}/${PNG_BYTES.length}`,
    )
    expect(res.headers.get("content-length")).toBe("10")
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES.subarray(PNG_BYTES.length - 10))).toBe(true)
  })

  it("answers an unsatisfiable range with 416 and bytes */<size>", async () => {
    const { baseUrl } = await start()
    const id = await upload(baseUrl, PNG_BYTES, "a.png", "image/png")

    const res = await get(baseUrl, id, "bytes=999999999999-")

    expect(res.status).toBe(416)
    expect(res.headers.get("content-range")).toBe(`bytes */${PNG_BYTES.length}`)
    expect(await res.text()).toBe("")
  })

  it("ignores a multi-range header and serves the whole file", async () => {
    const { baseUrl } = await start()
    const id = await upload(baseUrl, PNG_BYTES, "a.png", "image/png")

    const res = await get(baseUrl, id, "bytes=0-1,2-3")

    expect(res.status).toBe(200)
    expect(res.headers.get("content-length")).toBe(String(PNG_BYTES.length))
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true)
  })

  it("returns 404 for a well-formed but missing id", async () => {
    const { baseUrl } = await start()
    const res = await get(baseUrl, "0".repeat(64))
    expect(res.status).toBe(404)
  })

  it("returns 400 for a malformed id", async () => {
    const { baseUrl } = await start()
    const res = await get(baseUrl, "bad")
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: expect.stringContaining("invalid id") })
  })

  it("still serves the stored bytes after a ranged request (original untouched)", async () => {
    const { baseUrl } = await start()
    const id = await upload(baseUrl, PNG_BYTES, "a.png", "image/png")

    const partial = await get(baseUrl, id, "bytes=0-1023")
    expect(partial.status).toBe(206)
    await partial.arrayBuffer()

    const full = await get(baseUrl, id)
    expect(full.status).toBe(200)
    expect(Buffer.from(await full.arrayBuffer()).equals(PNG_BYTES)).toBe(true)
  })

  // Sanity check the whole round-trip: id really is sha256 of the payload.
  it("serves content under a hash id computed from the uploaded bytes", async () => {
    const { baseUrl, root } = await start()
    const id = await upload(baseUrl, PNG_BYTES, "a.png", "image/png")

    expect(id).toBe(sha256(PNG_BYTES))
    const onDisk = await readFile(
      join(root, "originals", id.slice(0, 2), id.slice(2, 4), `${id}.png`),
    )
    expect(onDisk.equals(PNG_BYTES)).toBe(true)
  })

  it("serves a JIT-transformed variant (200) with the pipeline's headers and exact bytes", async () => {
    const payload = randomBytes(48)
    const transforms = {
      resolve: vi.fn(async () => ({
        headers: { "Content-Type": "image/webp", "Content-Length": String(payload.length) },
        stream: Readable.from([payload]),
      })),
    }
    const { baseUrl } = await start({ transforms })
    const id = await upload(baseUrl, PNG_BYTES, "a.png", "image/png")

    const res = await fetch(`${baseUrl}/media/${id}?w=300&fmt=webp`)

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/webp")
    expect(res.headers.get("content-length")).toBe(String(payload.length))
    expect(Buffer.from(await res.arrayBuffer()).equals(payload)).toBe(true)
    expect(transforms.resolve).toHaveBeenCalledTimes(1)
  })

  it("answers invalid transform options with 400 JSON and never consults the pipeline", async () => {
    const { baseUrl, transforms } = await start()
    const id = await upload(baseUrl, PNG_BYTES, "a.png", "image/png")

    const res = await fetch(`${baseUrl}/media/${id}?w=abc`)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: expect.stringContaining("invalid w") })
    expect(transforms.resolve).not.toHaveBeenCalled()
  })
})