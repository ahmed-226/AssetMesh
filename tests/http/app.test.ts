import { once } from "node:events"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { UploadService } from "../../src/application/upload-service.js"
import type { Config } from "../../src/config/config.js"
import type { ObjectRepository, ReadableSource } from "../../src/domain/objects.js"
import { createApp } from "../../src/http/app.js"
import { CasObjectStore } from "../../src/infrastructure/storage/cas-object-store.js"

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex")

const listFiles = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir)
    return entries.sort()
  } catch {
    return []
  }
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(48),
])

// The current upload route can respond before an in-flight store() finishes
// (leaves the promise dangling). Track every store() so teardown can wait for
// the stray work before deleting the temp root.
const servers: Server[] = []
const roots: string[] = []
const inflight = new Set<Promise<unknown>>()

const start = async (opts: { maxBytes?: number; repo?: ObjectRepository } = {}): Promise<{
  baseUrl: string
  root: string
}> => {
  const root = await mkdtemp(join(tmpdir(), "assetmesh-http-"))
  roots.push(root)
  // Mirrors main.ts wiring: tmp/ lives next to originals/ (same fs for rename).
  await mkdir(join(root, "tmp"), { recursive: true })
  const config: Config = {
    port: 0,
    storageDir: root,
    maxUploadSizeBytes: opts.maxBytes ?? 1024,
    cacheLimitBytes: 1024 * 1024,
    allowedFormats: ["png"],
    workerPoolSize: 1,
    gcIntervalMs: 60_000,
  }
  const underlying = opts.repo ?? new CasObjectStore(join(root, "originals"), join(root, "tmp"))
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
  }
  const uploads = new UploadService(repo, config.maxUploadSizeBytes)
  const app = createApp(config, uploads)
  const server = app.listen(0)
  servers.push(server)
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("expected a TCP port")
  return { baseUrl: `http://127.0.0.1:${address.port}`, root }
}

const uploadFile = (baseUrl: string, bytes: Buffer, filename = "a.png"): Promise<Response> => {
  const form = new FormData()
  form.append("file", new Blob([bytes], { type: "image/png" }), filename)
  return fetch(`${baseUrl}/api/v1/upload`, { method: "POST", body: form })
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  // Let any store() calls the route left dangling finish before removing the
  // root, otherwise their rename/rm races the cleanup.
  for (let i = 0; i < 200 && inflight.size > 0; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe("GET /health", () => {
  it("reports ok", async () => {
    const { baseUrl } = await start()
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ status: "ok" })
  })
})

describe("POST /api/v1/upload", () => {
  it("stores a multipart file and returns 200 { id, url }", async () => {
    const { baseUrl, root } = await start({ maxBytes: 1024 })

    const res = await uploadFile(baseUrl, PNG_BYTES)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; url: string }
    expect(body.id).toBe(sha256(PNG_BYTES))
    expect(body.url).toBe(`/media/${body.id}`)

    const stored = await readFile(
      join(root, "originals", body.id.slice(0, 2), body.id.slice(2, 4), `${body.id}.png`),
    )
    expect(stored.equals(PNG_BYTES)).toBe(true)
    expect(await listFiles(join(root, "tmp"))).toEqual([])
  })

  it("re-uploading identical bytes returns the same id and creates no new file", async () => {
    const { baseUrl, root } = await start({ maxBytes: 1024 })

    const firstRes = await uploadFile(baseUrl, PNG_BYTES)
    expect(firstRes.status).toBe(200)
    const first = (await firstRes.json()) as { id: string }
    const secondRes = await uploadFile(baseUrl, PNG_BYTES)
    expect(secondRes.status).toBe(200)
    const second = (await secondRes.json()) as { id: string }

    expect(second.id).toBe(first.id)
    expect(await listFiles(join(root, "originals"))).toEqual([first.id.slice(0, 2)])
    const shard = join(root, "originals", first.id.slice(0, 2), first.id.slice(2, 4))
    expect(await listFiles(shard)).toEqual([`${first.id}.png`])
  })

  it("rejects a request without a file part with 400", async () => {
    const { baseUrl } = await start()

    const form = new FormData()
    form.append("unrelated", "not a file")
    const res = await fetch(`${baseUrl}/api/v1/upload`, { method: "POST", body: form })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: "multipart field 'file' is required" })
  })

  it("rejects an empty multipart body with 400", async () => {
    const { baseUrl } = await start()

    const res = await fetch(`${baseUrl}/api/v1/upload`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=assetmesh" },
      body: "--assetmesh--\r\n",
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: "multipart field 'file' is required" })
  })

  it("rejects two file parts with 400", async () => {
    const { baseUrl } = await start()

    const form = new FormData()
    form.append("file", new Blob([PNG_BYTES], { type: "image/png" }), "a.png")
    form.append("file", new Blob([randomBytes(64)], { type: "image/png" }), "b.png")
    const res = await fetch(`${baseUrl}/api/v1/upload`, { method: "POST", body: form })

    expect(res.status).toBe(400)
  })

  it("rejects an oversize payload with 413 (never 500) and leaves no tmp file", async () => {
    const { baseUrl, root } = await start({ maxBytes: 1024 })

    const res = await uploadFile(baseUrl, randomBytes(64 * 1024), "big.png")

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toEqual({ error: "Payload too large" })
    expect(await listFiles(join(root, "tmp"))).toEqual([])
    expect(await listFiles(join(root, "originals"))).toEqual([])
  })

  it("maps unknown repository errors to 500", async () => {
    const exploding: ObjectRepository = {
      async store(source: ReadableSource, _maxBytes: number) {
        // Drain the part so busboy can finish parsing — otherwise the fake's
        // early throw would stall the request and 'close' would never fire.
        source.resume()
        throw new Error("disk on fire")
      },
    }
    const { baseUrl } = await start({ repo: exploding })
    const res = await uploadFile(baseUrl, PNG_BYTES)
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: "internal server error" })
  })

  it("cleans up the temp file when the client aborts mid-upload", async () => {
    const { root, baseUrl } = await start({ maxBytes: 1024 * 1024 })
    const tmpDir = join(root, "tmp")
    const payload = randomBytes(1_000_000)
    const boundary = "----abortboundary"
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="a.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`

    const { request } = await import("node:http")
    const req = request(`${baseUrl}/api/v1/upload`, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "connection": "close",
      },
    })
    req.write(head)
    req.write(payload.subarray(0, payload.length / 2))
    // Give the server a moment to open the temp file, then sever the socket.
    await new Promise((r) => setTimeout(r, 50))
    req.destroy()

    // The stream-reviewer bug: a hard abort previously left the partial file in
    // tmp/ forever. Now busboy is destroyed via pipeline(req, bb) so the store
    // removes it. Poll briefly — the client is already gone, no response comes.
    let leftover = (await readdir(tmpDir).catch(() => [])).length
    for (let i = 0; i < 100 && leftover > 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
      leftover = (await readdir(tmpDir).catch(() => [])).length
    }
    expect(leftover).toBe(0)
  })
})