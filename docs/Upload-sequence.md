## 2. Upload sequence

The full lifecycle of a single `POST /api/v1/upload`:

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (curl/fetch)
    participant REQ as req stream
    participant BB as busboy
    participant US as UploadService
    participant CS as CasObjectStore
    participant HW as HashingWritable
    participant FS as tmp/ + originals/

    C->>REQ: POST /api/v1/upload (multipart/form-data)
    C->>BB: Content-Type: multipart boundary=[boundary]
    REQ->>BB: pipeline(req, bb) - streamed, never buffered

    Note over BB: limits: fileSize=maxBytes | infinity, fields:0, files:1
    BB->>US: emits "file" → file part stream
    US->>CS: store(stream, maxBytes)
    CS->>HW: stream → hasher → createWriteStream(tmp/uuid, "wx")
    HW->>FS: hash.update(chunk) + write chunk (SHA-256 rolling)
    HW->>HW: remember first ≤16 bytes (magic head only)

    alt client aborts mid-body
        REQ-->>BB: destroyed (pipeline propagates close/error)
        BB-->>CS: file stream errors
        CS->>FS: rm tmp/uuid
    else upload hits the size cap mid-stream
        HW-->>CS: PayloadTooLargeError (413)
        CS->>FS: rm tmp/uuid
        CS-->>US: 413
        US-->>C: 413 error Payload too large
    else busboy truncated because fileSize exhausted
        CS-->>US: 413
        US-->>C: 413
    else stream completes
        HW-->>CS: digest = sha256 hex, magic bytes, byteCount
        CS->>CS: sniff extension + mime from magic bytes
        CS->>FS: exists originals/ab/cd/id.ext?
        alt already exists (dedup)
            CS->>FS: rm tmp/uuid
            Note over CS: same bytes equals same id equals no new file
        else missing
            CS->>FS: mkdir -p shard dir, rename(tmp to final)
            Note over CS: atomic - a partial file never exists at the final path
        end
        CS-->>US: StoredObject with id, extension, mimeType, size
        US-->>C: 200 with id and url
    end
```

Key properties demonstrated by the code:

- **Zero payload buffering** — bytes flow `req → busboy → HashingWritable → tmp`
  with backpressure; only a ≤16-byte magic head is kept.
- **Identity = SHA-256 of the content** — the id is `hasher.digest`, never a
  client-supplied filename.
- **Atomic writes** — temp file then `rename()`, so no partial file appears at
  a final path; every error/abort path removes the temp file.
- **Dedup by existence** — same bytes always produce the same path, so a second
  upload of identical content returns the same id and writes nothing.