import type { Readable } from "node:stream"
import { validateHash } from "../domain/objects.js"
import type { ObjectRepository } from "../domain/objects.js"
import { parseRange } from "../domain/range.js"
import { TransformOptions } from "../domain/transform-options.js"
import type { TransformService } from "./transform-service.js"

export interface FetchResult {
  status: number
  headers: Record<string, string>
  stream: Readable | null
}

// Use-case orchestration only: gate the id, open the original blob, and shape
// the HTTP answer from the parsed Range. Transforms (M3) short-circuit to the
// JIT pipeline when the query carries any option; byte-ranges apply to originals.
// The stream is produced by the repository and piped verbatim by the http layer
// — nothing is buffered.
export class FetchService {
  constructor(
    private readonly objects: ObjectRepository,
    private readonly transforms: TransformService,
    private readonly allowedFormats: readonly string[],
  ) {}

  async fetch(
    id: string,
    rangeHeader: string | undefined,
    query: Record<string, string | undefined> = {},
  ): Promise<FetchResult> {
    validateHash(id)
    const file = await this.objects.open(id)
    const options = TransformOptions.parse(query, this.allowedFormats)

    if (options.hasOptions) {
      // A transform request serves the whole variant; Range is ignored for
      // generated output (originals only). Invalid options already threw 400
      // during parse.
      const { headers, stream } = await this.transforms.resolve(id, file, options)
      return { status: 200, headers, stream }
    }

    const range = parseRange(rangeHeader, file.size)

    if (range === "invalid") {
      return {
        status: 416,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Type": file.mimeType,
          "Content-Range": `bytes */${file.size}`,
        },
        stream: null,
      }
    }

    if (range === null) {
      return {
        status: 200,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Type": file.mimeType,
          "Content-Length": String(file.size),
        },
        stream: this.objects.read(file, null),
      }
    }

    return {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Type": file.mimeType,
        "Content-Range": `bytes ${range.start}-${range.end}/${file.size}`,
        "Content-Length": String(range.end - range.start + 1),
      },
      stream: this.objects.read(file, range),
    }
  }
}