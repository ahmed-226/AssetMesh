import { once } from "node:events"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FetchService } from "../../src/application/fetch-service.js"
import { PurgeService } from "../../src/application/purge-service.js"
import type { TransformService } from "../../src/application/transform-service.js"
import { UploadService } from "../../src/application/upload-service.js"
import type { Config } from "../../src/config/config.js"
import { CacheKey } from "../../src/domain/cache-key.js"
import type { ObjectRepository, ReadableSource } from "../../src/domain/objects.js"
import { TransformOptions } from "../../src/domain/transform-options.js"
import { createApp } from "../../src/http/app.js"
import { DiskCacheStore } from "../../src/infrastructure/cache/disk-cache-store.js"
import { LruIndex } from "../../src/infrastructure/cache/lru-index.js"
import { CasObjectStore } from "../../src/infrastructure/storage/cas-object-store.js"

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex")

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(2048),
])

const VARIANT_BYTES = randomBytes(1024)

const servers: Server[] = []
const roots: string[] = []
const inflight = new Set<Promise<unknown>>()

interface Harness {
  baseUrl: string
  root: string
  cache: DiskCacheStore
  index: LruIndex
}

// Same wiring as main.ts / app.test.ts: real objects + cache + index behind the
// app, plus the pieces returned so tests can seed variants and inspect disk.
const start = async (): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "assetmesh-delete-"))
  roots.push(root)
  const tmpDir = join(root, "tmp")
  await mkdir(tmpDir, { recursive: true })
  const config: Config = {
    port: 0,
    storageDir: root,
    maxUploadSizeBytes: 1024 * 1024,
    cacheLimitBytes: 1024 * 1024,
    allowedFormats: ["png"],
    workerPoolSize: 1,
    gcIntervalMs: 60_000,
  }
  const underlying = new CasObjectStore(join(root, "originals"), tmpDir)
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
    delete: (id) => underlying.delete(id),
  }
  const uploads = new UploadService(repo, config.maxUploadSizeBytes)
  const fetches = new FetchService(repo, { resolve: vi.fn() } as unknown as TransformService, [
    "jpg",
    "png",
    "webp",
    "avif",
  ])
  const cache = new DiskCacheStore(join(root, "cache"))
  const index = new LruIndex(join(root, "cache", "index.json"))
  const purges = new PurgeService(repo, cache, index)
  const app = createApp(config, uploads, fetches, purges)
  const server = app.listen(0)
  servers.push(server)
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("expected a TCP port")
  return { baseUrl: `http://127.0.0.1:${address.port}`, root, cache, index }
}

const upload = async (baseUrl: string): Promise<string> => {
  const form = new FormData()
  form.append("file", new Blob([PNG_BYTES], { type: "image/png" }), "a.png")
  const res = await fetch(`${baseUrl}/api/v1/upload`, { method: "POST", body: form })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { id: string }
  return body.id
}

// Stages a small tmp file and publishes it as a cache variant for the id (the
// transform miss path minus the worker pool), recording it in the LRU index.
const seedVariant = async (
  cache: DiskCacheStore,
  index: LruIndex,
  id: string,
): Promise<CacheKey> => {
  const options = TransformOptions.parse({ w: "100" }, ["jpg", "png", "webp", "avif"])
  const key = CacheKey.create(id, options, "webp")
  const tmpPath = join(await mkdtemp(join(tmpdir(), "assetmesh-delete-tmp-")), randomUUID())
  await writeFile(tmpPath, VARIANT_BYTES)
  await cache.store(key, tmpPath)
  index.touch(key.basename, VARIANT_BYTES.length)
  return key
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

describe("DELETE /api/v1/media/:id", () => {
  it("returns 204 and removes the original and its cached variants from disk", async () => {
    const { baseUrl, root, cache, index } = await start()
    const id = await upload(baseUrl)
    expect(id).toBe(sha256(PNG_BYTES))
    const variant = await seedVariant(cache, index, id)
    expect(index.count).toBe(1)

    const res = await fetch(`${baseUrl}/api/v1/media/${id}`, { method: "DELETE" })

    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
    expect(await cache.exists(variant)).toBe(false)
    expect(index.count).toBe(0)
    expect(await readdir(join(root, "originals", id.slice(0, 2), id.slice(2, 4)))).toEqual([])
  })

  it("is idempotent: a second DELETE also returns 204", async () => {
    const { baseUrl } = await start()
    const id = await upload(baseUrl)

    const first = await fetch(`${baseUrl}/api/v1/media/${id}`, { method: "DELETE" })
    const second = await fetch(`${baseUrl}/api/v1/media/${id}`, { method: "DELETE" })

    expect(first.status).toBe(204)
    expect(second.status).toBe(204)
  })

  it("returns 400 for a malformed id", async () => {
    const { baseUrl } = await start()

    const res = await fetch(`${baseUrl}/api/v1/media/not-a-hash`, { method: "DELETE" })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: expect.stringContaining("invalid id") })
  })

  it("returns 204 for a well-formed id that was never uploaded", async () => {
    const { baseUrl } = await start()

    const res = await fetch(`${baseUrl}/api/v1/media/${"0".repeat(64)}`, { method: "DELETE" })

    expect(res.status).toBe(204)
  })
})