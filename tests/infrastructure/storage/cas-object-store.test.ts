import { createHash, randomBytes } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ReadableSource } from "../../../src/domain/objects.js"
import { CasObjectStore } from "../../../src/infrastructure/storage/cas-object-store.js"

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex")

// Every file below the given dir, deepest path first (sorted for determinism).
const listFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return // dir does not exist → nothing stored
    }
    for (const entry of entries) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) await walk(path)
      else {
        out.push(path.replaceAll("\\", "/"))
      }
    }
  }
  await walk(dir)
  return out.sort()
}

const truncatableSource = (chunks: Buffer[]): ReadableSource =>
  Object.assign(Readable.from(chunks), { truncated: false }) as ReadableSource

const FIXTURES: ReadonlyArray<{ name: string; bytes: Buffer; extension: string; mime: string }> = [
  {
    name: "jpeg",
    bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), randomBytes(32)]),
    extension: "jpg",
    mime: "image/jpeg",
  },
  {
    name: "png",
    bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(32)]),
    extension: "png",
    mime: "image/png",
  },
  {
    name: "webp",
    bytes: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), randomBytes(32)]),
    extension: "webp",
    mime: "image/webp",
  },
  {
    name: "gif",
    bytes: Buffer.concat([Buffer.from("GIF89a"), randomBytes(32)]),
    extension: "gif",
    mime: "image/gif",
  },
  {
    name: "avif",
    bytes: Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif"), randomBytes(32)]),
    extension: "avif",
    mime: "image/avif",
  },
  {
    name: "bin",
    bytes: Buffer.from("hello world — this is definitely not an image!!"),
    extension: "bin",
    mime: "application/octet-stream",
  },
]

describe("CasObjectStore", () => {
  let root: string
  let originalsDir: string
  let tmpDir: string
  let store: CasObjectStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "assetmesh-cas-"))
    originalsDir = join(root, "originals")
    tmpDir = join(root, "tmp")
    // Mirrors main.ts wiring: tmp/ is created at boot, side by side with originals.
    await mkdir(tmpDir, { recursive: true })
    store = new CasObjectStore(originalsDir, tmpDir)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("stores bytes under originals/ab/cd/<sha256>.<ext> and leaves tmp empty", async () => {
    const bytes = FIXTURES.find((f) => f.name === "png")!.bytes
    const id = sha256(bytes)

    const stored = await store.store(truncatableSource([bytes]), 0)

    expect(stored.id).toBe(id)
    expect(stored.extension).toBe("png")
    expect(stored.mimeType).toBe("image/png")
    expect(stored.size).toBe(bytes.length)
    expect(await listFiles(tmpDir)).toEqual([])

    const finalPath = join(originalsDir, id.slice(0, 2), id.slice(2, 4), `${id}.png`)
    expect((await readFile(finalPath)).equals(bytes)).toBe(true)
  })

  it("places different contents at their own id-derived shard paths", async () => {
    const tail = randomBytes(48)
    const bytesA = Buffer.concat([Buffer.from("GIF89a"), tail])
    const bytesB = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(48, 0x42)])

    const a = await store.store(truncatableSource([bytesA]), 0)
    const b = await store.store(truncatableSource([bytesB]), 0)

    expect(a.id).not.toBe(b.id)
    const expectedPaths = [a, b]
      .map(
        (s) =>
          join(originalsDir, s.id.slice(0, 2), s.id.slice(2, 4), `${s.id}.gif`).replaceAll("\\", "/"),
      )
      .sort()
    expect(await listFiles(originalsDir)).toEqual(expectedPaths)
  })

  for (const f of FIXTURES) {
    it(`sniffs ${f.name} → .${f.extension} (${f.mime}) from magic bytes`, async () => {
      const stored = await store.store(truncatableSource([f.bytes]), 0)
      expect(stored.extension).toBe(f.extension)
      expect(stored.mimeType).toBe(f.mime)
      const finalPath = join(originalsDir, stored.id.slice(0, 2), stored.id.slice(2, 4), `${stored.id}.${f.extension}`)
      try {
        await access(finalPath)
      } catch {
        throw new Error(`expected stored file at ${finalPath}`)
      }
    })
  }

  it("dedups: same bytes → same id, no second file, tmp cleaned up", async () => {
    const bytes = randomBytes(4096)
    const id = sha256(bytes)

    const first = await store.store(truncatableSource([bytes]), 0)
    const second = await store.store(truncatableSource([bytes]), 0)

    expect(first.id).toBe(id)
    expect(second.id).toBe(first.id)
    expect(await listFiles(originalsDir)).toHaveLength(1)
    expect(await listFiles(tmpDir)).toEqual([])
  })

  it("dedup returns the stored metadata when the file already exists", async () => {
    const bytes = randomBytes(256)
    const first = await store.store(truncatableSource([bytes]), 0)
    const second = await store.store(truncatableSource([bytes]), 0)
    expect(second.extension).toBe("bin")
    expect(second.mimeType).toBe("application/octet-stream")
    expect(second.size).toBe(bytes.length)
    expect(second.id).toBe(first.id)
  })

  it("rejects a truncated source with 413 and leaves no files behind", async () => {
    const source = truncatableSource([randomBytes(512)])
    source.truncated = true

    await expect(store.store(source, 0)).rejects.toMatchObject({ statusCode: 413 })
    expect(await listFiles(tmpDir)).toEqual([])
    expect(await listFiles(originalsDir)).toEqual([])
  })

  it("rejects mid-stream oversize with 413 and leaves tmp + originals empty", async () => {
    await expect(
      store.store(truncatableSource([randomBytes(4096)]), 128),
    ).rejects.toMatchObject({ statusCode: 413 })
    expect(await listFiles(tmpDir)).toEqual([])
    expect(await listFiles(originalsDir)).toEqual([])
  })

  it("accepts a stream that exactly matches maxBytes", async () => {
    const bytes = Buffer.alloc(128, 7)
    const stored = await store.store(truncatableSource([bytes]), 128)
    expect(stored.id).toBe(sha256(bytes))
    expect(await listFiles(originalsDir)).toHaveLength(1)
  })

  it("treats maxBytes 0 as no cap", async () => {
    const bytes = randomBytes(2 * 1024 * 1024)
    const stored = await store.store(truncatableSource([bytes]), 0)
    expect(stored.id).toBe(sha256(bytes))
    expect(stored.size).toBe(bytes.length)
    expect(await listFiles(originalsDir)).toHaveLength(1)
  })

  it("handles an empty stream (empty-file upload)", async () => {
    const stored = await store.store(truncatableSource([]), 0)
    expect(stored.id).toBe(sha256(Buffer.alloc(0)))
    expect(stored.extension).toBe("bin")
    expect(stored.mimeType).toBe("application/octet-stream")
    expect(stored.size).toBe(0)
    expect(await listFiles(tmpDir)).toEqual([])
  })
})