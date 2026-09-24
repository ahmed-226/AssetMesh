## 6. Purge sequence (M5)

`DELETE /api/v1/media/{id}` removes the original blob **and** every cached
variant derived from it. The plan mandates idempotence: deleting an id that is
already gone (or was never uploaded) is a **204 no-op**, not a 404 — only a
malformed id is a 400.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant DR as DELETE /api/v1/media/:id
    participant PS as PurgeService
    participant CS as CasObjectStore
    participant DC as DiskCacheStore
    participant LI as LruIndex (memory)

    C->>DR: DELETE /api/v1/media/<id>
    DR->>PS: purge(id)
    PS->>PS: validateHash(id)
    alt malformed id (not 64-hex)
        PS-->>C: BadRequestError → 400
    else valid
        PS->>CS: delete(id)  — findPath → match "<id>.*" in shard
        alt original exists
            CS->>CS: rm originals/ab/cd/<id>.<ext>
            Note over CS: missing id is a no-op (bool, not an error)
        end
        PS->>DC: listByPrefix(id) — readdir cache/ab/cd, names starting "<id>_"
        loop each variant basename
            PS->>DC: remove(basename) — unlink FIRST
            PS->>LI: remove(basename) — dropped from index only after unlink
            Note over PS: invalid/tampered names in the shard are skipped, never fatal
        end
        DR-->>C: 204 No Content
    end
    Note over PS,LI: index.json itself is untouched — it persists on the next GC tick / shutdown
```

Purge properties:

- **One shard, all variants** — every variant of an id lives in the id's shard
  (`cache/ab/cd/`), so a single `readdir` covers the whole purge.
- **Unlink-before-index-remove** — same order as the GC, so a crash between the
  two leaves the file tracked (still evictable) instead of stranding a
  permanently untracked orphan.
- **Idempotent by design** — `CasObjectStore.delete` returns `false` for a
  missing file, `listByPrefix` returns `[]` for a missing shard, and `rm force`
  swallows races; a repeated DELETE is a clean 204 again.
- **Variants can't resurrect the original** — a transform request after a purge
  fails 404 at `objects.open`, and nothing ever writes back to `originals/`
  (only re-uploading identical bytes re-creates the id — correct CAS, not
  undelete).