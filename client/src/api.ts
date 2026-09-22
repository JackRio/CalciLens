import type { DicomSeriesInfo, LabelColor, ManifestPairsResult, OverwriteMode, Plane, VolumeInfo } from './types'

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

export async function loadVolume(path: string, isMask: boolean, force = false, seriesUid?: string): Promise<VolumeInfo> {
  const res = await fetch('/api/volumes/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, is_mask: isMask, force, series_uid: seriesUid ?? null }),
  })
  return handleJson<VolumeInfo>(res)
}

export async function listDicomSeries(path: string): Promise<DicomSeriesInfo[]> {
  const res = await fetch(`/api/volumes/list_dicom_series?path=${encodeURIComponent(path)}`)
  const data = await handleJson<{
    series: { series_uid: string; directory: string; description: string; num_files: number }[]
  }>(res)
  return data.series.map((s) => ({
    seriesUid: s.series_uid,
    directory: s.directory,
    description: s.description,
    numFiles: s.num_files,
  }))
}

// Shared by every CT-loading entry point (single-scan Load CT, manifest row
// select/navigate): resolves a user-given path to the exact directory+series
// to actually load, and — when the path is a DICOM directory holding more
// than one series — the full series list so the caller can drive a
// Previous/Next navigator. A listing failure (not a DICOM directory, or any
// other error) never blocks a plain load: it just falls back to loading
// `path` as-is with no series hint.
export async function resolveDicomLoad(
  path: string,
): Promise<{ directory: string; seriesUid?: string; seriesList: DicomSeriesInfo[] }> {
  let series: DicomSeriesInfo[] = []
  try {
    series = await listDicomSeries(path)
  } catch {
    series = []
  }
  if (series.length === 0) {
    return { directory: path, seriesUid: undefined, seriesList: [] }
  }
  return { directory: series[0].directory, seriesUid: series[0].seriesUid, seriesList: series }
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
  reasonColumn: string
  includeDefaultReasonTags: boolean
}): Promise<ManifestPairsResult> {
  const res = await fetch('/api/manifest_pairs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      manifest_path: params.manifestPath,
      image_column: params.imageColumn,
      mask_column: params.maskColumn,
      id_column: params.patientIdColumn || null,
      patient_id_column: params.patientIdColumn || null,
      reason_column: params.reasonColumn,
      include_default_reason_tags: params.includeDefaultReasonTags,
    }),
  })
  const data = await handleJson<{ rows: ManifestPairsResult['rows']; reason_options: string[]; score_classes: ManifestPairsResult['scoreClasses'] }>(
    res,
  )
  return { rows: data.rows, reasonOptions: data.reason_options, scoreClasses: data.score_classes }
}

export async function saveManifestComment(manifestPath: string, rowIndex: number, comment: string): Promise<void> {
  const res = await fetch('/api/manifest/comment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest_path: manifestPath, row_index: rowIndex, comment }),
  })
  await handleJson(res)
}

export async function saveManifestStatus(manifestPath: string, rowIndex: number, status: string): Promise<void> {
  const res = await fetch('/api/manifest/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest_path: manifestPath, row_index: rowIndex, status }),
  })
  await handleJson(res)
}

export async function saveManifestReason(
  manifestPath: string,
  rowIndex: number,
  reasons: string[],
  reasonColumn: string,
): Promise<void> {
  const res = await fetch('/api/manifest/reason', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest_path: manifestPath, row_index: rowIndex, reasons, reason_column: reasonColumn }),
  })
  await handleJson(res)
}

export async function saveManifestMaskPath(
  manifestPath: string,
  rowIndex: number,
  maskColumn: string,
  maskPath: string,
): Promise<void> {
  const res = await fetch('/api/manifest/mask_path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest_path: manifestPath, row_index: rowIndex, mask_column: maskColumn, mask_path: maskPath }),
  })
  await handleJson(res)
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
  searchRadiusMm?: number
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
      search_radius_mm: params.searchRadiusMm ?? null,
    }),
  })
  return handleJson(res)
}

export async function computeLesionScore(params: {
  maskId: string
  ctId: string
  plane: Plane
  index: number
  row: number
  col: number
  huThreshold?: number
  searchRadiusMm?: number
}): Promise<{ found: boolean; label: number | null; voxelCount: number; agatstonScore: number; isCoronary: boolean }> {
  const res = await fetch('/api/mask/lesion_score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mask_id: params.maskId,
      ct_id: params.ctId,
      plane: params.plane,
      index: params.index,
      row: params.row,
      col: params.col,
      hu_threshold: params.huThreshold ?? 130,
      search_radius_mm: params.searchRadiusMm ?? null,
    }),
  })
  const data = await handleJson<{
    found: boolean
    label: number | null
    voxel_count: number
    agatston_score: number
    is_coronary: boolean
  }>(res)
  return {
    found: data.found,
    label: data.label,
    voxelCount: data.voxel_count,
    agatstonScore: data.agatston_score,
    isCoronary: data.is_coronary,
  }
}

export async function computeVolumeAgatston(params: {
  maskId: string
  ctId: string
  labels?: number[]
  huThreshold?: number
}): Promise<{ totalScore: number }> {
  const res = await fetch('/api/volumes/agatston_total', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mask_id: params.maskId,
      ct_id: params.ctId,
      labels: params.labels ?? [1, 2, 3],
      hu_threshold: params.huThreshold ?? 130,
    }),
  })
  const data = await handleJson<{ total_score: number }>(res)
  return { totalScore: data.total_score }
}

export async function computeLesionVolume(params: {
  maskId: string
  ctId: string
  plane: Plane
  index: number
  row: number
  col: number
  huThreshold: number
  searchRadiusMm?: number
}): Promise<{ found: boolean; label: number | null; voxelCount: number; volumeMm3: number }> {
  const res = await fetch('/api/mask/lesion_volume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mask_id: params.maskId,
      ct_id: params.ctId,
      plane: params.plane,
      index: params.index,
      row: params.row,
      col: params.col,
      hu_threshold: params.huThreshold,
      search_radius_mm: params.searchRadiusMm ?? null,
    }),
  })
  const data = await handleJson<{ found: boolean; label: number | null; voxel_count: number; volume_mm3: number }>(res)
  return { found: data.found, label: data.label, voxelCount: data.voxel_count, volumeMm3: data.volume_mm3 }
}

export async function computeVolumeTotal(params: {
  maskId: string
  ctId: string
  labels?: number[]
  huThreshold: number
}): Promise<{ totalVolumeMm3: number }> {
  const res = await fetch('/api/volumes/volume_total', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mask_id: params.maskId,
      ct_id: params.ctId,
      labels: params.labels ?? [1, 2, 3],
      hu_threshold: params.huThreshold,
    }),
  })
  const data = await handleJson<{ total_volume_mm3: number }>(res)
  return { totalVolumeMm3: data.total_volume_mm3 }
}

export interface ContrastThresholdResult {
  meanHu: number
  stdHu: number
  thresholdHu: number
  voxelCount: number
  actualVolumeMm3: number
  targetVolumeMm3: number
  kMultiplier: number
  radiusMm: number
  seedVoxel: [number, number, number]
  plane: Plane
  index: number
  row: number
  col: number
  savedAt?: string
}

function parseContrastThresholdResult(data: {
  mean_hu: number
  std_hu: number
  threshold_hu: number
  voxel_count: number
  actual_volume_mm3: number
  target_volume_mm3: number
  k_multiplier: number
  radius_mm: number
  seed_voxel: [number, number, number]
  plane: Plane
  index: number
  row: number
  col: number
  saved_at?: string
}): ContrastThresholdResult {
  return {
    meanHu: data.mean_hu,
    stdHu: data.std_hu,
    // Rounded once here so every consumer (display, mismatch check, the
    // mirrored editThresholdMin/editRegionGrowThreshold fields) sees the
    // same 2-decimal value instead of each one re-rounding independently.
    thresholdHu: Math.round(data.threshold_hu * 100) / 100,
    voxelCount: data.voxel_count,
    actualVolumeMm3: data.actual_volume_mm3,
    targetVolumeMm3: data.target_volume_mm3,
    kMultiplier: data.k_multiplier,
    radiusMm: data.radius_mm,
    seedVoxel: data.seed_voxel,
    plane: data.plane,
    index: data.index,
    row: data.row,
    col: data.col,
    savedAt: data.saved_at,
  }
}

export async function computeContrastThreshold(params: {
  ctId: string
  plane: Plane
  index: number
  row: number
  col: number
  targetVolumeMm3: number
  kMultiplier: number
  save: boolean
  ctPath?: string
  maskPath?: string | null
  patientId?: string | null
  saveDir?: string | null
}): Promise<ContrastThresholdResult> {
  const res = await fetch('/api/contrast/compute_threshold', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ct_id: params.ctId,
      plane: params.plane,
      index: params.index,
      row: params.row,
      col: params.col,
      target_volume_mm3: params.targetVolumeMm3,
      k_multiplier: params.kMultiplier,
      save: params.save,
      ct_path: params.ctPath,
      mask_path: params.maskPath,
      patient_id: params.patientId,
      save_dir: params.saveDir || null,
    }),
  })
  const data = await handleJson<Parameters<typeof parseContrastThresholdResult>[0]>(res)
  return parseContrastThresholdResult(data)
}

export async function loadContrastThreshold(
  ctPath: string,
  saveDir?: string | null,
  seriesUid?: string | null,
): Promise<ContrastThresholdResult | null> {
  const params = new URLSearchParams({ ct_path: ctPath })
  if (saveDir) params.set('save_dir', saveDir)
  if (seriesUid) params.set('series_uid', seriesUid)
  const res = await fetch(`/api/contrast/load_threshold?${params.toString()}`)
  if (res.status === 404) return null
  const data = await handleJson<Parameters<typeof parseContrastThresholdResult>[0]>(res)
  return parseContrastThresholdResult(data)
}

export async function refreshMaskLabels(maskId: string): Promise<{ labels: number[] }> {
  const res = await fetch('/api/mask/refresh_labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mask_id: maskId }),
  })
  return handleJson(res)
}

export async function saveMask(maskId: string, tag?: string, saveDir?: string | null): Promise<{ path: string }> {
  const res = await fetch('/api/mask/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mask_id: maskId, tag: tag || null, save_dir: saveDir || null }),
  })
  return handleJson(res)
}
