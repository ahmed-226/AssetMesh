import "dotenv/config"
import os from "node:os"

// Single source of truth for runtime configuration. Every value is validated
// here so a typo in an env var fails loudly at boot instead of mid-request.

export interface Config {
  port: number
  storageDir: string
  maxUploadSizeBytes: number
  cacheLimitBytes: number
  allowedFormats: readonly string[]
  workerPoolSize: number
  gcIntervalMs: number
}

const MB = 1024 * 1024
const GB = 1024 ** 3

const readNumber = (
  name: string,
  opts: { fallback: number; min: number; max?: number; choices?: readonly number[] },
): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return opts.fallback
  const value = Number(raw)
  const valid =
    Number.isFinite(value) &&
    value >= opts.min &&
    (opts.max === undefined || value <= opts.max) &&
    (opts.choices === undefined || opts.choices.includes(value))
  if (!valid) {
    throw new Error(
      `Invalid ${name}=${JSON.stringify(raw)} — expected a number` +
        ` >= ${opts.min}${opts.max !== undefined ? ` and <= ${opts.max}` : ""}`,
    )
  }
  return value
}

const readDecimal = (name: string, fallback: number, warning: string): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}=${JSON.stringify(raw)} — expected a non-negative number`)
  }
  if (value === 0) console.warn(warning)
  return value
}

const readFormats = (): readonly string[] => {
  const raw = process.env.ALLOWED_FORMATS
  if (raw === undefined || raw.trim() === "") return ["jpg", "png", "webp", "avif"]
  const formats = raw
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .filter((f) => f.length > 0)
  if (formats.length === 0) {
    throw new Error("Invalid ALLOWED_FORMATS — expected a comma-separated list")
  }
  return formats
}

export const loadConfig = (): Config => {
  const port = readNumber("PORT", { fallback: 3000, min: 1, max: 65535 })
  const maxUploadSizeMb = readDecimal(
    "MAX_UPLOAD_SIZE_MB",
    50,
    "MAX_UPLOAD_SIZE_MB=0 disables the upload size limit",
  )
  const cacheLimitGb = readDecimal(
    "CACHE_LIMIT_GB",
    5,
    "CACHE_LIMIT_GB=0 disables cache eviction",
  )
  const gcIntervalMs = readNumber("GC_INTERVAL_MS", { fallback: 5 * 60 * 1000, min: 1 })
  const workerPoolSize = readNumber("WORKER_POOL_SIZE", {
    fallback: os.availableParallelism(),
    min: 1,
  })

  return {
    port,
    storageDir: (process.env.STORAGE_DIR ?? "./data").trim() || "./data",
    maxUploadSizeBytes: maxUploadSizeMb * MB,
    cacheLimitBytes: cacheLimitGb * GB,
    allowedFormats: readFormats(),
    workerPoolSize,
    gcIntervalMs,
  }
}