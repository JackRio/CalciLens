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
}

export const DEFAULT_MANIFEST_CONFIG: ManifestConfig = {
  manifestPath: '',
  imageColumn: 'image_path',
  maskColumn: 'mask_path',
  patientIdColumn: 'PatientId',
}

export const STATUS_OPTIONS = ['Not Started', 'Annotated', 'InProgress', 'Review'] as const
export type AnnotationStatus = (typeof STATUS_OPTIONS)[number]

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
}

export type EditTool = 'brush' | 'region-grow'
export type OverwriteMode = 'any' | 'label' | 'threshold'
