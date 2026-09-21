import os from "node:os"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../src/config/config.js"

const MB = 1024 * 1024
const GB = 1024 ** 3

const ENV_KEYS = [
  "PORT",
  "STORAGE_DIR",
  "MAX_UPLOAD_SIZE_MB",
  "CACHE_LIMIT_GB",
  "ALLOWED_FORMATS",
  "WORKER_POOL_SIZE",
  "GC_INTERVAL_MS",
] as const

const saved: Record<string, string | undefined> = {}

const cleanEnv = () => {
  for (const key of ENV_KEYS) delete process.env[key]
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  cleanEnv()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("loadConfig defaults", () => {
  it("uses documented defaults when no env vars are set", () => {
    const config = loadConfig()
    expect(config.port).toBe(3000)
    expect(config.storageDir).toBe("./data")
    expect(config.maxUploadSizeBytes).toBe(50 * MB)
    expect(config.cacheLimitBytes).toBe(5 * GB)
    expect(config.allowedFormats).toEqual(["jpg", "png", "webp", "avif"])
    expect(config.workerPoolSize).toBe(os.availableParallelism())
    expect(config.gcIntervalMs).toBe(5 * 60 * 1000)
  })
})

describe("PORT", () => {
  it("parses a valid port", () => {
    process.env.PORT = "4010"
    expect(loadConfig().port).toBe(4010)
  })

  it("rejects non-numeric ports", () => {
    process.env.PORT = "abc"
    expect(() => loadConfig()).toThrow(/PORT/)
  })

  it("rejects ports outside 1..65535", () => {
    process.env.PORT = "70000"
    expect(() => loadConfig()).toThrow(/PORT/)
    process.env.PORT = "0"
    expect(() => loadConfig()).toThrow(/PORT/)
  })
})

describe("STORAGE_DIR", () => {
  it("accepts an explicit directory", () => {
    process.env.STORAGE_DIR = "/var/data"
    expect(loadConfig().storageDir).toBe("/var/data")
  })

  it("falls back to ./data for a whitespace-only value", () => {
    process.env.STORAGE_DIR = "   "
    expect(loadConfig().storageDir).toBe("./data")
  })
})

describe("MAX_UPLOAD_SIZE_MB", () => {
  it("converts MB to bytes", () => {
    process.env.MAX_UPLOAD_SIZE_MB = "1"
    expect(loadConfig().maxUploadSizeBytes).toBe(1 * MB)
  })

  it("accepts decimals", () => {
    process.env.MAX_UPLOAD_SIZE_MB = "2.5"
    expect(loadConfig().maxUploadSizeBytes).toBe(2.5 * MB)
  })

  it("allows zero", () => {
    process.env.MAX_UPLOAD_SIZE_MB = "0"
    expect(loadConfig().maxUploadSizeBytes).toBe(0)
  })

  it("rejects non-numeric values", () => {
    process.env.MAX_UPLOAD_SIZE_MB = "abc"
    expect(() => loadConfig()).toThrow(/MAX_UPLOAD_SIZE_MB/)
  })

  it("rejects negative values", () => {
    process.env.MAX_UPLOAD_SIZE_MB = "-1"
    expect(() => loadConfig()).toThrow(/MAX_UPLOAD_SIZE_MB/)
  })
})

describe("CACHE_LIMIT_GB", () => {
  it("accepts decimal limits (LRU testability)", () => {
    process.env.CACHE_LIMIT_GB = "0.001"
    expect(loadConfig().cacheLimitBytes).toBeCloseTo(0.001 * GB)
  })

  it("converts to bytes", () => {
    process.env.CACHE_LIMIT_GB = "2"
    expect(loadConfig().cacheLimitBytes).toBe(2 * GB)
  })

  it("rejects non-numeric values", () => {
    process.env.CACHE_LIMIT_GB = "abc"
    expect(() => loadConfig()).toThrow(/CACHE_LIMIT_GB/)
  })

  it("rejects negative values", () => {
    process.env.CACHE_LIMIT_GB = "-0.5"
    expect(() => loadConfig()).toThrow(/CACHE_LIMIT_GB/)
  })
})

describe("ALLOWED_FORMATS", () => {
  it("lowercases, trims, and drops empty entries", () => {
    process.env.ALLOWED_FORMATS = "WEBP, png ,avif"
    expect(loadConfig().allowedFormats).toEqual(["webp", "png", "avif"])
  })

  it("keeps mixed sparsity but only non-empty entries", () => {
    process.env.ALLOWED_FORMATS = "jpg,,webp"
    expect(loadConfig().allowedFormats).toEqual(["jpg", "webp"])
  })

  it("rejects a resultingly-empty list", () => {
    process.env.ALLOWED_FORMATS = ",,,"
    expect(() => loadConfig()).toThrow(/ALLOWED_FORMATS/)
  })
})

describe("WORKER_POOL_SIZE", () => {
  it("defaults to available parallelism", () => {
    expect(loadConfig().workerPoolSize).toBe(os.availableParallelism())
  })

  it("parses an explicit positive integer", () => {
    process.env.WORKER_POOL_SIZE = "2"
    expect(loadConfig().workerPoolSize).toBe(2)
  })

  it("rejects zero or negative", () => {
    process.env.WORKER_POOL_SIZE = "0"
    expect(() => loadConfig()).toThrow(/WORKER_POOL_SIZE/)
  })

  it("rejects non-numeric values", () => {
    process.env.WORKER_POOL_SIZE = "many"
    expect(() => loadConfig()).toThrow(/WORKER_POOL_SIZE/)
  })
})

describe("GC_INTERVAL_MS", () => {
  it("parses an explicit interval", () => {
    process.env.GC_INTERVAL_MS = "1000"
    expect(loadConfig().gcIntervalMs).toBe(1000)
  })

  it("rejects non-numeric values", () => {
    process.env.GC_INTERVAL_MS = "soon"
    expect(() => loadConfig()).toThrow(/GC_INTERVAL_MS/)
  })
})