import { describe, expect, it } from "vitest"
import { CacheKey } from "../../src/domain/cache-key.js"
import { TransformOptions } from "../../src/domain/transform-options.js"

const ALLOWED = ["jpg", "png", "webp", "avif"]
const ID = "ab".repeat(32)

// Builds a key over an explicit fallback fmt (what TransformService would pass
// from file.extension when the query carries no fmt).
const key = (query: Record<string, string>, fallbackFmt = "webp"): CacheKey =>
  CacheKey.create(ID, TransformOptions.parse(query, ALLOWED), fallbackFmt)

describe("CacheKey.create", () => {
  it("canonicalizes ?w=300&fmt=webp to <id>_w300_q80.webp, order-insensitively", () => {
    const a = key({ w: "300", fmt: "webp" })
    const b = key({ fmt: "webp", w: "300", q: "80" })

    expect(a.basename).toBe(`${ID}_w300_q80.webp`)
    expect(b.basename).toBe(a.basename)
  })

  it("omits absent segments: h only → <id>_h200_q80.webp", () => {
    expect(key({ h: "200", fmt: "webp" }).basename).toBe(`${ID}_h200_q80.webp`)
  })

  it("orders segments w, h, q: <id>_w300_h200_q50.webp", () => {
    expect(key({ w: "300", h: "200", q: "50", fmt: "webp" }).basename).toBe(
      `${ID}_w300_h200_q50.webp`,
    )
  })

  it("treats an explicit q=80 as identical to an absent q (q is always present)", () => {
    expect(key({ w: "300", fmt: "webp", q: "80" }).basename).toBe(
      key({ w: "300", fmt: "webp" }).basename,
    )
  })

  it("mirrors the id shard as the cache dir (ab/ab for an abab… id)", () => {
    expect(key({}).dir).toBe(`${ID.slice(0, 2)}/${ID.slice(2, 4)}`)
  })

  it("falls back to the file.extension for the suffix when fmt is absent", () => {
    expect(key({ w: "300" }, "jpg").basename).toBe(`${ID}_w300_q80.jpg`)
  })
})