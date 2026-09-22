import { TransformOptions } from "./transform-options.js"

// Canonical name for a cached variant. Segment order is fixed (w, h, q) and
// defaults are resolved, so `?w=300&fmt=webp` and `?fmt=webp&w=300&q=80`
// address the exact same file. The id shard double-duties as the cache shard,
// mirroring the CAS layout (cache/ab/cd/…).
export class CacheKey {
  private constructor(
    readonly id: string,
    readonly dir: string,
    readonly basename: string,
  ) {}

  static create(id: string, options: TransformOptions, fmt: string): CacheKey {
    const segments: string[] = []
    if (options.width !== undefined) segments.push(`w${options.width}`)
    if (options.height !== undefined) segments.push(`h${options.height}`)
    segments.push(`q${options.effectiveQuality}`)
    return new CacheKey(
      id,
      `${id.slice(0, 2)}/${id.slice(2, 4)}`,
      `${id}_${segments.join("_")}.${fmt}`,
    )
  }

  toString(): string {
    return this.basename
  }
}