## 5. LRU bookkeeping + garbage collection (M4)

The variant cache is bounded by `CACHE_LIMIT_GB`. `LruIndex` keeps
`basename → { size, lastAccessedAt }` in memory; the `GarbageCollector` ticks
every `GC_INTERVAL_MS` and evicts the least-recently-used files until the index
sums to ≤ 90% of the limit.

```mermaid
sequenceDiagram
    autonumber
    participant RQ as Request GET /media/:id?w=
    participant TS as TransformService
    participant LI as LruIndex (memory)
    participant DC as DiskCacheStore
    participant GC as GarbageCollector
    participant IDX as cache/index.json

    Note over RQ,LI: REQUEST PATH - in-memory touches only, no bookkeeping I/O
    TS->>DC: open(key) - single atomic probe, ENOENT = miss (M8)
    alt cache hit
        TS->>LI: touch(key, size) - marks most-recent
    else cache miss
        TS->>DC: store(key, tmp) - atomic rename into cache/ab/cd/
        TS->>LI: touch(key, size)
    end

    Note over LI,IDX: GC TICK - every GC_INTERVAL_MS
    GC->>GC: running-guard, skip if the previous tick is still working
    loop while index.totalSize > 90% times CACHE_LIMIT_GB
        GC->>LI: peekOldest() - view only, nothing removed yet
        GC->>DC: remove(key) - unlink FIRST
        GC->>LI: remove(key) - dropped from the index only after the unlink succeeds
    end
    GC->>IDX: save() - tmp file + atomic rename (same filesystem)
    Note over IDX: also flushed on shutdown, the request path never writes index.json
```

Index lifecycle outside the tick:

- **Boot reconcile** (`main.ts`) — a process that dies between `store()`
  finishing and the next `index.save()` would otherwise drift: a stale-but-valid
  `index.json` loads fine and the new file is untracked, so GC under-counts and
  the cache grows past the limit every crash cycle. Boot therefore runs
  `mergeMissing(walk)`: any variant on disk that the index doesn't know gets
  absorbed (mtime = access time). Missing/corrupt `index.json` (→ `load()`
  throws) triggers a full `rebuild(walk)`.
- **Key validation** — every cache address passes through
  `DiskCacheStore.pathForBasename`, which rejects anything that isn't
  `<64-hex-id>_[whq…].<ext>`. A corrupt/hand-forged index key can never escape
  the `cache/` tree via `join()`.
- **Disposability preserved** — `index.json` is bookkeeping, not truth: a single
  atomic `open()` on disk decides hits/misses (ENOENT = miss, M8); a deleted
  index just means a rebuild. Evicted variants regenerate on the next request
  (originals are the source of truth).
- **Limit 0 = eviction disabled** — `CACHE_LIMIT_GB=0` short-circuits both the
  interval and `tick()`, so a tiny-for-testing or disabled cache never wipes.

Cache-layout hygiene:

- GC only ever scans/evicts `cache/ab/cd/` shard files — `index.json` and stray
  `.index-*.tmp` live at the `cache/` root and are structurally unreachable.
- **Unlink before index-remove**: if an `unlink` fails (e.g. EACCES/EPERM on a
  Windows open file) the entry stays indexed, so the byte count stays honest
  instead of the file becoming permanently un-evictable.
- Errors in the tick are logged, never propagated to a request — GC is
  best-effort bookkeeping by design.