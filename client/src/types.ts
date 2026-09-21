export type Plane = 'axial' | 'sagittal' | 'coronal'

export interface VolumeInfo {
  volume_id: string
  path: string
  size: [number, number, number]
  spacing: [number, number, number]
  origin: [number, number, number]
  direction: number[] // 9 values, row-major
  orientation: string
  dtype: string
  value_min: number
  value_max: number
  is_dicom_dir: boolean
  shape_lps: [number, number, number]
  plane_lengths: Record<Plane, number>
  labels: number[] | null
  is_new_mask: boolean
}

export interface LabelColor {
  label: number
  color: string
  name?: string
}

// CAC is the aggregate of LAD/LCx/RCA (not one of the 6 segmentation
// labels), so it gets a fixed neutral color instead of a slot in the
// palette; the other 6 classes map onto the 6 label colors positionally.
export const CAC_COLOR = '#FFFFFF'

export function colorForScoreClass(cls: ScoreClass, maskColors: LabelColor[]): string {
  if (cls === 'CAC') return CAC_COLOR
  const idx = SCORE_CLASS_BY_LABEL.indexOf(cls)
  return maskColors[idx]?.color || '#6c6d7a'
}

export const CALCIFICATIONS_PRESET: LabelColor[] = [
  { label: 1, color: '#FF0000', name: 'Calcification 1' },
  { label: 2, color: '#00FF00', name: 'Calcification 2' },
  { label: 3, color: '#0000FF', name: 'Calcification 3' },
  { label: 4, color: '#FFFF00', name: 'Calcification 4' },
  { label: 5, color: '#00FFFF', name: 'Calcification 5' },
  { label: 6, color: '#FF00FF', name: 'Calcification 6' },
]

export const DEFAULT_THRESHOLD_COLOR = '#FF8000'
export const DEFAULT_THRESHOLD_HU = 130

export interface WindowPreset {
  name: string
  level: number
  width: number
}

export const WINDOW_PRESETS: WindowPreset[] = [
  { name: 'Soft tissue', level: 40, width: 400 },
  { name: 'Lung', level: -600, width: 1500 },
  { name: 'Bone', level: 400, width: 1800 },
  { name: 'Brain', level: 40, width: 80 },
  { name: 'Calcium/Agatston', level: 90, width: 500 },
]

export const DEFAULT_WINDOW_LEVEL = 400 // Bone
export const DEFAULT_WINDOW_WIDTH = 1800 // Bone

export interface ManifestConfig {
  manifestPath: string
  imageColumn: string
  maskColumn: string
  patientIdColumn: string // required; used as the case-picker index/label and for split-view sync
  reasonColumn: string // column holding Reason tags — may be a pre-existing column (e.g. "kernel_type")
  includeDefaultReasonTags: boolean // merge the app's built-in tag set into the Reason picker's options
}

export const DEFAULT_MANIFEST_CONFIG: ManifestConfig = {
  manifestPath: '',
  imageColumn: 'image_path',
  maskColumn: 'mask_path',
  patientIdColumn: 'PatientId',
  reasonColumn: 'Reason',
  includeDefaultReasonTags: true,
}

export const STATUS_OPTIONS = ['Not Started', 'Annotated', 'InProgress', 'Review'] as const
export type AnnotationStatus = (typeof STATUS_OPTIONS)[number]

export const DEFAULT_REASON_TAGS = [
  'Mislabel',
  'Incorrect Prediction',
  'Empty Prediction',
  'Valve Class Error',
  'Foreign Object',
  'Corrupted Image',
  'Artefacts',
  'Region Growing Issue',
  'Image Noise',
]

// Score columns are named "<CLASS>_Agatston" in the manifest; purely
// optional/informational, shown if present and skipped if not.
export const SCORE_CLASSES = ['CAC', 'LAD', 'LCx', 'RCA', 'TAC', 'AV', 'MV'] as const
export type ScoreClass = (typeof SCORE_CLASSES)[number]

// Positional mapping of segmentation label (1-6) to its clinical class name —
// label 1 = SCORE_CLASS_BY_LABEL[0] = 'LAD', label 2 = 'LCx', etc. CAC is the
// aggregate of LAD/LCx/RCA and isn't a segmentation label itself, so it has
// no slot here. Shared by ScorePanel and LesionScorePanel.
export const SCORE_CLASS_BY_LABEL: ScoreClass[] = ['LAD', 'LCx', 'RCA', 'TAC', 'AV', 'MV']
export const CORONARY_LABELS = [1, 2, 3]

export interface ManifestRow {
  index: number
  label: string
  patient_id: string
  image_path: string
  mask_path: string
  image_exists: boolean
  mask_exists: boolean
  comment: string
  status: AnnotationStatus
  reason: string[]
  scores: Partial<Record<ScoreClass, number | null>>
}

export interface ManifestPairsResult {
  rows: ManifestRow[]
  reasonOptions: string[]
  scoreClasses: ScoreClass[]
}

export interface PaneState {
  id: string
  manifestConfig: ManifestConfig
  manifestColumns: string[]
  manifestRows: ManifestRow[]
  activeRowIndex: number | null
  manifestError: string | null
  batchLoadCollapsed: boolean
  wlMinimized: boolean
  reasonOptions: string[] // base + discovered-in-sheet + session-added tags
  scoreClasses: ScoreClass[] // which score columns are present in this manifest
  scorePanelOpen: boolean
  scorePanelPos: { x: number; y: number } | null

  loadingMessage: string | null // shown alongside the loading tag/overlay while `loading` is true

  ctPath: string
  maskPath: string
  ctInfo: VolumeInfo | null
  maskInfo: VolumeInfo | null

  plane: Plane
  index: number

  windowLevel: number
  windowWidth: number

  showMask: boolean
  maskColors: LabelColor[]
  maskAlpha: number

  thresholdEnabled: boolean
  thresholdValue: number
  thresholdColor: string
  thresholdAlpha: number

  zoom: number
  panX: number // screen-px offset applied after scaling (see .slice-image's transform in Pane.tsx)
  panY: number

  error: string | null
  loading: boolean

  // Mask editing — deliberately never synced between split-view panes.
  editMode: boolean
  editTool: EditTool
  editActiveLabel: number
  editOverwriteMode: OverwriteMode
  editOverwriteLabel: number | null
  editThresholdMin: number
  editBrushRadius: number
  editRegionGrowThreshold: number
  editVersion: number
  editBusy: boolean
  editMessage: string | null
  editMinimized: boolean
  editBoxPos: { x: number; y: number } | null // null = default bottom-right anchor

  // Per-lesion Agatston scoring — session-only, per-pane, never synced or
  // persisted, like mask editing above. One combined box (checkbox to
  // enable click-to-score, plus a running, append-only table of every
  // lesion scored so far this session) rather than a separate toggle and
  // results panel.
  scoreComputeMode: boolean
  scoreComputeMinimized: boolean
  scoreComputeBoxPos: { x: number; y: number } | null
  lesionResults: LesionScoreResult[]

  // Contrast CT: per-scan calcium-detection threshold, derived from a sphere VOI
  // around a user-placed seed point (ascending aorta near the left ostium) rather
  // than the fixed 130 HU used for non-contrast. Per-pane, never synced — each pane
  // can hold a different case. See ContrastSeedBox.tsx.
  contrastMode: boolean
  seedPlacementMode: boolean
  pendingSeed: { plane: Plane; index: number; row: number; col: number } | null
  contrastThreshold: number | null
  contrastThresholdLocked: boolean
  contrastMeta: {
    meanHu: number
    stdHu: number
    voxelCount: number
    actualVolumeMm3: number
    targetVolumeMm3: number
    kMultiplier: number
    radiusMm: number
    savedAt: string
    mismatch: boolean
  } | null

  // Contrast CT, computed-total volume score per class (CAC/TAC/AV/MV) via the
  // "Volume Compute" box's play button — parallel to ManifestRow.scores but
  // freshly computed (mm3, no Agatston weighting), not read from the manifest.
  volumeScores: Partial<Record<ScoreClass, number>> | null
}

export type EditTool = 'brush' | 'region-grow'
export type OverwriteMode = 'any' | 'label' | 'threshold'

export interface LesionScoreResult {
  id: number // unique per row, so a re-click of the same lesion can be told apart from a new one to append
  label: number
  voxelCount: number
  // 'agatston' rows (non-contrast) populate agatstonScore/targetClass/oldScore/
  // newScore/scoreSource; 'volume' rows (contrast) populate only volumeMm3 — the
  // manifest-baseline/confirm-total dance doesn't apply to a physical-volume metric.
  metric: 'agatston' | 'volume'
  agatstonScore: number
  volumeMm3?: number
  // The score class this lesion's baseline is measured against: the
  // aggregate 'CAC' for coronary labels (1-3, LAD/LCx/RCA), or the lesion's
  // own class for the rest (TAC/AV/MV, labels 4-6).
  targetClass: ScoreClass
  oldScore: number | null // baseline total for targetClass before subtracting this lesion
  newScore: number | null // oldScore - agatstonScore
  scoreSource: 'manifest' | 'computed' | 'unavailable'
  // Where this lesion was clicked, so a row click can jump back to it.
  plane: Plane
  index: number
  row: number
  col: number
}

// ---- Keyboard shortcuts ----

export type KeybindActionId =
  | 'toggleMask'
  | 'toggleThresh'
  | 'prevSlice'
  | 'nextSlice'
  | 'reloadCurrent'
  | 'toggleReviewMode'
  | 'toggleScoreComputeMode'

export interface KeyCombo {
  key: string // e.g. "r", "ArrowLeft" — letters stored lowercase
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

export type KeybindMap = Record<KeybindActionId, KeyCombo[]>

export const KEYBIND_LABELS: Record<KeybindActionId, string> = {
  toggleMask: 'Toggle Mask overlay',
  toggleThresh: 'Toggle Threshold overlay',
  prevSlice: 'Previous slice',
  nextSlice: 'Next slice',
  reloadCurrent: 'Reload CT / Mask',
  toggleReviewMode: 'Toggle Review mode',
  toggleScoreComputeMode: 'Toggle Score Compute mode',
}

export const DEFAULT_KEYBINDS: KeybindMap = {
  toggleMask: [{ key: 'r' }],
  toggleThresh: [{ key: 't' }],
  prevSlice: [{ key: 'ArrowLeft' }, { key: 'a' }],
  nextSlice: [{ key: 'ArrowRight' }, { key: 'd' }],
  reloadCurrent: [{ key: 'r', ctrl: true, shift: true }],
  toggleReviewMode: [{ key: 'v', ctrl: true, shift: true }],
  toggleScoreComputeMode: [{ key: 's', ctrl: true, shift: true }],
}

export function comboLabel(combo: KeyCombo): string {
  const parts: string[] = []
  if (combo.ctrl) parts.push('Ctrl')
  if (combo.alt) parts.push('Alt')
  if (combo.shift) parts.push('Shift')
  if (combo.meta) parts.push('Meta')
  const keyNames: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', ' ': 'Space' }
  parts.push(keyNames[combo.key] || (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key))
  return parts.join('+')
}

export function comboMatches(e: KeyboardEvent, combo: KeyCombo): boolean {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const comboKey = combo.key.length === 1 ? combo.key.toLowerCase() : combo.key
  return (
    key === comboKey &&
    e.ctrlKey === !!combo.ctrl &&
    e.altKey === !!combo.alt &&
    e.shiftKey === !!combo.shift &&
    e.metaKey === !!combo.meta
  )
}

export function combosEqual(a: KeyCombo, b: KeyCombo): boolean {
  const ka = a.key.length === 1 ? a.key.toLowerCase() : a.key
  const kb = b.key.length === 1 ? b.key.toLowerCase() : b.key
  return ka === kb && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift && !!a.meta === !!b.meta
}
