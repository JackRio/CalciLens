export type Plane = 'axial' | 'sagittal' | 'coronal'

export interface VolumeInfo {
  volume_id: string
  path: string
  size: [number, number, number]
  spacing: [number, number, number] // as-read axis order, for the info panel
  spacing_lps: [number, number, number] // (sx, sy, sz) in the LPS-reoriented array's axis order — use this for any physical-space math against plane/index/row/col
  origin: [number, number, number]
  direction: number[] // 9 values, row-major
  // Where the LPS-reoriented array sits in the world (voxel [0,0,0] and axis
  // directions). Same shape is not enough for two volumes to line up.
  origin_lps?: number[]
  direction_lps?: number[]
  orientation: string
  dtype: string
  value_min: number
  value_max: number
  is_dicom_dir: boolean
  shape_lps: [number, number, number]
  plane_lengths: Record<Plane, number>
  labels: number[] | null
  is_new_mask: boolean
  dicom_series_uid: string | null
}

// One entry per series found under a DICOM directory (see
// api.ts's listDicomSeries) — used to drive the series Previous/Next
// navigator when a folder holds more than one.
// Which screen the user picked on the launcher.
export type AppMode = 'view' | 'annotate-noncontrast' | 'annotate-contrast'

export interface DicomSeriesInfo {
  // 'file' entries are single images (NIfTI/MHA/...): `directory` is then the
  // file path and seriesUid is empty.
  kind: 'dicom' | 'file'
  seriesUid: string
  directory: string
  label: string
  description: string
  numFiles: number
}

export interface LabelColor {
  label: number
  color: string
  name?: string
}

// CAC is the aggregate of LAD/LCx/RCA (not one of the 6 segmentation
// labels), so it gets a fixed neutral color instead of a slot in the
// palette; the other 6 classes map onto the label colors of labels 1-6.
export const CAC_COLOR = '#FFFFFF'

export function colorForScoreClass(cls: ScoreClass, maskColors: LabelColor[]): string {
  if (cls === 'CAC') return CAC_COLOR
  // By label number, not list position: labels can be renumbered, removed or
  // reordered in the editor, and position would then colour the wrong class.
  const label = SCORE_CLASS_BY_LABEL.indexOf(cls) + 1
  return maskColors.find((c) => c.label === label)?.color || '#6c6d7a'
}

// Best-effort guess at which threshold basis a mask *loaded from disk* was
// annotated under, since nothing is actually persisted in the mask file
// itself — masks saved by this app get "Contrast" baked into their filename
// (see server/volume_store.py's save_mask tag selection) specifically so
// this heuristic can recognize them again later. Ambiguous filenames (e.g.
// a mask from outside this app, or an older save from before this existed)
// come back null rather than a guess, since acting on a wrong guess (silently
// unloading someone's real annotations) is worse than not knowing.
export function inferMaskAnnotationType(maskPath: string): 'contrast' | 'non-contrast' | null {
  if (!maskPath) return null
  const base = maskPath.toLowerCase()
  if (base.includes('contrast')) return 'contrast'
  if (base.includes('manualannotation') || base.includes('manualedit')) return 'non-contrast'
  return null
}

function normalizePathForCompare(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

// Signals that a CT was loaded by mistake as a mask (same file picked for
// both, or a manifest's image/mask columns mixed up).
//
// An earlier version also flagged a total value RANGE over 500, on the
// reasoning that CT spans roughly -1000 HU to +1000s. That produced false
// positives on real segmentations: whole-heart conventions (MMWHS and
// anything derived from it) use label VALUES like 205, 420, 500, 550, 600,
// 820, 850, so a perfectly good cardiac mask has a range of 850 and got
// flagged. The criteria below key off things a label map genuinely never
// has, rather than how large its label values happen to be.
const MASK_LOOKS_LIKE_CT_LABEL_COUNT = 256
// Air is about -1000 HU, so a CT essentially always goes well below zero;
// a label map is non-negative. This is the single most specific signal.
const MASK_LOOKS_LIKE_CT_MIN_VALUE = -100

// A mask can only be edited or scored against a CT of identical geometry.
// Nothing checked this before: every slice lookup clamps its index against
// its own volume independently, so a mask with fewer slices than the CT
// didn't error — viewing CT slice 200 and painting wrote to the mask's LAST
// slice, and that wrong data was then saved. Returns a message, or null when
// the two match.
export function detectGeometryMismatch(ctInfo: VolumeInfo, maskInfo: VolumeInfo): string | null {
  const a = ctInfo.shape_lps
  const b = maskInfo.shape_lps
  if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return null
  return (
    `This mask does not match the CT: mask is ${b.join(' x ')} voxels, CT is ${a.join(' x ')}. ` +
    'They must share the same geometry, so it cannot be displayed or edited against this scan.'
  )
}

// Same size is necessary but not sufficient: a mask on a shifted origin, other
// voxel spacing or another orientation has the right shape and still draws in
// the wrong place. This is a warning, not a block, because tiny differences
// from resampling tools are common and the user can judge the overlay.
export function detectAlignmentMismatch(ctInfo: VolumeInfo, maskInfo: VolumeInfo): string | null {
  const co = ctInfo.origin_lps
  const mo = maskInfo.origin_lps
  const cd = ctInfo.direction_lps
  const md = maskInfo.direction_lps
  if (!co || !mo || !cd || !md) return null
  const minSpacing = Math.min(...ctInfo.spacing_lps)
  const originShift = Math.hypot(...co.map((v, i) => v - mo[i]))
  const spacingOff = Math.max(...ctInfo.spacing_lps.map((v, i) => Math.abs(v - maskInfo.spacing_lps[i]) / v))
  const directionOff = Math.max(...cd.map((v, i) => Math.abs(v - md[i])))
  const problems: string[] = []
  if (originShift > 0.1 * minSpacing) problems.push(`its position is ${originShift.toFixed(1)} mm away from the CT's`)
  if (spacingOff > 1e-3) problems.push('its voxel spacing differs')
  if (directionOff > 1e-3) problems.push('its orientation differs')
  if (problems.length === 0) return null
  return (
    `This mask is the same size as the CT, but ${problems.join(' and ')}. ` +
    'It may not line up with the anatomy. Check the overlay before you rely on it.'
  )
}

// The app already infers whether a mask was annotated with or without
// contrast, and used to do nothing with that but feed the Contrast toggle —
// so loading a contrast-annotated mask with contrast mode off showed no
// warning at all, even though its labels were drawn against a completely
// different threshold.
export function detectAnnotationTypeMismatch(
  maskAnnotationType: 'contrast' | 'non-contrast' | null,
  contrastScreen: boolean,
): string | null {
  if (!maskAnnotationType) return null
  const expected = contrastScreen ? 'contrast' : 'non-contrast'
  if (maskAnnotationType === expected) return null
  return maskAnnotationType === 'contrast'
    ? NONCONTRAST_SCREEN_BLOCK
    : NONCONTRAST_ANNOTATION_ON_CONTRAST_SCREEN
}

export const NONCONTRAST_SCREEN_BLOCK =
  "This scan is recorded as contrast. Its labels use a per-scan threshold, not this screen's fixed 130 HU — open it from Modes ▸ Annotate ▸ Contrast."
export const NONCONTRAST_ANNOTATION_ON_CONTRAST_SCREEN =
  'This scan was annotated as non-contrast (fixed 130 HU). For that, use Modes ▸ Annotate ▸ Non-contrast; here the threshold comes from a seed.'
export const CONTRAST_NEEDS_SEED =
  'Place a seed first: tick Set AO seed and click the middle of the aorta, on the slice where the left ostium originates, then press Finalize. Painting stays off until then.'

// What earlier sessions recorded about a scan says it is contrast-enhanced: a
// saved seed, or an annotation saved as contrast. (The scan-level counterpart
// of detectAnnotationTypeMismatch, which only sees a loaded mask.)
export function scanRecordedAsContrast(lookup: AnnotationLookup | null | undefined): boolean {
  return !!lookup && (lookup.hasSeed || lookup.annotationType === 'contrast')
}

export function detectMaskLooksLikeCt(maskInfo: VolumeInfo, ctPath: string, maskPath: string): string | null {
  if (ctPath && maskPath && normalizePathForCompare(ctPath) === normalizePathForCompare(maskPath)) {
    return 'The mask path is the same file as the loaded CT scan — this overlays the CT on itself, not a real segmentation.'
  }
  // Each reason is reported, so the warning says *why* it fired rather than
  // leaving the user to guess whether it has misjudged their data.
  const reasons: string[] = []

  const labelCount = maskInfo.labels?.length ?? 0
  if (labelCount > MASK_LOOKS_LIKE_CT_LABEL_COUNT) {
    reasons.push(`${labelCount} distinct values`)
  }
  if (maskInfo.value_min < MASK_LOOKS_LIKE_CT_MIN_VALUE) {
    reasons.push(`values as low as ${Math.round(maskInfo.value_min)} (a label map is never negative)`)
  }
  if (/float/i.test(maskInfo.dtype)) {
    reasons.push(`a ${maskInfo.dtype} data type (labels are whole numbers)`)
  }

  if (reasons.length === 0) return null
  return (
    `This mask looks like a CT scan rather than a segmentation — ${reasons.join('; ')}. ` +
    'Double-check the mask path or manifest column. If it is correct, dismiss this and carry on.'
  )
}

// Names follow SCORE_CLASS_BY_LABEL: coronary arteries (LAD, LCx, RCA), thoracic
// aorta (TAC), aortic valve (AV), mitral valve (MV).
export const CALCIFICATIONS_PRESET: LabelColor[] = [
  { label: 1, color: '#FF0000', name: 'LAD' },
  { label: 2, color: '#00FF00', name: 'LCx' },
  { label: 3, color: '#0000FF', name: 'RCA' },
  { label: 4, color: '#FFFF00', name: 'TAC' },
  { label: 5, color: '#00FFFF', name: 'AV' },
  { label: 6, color: '#FF00FF', name: 'MV' },
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
  // Configurable like reasonColumn, and for the same reason: "Status" used to
  // be a hardcoded name whose contents the app overwrote on load, which
  // destroyed any pre-existing Status column a lab already used. '' = don't
  // track status at all.
  statusColumn: string
  // Where a saved annotation's path is recorded. Deliberately NOT maskColumn:
  // writing there would lose the original prediction's path, and not writing
  // it anywhere (the old behavior for rows that already had a mask) meant the
  // next visit silently re-opened the prediction and the previous session's
  // work was never loaded again. '' = don't record it.
  annotationColumn: string
  // Records whether a case is a contrast scan, so the app can know that
  // before anyone starts annotating rather than relying on a checkbox being
  // remembered. '' = don't track it.
  contrastColumn: string
}

export const DEFAULT_MANIFEST_CONFIG: ManifestConfig = {
  manifestPath: '',
  imageColumn: 'image_path',
  maskColumn: 'mask_path',
  patientIdColumn: 'PatientId',
  reasonColumn: 'Reason',
  includeDefaultReasonTags: true,
  statusColumn: 'Status',
  annotationColumn: 'annotation_path',
  contrastColumn: 'Contrast',
}

export const STATUS_OPTIONS = ['Not Started', 'Annotated', 'InProgress', 'Review'] as const

// Score columns are named "<CLASS>_Agatston" in the manifest; purely
// optional/informational, shown if present and skipped if not.
const SCORE_CLASSES = ['CAC', 'LAD', 'LCx', 'RCA', 'TAC', 'AV', 'MV'] as const
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
  // The original prediction/segmentation this case shipped with.
  mask_path: string
  // This app's own saved annotation for the case, if one has been saved.
  // Preferred over mask_path when loading — see App.tsx's loadRowIntoPane.
  annotation_path: string
  image_exists: boolean
  mask_exists: boolean
  annotation_exists: boolean
  comment: string
  // Free text, not a fixed enum: the column may already hold a lab's own
  // vocabulary, which the app must preserve rather than replace.
  status: string
  reason: string[]
  scores: Partial<Record<ScoreClass, number | null>>
  // true / false / null where null means "nobody has recorded it" — which is
  // NOT the same as "confirmed non-contrast" and must not be treated as one.
  contrast: boolean | null
}

export interface ManifestPairsResult {
  rows: ManifestRow[]
  reasonOptions: string[]
  statusOptions: string[]
  scoreClasses: ScoreClass[]
  hasAnnotationColumn: boolean
  hasContrastColumn: boolean
}

// What the backend already knows about a scan from previous sessions,
// independent of any UI state — see /api/annotations/lookup.
export interface AnnotationLookup {
  found: boolean
  scanDir: string | null
  annotationPath: string | null
  hasSeed: boolean
  annotationType: 'contrast' | 'non-contrast' | null
  savedAt: string | null
  savedForCtPath: string | null
}

export interface PaneState {
  id: string
  manifestConfig: ManifestConfig
  manifestColumns: string[]
  manifestRows: ManifestRow[]
  activeRowIndex: number | null
  manifestError: string | null

  // Populated whenever the loaded CT came from a DICOM directory holding
  // more than one series — drives the series Previous/Next navigator.
  // Empty/null for a single-series DICOM load or a plain file load. Only
  // shown when no manifest is active (manifest case-navigation takes
  // precedence — see Pane.tsx).
  dicomSeriesList: DicomSeriesInfo[]
  dicomSeriesIndex: number | null
  batchLoadCollapsed: boolean
  wlMinimized: boolean
  // View mode: show axial, sagittal and coronal together, linked by one point.
  showAll: boolean
  reasonOptions: string[] // base + discovered-in-sheet + session-added tags
  statusOptions: string[] // built-in statuses merged with whatever the sheet already uses
  hasAnnotationColumn: boolean
  hasContrastColumn: boolean
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
  // Which label-colour preset maskColors currently belongs to (see labelPresets.ts).
  labelPresetId: string
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

  // Non-blocking heads-up when a loaded "mask" looks like it's actually
  // another CT scan (huge label count / CT-like HU range, or the exact same
  // path as the loaded CT) rather than a real segmentation — see
  // detectMaskLooksLikeCt in Pane.tsx. Distinct from `error` since the load
  // itself succeeded; this is a content sanity check, not a failure.
  maskWarning: string | null

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
  // `flip` is the display orientation the click was made under (see displayOrientation.ts's
  // flipCode) — row/col only mean something together with it.
  pendingSeed: { plane: Plane; index: number; row: number; col: number; flip: string } | null
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
  // Non-contrast counterpart: freshly-recomputed Agatston totals via the
  // "Score Compute" box's play button. Takes precedence over the
  // manifest-backed ManifestRow.scores once populated, for this pane/session
  // only — doesn't write back to the manifest.
  agatstonScores: Partial<Record<ScoreClass, number>> | null

  // Which threshold basis the currently-loaded/created mask's labels were
  // painted against — contrast annotations use a per-scan computed
  // threshold and are not meaningful under the fixed 130 HU non-contrast
  // threshold (or vice versa). null means unknown (e.g. a mask loaded from
  // disk whose filename doesn't indicate either way) — see Pane.tsx's
  // Contrast CT toggle, which auto-unloads the mask on a confirmed mismatch.
  maskAnnotationType: 'contrast' | 'non-contrast' | null

  // Whether the loaded mask has edits that are not on disk. Lives on the
  // pane (not inside the Pane component) because App.tsx owns navigation and
  // has to be able to check it before loading something over the top —
  // cross-pane Patient-ID sync and the reload-everything shortcut both used
  // to discard another pane's unsaved work without asking.
  hasUnsavedMaskChanges: boolean
  // Baseline for the above: the editVersion at the moment this exact mask
  // (by volume_id) was loaded, saved, or reset.
  maskBaselineVolumeId: string | null
  maskBaselineVersion: number
  lastSavedAt: string | null // ISO timestamp of the last successful save

  // Which file the visible mask came from, so the pane can say so rather
  // than leaving the user guessing whether they are looking at their own
  // annotation or the original prediction.
  maskSource: 'annotation' | 'prediction' | 'new' | 'manual' | null

  // What previous sessions recorded about this scan (see AnnotationLookup).
  // Checked on every CT load regardless of whether contrast mode is on —
  // that check used to be skipped entirely unless the user had already
  // ticked the Contrast box, so a contrast scan opened without ticking it
  // silently used the 130 HU non-contrast threshold.
  annotationLookup: AnnotationLookup | null
  // Set when the app believes this is a contrast scan but no usable
  // threshold is active yet; drives the banner and blocks annotation.
  contrastNotice: string | null
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
