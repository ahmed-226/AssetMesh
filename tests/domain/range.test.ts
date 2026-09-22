import { describe, expect, it } from "vitest"
import { parseRange } from "../../src/domain/range.js"

const SIZE = 4096

describe("parseRange", () => {
  it("returns null for an absent header", () => {
    expect(parseRange(undefined, SIZE)).toBeNull()
  })

  it("returns null for a multi-range request", () => {
    expect(parseRange("bytes=0-1,2-3", SIZE)).toBeNull()
  })

  it("parses an explicit start-end window", () => {
    expect(parseRange("bytes=0-1023", SIZE)).toEqual({ start: 0, end: 1023 })
    expect(parseRange("bytes=100-200", SIZE)).toEqual({ start: 100, end: 200 })
  })

  it("clamps the end to size-1", () => {
    expect(parseRange("bytes=0-999999", 100)).toEqual({ start: 0, end: 99 })
  })

  it("parses an open-ended range from offset to EOF", () => {
    expect(parseRange("bytes=1024-", SIZE)).toEqual({ start: 1024, end: SIZE - 1 })
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 })
  })

  it("parses a suffix range as the last N bytes", () => {
    expect(parseRange("bytes=-500", SIZE)).toEqual({ start: SIZE - 500, end: SIZE - 1 })
  })

  it("clamps a suffix longer than the file to the whole file", () => {
    expect(parseRange("bytes=-99999", 100)).toEqual({ start: 0, end: 99 })
  })

  it("returns a single-byte window for an exact start=end", () => {
    expect(parseRange("bytes=7-7", SIZE)).toEqual({ start: 7, end: 7 })
  })

  it("is case-insensitive on the unit", () => {
    expect(parseRange("Bytes=0-9", SIZE)).toEqual({ start: 0, end: 9 })
  })

  it.each([
    "bytes=abc",
    "bytes=",
    "bytes=-",
    "bytes=-0",
    "bytes=4096-", // start == size
    "bytes=999999999999-", // start well beyond size
    "bytes=100-99", // start > end
    "bytes=5-2",
  ])("rejects %j as 'invalid'", (header) => {
    expect(parseRange(header, SIZE)).toBe("invalid")
  })

  describe("zero-length file", () => {
    it("treats any range as 'invalid' (nothing to serve)", () => {
      expect(parseRange("bytes=0-0", 0)).toBe("invalid")
      expect(parseRange("bytes=0-", 0)).toBe("invalid")
      expect(parseRange("bytes=-5", 0)).toBe("invalid")
      expect(parseRange("bytes=-", 0)).toBe("invalid")
    })

    it("returns null for a header that is entirely malformed (no range to interpret)", () => {
      expect(parseRange("bytes=abc", 0)).toBeNull()
      expect(parseRange("bytes=-0", 0)).toBeNull()
    })
  })
})