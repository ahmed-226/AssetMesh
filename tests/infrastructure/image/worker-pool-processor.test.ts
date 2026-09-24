import { beforeEach, describe, expect, it, vi } from "vitest"
import { ServiceUnavailableError } from "../../../src/domain/errors.js"
import type { TransformRequest } from "../../../src/infrastructure/image/sharp-worker.js"
import { WorkerPoolProcessor } from "../../../src/infrastructure/image/worker-pool-processor.js"

// Piscina is swapped for a scripted double at the module boundary so no real
// worker threads (and no sharp/libvips) ever spawn in this unit test. Every
// instance the processor constructs is recorded so a test can script queueSize
// and run() before calling transform().
const { instances, FakePiscina } = vi.hoisted(() => {
  const instances: FakePiscina[] = []
  class FakePiscina {
    queueSize = 0
    run = vi.fn()
    destroy = vi.fn()
    constructor() {
      instances.push(this)
    }
  }
  return { instances, FakePiscina }
})

vi.mock("piscina", () => ({ Piscina: FakePiscina }))

const REQUEST: TransformRequest = {
  originalPath: "originals/ab/ab/original.png",
  tmpPath: "tmp/test-job",
  width: 300,
  height: 200,
  quality: 80,
  fmt: "webp",
}

describe("WorkerPoolProcessor", () => {
  beforeEach(() => {
    instances.length = 0
  })

  it("maps a full-queue rejection from pool.run() to ServiceUnavailableError (503) instead of a 500", async () => {
    const processor = new WorkerPoolProcessor({ maxThreads: 1, maxQueue: 2 })
    const pool = instances[0] as FakePiscina
    // piscina rejects at admission when the queue filled between our pre-check
    // and run() — the catch keys off the real 5.3.2 message ("Task queue is at
    // limit", from node_modules/piscina/dist/errors.js).
    pool.run.mockRejectedValue(new Error("Task queue is at limit"))

    await expect(processor.transform(REQUEST)).rejects.toBeInstanceOf(ServiceUnavailableError)
    await expect(processor.transform(REQUEST)).rejects.toMatchObject({
      statusCode: 503,
      message: "image worker queue is full",
    })
  })

  it("refuses with ServiceUnavailableError (503) before pool.run() when the queue is already full", async () => {
    const processor = new WorkerPoolProcessor({ maxThreads: 1, maxQueue: 2 })
    const pool = instances[0] as FakePiscina
    pool.queueSize = 2 // >= maxQueue → the pre-check refuses the submit

    await expect(processor.transform(REQUEST)).rejects.toBeInstanceOf(ServiceUnavailableError)
    await expect(processor.transform(REQUEST)).rejects.toMatchObject({
      statusCode: 503,
      message: "image worker queue is full",
    })
    expect(pool.run).not.toHaveBeenCalled()
  })
})