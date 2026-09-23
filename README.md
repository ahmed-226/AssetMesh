# AssetMesh

![Node.js >=20](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/typescript-strict-3178C6?logo=typescript&logoColor=white)
![Express 5](https://img.shields.io/badge/express-5-000000?logo=express)
![sharp](https://img.shields.io/badge/sharp-0.35-99CC00)
![piscina](https://img.shields.io/badge/piscina-worker_pool-6B5B95)
![Docker Compose](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)
![zero-buffer streaming](https://img.shields.io/badge/streaming-zero_buffer-00A98F)

Single-node **object storage API** with an **on-the-fly image transformer**.

Store a file once (content-addressed by its SHA-256 — identical bytes are
stored once and deduplicated forever), then request it back as any size or
format. Image processing runs in a bounded worker pool and results are cached
on disk with LRU + garbage-collected eviction, so repeat requests are fast disk
reads, not re-encodes.

## Quick start

### With Docker (recommended)

```bash
docker compose up --build
# API on http://localhost:3000, data persisted in ./data on your machine
```

### With Node directly

```bash
npm ci
npm run build
npm start          # → http://localhost:3000
```

For local development with auto-reload: `npm run dev`.

> Docker mount note: with Docker Desktop this mounts `./data` automatically.
> On Docker Engine inside WSL, keep the WSL distro running (a long-lived
> `wsl sleep` in the background prevents idle hibernation that stops containers).

## Usage

The API has **three endpoints**:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/upload` | Upload a file (multipart, field name `file`) |
| `GET /media/{id}` | Download an original — or a transformed variant with query options |
| `DELETE /api/v1/media/{id}` | Remove an original **and** every derived variant |

### 1. Upload

```bash
curl -F file=@photo.jpg http://localhost:3000/api/v1/upload
```

```json
{
  "id": "b259b59b6ba9d8cfdc3020eaa88fa227a37c498c1c613ba893335ffede7988d1",
  "url": "/media/b259b59b6ba9d8cfdc3020eaa88fa227a37c498c1c613ba893335ffede7988d1"
}
```

- The `id` is the **SHA-256 of the content** — upload the same bytes twice and
  you get the same `id` back (and no duplicate file is written).
- `MAX_UPLOAD_SIZE_MB` caps payload size (default **50 MB**); oversized uploads
  fail with `413 Payload Too Large`, enforced mid-stream while still streaming.

### 2. Download the original

```bash
curl http://localhost:3000/media/<id> -o photo.jpg
```

- `Content-Type` is sniffed from the file's magic bytes, not a filename — a
  renamed file still downloads with the right MIME.
- **Byte ranges work**, so interrupted downloads resume and video/audio can
  seek — browsers and `curl -C -` use this automatically:

```bash
curl -r 0-1023 http://localhost:3000/media/<id> -o first-1kb.bin   # → 206 Partial Content
curl -C - http://localhost:3000/media/<id> -o photo.jpg            # resume
```

### 3. Get a transformed variant

Append any of `w`, `h`, `q`, `fmt` to request an on-the-fly resize/re-encode:

```bash
curl "http://localhost:3000/media/<id>?w=300" -o thumb.webp                       # 300px wide
curl "http://localhost:3000/media/<id>?w=300&h=300&q=80&fmt=webp" -o card.webp    # fit inside a 300×300 box
curl "http://localhost:3000/media/<id>?w=1920&q=70&fmt=avif" -o hero.avif         # AVIF for modern browsers
curl "http://localhost:3000/media/<id>?fmt=png" -o lossless.png                   # re-encode only
```

Rules:
- `w` → width, `h` → height (**1–4096**, integer). An image is **never enlarged**;
  `inside` fit preserves aspect ratio.
- `q` → quality **1–100** (default **80**).
- `fmt` → output format, one of `ALLOWED_FORMATS` (default: `jpg`, `png`,
  `webp`, `avif`). Defaults to the original's format when omitted.
- Idempotent requests name the **same cache key**, so `?w=300&fmt=webp` and
  `?fmt=webp&q=80&w=300` serve the same cached file — a repeated request is a
  few-millisecond disk read, not a re-encode.
- Nonsense options (`w=abc`, `q=0`, `fmt=exe`) → `400`. A non-image upload asked
  to transform → `400`. Worker queue saturated → `503 + Retry-After: 10`.

This is what front-ends do per breakpoint — one stored image, many URLs:

```html
<img src="http://localhost:3000/media/<id>?w=64&fmt=webp" alt="avatar">
<img src="http://localhost:3000/media/<id>?w=600&q=80&fmt=webp" alt="card">
<img src="http://localhost:3000/media/<id>?w=1920&q=75&fmt=webp" alt="hero">
```

### 4. Delete

```bash
curl -X DELETE http://localhost:3000/api/v1/media/<id>
```

- **204 No Content**; removes the original **and every cached variant**.
- Idempotent: deleting an already-deleted (or never-uploaded) id is also `204`,
  never an error. Malformed ids (`not-a-hash`) → `400`.

### Health

```bash
curl http://localhost:3000/health   # → {"status":"ok"}
```

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `STORAGE_DIR` | `./data` | Where originals + cache live (`originals/…`, `cache/…`, `tmp/`) |
| `MAX_UPLOAD_SIZE_MB` | `50` | Upload cap; `0` disables the limit |
| `CACHE_LIMIT_GB` | `5` | Variant cache budget (accepts decimals, e.g. `0.001`); `0` disables eviction |
| `GC_INTERVAL_MS` | `300000` | How often the garbage collector reclaims cache space |
| `WORKER_POOL_SIZE` | CPU cores | image worker threads; larger pool = more parallel encodes |
| `ALLOWED_FORMATS` | `jpg,png,webp,avif` | Comma-separated transform output formats |

Injectable via a `.env` file in the repo root or the process environment (a
typed loader validates everything at boot and fails fast — wrong values exit
with a clear message instead of misbehaving).

## How it behaves under the hood

- **Content-addressed & streaming** — files are stored under `originals/{sha}/…`
  by their content hash, streamed to disk while hashing (no buffering), then
  atomically renamed into place; a partial file can never appear at a final path.
- **Derived cache is disposable** — variants under `cache/` are keyed
  `<id>_w…q….fmt`. The original is always the source of truth: delete the cache
  and the next request simply regenerates. The LRU + GC keeps the cache under
  `CACHE_LIMIT_GB` on its own.
- **CPU is boxed** — image processing runs only in worker threads; a heavy 4K
  AVIF encode won't stall other downloads.
