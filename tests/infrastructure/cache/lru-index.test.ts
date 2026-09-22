import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { LruIndex } from "../../../src/infrastructure/cache/lru-index.js"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("LruIndex", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "assetmesh-lru-"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("evictOldest returns the sole touched entry with its size, then undefined when empty", () => {
    const index = new LruIndex(join(root, "index.json"))
    index.touch("a", 1000)

    const evicted = index.evictOldest()
    expect(evicted).toEqual({ key: "a", size: 1000, lastAccessedAt: expect.any(Number) })

    expect(index.count).toBe(0)
    expect(index.evictOldest()).toBeUndefined()
  })

  it("refresh keeps an entry most-recently-accessed; evictOldest picks the least recent", async () => {
    const index = new LruIndex(join(root, "index.json"))
    index.touch("a", 1000) // t0
    await sleep(5)
    index.touch("b", 2000) // t1
    await sleep(5)
    index.touch("a", 1000) // t2 → a refreshed, now most recent

    expect(index.count).toBe(2)
    expect(index.totalSize).toBe(3000)

    const evicted = index.evictOldest()
    expect(evicted?.key).toBe("b") // touched only at t1 → least recent
    expect(evicted?.size).toBe(2000)
    expect(index.totalSize).toBe(1000)

    index.remove("a")
    expect(index.count).toBe(0)
    expect(index.totalSize).toBe(0)
  })

  it("touch refreshes lastAccessedAt without duplicating the entry", async () => {
    const index = new LruIndex(join(root, "index.json"))
    index.touch("a", 100)
    const first = index.lastAccessedAt("a")
    await sleep(5)
    index.touch("a", 100)
    const refreshed = index.lastAccessedAt("a")

    expect(refreshed).toBeGreaterThanOrEqual(first!)
    expect(index.count).toBe(1)
    expect(index.totalSize).toBe(100)
  })

  it("save → load round-trips entries with sizes and timestamps intact", async () => {
    const index = new LruIndex(join(root, "index.json"))
    index.touch("a", 1000)
    await sleep(5)
    index.touch("b", 2000)
    await index.save()

    const loaded = new LruIndex(join(root, "index.json"))
    await loaded.load()

    expect(loaded.count).toBe(2)
    expect(loaded.totalSize).toBe(3000)
    expect(loaded.lastAccessedAt("a")).toBe(index.lastAccessedAt("a"))
    expect(loaded.lastAccessedAt("b")).toBe(index.lastAccessedAt("b"))
    expect(loaded.evictOldest()?.key).toBe("a") // preserved LRU order
  })

  it("load() throws when index.json is missing", async () => {
    const index = new LruIndex(join(root, "missing.json"))
    await expect(index.load()).rejects.toThrow()
  })

  it("load() throws when index.json is not valid JSON", async () => {
    await writeFile(join(root, "index.json"), "not json", "utf8")
    const index = new LruIndex(join(root, "index.json"))
    await expect(index.load()).rejects.toThrow()
  })

  it("load() throws when an entry is malformed", async () => {
    await writeFile(
      join(root, "index.json"),
      JSON.stringify({ version: 1, entries: { k: "bad" } }),
      "utf8",
    )
    const index = new LruIndex(join(root, "index.json"))
    await expect(index.load()).rejects.toThrow()
  })

  it("rebuild seeds entries from a disk walk; lowest mtime evicts first", () => {
    const index = new LruIndex(join(root, "index.json"))
    index.rebuild([
      { basename: "a", size: 5, mtimeMs: 100 },
      { basename: "b", size: 7, mtimeMs: 200 },
    ])

    expect(index.count).toBe(2)
    expect(index.totalSize).toBe(12)
    const evicted = index.evictOldest()
    expect(evicted).toEqual({ key: "a", size: 5, lastAccessedAt: 100 })
  })

  it("save() creates missing dirs and leaves no *.tmp artifacts behind", async () => {
    const dir = join(root, "nested", "index-dir")
    const index = new LruIndex(join(dir, "index.json"))
    index.touch("a", 1)

    await index.save()
    await index.save() // second save renames over the existing file

    expect(await readdir(dir)).toEqual(["index.json"])
  })
})