## 1. Layered architecture

Layers point inward: `http → application → domain`, and `infrastructure`
implements the domain interfaces. `domain` never imports express/busboy/fs;
**`sharp` is imported in exactly one module (the worker)** — never the main
thread.

```mermaid
flowchart LR
    subgraph HTTP["http/ — Express 5"]
        UR["POST /api/v1/upload"]
        BB["busboy (streaming parser)"]
        MR["GET /media/:id"]
        DR["DELETE /api/v1/media/:id"]
        EM["error-mapper.ts"]
    end

    subgraph APP["application/"]
        US["UploadService"]
        FS["FetchService"]
        TS["TransformService"]
        PS["PurgeService"]
    end

    subgraph DOM["domain/"]
        POR["ObjectRepository (port)"]
        RNG["range.ts · parseRange"]
        TO["transform-options.ts"]
        CK["cache-key.ts"]
        ERR["AppError: 400 / 404 / 413 / 503"]
    end

    subgraph IMG["infrastructure/image/"]
        WP["WorkerPoolProcessor"]
        SW["sharp-worker.ts (piscina)"]
    end

    subgraph CST["infrastructure/"]
        HW["HashingWritable"]
        CS["CasObjectStore"]
        DCS["DiskCacheStore"]
        LI["LruIndex"]
        GC["GarbageCollector"]
        MG["magic.ts (byte sniffing)"]
    end

    UR --> BB
    BB --> US
    US --> POR
    POR --> CS
    CS --> HW
    HW --> MG

    MR --> FS
    FS --> POR
    FS --> RNG
    FS --> TO
    FS --> TS
    TS --> CK
    TS --> DCS
    TS -. touch .-> LI
    TS --> WP
    GC --> LI
    GC --> DCS
    WP -. spawns threads .-> SW
    SW -. reads path .-> CS

    DR --> PS
    PS --> POR
    PS -. removes .-> LI
    PS --> DCS

    US .-> ERR
    FS .-> ERR
    TS .-> ERR
    PS .-> ERR
    MR .-> EM
    DR .-> EM
    EM .-> ERR
```

- `FetchService` orchestrates: no options → original (range-aware); any option →
  `TransformService` → variant stream.
- `TransformService` validates nothing itself — `TransformOptions.parse` already
  threw 400 — it owns caching + coalescing + worker dispatch; on a hit and after
  storing a variant it refreshes `LruIndex` **in memory only** (the request path
  never pays for bookkeeping I/O).
- `GarbageCollector` ticks on an `unref()`'d interval: it persists the index,
  evicts least-recently-accessed variants down to 90% of `CACHE_LIMIT_GB`, then
  persists again. Bookkeeping only — it never touches originals or `tmp/`, and
  never prevents shutdown.
- `PurgeService` is pure orchestration (no fs): it unlinks the original via
  `ObjectRepository.delete` and removes every variant via `DiskCacheStore.listByPrefix`
  + `LruIndex`. Delete is idempotent — never a 404, only 204s.
- All error-to-HTTP translation is centralized in `error-mapper.ts`.