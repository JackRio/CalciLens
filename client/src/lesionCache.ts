// Session-only cache of each scan's total CAC score (read from the manifest
// or computed on demand), keyed by the mask volume id. Module-level rather
// than React state since it must survive Prev/Next navigation and be shared
// across both split-view panes, but is intentionally lost on app restart —
// nothing here is persisted to disk or the manifest.
export type CacSource = 'manifest' | 'computed'

const cache = new Map<string, { total: number; source: CacSource }>()

export function getCachedCac(volumeId: string): { total: number; source: CacSource } | null {
  return cache.get(volumeId) ?? null
}

export function setCachedCac(volumeId: string, total: number, source: CacSource): void {
  cache.set(volumeId, { total, source })
}
