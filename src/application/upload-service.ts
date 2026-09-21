import type { ObjectRepository, ReadableSource } from "../domain/objects.js"

export interface UploadResult {
  id: string
  url: string
}

// Use-case orchestration only: the size guard (maxBytes) is enforced here and
// the repository streams the bytes straight through HashingWritable.
export class UploadService {
  constructor(
    private readonly objects: ObjectRepository,
    private readonly maxBytes: number,
  ) {}

  async upload(source: ReadableSource): Promise<UploadResult> {
    const stored = await this.objects.store(source, this.maxBytes)
    return { id: stored.id, url: `/media/${stored.id}` }
  }
}