import { describe, expect, it } from "vitest"
import { BadRequestError } from "../../src/domain/errors.js"
import { validateHash } from "../../src/domain/objects.js"

const HASH = "ab".repeat(32) // 64 lowercase hex chars

describe("validateHash", () => {
  it("accepts a 64-char lowercase hex id and returns it unchanged", () => {
    expect(validateHash(HASH)).toBe(HASH)
  })

  it.each([
    ["", "empty id"],
    ["abc", "too short"],
    [HASH + "ab", "too long"],
    [HASH.toUpperCase(), "uppercase hex (rejected — must be lowercase)"],
    ["z".repeat(64), "non-hex character"],
    [HASH.replace("a", "g"), "non-hex within a 64-char string"],
  ])("rejects %j (%s) with a 400 BadRequestError", (id) => {
    let thrown: unknown
    try {
      validateHash(id)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BadRequestError)
    expect((thrown as BadRequestError).statusCode).toBe(400)
  })
})