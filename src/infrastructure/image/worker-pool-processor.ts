import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Piscina } from "piscina"
import { ServiceUnavailableError } from "../../domain/errors.js"
import type { TransformOutcome, TransformRequest } from "./sharp-worker.js"

// The worker module ships as .ts in src/ and compiles to .js in dist/. Node's
// floor here is v20, which can't execute .ts, so dev/test spawns the pool with
// the tsx loader injected via execArgv; the compiled build needs no loader.
const resolveWorkerPath = (): string => {
  const dir = fileURLToPath(new URL(".", import.meta.url))
  const js = `${dir}sharp-worker.js`
  return existsSync(js) ? js : `${dir}sharp-worker.ts`
}

export interface WorkerPoolOptions {
  maxThreads: number
  maxQueue: number
}

// Async front for the piscina thread pool. All CPU-bound sharp work happens in
// worker threads, never the main thread. The queue is bounded: instead of
// queueing forever (unbounded latency + memory), a full queue is refused with
// 503 + Retry-After so the client backs off.
export class WorkerPoolProcessor {
  private readonly pool: Piscina
  private readonly maxQueue: number

  constructor(opts: WorkerPoolOptions) {
    this.maxQueue = opts.maxQueue
    const filename = resolveWorkerPath()
    const execArgv = filename.endsWith(".ts") ? ["--import", "tsx/esm"] : undefined
    this.pool = new Piscina({ filename, maxThreads: opts.maxThreads, maxQueue: opts.maxQueue, execArgv })
  }

  async transform(request: TransformRequest): Promise<TransformOutcome> {
    if (this.pool.queueSize >= this.maxQueue) {
      throw new ServiceUnavailableError("image worker queue is full")
    }
    return (await this.pool.run(request)) as TransformOutcome
  }

  async close(): Promise<void> {
    await this.pool.destroy()
  }
}