import type { LabelColor, ManifestRow, OverwriteMode, Plane, VolumeInfo } from './types'

async function handleJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail || detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  return res.json()
}

export async function loadVolume(path: string, isMask: boolean): Promise<VolumeInfo> {
  const res = await fetch('/api/volumes/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, is_mask: isMask }),
  })
  return handleJson<VolumeInfo>(res)
}

export function renderUrl(params: {
  ctId: string
  maskId?: string | null
  plane: Plane
  index: number
  ww: number
  wl: number
  maskColors?: LabelColor[]
  maskAlpha?: number
  showMask?: boolean
  thresholdEnabled?: boolean
  thresholdValue?: number
  thresholdColor?: string
  thresholdAlpha?: number
  editVersion?: number
}): string {
  const q = new URLSearchParams()
  q.set('ct_id', params.ctId)
  if (params.maskId) q.set('mask_id', params.maskId)
  q.set('plane', params.plane)
  q.set('index', String(params.index))
  q.set('ww', String(params.ww))
  q.set('wl', String(params.wl))
  if (params.maskColors) {
    const obj: Record<string, string> = {}
    for (const lc of params.maskColors) obj[String(lc.label)] = lc.color
    q.set('mask_colors', JSON.stringify(obj))
  }
  if (params.maskAlpha !== undefined) q.set('mask_alpha', String(params.maskAlpha))
  if (params.showMask !== undefined) q.set('show_mask', String(params.showMask))
  if (params.thresholdEnabled !== undefined) q.set('threshold_enabled', String(params.thresholdEnabled))
  if (params.thresholdValue !== undefined) q.set('threshold_value', String(params.thresholdValue))
  if (params.thresholdColor) q.set('threshold_color', params.thresholdColor)
  if (params.thresholdAlpha !== undefined) q.set('threshold_alpha', String(params.thresholdAlpha))
  if (params.editVersion !== undefined) q.set('v', String(params.editVersion))
  return `/api/render?${q.toString()}`
}

export async function probeVoxel(params: {
  ctId: string
  maskId?: string | null
  plane: Plane
  index: number
  row: number
  col: number
}): Promise<{ hu: number | null; label: number | null }> {
  const q = new URLSearchParams()
  q.set('ct_id', params.ctId)
  if (params.maskId) q.set('mask_id', params.maskId)
  q.set('plane', params.plane)
  q.set('index', String(params.index))
  q.set('row', String(params.row))
  q.set('col', String(params.col))
  const res = await fetch(`/api/probe?${q.toString()}`)
  return handleJson(res)
}

export async function getManifestColumns(manifestPath: string): Promise<string[]> {
  const res = await fetch('/api/manifest_columns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest_path: manifestPath }),
  })
  const data = await handleJson<{ columns: string[] }>(res)
  return data.columns
}

export async function getManifestPairs(params: {
  manifestPath: string
  imageColumn: string
  maskColumn: string
  patientIdColumn?: string
}): Promise<ManifestRow[]> {
  const res = await fetch('/api/manifest_pairs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      manifest_path: params.manifestPath,
      image_column: params.imageColumn,
      mask_column: params.maskColumn,
      id_column: params.patientIdColumn || null,
      patient_id_column: params.patientIdColumn || null,
    }),
  })
  const data = await handleJson<{ rows: ManifestRow[] }>(res)
  return data.rows
}

export async function createBlankMask(ctId: string): Promise<VolumeInfo> {
  const res = await fetch('/api/mask/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ct_id: ctId }),
  })
  return handleJson<VolumeInfo>(res)
}

export async function paintMask(params: {
  maskId: string
  ctId: string
  plane: Plane
  index: number
  row: number
  col: number
  radius: number
  newLabel: number
  overwriteMode: OverwriteMode
  overwriteLabel?: number | null
  thresholdMin?: number
}): Promise<{ changed: number; labels: number[] }> {
  const res = await fetch('/api/mask/paint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mask_id: params.maskId,
      ct_id: params.ctId,
      plane: params.plane,
      index: params.index,
      row: params.row,
      col: params.col,
      radius: params.radius,
      new_label: params.newLabel,
      overwrite_mode: params.overwriteMode,
      overwrite_label: params.overwriteLabel ?? null,
      threshold_min: params.thresholdMin ?? null,
    }),
  })
  return handleJson(res)
}

export async function regionGrowMask(params: {
  maskId: string
  ctId: string
  plane: Plane
  index: number
  row: number
  col: number
  thresholdMin: number
  newLabel: number
}): Promise<{ changed: number; labels: number[] }> {
  const res = await fetch('/api/mask/region_grow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mask_id: params.maskId,
      ct_id: params.ctId,
      plane: params.plane,
      index: params.index,
      row: params.row,
      col: params.col,
      threshold_min: params.thresholdMin,
      new_label: params.newLabel,
    }),
  })
  return handleJson(res)
}

export async function refreshMaskLabels(maskId: string): Promise<{ labels: number[] }> {
  const res = await fetch('/api/mask/refresh_labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mask_id: maskId }),
  })
  return handleJson(res)
}

export async function saveMask(maskId: string, tag?: string): Promise<{ path: string }> {
  const res = await fetch('/api/mask/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mask_id: maskId, tag: tag || null }),
  })
  return handleJson(res)
}
