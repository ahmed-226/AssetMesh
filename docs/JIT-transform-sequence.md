## 4. JIT transform sequence (M3)

`GET /media/{id}?w=300&h=200&q=80&fmt=webp` resolves a canonical cache key,
serves a hit, or coordinates **exactly one** generation job. The heavy lifting
happens in a worker thread; the main process only renames the result into the
cache and streams it.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant RT as GET /media/:id
    participant FV as FetchService
    participant TO as TransformOptions
    participant TS as TransformService
    participant DC as DiskCacheStore
    participant CS as CasObjectStore
    participant WP as WorkerPoolProcessor
    participant WK as sharp worker (piscina)

    C->>RT: ?w=300&fmt=webp (any of w/h/q/fmt present)
    RT->>FV: fetch(id, range, query)
    FV->>CS: open(id) returns path, size, extension, mimeType
    FV->>TO: parse(query, ALLOWED_FORMATS)
    alt any w/h/q/fmt invalid (0, 4097, abc, 1.5, q=0, fmt=exe)
        TO-->>FV: BadRequestError
        FV-->>C: 400 with error invalid
    else valid options
        Note over TO: fmt = opts.fmt ?? original extension
        FV->>TS: resolve(id, file, options)
        TS->>TS: key = id_w300_q80.webp (canonical, defaults resolved)
        TS->>DC: open(key) - single atomic probe, ENOENT reads as a miss
        alt cache hit
            DC-->>TS: stream + size
            TS-->>FV: Content-Type: image/webp, Content-Length: size (LRU touched)
            FV-->>C: 200 (stream piped, never buffered)
        else cache miss (ENOENT)
            TS->>TS: coalesce on Map key Promise
            Note over TS: concurrent identical requests await the SAME in-flight job
            TS->>WP: transform with originalPath, tmpPath, w, h, q, fmt
            WP->>WK: run on a worker thread
            WK->>WK: sharp(path) rotate (EXIF) resize(inside, no-enlarge) toFormat(q) toFile(tmp/uuid)
            alt not an image
                WK-->>TS: ok false, code NOT_IMAGE
                TS-->>C: 400 with error stored object is not a supported image
            else ok
                WK-->>TS: ok true, width, height, size
                TS->>DC: store(key, tmp/uuid) - atomic rename into cache/ab/cd/
                Note over DC,TS: nothing partial ever appears at the final path
                TS->>DC: open(key) returns stream
                alt variant GC-evicted between generation and open
                    Note over TS: regenerate ONCE (cache is disposable), then open again
                end
                TS-->>FV: 200 + Content-Type/Length
                FV-->>C: backpressured stream
            end
        end
    end
    Note over TS: map entry dropped in finally - failed jobs are NEVER cached
```

Error back-channels:

- **Queue overload** — if `pool.queueSize >= maxQueue` the worker pre-check
  refuses immediately: **503 + `Retry-After: 10`** instead of queueing forever.
- **Heavy requests don't stall the event loop** — CPU work runs only in worker
  threads, so a 21s 4K avif encode coexists with a 7ms plain download (measured).

Transform properties:

- **Canonical key** — segment order is fixed (`w, h, q`) and defaults are
  resolved (`q` defaults to 80), so `?w=300&fmt=webp` and
  `?fmt=webp&w=300&q=80` name the same file; cache hits beat re-encoding.
- **sharp confined to the worker** — `sharp.cache(false)` + `concurrency(1)`
  pin libvips; the pool size is the parallelism control (thread × worker would
  otherwise explode RAM).
- **Variant extension/mime** — output format is the requested `fmt` (validated
  against `ALLOWED_FORMATS`) or the original's sniffed extension; `Content-Type`
  follows the output format, never the original.
- **Cache is disposable** — originals stay the source of truth; a deleted
  variant is regenerated on the next request.