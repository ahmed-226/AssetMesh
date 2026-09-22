import { describe, expect, it } from "vitest"
import { BadRequestError } from "../../src/domain/errors.js"
import { mimeForFormat, TransformOptions } from "../../src/domain/transform-options.js"

const ALLOWED = ["jpg", "png", "webp", "avif"]

// Runs fn, returning a thrown value (or failing the test if fn didn't throw).
const capture = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error("expected the call to throw")
}

describe("TransformOptions.parse", () => {
  it("empty query → hasOptions false and no option fields set", () => {
    const options = TransformOptions.parse({}, ALLOWED)

    expect(options.hasOptions).toBe(false)
    expect(options.width).toBeUndefined()
    expect(options.height).toBeUndefined()
    expect(options.quality).toBeUndefined()
    expect(options.fmt).toBeUndefined()
  })

  it("parses w/h/fmt and defaults effective quality to 80", () => {
    const options = TransformOptions.parse({ w: "300", h: "200", fmt: "webp" }, ALLOWED)

    expect(options.width).toBe(300)
    expect(options.height).toBe(200)
    expect(options.fmt).toBe("webp")
    expect(options.quality).toBeUndefined()
    expect(options.effectiveQuality).toBe(80)
    expect(options.hasOptions).toBe(true)
  })

  it("q=50 → explicit quality 50 and effectiveQuality 50", () => {
    const options = TransformOptions.parse({ q: "50" }, ALLOWED)

    expect(options.quality).toBe(50)
    expect(options.effectiveQuality).toBe(50)
    expect(options.hasOptions).toBe(true)
  })

  it("lowercases and trims an uppercase fmt", () => {
    const options = TransformOptions.parse({ fmt: "  WEBP " }, ALLOWED)
    expect(options.fmt).toBe("webp")
  })

  it("only q present → hasOptions true", () => {
    expect(TransformOptions.parse({ q: "90" }, ALLOWED).hasOptions).toBe(true)
  })

  it("only fmt present → hasOptions true", () => {
    expect(TransformOptions.parse({ fmt: "png" }, ALLOWED).hasOptions).toBe(true)
  })

  it("accepts the boundary values w=4096 and q=100", () => {
    const options = TransformOptions.parse({ w: "4096", q: "100" }, ALLOWED)
    expect(options.width).toBe(4096)
    expect(options.quality).toBe(100)
  })

  const INVALID: ReadonlyArray<[string, Record<string, string>]> = [
    ["w=0", { w: "0" }],
    ["w=4097", { w: "4097" }],
    ["w=abc", { w: "abc" }],
    ["w=1.5", { w: "1.5" }],
    ["q=0", { q: "0" }],
    ["q=101", { q: "101" }],
    ["q=abc", { q: "abc" }],
  ]

  for (const [label, query] of INVALID) {
    it(`rejects ${label} with BadRequestError 400 and a message`, () => {
      const err = capture(() => TransformOptions.parse(query, ALLOWED))

      expect(err).toBeInstanceOf(BadRequestError)
      expect(err).toMatchObject({ statusCode: 400 })
      expect((err as Error).message).toContain("invalid")
    })
  }

  it("rejects a fmt outside the allowed set with BadRequestError 400", () => {
    const err = capture(() => TransformOptions.parse({ fmt: "tiff" }, ALLOWED))

    expect(err).toBeInstanceOf(BadRequestError)
    expect(err).toMatchObject({ statusCode: 400 })
    expect((err as Error).message).toContain("expected one of")
  })
})

describe("mimeForFormat", () => {
  it("maps known formats to their content types", () => {
    expect(mimeForFormat("jpg")).toBe("image/jpeg")
    expect(mimeForFormat("avif")).toBe("image/avif")
  })

  it("falls back to application/octet-stream for unknown formats", () => {
    expect(mimeForFormat("nope")).toBe("application/octet-stream")
  })
})