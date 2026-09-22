import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeybindMap, LesionScoreResult, ManifestRow, PaneState, Plane, ScoreClass, VolumeInfo } from '../types'
import {
  WINDOW_PRESETS,
  DEFAULT_WINDOW_LEVEL,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_THRESHOLD_HU,
  STATUS_OPTIONS,
  CORONARY_LABELS,
  SCORE_CLASS_BY_LABEL,
  inferMaskAnnotationType,
  detectMaskLooksLikeCt,
  detectGeometryMismatch,
  comboMatches,
} from '../types'
import {
  loadVolume,
  resolveDicomLoad,
  probeVoxel,
  renderUrl,
  createBlankMask,
  paintMask,
  regionGrowMask,
  computeLesionScore,
  computeVolumeAgatston,
  computeLesionVolume,
  computeVolumeTotal,
  computeContrastThreshold,
  loadContrastThreshold,
  refreshMaskLabels,
  saveMask,
  saveManifestComment,
  saveManifestStatus,
  saveManifestReason,
  saveManifestAnnotationPath,
  saveManifestContrast,
} from '../api'
import type { SaveMaskConflict } from '../api'
import { getCachedCac, setCachedCac } from '../lesionCache'
import { useContrastSettings } from '../useContrastSettings'
import InfoPanel from './InfoPanel'
import LabelColorEditor from './LabelColorEditor'
import CaseLoader from './CaseLoader'
import AlphaSpinner from './AlphaSpinner'
import MaskEditor from './MaskEditor'
import ReasonPicker from './ReasonPicker'
import ScorePanel from './ScorePanel'
import LesionScoreBox from './LesionScoreBox'
import ContrastSeedBox from './ContrastSeedBox'

const PLANES: Plane[] = ['axial', 'sagittal', 'coronal']

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatShortDate(d: Date): string {
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`
}

// Solves V = (4/3)*pi*r^3 for r — the sphere-VOI preview radius is knowable
// purely from the target volume, no per-scan CT data needed.
function sphereRadiusMmFromVolume(targetVolumeMm3: number): number {
  return Math.cbrt((3 * targetVolumeMm3) / (4 * Math.PI))
}

// Shift+click circle-seed feature (Score/Volume-compute and Region-grow): a
// user-sized search radius for isolating tiny/isolated lesions the exact
// click missed. Kept small and physically meaningful (mm) rather than a
// generic "pixel size" so it means the same thing regardless of zoom level.
const MIN_SEED_RADIUS_MM = 1
const MAX_SEED_RADIUS_MM = 15
const SEED_RADIUS_STEP_MM = 0.5
const DEFAULT_SEED_RADIUS_MM = 3

// Physical spacing (mm) of one index-step for the given plane — same axis
// mapping as the server's plane_length/_seed_index_3d (axial steps through
// z, sagittal through x, coronal through y). spacingLps is (sx, sy, sz) in
// the LPS-reoriented array's own axis order (VolumeInfo.spacing_lps), not
// the as-read "spacing" field, which is not necessarily the same order.
function planeIndexSpacingMm(spacingLps: [number, number, number], plane: Plane): number {
  const [sx, sy, sz] = spacingLps
  if (plane === 'sagittal') return sx
  if (plane === 'coronal') return sy
  return sz // axial
}

// Mirrors the server's _seed_index_3d exactly (volume_store.py): converts a
// display-space click (as sent by getDisplayCoords — post display-rescale
// pixel space) on one specific plane into the full 3D (z, y, x) array index.
// Needed client-side so the sphere-VOI preview can be projected onto
// whichever plane is *currently* being viewed, not just the plane the seed
// happened to be placed on.
function seedDisplayToVoxel(
  planeLengths: Record<Plane, number>,
  spacingLps: [number, number, number],
  seed: { plane: Plane; index: number; row: number; col: number },
): [number, number, number] {
  const [sx, sy, sz] = spacingLps
  const target = Math.min(sx, sy, sz) || 1
  const nz = planeLengths.axial
  const [scaleH, scaleW] =
    seed.plane === 'axial' ? [sy / target, sx / target] : seed.plane === 'sagittal' ? [sz / target, sy / target] : [sz / target, sx / target]
  let viewRow = seed.row / scaleH
  let viewCol = seed.col / scaleW
  if (seed.plane !== 'axial') viewRow = nz - 1 - viewRow // sagittal/coronal display is flipud'd
  viewRow = Math.round(viewRow)
  viewCol = Math.round(viewCol)
  const index = Math.max(0, Math.min(seed.index, planeLengths[seed.plane] - 1))
  if (seed.plane === 'axial') return [index, viewRow, viewCol]
  if (seed.plane === 'sagittal') return [viewRow, viewCol, index]
  return [viewRow, index, viewCol] // coronal
}

// Inverse of the above for a fixed 3D voxel: its display-space (row, col) on
// a *given* plane, independent of which slice index that plane is currently
// showing (in-plane position doesn't depend on the out-of-plane index).
function projectVoxelToPlaneDisplay(
  planeLengths: Record<Plane, number>,
  spacingLps: [number, number, number],
  voxel: [number, number, number],
  plane: Plane,
): { row: number; col: number } {
  const [sx, sy, sz] = spacingLps
  const [z0, y0, x0] = voxel
  const target = Math.min(sx, sy, sz) || 1
  const nz = planeLengths.axial
  if (plane === 'axial') return { row: (y0 * sy) / target, col: (x0 * sx) / target }
  const adjustedRow = nz - 1 - z0
  if (plane === 'sagittal') return { row: (adjustedRow * sz) / target, col: (y0 * sy) / target }
  return { row: (adjustedRow * sz) / target, col: (x0 * sx) / target } // coronal
}

// The seed voxel's own index along a *given* plane's out-of-plane axis (same
// mapping as _seed_index_3d: axial's index is z, sagittal's is x, coronal's
// is y) — used to compute the physical distance from an arbitrary currently-
// viewed slice to the seed, regardless of which plane the seed was placed on.
function seedIndexAlongPlane(voxel: [number, number, number], plane: Plane): number {
  const [z0, y0, x0] = voxel
  if (plane === 'axial') return z0
  if (plane === 'sagittal') return x0
  return y0 // coronal
}

// One entry per tile ScorePanel can render: the CAC aggregate (all three
// coronary labels combined) plus each individual class — including LAD/LCx/
// RCA, which ScorePanel shows as members under the CAC header tile. Missing
// any of these from pane.volumeScores is exactly why they'd render blank.
const VOLUME_SCORE_SPECS: { cls: ScoreClass; labels: number[] }[] = [
  { cls: 'CAC', labels: [...CORONARY_LABELS] },
  { cls: 'LAD', labels: [1] },
  { cls: 'LCx', labels: [2] },
  { cls: 'RCA', labels: [3] },
  { cls: 'TAC', labels: [4] },
  { cls: 'AV', labels: [5] },
  { cls: 'MV', labels: [6] },
]

export default function Pane({
  pane,
  onChange,
  onClose,
  closable,
  onNavigate,
  onJumpTo,
  isActive,
  onActivate,
  keybinds,
  onCopyToOtherPane,
  onToggleReviewMode,
  annotationSaveDir,
  onAnnotationSaveDirChange,
  onApplyContrastEvidence,
  onLoadRow,
}: {
  pane: PaneState
  onChange: (partial: Partial<PaneState>) => void
  onClose: () => void
  closable: boolean
  onNavigate: (direction: 1 | -1) => void
  onJumpTo: (position: number) => void
  isActive: boolean
  onActivate: () => void
  keybinds: KeybindMap
  onCopyToOtherPane?: () => Promise<void>
  onToggleReviewMode: () => void
  annotationSaveDir: string
  onAnnotationSaveDirChange: (next: string) => void
  onApplyContrastEvidence: (ctPath: string, ctInfo: VolumeInfo | null) => Promise<boolean>
  // The one path that loads a manifest row properly: prefers a saved
  // annotation over the original prediction, checks geometry, and applies
  // whatever is recorded about the scan being contrast-enhanced.
  onLoadRow: (row: ManifestRow) => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [copyingToOtherPane, setCopyingToOtherPane] = useState(false)
  const [probe, setProbe] = useState<{ hu: number | null; label: number | null; row: number; col: number } | null>(
    null,
  )
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSaving, setCommentSaving] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [reasonPickerOpen, setReasonPickerOpen] = useState(false)
  const [reasonOptionsSnapshot, setReasonOptionsSnapshot] = useState<string[]>([])
  const [navModalDirection, setNavModalDirection] = useState<1 | -1 | null>(null)
  const [jumpPos, setJumpPos] = useState<number | null>(null)
  const [seriesStepDirection, setSeriesStepDirection] = useState<1 | -1 | null>(null)
  const [counterDraft, setCounterDraft] = useState('')
  const [counterFocused, setCounterFocused] = useState(false)
  const [counterError, setCounterError] = useState<string | null>(null)
  const [statusSaving, setStatusSaving] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [lesionNotFound, setLesionNotFound] = useState(false)
  const [scoreConfirmPending, setScoreConfirmPending] = useState<{
    label: number
    voxelCount: number
    agatstonScore: number
    targetClass: ScoreClass
    plane: Plane
    index: number
    row: number
    col: number
  } | null>(null)
  const [computingScore, setComputingScore] = useState(false)
  const [flashRowId, setFlashRowId] = useState<number | null>(null)
  const [contrastSettings, setContrastSettings] = useContrastSettings()
  // A save that reported something already at the destination, waiting for
  // the user to say what to do about it. Nothing has been written yet.
  const [saveConflict, setSaveConflict] = useState<SaveMaskConflict | null>(null)
  // Turning the Contrast toggle off/on can unload an edited mask; this holds
  // that intent until the user confirms they're willing to lose the edits.
  const [contrastUnloadPending, setContrastUnloadPending] = useState<boolean | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [contrastSaving, setContrastSaving] = useState(false)
  const [contrastError, setContrastError] = useState<string | null>(null)
  const [contrastBoxMinimized, setContrastBoxMinimized] = useState(false)
  const [computingVolumeScores, setComputingVolumeScores] = useState(false)
  // Shift+click circle-seed (see MIN/MAX_SEED_RADIUS_MM above): shiftHeld only
  // drives the preview cursor; the actual click/scroll handlers read
  // e.shiftKey directly off the native event instead, so they stay correct
  // regardless of which element currently has focus.
  const [shiftHeld, setShiftHeld] = useState(false)
  const [seedRadiusMm, setSeedRadiusMm] = useState(DEFAULT_SEED_RADIUS_MM)
  const seedRadiusRef = useRef(seedRadiusMm)
  seedRadiusRef.current = seedRadiusMm
  const circleClickActive = pane.scoreComputeMode || (pane.editMode && pane.editTool === 'region-grow')
  const circleClickActiveRef = useRef(circleClickActive)
  circleClickActiveRef.current = circleClickActive
  const lesionIdCounter = useRef(0)
  const flashTimeoutRef = useRef<number | null>(null)
  const jumpMarkerTimeoutRef = useRef<number | null>(null)
  const pendingJumpMarkerRef = useRef<{ row: number; col: number } | null>(null)
  // Brush-cursor tracking deliberately bypasses React state: it's a
  // high-frequency, purely-visual value with no data anyone else reads, so
  // we write straight to the DOM node (via ref) in a requestAnimationFrame
  // callback instead of paying for a React re-render on every mouse move.
  const cursorDivRef = useRef<HTMLDivElement>(null)
  const pendingCursor = useRef<{ x: number; y: number; diameter: number; variant: 'brush' | 'seed-radius' } | null>(null)
  const cursorRafId = useRef<number | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const viewerAreaRef = useRef<HTMLDivElement>(null)
  const wlBoxRef = useRef<HTMLDivElement>(null)
  const contrastBoxRef = useRef<HTMLDivElement>(null)
  const bottomLeftRef = useRef<HTMLDivElement>(null)
  const editBoxRef = useRef<HTMLDivElement>(null)
  const scorePanelRef = useRef<HTMLDivElement>(null)
  const jumpMarkerRef = useRef<HTMLDivElement>(null)
  const seedMarkerRef = useRef<HTMLDivElement>(null)
  const seedSphereRef = useRef<HTMLDivElement>(null)
  const lastProbeTs = useRef(0)
  const rightDrag = useRef<{
    active: boolean
    startX: number
    startY: number
    startZoom: number
    startLevel: number
    axis: 'zoom' | 'brightness' | null
  }>({ active: false, startX: 0, startY: 0, startZoom: 1, startLevel: 40, axis: null })
  const paintDrag = useRef<{ active: boolean; didPaint: boolean; erasing: boolean }>({
    active: false,
    didPaint: false,
    erasing: false,
  })
  const panDrag = useRef<{
    active: boolean
    buttonMask: number
    startX: number
    startY: number
    startPanX: number
    startPanY: number
  }>({ active: false, buttonMask: 0, startX: 0, startY: 0, startPanX: 0, startPanY: 0 })
  const lastPaintTs = useRef(0)
  const lastRenderBumpTs = useRef(0)
  const editBoxDrag = useRef<{ active: boolean; offsetX: number; offsetY: number }>({
    active: false,
    offsetX: 0,
    offsetY: 0,
  })
  const scorePanelDrag = useRef<{ active: boolean; offsetX: number; offsetY: number }>({
    active: false,
    offsetX: 0,
    offsetY: 0,
  })
  const scoreComputeBoxRef = useRef<HTMLDivElement>(null)
  const scoreComputeBoxDrag = useRef<{ active: boolean; offsetX: number; offsetY: number }>({
    active: false,
    offsetX: 0,
    offsetY: 0,
  })

  const planeLength = pane.ctInfo ? pane.ctInfo.plane_lengths[pane.plane] : 1
  const currentRowPos = pane.manifestRows.findIndex((r) => r.index === pane.activeRowIndex)
  const currentRow = currentRowPos >= 0 ? pane.manifestRows[currentRowPos] : null
  // Whatever the sheet already uses, merged with the built-ins by the
  // backend — the app must not assume its own four values are the only ones.
  const statusOptions = pane.statusOptions.length > 0 ? pane.statusOptions : [...STATUS_OPTIONS]
  // Whether the loaded mask has edits that aren't on disk. Derived here but
  // mirrored onto the pane (below) because App.tsx owns navigation and has to
  // be able to check it before loading something over the top.
  const hasUnsavedMaskChanges = !!pane.maskInfo && pane.editVersion !== pane.maskBaselineVersion
  const lastSavedAt = pane.lastSavedAt ? new Date(pane.lastSavedAt) : null

  useEffect(() => {
    if (pane.hasUnsavedMaskChanges !== hasUnsavedMaskChanges) {
      onChange({ hasUnsavedMaskChanges })
    }
  }, [hasUnsavedMaskChanges, pane.hasUnsavedMaskChanges, onChange])

  // Most-used reason tags first, so the picker surfaces what's actually
  // being picked as the session goes on. Only recomputed when the picker is
  // (re)opened, not on every render — reordering the list live while it's
  // open would shuffle options out from under the user mid-click.
  function computeReasonOptionsByFrequency(): string[] {
    const counts = new Map<string, number>()
    for (const row of pane.manifestRows) {
      for (const tag of row.reason) counts.set(tag, (counts.get(tag) || 0) + 1)
    }
    return [...pane.reasonOptions].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0))
  }

  function toggleReasonPicker() {
    setReasonPickerOpen((v) => {
      const next = !v
      if (next) setReasonOptionsSnapshot(computeReasonOptionsByFrequency())
      return next
    })
  }

  // Keep the editable case-counter box showing the current position, except
  // while the user is actively typing in it (don't stomp on their input).
  useEffect(() => {
    if (!counterFocused) {
      setCounterDraft(currentRowPos >= 0 ? String(currentRowPos + 1) : '')
    }
  }, [currentRowPos, counterFocused])

  useEffect(() => {
    return () => {
      if (cursorRafId.current !== null) cancelAnimationFrame(cursorRafId.current)
    }
  }, [])

  // A newly-loaded (or newly-created) mask starts "clean" — its baseline is
  // wherever editVersion happens to be right now (that pane-wide counter
  // keeps climbing across every mask this pane has ever touched, so it's
  // never itself a "changed since load" signal on its own).
  useEffect(() => {
    const id = pane.maskInfo?.volume_id ?? null
    if (id !== pane.maskBaselineVolumeId) {
      onChange({ maskBaselineVolumeId: id, maskBaselineVersion: pane.editVersion, lastSavedAt: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.maskInfo?.volume_id])

  // Contrast mode: whenever the loaded CT changes while contrast mode is on,
  // check for a previously-saved seed/threshold sidecar next to it and, if
  // found, recompute fresh from the current volume to both apply and verify
  // it (rather than trusting the saved threshold_hu blindly) — "we also
  // verify if the threshold matches the previous save as well."
  useEffect(() => {
    if (!pane.contrastMode || !pane.ctInfo || !pane.ctPath) return
    let cancelled = false
    const ctInfo = pane.ctInfo
    const ctPath = pane.ctPath
    ;(async () => {
      const saved = await loadContrastThreshold(ctPath, annotationSaveDir, ctInfo.dicom_series_uid).catch(() => null)
      if (cancelled) return
      if (!saved) {
        // No seed saved for this scan yet — don't carry over whatever
        // threshold the previously-viewed case left behind, reset to the
        // same 130 HU default a fresh non-contrast pane starts with.
        onChange({
          contrastThreshold: null,
          contrastThresholdLocked: false,
          contrastMeta: null,
          pendingSeed: null,
          thresholdValue: DEFAULT_THRESHOLD_HU,
          thresholdEnabled: false,
          editThresholdMin: DEFAULT_THRESHOLD_HU,
          editRegionGrowThreshold: DEFAULT_THRESHOLD_HU,
          volumeScores: null,
        })
        return
      }
      try {
        const recomputed = await computeContrastThreshold({
          ctId: ctInfo.volume_id,
          plane: saved.plane,
          index: saved.index,
          row: saved.row,
          col: saved.col,
          targetVolumeMm3: saved.targetVolumeMm3,
          kMultiplier: saved.kMultiplier,
          save: false,
        })
        if (cancelled) return
        const mismatch = Math.abs(recomputed.thresholdHu - saved.thresholdHu) > 0.5
        onChange({
          contrastThreshold: recomputed.thresholdHu,
          contrastThresholdLocked: true,
          thresholdValue: recomputed.thresholdHu,
          thresholdEnabled: true,
          editThresholdMin: recomputed.thresholdHu,
          editRegionGrowThreshold: recomputed.thresholdHu,
          pendingSeed: { plane: saved.plane, index: saved.index, row: saved.row, col: saved.col },
          contrastMeta: {
            meanHu: recomputed.meanHu,
            stdHu: recomputed.stdHu,
            voxelCount: recomputed.voxelCount,
            actualVolumeMm3: recomputed.actualVolumeMm3,
            targetVolumeMm3: recomputed.targetVolumeMm3,
            kMultiplier: recomputed.kMultiplier,
            radiusMm: recomputed.radiusMm,
            savedAt: saved.savedAt || '',
            mismatch,
          },
        })
      } catch (e) {
        if (!cancelled) setContrastError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.contrastMode, pane.ctInfo?.volume_id])

  // Loads one resolved CT directory+series. Shared by the initial CT load
  // (below) and by series-stepping (stepSeries), so both go through the
  // same reset-everything-mask-related logic.
  async function loadCtEntry(directory: string, seriesUid?: string) {
    onChange({ loading: true, loadingMessage: 'Loading CT scan...', error: null })
    try {
      const info = await loadVolume(directory, false, false, seriesUid)
      onChange({
        ctPath: directory,
        ctInfo: info,
        loading: false,
        loadingMessage: null,
        index: Math.floor(info.plane_lengths[pane.plane] / 2),
        // A mask (and anything computed against it) belongs to whatever CT
        // it was created/loaded for — carrying it over to a different scan
        // left stale, unsaved annotations silently attached to the wrong
        // volume. Batch/manifest navigation (App.tsx's loadRowIntoPane)
        // already does this; the single-scan "Load CT" button needs it too.
        maskPath: '',
        maskInfo: null,
        maskAnnotationType: null,
        maskWarning: null,
        editMode: false,
        lesionResults: [],
        volumeScores: null,
        agatstonScores: null,
        maskSource: null,
        hasUnsavedMaskChanges: false,
        maskBaselineVolumeId: null,
        maskBaselineVersion: 0,
        lastSavedAt: null,
        // Contrast state belongs to the scan it was derived from, never to
        // the next one. Cleared here and re-established below from what is
        // actually recorded for the newly-loaded scan.
        seedPlacementMode: false,
        pendingSeed: null,
        contrastThreshold: null,
        contrastThresholdLocked: false,
        contrastMeta: null,
        annotationLookup: null,
        contrastNotice: null,
      })
      await onApplyContrastEvidence(directory, info)
    } catch (e) {
      onChange({ loading: false, loadingMessage: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  async function doLoadCt(path: string) {
    const { directory, seriesUid, seriesList } = await resolveDicomLoad(path)
    onChange({
      dicomSeriesList: seriesList.length > 1 ? seriesList : [],
      dicomSeriesIndex: seriesList.length > 1 ? 0 : null,
    })
    await loadCtEntry(directory, seriesUid)
  }

  // Series Previous/Next (only relevant when doLoadCt found >1 series in the
  // loaded DICOM folder — see the series-nav-tabs bar below). Reuses the
  // same "Before you move on..." unsaved-mask-edits confirmation as manifest
  // case navigation, rather than a parallel modal.
  function requestSeriesStep(direction: 1 | -1) {
    if (hasUnsavedMaskChanges) {
      setSeriesStepDirection(direction)
    } else {
      stepSeries(direction)
    }
  }

  function confirmSeriesStep() {
    if (seriesStepDirection !== null) stepSeries(seriesStepDirection)
    setSeriesStepDirection(null)
  }

  function stepSeries(direction: 1 | -1) {
    const idx = pane.dicomSeriesIndex
    if (idx === null) return
    const next = idx + direction
    if (next < 0 || next >= pane.dicomSeriesList.length) return
    const entry = pane.dicomSeriesList[next]
    onChange({ dicomSeriesIndex: next })
    loadCtEntry(entry.directory, entry.seriesUid)
  }

  async function doLoadMask(path: string) {
    onChange({ loading: true, loadingMessage: 'Loading mask...', error: null })
    try {
      const info = await loadVolume(path, true)
      // A mask of different geometry cannot be shown or edited against this
      // CT — every slice index would silently mean a different slice in each
      // volume, and painting would write to the wrong one and save it.
      const mismatch = pane.ctInfo ? detectGeometryMismatch(pane.ctInfo, info) : null
      if (mismatch) {
        onChange({ loading: false, loadingMessage: null, error: mismatch })
        return
      }
      onChange({
        maskPath: path,
        maskInfo: info,
        maskSource: 'manual',
        maskAnnotationType: inferMaskAnnotationType(path),
        maskWarning: detectMaskLooksLikeCt(info, pane.ctPath, path),
        loading: false,
        loadingMessage: null,
        showMask: true,
      })
    } catch (e) {
      onChange({ loading: false, loadingMessage: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // The Contrast toggle can unload the loaded mask when its annotation type
  // no longer matches. That used to happen with no warning at all, taking any
  // unsaved edits with it.
  function requestContrastToggle(checked: boolean) {
    const willUnload = !!pane.maskInfo && !!pane.maskAnnotationType &&
      pane.maskAnnotationType !== (checked ? 'contrast' : 'non-contrast')
    if (willUnload && hasUnsavedMaskChanges) {
      setContrastUnloadPending(checked)
      return
    }
    applyContrastToggle(checked)
  }

  function applyContrastToggle(checked: boolean) {
    setContrastUnloadPending(null)
    // Record the answer so the next session doesn't have to rely on anyone
    // remembering to tick this box again — that is exactly how a contrast
    // scan ended up annotated against the fixed 130 HU threshold.
    if (currentRow && pane.manifestConfig.manifestPath && pane.manifestConfig.contrastColumn) {
      saveManifestContrast(
        pane.manifestConfig.manifestPath,
        currentRow.index,
        pane.manifestConfig.contrastColumn,
        checked,
      )
        .then(() => {
          onChange({
            manifestRows: pane.manifestRows.map((r) =>
              r.index === currentRow.index ? { ...r, contrast: checked } : r,
            ),
          })
        })
        .catch((e) => onChange({ manifestError: e instanceof Error ? e.message : String(e) }))
    }
    // A mask painted under the other threshold basis isn't meaningful here —
    // contrast annotations are gated by a per-scan computed threshold, non-
    // contrast by the fixed 130 HU, so a label boundary drawn under one
    // doesn't mean the same thing under the other. Only unload on a
    // *confirmed* mismatch; an unknown type (e.g. a mask from outside this
    // app) is left alone rather than guessed at and discarded.
    const mismatched = !!pane.maskInfo && !!pane.maskAnnotationType &&
      pane.maskAnnotationType !== (checked ? 'contrast' : 'non-contrast')
    const unload: Partial<PaneState> = mismatched
      ? {
          maskPath: '',
          maskInfo: null,
          maskAnnotationType: null,
          maskSource: null,
          hasUnsavedMaskChanges: false,
          maskBaselineVolumeId: null,
          maskBaselineVersion: 0,
          editMode: false,
          lesionResults: [],
          volumeScores: null,
          agatstonScores: null,
          editMessage: `Unloaded the mask - it was annotated ${pane.maskAnnotationType === 'contrast' ? 'with' : 'without'} contrast mode, which no longer matches.`,
        }
      : {}

    if (checked) {
      onChange({
        contrastMode: true,
        editMode: mismatched ? false : pane.editMode,
        scoreComputeMode: false,
        contrastNotice: pane.contrastThreshold
          ? null
          : 'Contrast mode is on but no threshold has been derived for this scan yet. Place and finalize a seed before annotating.',
        ...unload,
      })
    } else {
      // Leaving contrast mode clears the seed/sphere and the computed
      // threshold — it shouldn't keep driving the render overlay / paint /
      // region-grow HU fields once contrast mode is off.
      onChange({
        contrastMode: false,
        seedPlacementMode: false,
        pendingSeed: null,
        contrastThreshold: null,
        contrastThresholdLocked: false,
        contrastMeta: null,
        volumeScores: null,
        thresholdValue: DEFAULT_THRESHOLD_HU,
        thresholdEnabled: false,
        editThresholdMin: DEFAULT_THRESHOLD_HU,
        editRegionGrowThreshold: DEFAULT_THRESHOLD_HU,
        contrastNotice: null,
        ...unload,
      })
    }
  }

  function toggleSeedPlacement() {
    const next = !pane.seedPlacementMode
    onChange(next ? { seedPlacementMode: true, editMode: false, scoreComputeMode: false } : { seedPlacementMode: false })
  }

  async function finalizeSeed() {
    if (!pane.ctInfo || !pane.pendingSeed) return
    setContrastSaving(true)
    setContrastError(null)
    try {
      const result = await computeContrastThreshold({
        ctId: pane.ctInfo.volume_id,
        plane: pane.pendingSeed.plane,
        index: pane.pendingSeed.index,
        row: pane.pendingSeed.row,
        col: pane.pendingSeed.col,
        targetVolumeMm3: contrastSettings.targetVolumeMm3,
        kMultiplier: contrastSettings.kMultiplier,
        save: true,
        ctPath: pane.ctPath,
        maskPath: pane.maskPath || null,
        patientId: currentRow?.patient_id || null,
        saveDir: annotationSaveDir || null,
      })
      onChange({
        contrastThreshold: result.thresholdHu,
        contrastThresholdLocked: true,
        seedPlacementMode: false,
        thresholdValue: result.thresholdHu,
        thresholdEnabled: true,
        editThresholdMin: result.thresholdHu,
        editRegionGrowThreshold: result.thresholdHu,
        contrastMeta: {
          meanHu: result.meanHu,
          stdHu: result.stdHu,
          voxelCount: result.voxelCount,
          actualVolumeMm3: result.actualVolumeMm3,
          targetVolumeMm3: result.targetVolumeMm3,
          kMultiplier: result.kMultiplier,
          radiusMm: result.radiusMm,
          savedAt: result.savedAt || new Date().toISOString(),
          mismatch: false,
        },
        contrastNotice: null,
      })
      // A finalized seed is itself the record that this scan is contrast —
      // mirror it into the manifest so the next session knows before loading.
      if (currentRow && pane.manifestConfig.manifestPath && pane.manifestConfig.contrastColumn) {
        saveManifestContrast(
          pane.manifestConfig.manifestPath,
          currentRow.index,
          pane.manifestConfig.contrastColumn,
          true,
        ).catch(() => {
          /* advisory only — the seed sidecar is the authoritative record */
        })
      }
    } catch (e) {
      setContrastError(e instanceof Error ? e.message : String(e))
    } finally {
      setContrastSaving(false)
    }
  }

  function reSeed() {
    onChange({
      contrastThreshold: null,
      contrastThresholdLocked: false,
      contrastMeta: null,
      pendingSeed: null,
      seedPlacementMode: true,
      editMode: false,
      scoreComputeMode: false,
      contrastNotice: 'No threshold is active while re-seeding — finalize a seed before annotating.',
    })
  }

  async function doCreateMask() {
    if (!pane.ctInfo) return
    onChange({ loading: true, loadingMessage: 'Creating new mask...', error: null })
    try {
      const info = await createBlankMask(pane.ctInfo.volume_id)
      onChange({
        maskPath: '',
        maskInfo: info,
        maskSource: 'new',
        // Unambiguous: a brand-new mask's annotation type is exactly
        // whatever mode is active right now, no filename guessing needed.
        maskAnnotationType: pane.contrastMode ? 'contrast' : 'non-contrast',
        maskWarning: null,
        loading: false,
        loadingMessage: null,
        showMask: true,
        editMode: true,
      })
    } catch (e) {
      onChange({ loading: false, loadingMessage: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  async function doSaveMask(resolution?: 'overwrite' | 'new_copy') {
    if (!pane.maskInfo || !pane.ctPath) return
    onChange({ editBusy: true, editMessage: null })
    try {
      const res = await saveMask({
        maskId: pane.maskInfo.volume_id,
        // Derived from the CT, not from the loaded mask: a path built from
        // the mask's own name grew another suffix every session and orphaned
        // the previous save.
        ctPath: pane.ctPath,
        seriesUid: pane.ctInfo?.dicom_series_uid ?? null,
        saveDir: annotationSaveDir || null,
        annotationType: pane.contrastMode ? 'contrast' : 'non-contrast',
        patientId: currentRow?.patient_id || null,
        resolution: resolution || null,
      })

      if (res.status === 'conflict') {
        // Nothing was written. Ask, then call back with the answer.
        setSaveConflict(res)
        onChange({ editBusy: false })
        return
      }

      let message = `Saved to ${res.path}`
      onChange({
        maskBaselineVolumeId: pane.maskInfo.volume_id,
        maskBaselineVersion: pane.editVersion,
        hasUnsavedMaskChanges: false,
        lastSavedAt: new Date().toISOString(),
      })

      // Record where this case's annotation now lives, in its own column —
      // ALWAYS, not just when the row had no mask. Skipping it for rows that
      // already had a mask is what made every previous session's work
      // invisible on the next visit (and overwritten by the next save).
      if (currentRow && pane.manifestConfig.manifestPath && pane.manifestConfig.annotationColumn) {
        try {
          await saveManifestAnnotationPath(
            pane.manifestConfig.manifestPath,
            currentRow.index,
            pane.manifestConfig.annotationColumn,
            res.path,
          )
          onChange({
            maskPath: res.path,
            maskSource: 'annotation',
            manifestRows: pane.manifestRows.map((r) =>
              r.index === currentRow.index ? { ...r, annotation_path: res.path, annotation_exists: true } : r,
            ),
          })
        } catch (e) {
          message += ` (but failed to record it in the manifest: ${e instanceof Error ? e.message : String(e)})`
        }
      } else {
        onChange({ maskPath: res.path, maskSource: 'annotation' })
      }
      onChange({ editBusy: false, editMessage: message })
    } catch (e) {
      onChange({ editBusy: false, editMessage: e instanceof Error ? e.message : String(e) })
    }
  }

  // Reverts to the last actually-saved-to-disk state: a brand new (never
  // saved) mask goes back to blank; an existing one is force-reloaded from
  // its on-disk path, discarding every in-memory edit since it was loaded
  // (Save always writes to a differently-named file, so the original path
  // never changes underneath it — reloading it is exactly "last saved").
  async function doResetMask() {
    if (!pane.ctInfo || !pane.maskInfo) return
    onChange({ loading: true, loadingMessage: 'Resetting mask...', error: null, editMessage: null })
    try {
      if (pane.maskInfo.is_new_mask) {
        const info = await createBlankMask(pane.ctInfo.volume_id)
        onChange({
          maskPath: '',
          maskInfo: info,
          loading: false,
          loadingMessage: null,
          editVersion: pane.editVersion + 1,
          editMessage: 'Reset to blank',
        })
      } else {
        const info = await loadVolume(pane.maskPath, true, true, pane.maskInfo?.dicom_series_uid ?? undefined)
        const nextVersion = pane.editVersion + 1
        onChange({
          maskInfo: info,
          loading: false,
          loadingMessage: null,
          editVersion: nextVersion,
          editMessage: 'Reset to last saved state',
          maskBaselineVolumeId: info.volume_id,
          maskBaselineVersion: nextVersion,
          hasUnsavedMaskChanges: false,
          lastSavedAt: null,
        })
      }
    } catch (e) {
      onChange({ loading: false, loadingMessage: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // Not a persistent toggle — just a shortcut that sets the active label to
  // Background, since Brush/RG already paint with whatever editActiveLabel
  // is, so this makes the very next stroke (in either tool) an erase. The
  // Label dropdown reflects it immediately since it's driven by this same
  // editActiveLabel value.
  function doErase() {
    onChange({ editActiveLabel: 0 })
  }

  // Guarded on whether anything actually CHANGED, not on whether the
  // annotation checkbox happens to be ticked. The old `editMode && maskInfo`
  // test both cried wolf when nothing had changed and — worse — stayed silent
  // whenever edit mode had been switched off with edits still pending, which
  // several other controls do on their own (seed placement, re-seed, score
  // compute mode).
  function requestNavigate(direction: 1 | -1) {
    if (hasUnsavedMaskChanges) {
      setNavModalDirection(direction)
    } else {
      onNavigate(direction)
    }
  }

  function confirmNavigate() {
    if (navModalDirection !== null) onNavigate(navModalDirection)
    setNavModalDirection(null)
  }

  function requestJumpToPosition(targetPos: number) {
    if (hasUnsavedMaskChanges) {
      setJumpPos(targetPos)
    } else {
      onJumpTo(targetPos)
    }
  }

  function confirmJump() {
    if (jumpPos !== null) onJumpTo(jumpPos)
    setJumpPos(null)
  }

  // The case dropdown in the settings panel used to load straight over the
  // top with no prompt at all, unlike Prev/Next and the jump box.
  function requestSelectRow(rowIndex: number) {
    const pos = pane.manifestRows.findIndex((r) => r.index === rowIndex)
    if (pos < 0) return
    requestJumpToPosition(pos)
  }

  function submitCounterJump() {
    const trimmed = counterDraft.trim()
    const n = Number(trimmed)
    const total = pane.manifestRows.length
    if (trimmed === '' || !Number.isInteger(n) || n < 1 || n > total) {
      setCounterError(`Enter a whole number between 1 and ${total}.`)
      setCounterDraft(currentRowPos >= 0 ? String(currentRowPos + 1) : '')
      return
    }
    const targetPos = n - 1
    if (targetPos !== currentRowPos) requestJumpToPosition(targetPos)
  }

  async function handleSetStatus(status: string) {
    if (!currentRow) return
    setStatusSaving(true)
    setStatusError(null)
    try {
      await saveManifestStatus(
        pane.manifestConfig.manifestPath,
        currentRow.index,
        status,
        pane.manifestConfig.statusColumn,
      )
      onChange({
        manifestRows: pane.manifestRows.map((r) => (r.index === currentRow.index ? { ...r, status } : r)),
      })
      setStatusSaving(false)
    } catch (e) {
      setStatusSaving(false)
      setStatusError(e instanceof Error ? e.message : String(e))
    }
  }

  function openCommentModal() {
    setCommentDraft(currentRow?.comment || '')
    setCommentError(null)
    setCommentOpen(true)
  }

  async function handleSaveComment() {
    if (!currentRow) return
    setCommentSaving(true)
    setCommentError(null)
    try {
      await saveManifestComment(pane.manifestConfig.manifestPath, currentRow.index, commentDraft)
      onChange({
        manifestRows: pane.manifestRows.map((r) =>
          r.index === currentRow.index ? { ...r, comment: commentDraft } : r,
        ),
      })
      setCommentSaving(false)
      setCommentOpen(false)
    } catch (e) {
      setCommentSaving(false)
      setCommentError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleToggleReason(tag: string) {
    if (!currentRow) return
    const next = currentRow.reason.includes(tag)
      ? currentRow.reason.filter((t) => t !== tag)
      : [...currentRow.reason, tag]
    // Optimistic — the picker reads straight from manifestRows so it needs
    // to reflect the click immediately, not just after the round trip.
    onChange({
      manifestRows: pane.manifestRows.map((r) => (r.index === currentRow.index ? { ...r, reason: next } : r)),
    })
    try {
      await saveManifestReason(pane.manifestConfig.manifestPath, currentRow.index, next, pane.manifestConfig.reasonColumn)
    } catch (e) {
      onChange({ manifestError: e instanceof Error ? e.message : String(e) })
    }
  }

  async function handleCopyToOtherPane() {
    if (!onCopyToOtherPane) return
    setCopyingToOtherPane(true)
    try {
      await onCopyToOtherPane()
    } finally {
      setCopyingToOtherPane(false)
    }
  }

  function handleAddReasonTag(tag: string) {
    // Session-only: added to this pane's option list so it's pickable
    // right away, but never written anywhere until actually assigned to a
    // row (handleToggleReason below does that, and that's what persists).
    if (!pane.reasonOptions.includes(tag)) {
      onChange({ reasonOptions: [...pane.reasonOptions, tag] })
    }
    // Append rather than re-sort the open picker's list — the frequency
    // order is frozen while it's open (see toggleReasonPicker) so a new tag
    // just needs to appear, not trigger a reshuffle of everything else.
    if (!reasonOptionsSnapshot.includes(tag)) {
      setReasonOptionsSnapshot([...reasonOptionsSnapshot, tag])
    }
    if (!currentRow?.reason.includes(tag)) {
      handleToggleReason(tag)
    }
  }

  function getDisplayCoords(clientX: number, clientY: number): { row: number; col: number } | null {
    const img = imgRef.current
    if (!img) return null
    const rect = img.getBoundingClientRect()
    const relX = (clientX - rect.left) / rect.width
    const relY = (clientY - rect.top) / rect.height
    if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null
    return { col: relX * img.naturalWidth, row: relY * img.naturalHeight }
  }

  // Contrast scans have no meaningful fixed threshold, so annotating one
  // before a seed has been finalized would silently produce labels drawn
  // against the 130 HU non-contrast value. Refuse instead.
  function annotationBlockedReason(): string | null {
    if (pane.contrastMode && pane.contrastThreshold === null) {
      return 'No contrast threshold yet — place and finalize a seed before annotating this scan.'
    }
    return null
  }

  async function doPaint(row: number, col: number, forceRefresh = false) {
    if (!pane.ctInfo || !pane.maskInfo) return
    const blocked = annotationBlockedReason()
    if (blocked) {
      onChange({ editMessage: blocked })
      return
    }
    const erasing = paintDrag.current.erasing
    try {
      await paintMask({
        maskId: pane.maskInfo.volume_id,
        ctId: pane.ctInfo.volume_id,
        plane: pane.plane,
        index: pane.index,
        row,
        col,
        radius: pane.editBrushRadius,
        newLabel: erasing ? 0 : pane.editActiveLabel,
        overwriteMode: erasing ? 'any' : pane.editOverwriteMode,
        overwriteLabel: pane.editOverwriteLabel,
        thresholdMin: pane.editThresholdMin,
      })
      paintDrag.current.didPaint = true
      // Mutations are cheap (~5ms) but each visual refresh re-encodes a full
      // PNG (tens of ms) — so during a drag we keep mutating on every dab
      // but only pull a fresh image at a capped rate, or the render requests
      // queue up faster than the server can produce them. forceRefresh
      // (mousedown's first dab, and mouseup's final catch-up) bypasses that.
      const now = performance.now()
      if (forceRefresh || now - lastRenderBumpTs.current >= 100) {
        lastRenderBumpTs.current = now
        onChange({ editVersion: pane.editVersion + 1 })
      }
    } catch (e) {
      // Previously swallowed entirely. A dead backend, a geometry mismatch,
      // or a mask that fell out of the server's cache then looked exactly
      // like a successful brush stroke: the user kept painting and nothing
      // was being recorded anywhere.
      onChange({ editMessage: e instanceof Error ? e.message : String(e) })
    }
  }

  async function doRegionGrow(row: number, col: number, searchRadiusMm?: number) {
    if (!pane.ctInfo || !pane.maskInfo) return
    const blocked = annotationBlockedReason()
    if (blocked) {
      onChange({ editMessage: blocked })
      return
    }
    try {
      const res = await regionGrowMask({
        maskId: pane.maskInfo.volume_id,
        ctId: pane.ctInfo.volume_id,
        plane: pane.plane,
        index: pane.index,
        row,
        col,
        thresholdMin: pane.editRegionGrowThreshold,
        newLabel: pane.editActiveLabel,
        searchRadiusMm,
      })
      onChange({
        editVersion: pane.editVersion + 1,
        maskInfo: { ...pane.maskInfo, labels: res.labels },
        editMessage: `Region grow changed ${res.changed} voxels`,
      })
    } catch (e) {
      onChange({ editMessage: e instanceof Error ? e.message : String(e) })
    }
  }

  // Coronary labels (1-3, LAD/LCx/RCA) are scored against the aggregate CAC
  // total; every other label (4-6, TAC/AV/MV) is scored against its own
  // class's total instead — each maps onto exactly one score class.
  function targetClassForLabel(label: number): ScoreClass {
    return CORONARY_LABELS.includes(label) ? 'CAC' : SCORE_CLASS_BY_LABEL[label - 1]
  }

  function flashRow(id: number) {
    if (flashTimeoutRef.current !== null) window.clearTimeout(flashTimeoutRef.current)
    setFlashRowId(id)
    flashTimeoutRef.current = window.setTimeout(() => setFlashRowId(null), 1700)
  }

  function showJumpMarker(row: number, col: number) {
    const img = imgRef.current
    const el = jumpMarkerRef.current
    const container = viewerAreaRef.current
    if (!img || !el || !container) return
    const imgRect = img.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const scaleX = imgRect.width / (img.naturalWidth || 1)
    const scaleY = imgRect.height / (img.naturalHeight || 1)
    const x = imgRect.left - containerRect.left + col * scaleX
    const y = imgRect.top - containerRect.top + row * scaleY
    el.hidden = false
    el.style.transform = `translate(${x}px, ${y}px)`
    if (jumpMarkerTimeoutRef.current !== null) window.clearTimeout(jumpMarkerTimeoutRef.current)
    jumpMarkerTimeoutRef.current = window.setTimeout(() => {
      el.hidden = true
    }, 1600)
  }

  // Positions the (persistent, non-fading) seed marker — same math as
  // showJumpMarker above, but re-run on every relevant change via the effect
  // below rather than a one-shot timeout, since the seed stays put until
  // re-seeded. Also sizes/positions the sphere-VOI preview circle: before
  // finalizing, its radius is only an ESTIMATE from the target volume alone
  // (r = (3V/4pi)^(1/3) — no per-scan data needed, so it can be shown live as
  // soon as a seed is placed); once finalized, contrastMeta.radiusMm is the
  // server's actual *emergent* radius — the farthest voxel it needed to
  // reach to hit the target voxel count exactly (see compute_sphere_stats in
  // contrast_threshold.py) — which is close to but not identical to the
  // formula estimate, and is what actually determines the sampled voxels.
  //
  // The circle is a true spherical cross-section, shown on WHICHEVER plane
  // and slice is currently being viewed (not just the plane the seed was
  // originally placed on) — the seed's display click is first converted to
  // its full 3D voxel index (seedDisplayToVoxel, mirroring the server's
  // _seed_index_3d), then re-projected onto the current plane
  // (projectVoxelToPlaneDisplay) to get where the circle's center belongs on
  // screen right now. Its radius shrinks per the sphere equation
  // r_slice = sqrt(r^2 - d^2), where d is the physical distance (mm) from
  // the current slice to the seed's own slice along the current plane's
  // normal axis (seedIndexAlongPlane) — shrinking to a point at the sphere's
  // poles and disappearing once d exceeds r. The crosshair marker itself
  // still only shows on the exact plane+slice the seed was placed on (it's a
  // precise placement target, not "this slice is somewhere in the VOI").
  function updateSeedMarkerPosition() {
    const img = imgRef.current
    const el = seedMarkerRef.current
    const sphereEl = seedSphereRef.current
    const container = viewerAreaRef.current
    if (!img || !el || !container) return
    const seed = pane.pendingSeed
    if (!seed || !pane.ctInfo) {
      el.hidden = true
      if (sphereEl) sphereEl.hidden = true
      return
    }
    const imgRect = img.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const scaleX = imgRect.width / (img.naturalWidth || 1)
    const scaleY = imgRect.height / (img.naturalHeight || 1)

    el.hidden = !(seed.plane === pane.plane && seed.index === pane.index)
    if (!el.hidden) {
      const mx = imgRect.left - containerRect.left + seed.col * scaleX
      const my = imgRect.top - containerRect.top + seed.row * scaleY
      el.style.transform = `translate(${mx}px, ${my}px)`
    }

    if (sphereEl) {
      const voxel = seedDisplayToVoxel(pane.ctInfo.plane_lengths, pane.ctInfo.spacing_lps, seed)
      const radiusMm = pane.contrastMeta?.radiusMm ?? sphereRadiusMmFromVolume(contrastSettings.targetVolumeMm3)
      const stepMm = planeIndexSpacingMm(pane.ctInfo.spacing_lps, pane.plane)
      const distMm = Math.abs(pane.index - seedIndexAlongPlane(voxel, pane.plane)) * stepMm
      if (distMm > radiusMm) {
        sphereEl.hidden = true
      } else {
        const sliceRadiusMm = Math.sqrt(radiusMm * radiusMm - distMm * distMm)
        const finestSpacing = Math.min(...pane.ctInfo.spacing_lps) || 1
        // Every display pixel represents finestSpacing mm (the render
        // endpoint rescales each plane to isotropic pixels relative to the
        // volume's finest spacing axis — see get_plane_display_scale in
        // volume_store.py).
        const radiusNaturalPx = sliceRadiusMm / finestSpacing
        const diameterScreenPx = 2 * radiusNaturalPx * scaleX
        const proj = projectVoxelToPlaneDisplay(pane.ctInfo.plane_lengths, pane.ctInfo.spacing_lps, voxel, pane.plane)
        const cx = imgRect.left - containerRect.left + proj.col * scaleX
        const cy = imgRect.top - containerRect.top + proj.row * scaleY
        sphereEl.hidden = false
        sphereEl.style.width = `${diameterScreenPx}px`
        sphereEl.style.height = `${diameterScreenPx}px`
        sphereEl.style.transform = `translate(${cx - diameterScreenPx / 2}px, ${cy - diameterScreenPx / 2}px)`
      }
    }
  }

  useEffect(() => {
    updateSeedMarkerPosition()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pane.pendingSeed,
    pane.plane,
    pane.index,
    pane.zoom,
    pane.panX,
    pane.panY,
    pane.contrastMeta,
    contrastSettings.targetVolumeMm3,
  ])

  // The effect above only re-runs on viewer *state* changes, not on the
  // image/container's actual on-screen geometry — so toggling Settings,
  // entering split view, or resizing the window (none of which touch any of
  // those state fields) left the marker/circle stuck at their last computed
  // screen position until the next slice change happened to fire the effect
  // above. A ResizeObserver on both elements catches every such layout
  // change directly. Routed through a ref (rather than putting
  // updateSeedMarkerPosition itself in the deps) so this observer isn't
  // torn down and recreated on every render.
  const updateSeedMarkerPositionRef = useRef(updateSeedMarkerPosition)
  updateSeedMarkerPositionRef.current = updateSeedMarkerPosition

  useEffect(() => {
    const container = viewerAreaRef.current
    const img = imgRef.current
    if (!container || !img) return
    const ro = new ResizeObserver(() => updateSeedMarkerPositionRef.current())
    ro.observe(container)
    ro.observe(img)
    return () => ro.disconnect()
  }, [])

  // Global Shift tracking for the circle-seed preview cursor. Deliberately a
  // fresh window-level listener rather than reusing the keybind effect
  // above (or below) it, which bails out whenever document.activeElement is
  // an INPUT/TEXTAREA/SELECT — the Score/Volume Compute checkbox
  // (LesionScoreBox.tsx) is exactly such an input, so tracking Shift there
  // would silently stop working right after the user clicks it. This only
  // toggles the preview-cursor boolean; the actual click/scroll handlers
  // read e.shiftKey directly off the native event instead.
  useEffect(() => {
    function handleShiftDown(e: KeyboardEvent) {
      if (e.key === 'Shift') setShiftHeld(true)
    }
    function handleShiftUp(e: KeyboardEvent) {
      if (e.key === 'Shift') setShiftHeld(false)
    }
    function handleBlur() {
      setShiftHeld(false) // window/tab lost focus while Shift was held — don't get stuck
    }
    window.addEventListener('keydown', handleShiftDown)
    window.addEventListener('keyup', handleShiftUp)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('keydown', handleShiftDown)
      window.removeEventListener('keyup', handleShiftUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [])

  function jumpToLesion(entry: LesionScoreResult) {
    const samePlaneAndIndex = pane.plane === entry.plane && pane.index === entry.index
    if (samePlaneAndIndex) {
      showJumpMarker(entry.row, entry.col)
    } else {
      pendingJumpMarkerRef.current = { row: entry.row, col: entry.col }
      onChange({ plane: entry.plane, index: entry.index })
    }
  }

  function applyScoreResult(
    label: number,
    voxelCount: number,
    agatstonScore: number,
    targetClass: ScoreClass,
    oldScore: number | null,
    scoreSource: 'manifest' | 'computed' | 'unavailable',
    plane: Plane,
    index: number,
    row: number,
    col: number,
  ) {
    lesionIdCounter.current += 1
    const entry: LesionScoreResult = {
      id: lesionIdCounter.current,
      label,
      voxelCount,
      metric: 'agatston',
      agatstonScore,
      targetClass,
      oldScore,
      newScore: oldScore !== null ? oldScore - agatstonScore : null,
      scoreSource,
      plane,
      index,
      row,
      col,
    }
    onChange({ lesionResults: [...pane.lesionResults, entry] })
  }

  function finishLesionScore(
    label: number,
    voxelCount: number,
    agatstonScore: number,
    plane: Plane,
    index: number,
    row: number,
    col: number,
  ) {
    const targetClass = targetClassForLabel(label)
    const volumeId = pane.maskInfo!.volume_id
    // editVersion is part of the key: the cached total is a property of the
    // mask's CONTENTS, and the volume id alone survives every edit and every
    // reset, so a stale total was being subtracted from long after the mask
    // it was computed from had changed.
    const cacheKey = `${volumeId}:${pane.editVersion}:${targetClass}`
    const cached = getCachedCac(cacheKey)
    if (cached) {
      applyScoreResult(label, voxelCount, agatstonScore, targetClass, cached.total, cached.source, plane, index, row, col)
      return
    }
    const manifestVal = currentRow?.scores?.[targetClass]
    if (manifestVal !== null && manifestVal !== undefined) {
      setCachedCac(cacheKey, manifestVal, 'manifest')
      applyScoreResult(label, voxelCount, agatstonScore, targetClass, manifestVal, 'manifest', plane, index, row, col)
      return
    }
    setScoreConfirmPending({ label, voxelCount, agatstonScore, targetClass, plane, index, row, col })
  }

  async function doLesionScore(row: number, col: number, searchRadiusMm?: number) {
    if (!pane.ctInfo || !pane.maskInfo) return
    onChange({ loading: true, loadingMessage: 'Computing lesion score...' })
    try {
      const res = await computeLesionScore({
        maskId: pane.maskInfo.volume_id,
        ctId: pane.ctInfo.volume_id,
        plane: pane.plane,
        index: pane.index,
        row,
        col,
        searchRadiusMm,
      })
      onChange({ loading: false, loadingMessage: null })
      if (!res.found || res.label === null) {
        setLesionNotFound(true)
        return
      }
      // Same 3D lesion already scored this session (identical label + voxel
      // count + score) — flash the existing row instead of appending a
      // duplicate one.
      const existing = pane.lesionResults.find(
        (r) => r.label === res.label && r.voxelCount === res.voxelCount && r.agatstonScore === res.agatstonScore,
      )
      if (existing) {
        flashRow(existing.id)
        return
      }
      finishLesionScore(res.label, res.voxelCount, res.agatstonScore, pane.plane, pane.index, row, col)
    } catch (e) {
      onChange({ loading: false, loadingMessage: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // Contrast mode's click-to-score path: same lesion-isolation call shape as
  // doLesionScore, but computes a physical volume (mm3) instead of an
  // Agatston score, and skips the manifest-baseline lookup/confirm-total
  // dance entirely — there's no "existing manifest volume" concept to
  // reconcile against, so every click just computes and appends fresh.
  async function doLesionVolume(row: number, col: number, searchRadiusMm?: number) {
    if (!pane.ctInfo || !pane.maskInfo || pane.contrastThreshold === null) return
    onChange({ loading: true, loadingMessage: 'Computing lesion volume...' })
    try {
      const res = await computeLesionVolume({
        maskId: pane.maskInfo.volume_id,
        ctId: pane.ctInfo.volume_id,
        plane: pane.plane,
        index: pane.index,
        row,
        col,
        huThreshold: pane.contrastThreshold,
        searchRadiusMm,
      })
      onChange({ loading: false, loadingMessage: null })
      if (!res.found || res.label === null) {
        setLesionNotFound(true)
        return
      }
      const existing = pane.lesionResults.find(
        (r) => r.metric === 'volume' && r.label === res.label && r.voxelCount === res.voxelCount,
      )
      if (existing) {
        flashRow(existing.id)
        return
      }
      lesionIdCounter.current += 1
      const entry: LesionScoreResult = {
        id: lesionIdCounter.current,
        label: res.label,
        voxelCount: res.voxelCount,
        metric: 'volume',
        agatstonScore: 0,
        volumeMm3: res.volumeMm3,
        targetClass: targetClassForLabel(res.label),
        oldScore: null,
        newScore: null,
        scoreSource: 'unavailable',
        plane: pane.plane,
        index: pane.index,
        row,
        col,
      }
      onChange({ lesionResults: [...pane.lesionResults, entry] })
    } catch (e) {
      onChange({ loading: false, loadingMessage: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // The Volume Compute box's "play" button: recomputes the total physical
  // volume (mm3) for every score class across the whole mask at once (CAC =
  // coronary labels 1-3 aggregated, TAC/AV/MV = labels 4/5/6 individually),
  // then opens the Score panel to show them — the volume-metric counterpart
  // of confirmComputeScore's per-class Agatston total, but for all classes in
  // one go rather than one at a time, since there's no manifest baseline to
  // reconcile against here.
  async function computeAllVolumeScores() {
    if (!pane.ctInfo || !pane.maskInfo || pane.contrastThreshold === null) return
    setComputingVolumeScores(true)
    try {
      const results = await Promise.all(
        VOLUME_SCORE_SPECS.map((s) =>
          computeVolumeTotal({
            maskId: pane.maskInfo!.volume_id,
            ctId: pane.ctInfo!.volume_id,
            labels: s.labels,
            huThreshold: pane.contrastThreshold!,
          }),
        ),
      )
      const volumeScores: Partial<Record<ScoreClass, number>> = {}
      VOLUME_SCORE_SPECS.forEach((s, i) => {
        volumeScores[s.cls] = results[i].totalVolumeMm3
      })
      onChange({ volumeScores, scorePanelOpen: true })
    } catch (e) {
      onChange({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setComputingVolumeScores(false)
    }
  }

  // Non-contrast counterpart: recomputes Agatston totals for every class at
  // once (same class/label groupings as the volume version above), rather
  // than the existing one-class-at-a-time confirmComputeScore flow — and
  // shows them in the Score panel even without a manifest `<CLASS>_Agatston`
  // baseline to compare against.
  async function computeAllAgatstonScores() {
    if (!pane.ctInfo || !pane.maskInfo) return
    setComputingVolumeScores(true)
    try {
      const results = await Promise.all(
        VOLUME_SCORE_SPECS.map((s) =>
          computeVolumeAgatston({
            maskId: pane.maskInfo!.volume_id,
            ctId: pane.ctInfo!.volume_id,
            labels: s.labels,
          }),
        ),
      )
      const agatstonScores: Partial<Record<ScoreClass, number>> = {}
      VOLUME_SCORE_SPECS.forEach((s, i) => {
        agatstonScores[s.cls] = results[i].totalScore
      })
      onChange({ agatstonScores, scorePanelOpen: true })
    } catch (e) {
      onChange({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setComputingVolumeScores(false)
    }
  }

  function computeAllScores() {
    if (pane.contrastMode) computeAllVolumeScores()
    else computeAllAgatstonScores()
  }

  async function confirmComputeScore() {
    if (!scoreConfirmPending || !pane.ctInfo || !pane.maskInfo) return
    setComputingScore(true)
    try {
      const labels = scoreConfirmPending.targetClass === 'CAC' ? CORONARY_LABELS : [scoreConfirmPending.label]
      const res = await computeVolumeAgatston({
        maskId: pane.maskInfo.volume_id,
        ctId: pane.ctInfo.volume_id,
        labels,
      })
      const cacheKey = `${pane.maskInfo.volume_id}:${pane.editVersion}:${scoreConfirmPending.targetClass}`
      setCachedCac(cacheKey, res.totalScore, 'computed')
      applyScoreResult(
        scoreConfirmPending.label,
        scoreConfirmPending.voxelCount,
        scoreConfirmPending.agatstonScore,
        scoreConfirmPending.targetClass,
        res.totalScore,
        'computed',
        scoreConfirmPending.plane,
        scoreConfirmPending.index,
        scoreConfirmPending.row,
        scoreConfirmPending.col,
      )
    } catch (e) {
      onChange({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setComputingScore(false)
      setScoreConfirmPending(null)
    }
  }

  function declineComputeScore() {
    if (!scoreConfirmPending) return
    applyScoreResult(
      scoreConfirmPending.label,
      scoreConfirmPending.voxelCount,
      scoreConfirmPending.agatstonScore,
      scoreConfirmPending.targetClass,
      null,
      'unavailable',
      scoreConfirmPending.plane,
      scoreConfirmPending.index,
      scoreConfirmPending.row,
      scoreConfirmPending.col,
    )
    setScoreConfirmPending(null)
  }

  function setPlane(plane: Plane) {
    if (!pane.ctInfo) {
      onChange({ plane })
      return
    }
    const len = pane.ctInfo.plane_lengths[plane]
    onChange({ plane, index: Math.min(pane.index, len - 1) })
  }

  // Wheel events can arrive in a rapid burst (a trackpad flick easily fires
  // many within one React batch) — computing the next zoom/index from the
  // `pane` prop would have every event in that burst read the same
  // not-yet-updated value and land on the same result instead of
  // compounding, making fast scroll-zoom/scroll-scrub silently "stick".
  // liveRef tracks the authoritative current value synchronously across a
  // burst; effects below resync it whenever the real value changes for any
  // other reason (slider drag, cross-pane sync, Prev/Next, plane switch).
  const liveRef = useRef({
    zoom: pane.zoom,
    index: pane.index,
    windowLevel: pane.windowLevel,
    windowWidth: pane.windowWidth,
    thresholdValue: pane.thresholdValue,
  })
  useEffect(() => {
    liveRef.current.zoom = pane.zoom
  }, [pane.zoom])
  useEffect(() => {
    liveRef.current.index = pane.index
  }, [pane.index, pane.plane])
  useEffect(() => {
    liveRef.current.windowLevel = pane.windowLevel
  }, [pane.windowLevel])
  useEffect(() => {
    liveRef.current.windowWidth = pane.windowWidth
  }, [pane.windowWidth])
  useEffect(() => {
    liveRef.current.thresholdValue = pane.thresholdValue
  }, [pane.thresholdValue])

  const onWheel = useCallback(
    (e: WheelEvent) => {
      // React 19 registers its delegated wheel listener as passive (matching
      // the browser default, for scroll perf), so e.preventDefault() here
      // silently no-ops and logs a console warning — the page/ancestor could
      // still scroll on every zoom/slice-scrub. Bypassed below by attaching
      // this as a real { passive: false } native listener instead of a JSX
      // onWheel prop. Because it's attached directly on viewerAreaRef (a
      // descendant of wherever React's own delegated listener lives), it
      // would otherwise fire before the W/L and overlay boxes' own onWheel
      // stopPropagation() guards get a chance to run — so re-check
      // isOverUIBox here rather than relying on propagation order.
      if (isOverUIBox(e.target)) return
      e.preventDefault()
      if (e.shiftKey && circleClickActiveRef.current) {
        // Shift+scroll resizes the circle-seed radius instead of scrubbing
        // slices — scoped to when the circle-seed feature is actually
        // relevant (Score/Volume-compute or Region-grow) so Shift held
        // incidentally during plain viewing doesn't silently disable slice
        // scroll with no visible reason.
        const delta = e.deltaY > 0 ? -SEED_RADIUS_STEP_MM : SEED_RADIUS_STEP_MM
        const next = Math.max(MIN_SEED_RADIUS_MM, Math.min(MAX_SEED_RADIUS_MM, seedRadiusRef.current + delta))
        seedRadiusRef.current = next
        setSeedRadiusMm(next)
        return
      }
      if (e.ctrlKey) {
        const factor = e.deltaY > 0 ? 0.9 : 1.1
        const next = Math.max(0.2, Math.min(10, liveRef.current.zoom * factor))
        liveRef.current.zoom = next
        onChange({ zoom: next })
      } else if (pane.ctInfo) {
        const len = pane.ctInfo.plane_lengths[pane.plane]
        const next = Math.max(0, Math.min(len - 1, liveRef.current.index + (e.deltaY > 0 ? 1 : -1)))
        liveRef.current.index = next
        onChange({ index: next })
      }
    },
    [pane.ctInfo, pane.plane, onChange],
  )

  useEffect(() => {
    const el = viewerAreaRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // Configurable keyboard shortcuts (see KeybindSettings), active only for
  // whichever pane was last clicked into (isActive — App.tsx tracks this
  // globally) and not while the user is typing in a text field/select
  // anywhere on the page. Slice-scrub uses the same liveRef.index as the
  // wheel handler so holding a key down (rapid key-repeat events) compounds
  // correctly instead of every repeat reading the same stale pane.index.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!isActive) return
      const active = document.activeElement as HTMLElement | null
      if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return

      if (pane.ctInfo && keybinds.prevSlice.some((c) => comboMatches(e, c))) {
        e.preventDefault()
        const len = pane.ctInfo.plane_lengths[pane.plane]
        const next = Math.max(0, Math.min(len - 1, liveRef.current.index - 1))
        liveRef.current.index = next
        onChange({ index: next })
        return
      }
      if (pane.ctInfo && keybinds.nextSlice.some((c) => comboMatches(e, c))) {
        e.preventDefault()
        const len = pane.ctInfo.plane_lengths[pane.plane]
        const next = Math.max(0, Math.min(len - 1, liveRef.current.index + 1))
        liveRef.current.index = next
        onChange({ index: next })
        return
      }
      if (keybinds.toggleMask.some((c) => comboMatches(e, c))) {
        e.preventDefault()
        onChange({ showMask: !pane.showMask })
        return
      }
      if (keybinds.toggleThresh.some((c) => comboMatches(e, c))) {
        e.preventDefault()
        onChange({ thresholdEnabled: !pane.thresholdEnabled })
        return
      }
      if (pane.manifestRows.length > 0 && keybinds.toggleReviewMode.some((c) => comboMatches(e, c))) {
        e.preventDefault()
        onToggleReviewMode()
        return
      }
      if (keybinds.toggleScoreComputeMode.some((c) => comboMatches(e, c))) {
        e.preventDefault()
        const next = !pane.scoreComputeMode
        onChange(next ? { scoreComputeMode: true, editMode: false } : { scoreComputeMode: false })
        return
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    isActive,
    keybinds,
    pane.ctInfo,
    pane.plane,
    pane.showMask,
    pane.thresholdEnabled,
    pane.manifestRows.length,
    pane.scoreComputeMode,
    onChange,
    onToggleReviewMode,
  ])

  function isOverUIBox(target: EventTarget | null): boolean {
    const node = target as Node | null
    if (!node) return false
    return Boolean(
      (wlBoxRef.current && wlBoxRef.current.contains(node)) ||
        (contrastBoxRef.current && contrastBoxRef.current.contains(node)) ||
        (editBoxRef.current && editBoxRef.current.contains(node)) ||
        (bottomLeftRef.current && bottomLeftRef.current.contains(node)) ||
        (scorePanelRef.current && scorePanelRef.current.contains(node)) ||
        (scoreComputeBoxRef.current && scoreComputeBoxRef.current.contains(node)),
    )
  }

  // MouseEvent.button (which button started the drag) uses 0=left/1=middle/2=right,
  // but MouseEvent.buttons (bitmask of currently-held buttons, checked on move to
  // self-heal a missed mouseup) uses 1=left/4=middle/2=right — these are NOT the
  // same numbering, so the two buttons that can start a pan need an explicit map.
  const PAN_BUTTON_MASK: Record<number, number> = { 0: 1, 1: 4 }

  function startPan(e: React.MouseEvent) {
    e.preventDefault()
    panDrag.current = {
      active: true,
      buttonMask: PAN_BUTTON_MASK[e.button] ?? 1,
      startX: e.clientX,
      startY: e.clientY,
      startPanX: pane.panX,
      startPanY: pane.panY,
    }
  }

  function onMouseDown(e: React.MouseEvent) {
    if (isOverUIBox(e.target)) return
    if (e.button === 1) {
      // Middle-click drag always pans, regardless of edit/score mode, since
      // left and right buttons are already spoken for in those modes.
      startPan(e)
      return
    }
    if (e.button === 2) {
      e.preventDefault()
      rightDrag.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        startZoom: pane.zoom,
        startLevel: pane.windowLevel,
        axis: null,
      }
      return
    }
    if (e.button === 0 && pane.seedPlacementMode && pane.ctInfo) {
      // Just record the candidate — never compute the sphere on the first
      // click, the user may take several tries to find the ostium/aorta
      // center before clicking "Finalize Seed".
      const coords = getDisplayCoords(e.clientX, e.clientY)
      if (coords) onChange({ pendingSeed: { plane: pane.plane, index: pane.index, row: coords.row, col: coords.col } })
      return
    }
    if (e.button === 0 && pane.scoreComputeMode && pane.ctInfo && pane.maskInfo) {
      const coords = getDisplayCoords(e.clientX, e.clientY)
      if (!coords) return
      const searchRadiusMm = e.shiftKey ? seedRadiusMm : undefined
      if (pane.contrastMode) doLesionVolume(coords.row, coords.col, searchRadiusMm)
      else doLesionScore(coords.row, coords.col, searchRadiusMm)
      return
    }
    if (e.button === 0 && !pane.editMode && !pane.scoreComputeMode && !pane.seedPlacementMode) {
      // Plain viewing (not painting/region-growing/lesion-scoring/seed
      // placement): left-drag pans too, so panning doesn't require a middle
      // mouse button.
      startPan(e)
      return
    }
    if (e.button === 0 && pane.editMode && pane.ctInfo && pane.maskInfo) {
      const coords = getDisplayCoords(e.clientX, e.clientY)
      if (!coords) return
      if (pane.editTool === 'brush') {
        paintDrag.current.active = true
        paintDrag.current.didPaint = false
        paintDrag.current.erasing = e.ctrlKey
        doPaint(coords.row, coords.col, true)
      } else {
        doRegionGrow(coords.row, coords.col, e.shiftKey ? seedRadiusMm : undefined)
      }
    }
  }

  function handleEditBoxDragStart(e: React.MouseEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    const box = editBoxRef.current
    if (!box) return
    const boxRect = box.getBoundingClientRect()
    editBoxDrag.current = {
      active: true,
      offsetX: e.clientX - boxRect.left,
      offsetY: e.clientY - boxRect.top,
    }
  }

  function handleScorePanelDragStart(e: React.MouseEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    const box = scorePanelRef.current
    if (!box) return
    const boxRect = box.getBoundingClientRect()
    scorePanelDrag.current = {
      active: true,
      offsetX: e.clientX - boxRect.left,
      offsetY: e.clientY - boxRect.top,
    }
  }

  function handleScoreComputeBoxDragStart(e: React.MouseEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    const box = scoreComputeBoxRef.current
    if (!box) return
    const boxRect = box.getBoundingClientRect()
    scoreComputeBoxDrag.current = {
      active: true,
      offsetX: e.clientX - boxRect.left,
      offsetY: e.clientY - boxRect.top,
    }
  }

  function rectsOverlap(
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  }

  // Applies pendingCursor.current to the DOM directly (no setState), run
  // inside a requestAnimationFrame so any number of mousemove events between
  // two rendered frames collapse into a single style write.
  function scheduleCursorApply() {
    if (cursorRafId.current !== null) return
    cursorRafId.current = requestAnimationFrame(() => {
      cursorRafId.current = null
      const el = cursorDivRef.current
      if (!el) return
      const p = pendingCursor.current
      if (!p) {
        el.hidden = true
        return
      }
      el.hidden = false
      el.classList.toggle('seed-radius-cursor', p.variant === 'seed-radius')
      el.style.width = `${p.diameter}px`
      el.style.height = `${p.diameter}px`
      el.style.transform = `translate(${p.x - p.diameter / 2}px, ${p.y - p.diameter / 2}px)`
    })
  }

  function hideCursor() {
    if (pendingCursor.current !== null) {
      pendingCursor.current = null
      scheduleCursorApply()
    }
  }

  // Last known mouse position over the viewer, so the circle-seed preview
  // cursor can be refreshed the instant Shift is pressed/released even if
  // the mouse itself hasn't moved yet (see the shiftHeld effect below) —
  // otherwise it would wait for the next mousemove to appear/disappear.
  const lastViewerMousePos = useRef<{ clientX: number; clientY: number } | null>(null)

  function updateSeedRadiusCursorAt(clientX: number, clientY: number) {
    const container = viewerAreaRef.current
    const img = imgRef.current
    if (!container || !img || !pane.ctInfo) return
    const containerRect = container.getBoundingClientRect()
    const imgRect = img.getBoundingClientRect()
    const scaleX = imgRect.width / (img.naturalWidth || 1)
    const finestSpacing = Math.min(...pane.ctInfo.spacing_lps) || 1
    const diameter = Math.max(8, 2 * (seedRadiusRef.current / finestSpacing) * scaleX)
    pendingCursor.current = {
      x: clientX - containerRect.left,
      y: clientY - containerRect.top,
      diameter,
      variant: 'seed-radius',
    }
    scheduleCursorApply()
  }

  useEffect(() => {
    if (!shiftHeld || !circleClickActive) {
      // Only hide if a seed-radius cursor is what's currently shown — don't
      // stomp on the brush cursor if that's active instead.
      if (pendingCursor.current?.variant === 'seed-radius') hideCursor()
      return
    }
    const pos = lastViewerMousePos.current
    if (pos) updateSeedRadiusCursorAt(pos.clientX, pos.clientY)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftHeld, circleClickActive])

  function onMouseMove(e: React.MouseEvent) {
    lastViewerMousePos.current = { clientX: e.clientX, clientY: e.clientY }
    // Self-heal against a missed mouseup (e.g. the button was released while
    // briefly outside the window, or a fast click dropped/coalesced the
    // event): if our own flag says a drag is still active but the browser
    // says the button that started it is no longer actually held, end the
    // drag right here instead of continuing to paint/zoom/drag wherever the
    // cursor travels next with no button down at all.
    if (paintDrag.current.active && !(e.buttons & 1)) onMouseUp()
    if (rightDrag.current.active && !(e.buttons & 2)) onMouseUp()
    if (editBoxDrag.current.active && !(e.buttons & 1)) onMouseUp()
    if (scorePanelDrag.current.active && !(e.buttons & 1)) onMouseUp()
    if (scoreComputeBoxDrag.current.active && !(e.buttons & 1)) onMouseUp()
    if (panDrag.current.active && !(e.buttons & panDrag.current.buttonMask)) onMouseUp()

    if (panDrag.current.active) {
      const dx = e.clientX - panDrag.current.startX
      const dy = e.clientY - panDrag.current.startY
      onChange({ panX: panDrag.current.startPanX + dx, panY: panDrag.current.startPanY + dy })
    }

    if (pane.editMode && pane.editTool === 'brush' && !isOverUIBox(e.target)) {
      const container = viewerAreaRef.current
      const img = imgRef.current
      if (container && img) {
        const containerRect = container.getBoundingClientRect()
        const imgRect = img.getBoundingClientRect()
        const scale = imgRect.width / (img.naturalWidth || 1)
        const diameter = Math.max(4, 2 * pane.editBrushRadius * scale)
        pendingCursor.current = { x: e.clientX - containerRect.left, y: e.clientY - containerRect.top, diameter, variant: 'brush' }
        scheduleCursorApply()
      }
    } else if (e.shiftKey && circleClickActive && pane.ctInfo && !isOverUIBox(e.target)) {
      // Shift+click circle-seed preview — same cursor DOM/RAF machinery as
      // the brush cursor above (mutually exclusive with it: this only
      // engages in Score/Volume-compute or Region-grow, brush's own branch
      // above already claims 'brush' edit mode).
      updateSeedRadiusCursorAt(e.clientX, e.clientY)
    } else {
      hideCursor()
    }

    if (editBoxDrag.current.active) {
      const container = viewerAreaRef.current
      const box = editBoxRef.current
      if (!container || !box) return
      const containerRect = container.getBoundingClientRect()
      const boxRect = box.getBoundingClientRect()
      let x = e.clientX - containerRect.left - editBoxDrag.current.offsetX
      let y = e.clientY - containerRect.top - editBoxDrag.current.offsetY
      x = Math.max(0, Math.min(containerRect.width - boxRect.width, x))
      y = Math.max(0, Math.min(containerRect.height - boxRect.height, y))

      const proposed = { x, y, w: boxRect.width, h: boxRect.height }
      const exclusions: { x: number; y: number; w: number; h: number }[] = []
      if (wlBoxRef.current) {
        const r = wlBoxRef.current.getBoundingClientRect()
        exclusions.push({ x: r.left - containerRect.left, y: r.top - containerRect.top, w: r.width, h: r.height })
      }
      if (bottomLeftRef.current) {
        const r = bottomLeftRef.current.getBoundingClientRect()
        exclusions.push({ x: r.left - containerRect.left, y: r.top - containerRect.top, w: r.width, h: r.height })
      }
      const blocked = exclusions.some((ex) => rectsOverlap(proposed, ex))
      if (!blocked) {
        onChange({ editBoxPos: { x, y } })
      }
      return
    }

    if (scoreComputeBoxDrag.current.active) {
      const container = viewerAreaRef.current
      const box = scoreComputeBoxRef.current
      if (!container || !box) return
      const containerRect = container.getBoundingClientRect()
      const boxRect = box.getBoundingClientRect()
      let x = e.clientX - containerRect.left - scoreComputeBoxDrag.current.offsetX
      let y = e.clientY - containerRect.top - scoreComputeBoxDrag.current.offsetY
      x = Math.max(0, Math.min(containerRect.width - boxRect.width, x))
      y = Math.max(0, Math.min(containerRect.height - boxRect.height, y))
      onChange({ scoreComputeBoxPos: { x, y } })
      return
    }

    if (scorePanelDrag.current.active) {
      const container = viewerAreaRef.current
      const box = scorePanelRef.current
      if (!container || !box) return
      const containerRect = container.getBoundingClientRect()
      const boxRect = box.getBoundingClientRect()
      let x = e.clientX - containerRect.left - scorePanelDrag.current.offsetX
      let y = e.clientY - containerRect.top - scorePanelDrag.current.offsetY
      x = Math.max(0, Math.min(containerRect.width - boxRect.width, x))
      y = Math.max(0, Math.min(containerRect.height - boxRect.height, y))
      onChange({ scorePanelPos: { x, y } })
      return
    }

    if (rightDrag.current.active) {
      const dx = e.clientX - rightDrag.current.startX
      const dy = e.clientY - rightDrag.current.startY
      // Axis-lock: decide zoom vs. brightness from whichever direction
      // dominates once the drag clears a small deadzone, then commit to
      // that axis for the rest of the drag — otherwise diagonal hand jitter
      // nudges both at once.
      if (rightDrag.current.axis === null) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
        rightDrag.current.axis = Math.abs(dy) > Math.abs(dx) ? 'zoom' : 'brightness'
      }
      if (rightDrag.current.axis === 'zoom') {
        const newZoom = Math.max(0.2, Math.min(10, rightDrag.current.startZoom * Math.exp(-dy * 0.01)))
        onChange({ zoom: newZoom })
      } else {
        onChange({ windowLevel: rightDrag.current.startLevel + dx })
      }
      return
    }
    if (paintDrag.current.active) {
      const now = performance.now()
      if (now - lastPaintTs.current < 40) return
      lastPaintTs.current = now
      const coords = getDisplayCoords(e.clientX, e.clientY)
      if (coords) doPaint(coords.row, coords.col)
      return
    }
    const img = imgRef.current
    if (!img || !pane.ctInfo) return
    const now = performance.now()
    if (now - lastProbeTs.current < 80) return
    lastProbeTs.current = now
    const rect = img.getBoundingClientRect()
    const relX = (e.clientX - rect.left) / rect.width
    const relY = (e.clientY - rect.top) / rect.height
    if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return
    const col = Math.floor(relX * img.naturalWidth)
    const row = Math.floor(relY * img.naturalHeight)
    probeVoxel({
      ctId: pane.ctInfo.volume_id,
      maskId: pane.maskInfo?.volume_id,
      plane: pane.plane,
      index: pane.index,
      row,
      col,
    })
      .then((res) => setProbe({ ...res, row, col }))
      .catch(() => {})
  }

  function onMouseUp() {
    rightDrag.current.active = false
    panDrag.current.active = false
    editBoxDrag.current.active = false
    scorePanelDrag.current.active = false
    scoreComputeBoxDrag.current.active = false
    if (paintDrag.current.active) {
      paintDrag.current.active = false
      if (paintDrag.current.didPaint && pane.maskInfo) {
        // Catch up the visual in case the throttle skipped a refresh for
        // the last dab or two, then refresh the (expensive, full-volume)
        // label list once now that the stroke is actually done.
        onChange({ editVersion: pane.editVersion + 1 })
        const maskId = pane.maskInfo.volume_id
        refreshMaskLabels(maskId)
          .then((res) => {
            onChange({ maskInfo: pane.maskInfo?.volume_id === maskId ? { ...pane.maskInfo, labels: res.labels } : pane.maskInfo })
          })
          .catch(() => {})
      }
      paintDrag.current.didPaint = false
      paintDrag.current.erasing = false
    }
  }

  function resetView() {
    onChange({ zoom: 1, panX: 0, panY: 0, windowLevel: DEFAULT_WINDOW_LEVEL, windowWidth: DEFAULT_WINDOW_WIDTH })
  }

  function stopWheel(e: React.WheelEvent) {
    e.stopPropagation()
  }

  function wheelStep(key: 'windowLevel' | 'windowWidth' | 'thresholdValue', step: number, set: (v: number) => void) {
    return (e: React.WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const next = liveRef.current[key] + (e.deltaY < 0 ? step : -step)
      liveRef.current[key] = next
      set(next)
    }
  }

  const imgSrc = pane.ctInfo
    ? renderUrl({
        ctId: pane.ctInfo.volume_id,
        maskId: pane.maskInfo?.volume_id ?? null,
        plane: pane.plane,
        index: pane.index,
        ww: pane.windowWidth,
        wl: pane.windowLevel,
        maskColors: pane.maskColors,
        maskAlpha: pane.maskAlpha,
        showMask: pane.showMask,
        thresholdEnabled: pane.thresholdEnabled,
        thresholdValue: pane.thresholdValue,
        thresholdColor: pane.thresholdColor,
        thresholdAlpha: pane.thresholdAlpha,
        editVersion: pane.editVersion,
      })
    : null

  return (
    <div className={isActive ? 'pane pane-active' : 'pane'} onMouseDownCapture={onActivate}>
      <div className="pane-toolbar">
        <div className="plane-tabs">
          {PLANES.map((p) => (
            <button
              key={p}
              className={p === pane.plane ? 'active' : ''}
              onClick={() => setPlane(p)}
            >
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
        {pane.manifestRows.length > 0 && (
          <div className="case-nav-tabs">
            <button
              onClick={() => requestNavigate(-1)}
              disabled={currentRowPos <= 0}
              title="Load previous case in manifest"
            >
              ◂ Previous
            </button>
            <span className="case-nav-count">
              <input
                type="text"
                inputMode="numeric"
                className="case-nav-count-input"
                value={counterDraft}
                onFocus={(e) => {
                  setCounterFocused(true)
                  e.target.select()
                }}
                onChange={(e) => setCounterDraft(e.target.value)}
                onBlur={() => {
                  setCounterFocused(false)
                  submitCounterJump()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    ;(e.target as HTMLInputElement).blur()
                  } else if (e.key === 'Escape') {
                    setCounterDraft(currentRowPos >= 0 ? String(currentRowPos + 1) : '')
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
                title="Jump to case number"
              />
              /{pane.manifestRows.length}
            </span>
            <button
              onClick={() => requestNavigate(1)}
              disabled={currentRowPos < 0 || currentRowPos >= pane.manifestRows.length - 1}
              title="Load next case in manifest"
            >
              Next ▸
            </button>
            <button
              className={currentRow?.comment ? 'has-comment' : ''}
              onClick={openCommentModal}
              disabled={!currentRow}
              title={currentRow?.comment ? 'Read/edit comment for this case' : 'Add a comment for this case'}
            >
              {currentRow?.comment ? 'Read' : 'Comment'}
            </button>
            {(pane.manifestConfig.reasonColumn || pane.manifestConfig.includeDefaultReasonTags) && (
              <div className="reason-picker-anchor">
                <button
                  className={currentRow?.reason.length ? 'has-comment' : ''}
                  onClick={toggleReasonPicker}
                  disabled={!currentRow}
                  title="Tag a reason for this case"
                >
                  Reason{currentRow?.reason.length ? ` (${currentRow.reason.length})` : ''}
                </button>
                {reasonPickerOpen && currentRow && (
                  <ReasonPicker
                    options={reasonOptionsSnapshot}
                    selected={currentRow.reason}
                    onToggle={handleToggleReason}
                    onAddTag={handleAddReasonTag}
                    onClose={() => setReasonPickerOpen(false)}
                  />
                )}
              </div>
            )}
            {onCopyToOtherPane && (
              <button
                onClick={handleCopyToOtherPane}
                disabled={!currentRow || copyingToOtherPane}
                title="Copy this case's Comment and Reason to the other pane (and save it to that pane's manifest)"
              >
                {copyingToOtherPane ? (
                  <>
                    <span className="loading-spinner" /> Copying...
                  </>
                ) : (
                  'Copy ⇄'
                )}
              </button>
            )}
          </div>
        )}
        {pane.manifestRows.length === 0 && pane.dicomSeriesList.length > 1 && (
          <div className="series-nav-tabs">
            <button
              onClick={() => requestSeriesStep(-1)}
              disabled={pane.dicomSeriesIndex === 0}
              title="Previous DICOM series in this folder"
            >
              ◂ Previous
            </button>
            <span className="case-nav-count">
              {(pane.dicomSeriesIndex ?? 0) + 1}/{pane.dicomSeriesList.length}
            </span>
            <button
              onClick={() => requestSeriesStep(1)}
              disabled={pane.dicomSeriesIndex === pane.dicomSeriesList.length - 1}
              title="Next DICOM series in this folder"
            >
              Next ▸
            </button>
          </div>
        )}
        <div className="pane-toolbar-right">
          {pane.loading && (
            <span className="loading-tag">
              <span className="loading-spinner" />
              {pane.loadingMessage || 'Loading...'}
            </span>
          )}
          {/* Which file the visible mask came from. Without this there was no
              way to tell your own saved annotation from the original
              prediction, which matters because saving overwrites one of them. */}
          {pane.maskInfo && pane.maskSource && (
            <span
              className={`mask-source-tag mask-source-${pane.maskSource}`}
              title={pane.maskPath || 'Created in this session'}
            >
              {pane.maskSource === 'annotation'
                ? `Your annotation${pane.lastSavedAt ? ` (saved ${formatShortDate(new Date(pane.lastSavedAt))})` : ''}`
                : pane.maskSource === 'prediction'
                  ? 'Original prediction'
                  : pane.maskSource === 'new'
                    ? 'New, unsaved'
                    : 'Manually loaded'}
              {hasUnsavedMaskChanges ? ' • unsaved edits' : ''}
            </span>
          )}
          {pane.ctInfo &&
            (pane.zoom !== 1 ||
              pane.panX !== 0 ||
              pane.panY !== 0 ||
              pane.windowLevel !== DEFAULT_WINDOW_LEVEL ||
              pane.windowWidth !== DEFAULT_WINDOW_WIDTH) && (
            <button onClick={resetView} title="Reset zoom and window/level to defaults">
              Reset view
            </button>
          )}
          <button onClick={() => setSettingsOpen((v) => !v)}>{settingsOpen ? 'Hide settings' : 'Settings'}</button>
          {closable && (
            <button onClick={onClose} title="Close pane">
              ✕
            </button>
          )}
        </div>
      </div>

      {pane.error && <div className="pane-error">{pane.error}</div>}
      {pane.contrastNotice && (
        <div className="pane-warning pane-warning-contrast">
          {pane.contrastNotice}
          <button className="pane-warning-dismiss" onClick={() => onChange({ contrastNotice: null })} title="Dismiss">
            x
          </button>
        </div>
      )}

      {renderError && (
        <div className="pane-warning">
          {renderError}
          <button className="pane-warning-dismiss" onClick={() => setRenderError(null)} title="Dismiss">
            x
          </button>
        </div>
      )}

      {pane.maskWarning && (
        <div className="pane-error pane-warning">
          {pane.maskWarning}
          <button className="pane-warning-dismiss" onClick={() => onChange({ maskWarning: null })} title="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="pane-body">
        <div
          ref={viewerAreaRef}
          className="viewer-area"
          style={
            pane.editMode && pane.editTool === 'brush'
              ? { cursor: 'none' }
              : pane.seedPlacementMode
                ? { cursor: 'crosshair' }
                : !pane.editMode && !pane.scoreComputeMode
                  ? { cursor: 'grab' }
                  : undefined
          }
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={() => {
            onMouseUp()
            hideCursor()
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {imgSrc ? (
            <img
              ref={imgRef}
              src={imgSrc}
              alt="slice"
              draggable={false}
              className="slice-image"
              style={{ transform: `translate(${pane.panX}px, ${pane.panY}px) scale(${pane.zoom})` }}
              onError={() =>
                // Without this a failed render (e.g. the backend restarted,
                // or the volume fell out of its cache) just showed an empty
                // viewport with no explanation at all.
                setRenderError('Could not render this slice. The scan may need reloading (the backend may have restarted).')
              }
              onLoad={() => {
                if (renderError) setRenderError(null)
                if (pendingJumpMarkerRef.current) {
                  const { row, col } = pendingJumpMarkerRef.current
                  pendingJumpMarkerRef.current = null
                  showJumpMarker(row, col)
                }
                updateSeedMarkerPosition()
              }}
            />
          ) : pane.loading ? (
            <div className="viewer-placeholder viewer-loading">
              <span className="loading-spinner loading-spinner-lg" />
              {pane.loadingMessage || 'Loading...'}
            </div>
          ) : (
            <div className="viewer-placeholder">Developed by a bored PhD student with vibes only</div>
          )}
          {/* Always mounted (just hidden) so cursorDivRef is available the
              moment a mouse move needs it — positioned and shown/hidden via
              direct DOM writes in scheduleCursorApply, not React state. */}
          <div ref={cursorDivRef} className="brush-cursor" hidden />
          {/* Same deal as brush-cursor: shown briefly via direct DOM writes
              (showJumpMarker) when a Score-Compute-box row is clicked, to
              point at the lesion's location without a React re-render. */}
          <div ref={jumpMarkerRef} className="jump-marker" hidden />
          <div ref={seedSphereRef} className="seed-sphere-circle" hidden />
          <div ref={seedMarkerRef} className="seed-marker" hidden />
          {pane.ctInfo && (
            <div className="viewer-left-controls">
              <div className="wl-box" ref={wlBoxRef} onWheel={stopWheel}>
                <div className="wl-title">
                  <span>Window / Level</span>
                  <button
                    className="wl-minimize-btn"
                    onClick={() => onChange({ wlMinimized: !pane.wlMinimized })}
                    title={pane.wlMinimized ? 'Expand' : 'Minimize'}
                  >
                    {pane.wlMinimized ? '+' : '−'}
                  </button>
                </div>
                {!pane.wlMinimized && (
                  <>
                    <label className="wl-field">
                      L
                      <input
                        type="number"
                        value={pane.windowLevel}
                        onChange={(e) => onChange({ windowLevel: Number(e.target.value) })}
                        onWheel={wheelStep('windowLevel', 10, (v) => onChange({ windowLevel: v }))}
                      />
                    </label>
                    <label className="wl-field">
                      W
                      <input
                        type="number"
                        value={pane.windowWidth}
                        onChange={(e) => onChange({ windowWidth: Number(e.target.value) })}
                        onWheel={wheelStep('windowWidth', 10, (v) => onChange({ windowWidth: v }))}
                      />
                    </label>
                    <div className="wl-presets">
                      {WINDOW_PRESETS.map((p) => (
                        <button
                          key={p.name}
                          onClick={() => onChange({ windowLevel: p.level, windowWidth: p.width })}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {pane.contrastMode && (
                <div ref={contrastBoxRef}>
                  <ContrastSeedBox
                    pane={pane}
                    contrastSettings={contrastSettings}
                    onContrastSettingsChange={setContrastSettings}
                    minimized={contrastBoxMinimized}
                    onToggleMinimized={() => setContrastBoxMinimized((v) => !v)}
                    saving={contrastSaving}
                    error={contrastError}
                    onFinalize={finalizeSeed}
                    onReSeed={reSeed}
                    onToggleSeedPlacement={toggleSeedPlacement}
                  />
                </div>
              )}
            </div>
          )}
          {pane.ctInfo && (
            <div className="viewer-top-right">
              <div>
                <span>
                  {pane.plane} {pane.index + 1}/{planeLength}
                </span>
                {probe && (
                  <span>
                    {' '}
                    · row {probe.row}, col {probe.col} · HU {probe.hu !== null ? probe.hu.toFixed(0) : '-'}
                    {probe.label !== null && probe.label !== 0 ? ` · label ${probe.label}` : ''}
                  </span>
                )}
              </div>
              {currentRow && currentRow.patient_id && (
                <div className="viewer-patient-id">Patient ID: {currentRow.patient_id}</div>
              )}
            </div>
          )}
          {pane.ctInfo &&
            !pane.contrastMode &&
            (pane.agatstonScores || (pane.scoreClasses.length > 0 && currentRow)) && (
              <ScorePanel
                ref={scorePanelRef}
                style={
                  pane.scorePanelPos
                    ? { left: pane.scorePanelPos.x, top: pane.scorePanelPos.y, bottom: 'auto', transform: 'none' }
                    : undefined
                }
                scoreClasses={pane.agatstonScores ? (Object.keys(pane.agatstonScores) as ScoreClass[]) : pane.scoreClasses}
                scores={pane.agatstonScores ?? currentRow!.scores}
                maskColors={pane.maskColors}
                open={pane.scorePanelOpen}
                onToggleOpen={() => onChange({ scorePanelOpen: !pane.scorePanelOpen })}
                onDragHandleDown={handleScorePanelDragStart}
              />
            )}
          {pane.ctInfo && pane.contrastMode && pane.volumeScores && (
            <ScorePanel
              ref={scorePanelRef}
              style={
                pane.scorePanelPos
                  ? { left: pane.scorePanelPos.x, top: pane.scorePanelPos.y, bottom: 'auto', transform: 'none' }
                  : undefined
              }
              scoreClasses={Object.keys(pane.volumeScores) as ScoreClass[]}
              scores={pane.volumeScores}
              maskColors={pane.maskColors}
              open={pane.scorePanelOpen}
              onToggleOpen={() => onChange({ scorePanelOpen: !pane.scorePanelOpen })}
              onDragHandleDown={handleScorePanelDragStart}
            />
          )}
          {pane.ctInfo && (
            <div className="viewer-bottom-left" ref={bottomLeftRef}>
              <div className="viewer-alpha-controls">
                <div className="overlay-box" onWheel={stopWheel}>
                  <label className="overlay-toggle">
                    <input
                      type="checkbox"
                      checked={pane.showMask}
                      onChange={(e) => onChange({ showMask: e.target.checked })}
                    />
                    Mask
                  </label>
                  <AlphaSpinner label="α" value={pane.maskAlpha} onChange={(v) => onChange({ maskAlpha: v })} />
                </div>
                <div className="overlay-box" onWheel={stopWheel}>
                  <label className="overlay-toggle">
                    <input
                      type="checkbox"
                      checked={pane.thresholdEnabled}
                      onChange={(e) => onChange({ thresholdEnabled: e.target.checked })}
                    />
                    Thresh
                  </label>
                  <div className="overlay-box-row">
                    <input
                      type="number"
                      className="overlay-hu-input"
                      value={pane.thresholdValue}
                      disabled={pane.contrastMode && pane.contrastThresholdLocked}
                      onChange={(e) => onChange({ thresholdValue: Number(e.target.value) })}
                      onWheel={wheelStep('thresholdValue', 5, (v) => onChange({ thresholdValue: v }))}
                      title={
                        pane.contrastMode && pane.contrastThresholdLocked
                          ? 'Locked to the computed contrast threshold for this session'
                          : 'Threshold (HU)'
                      }
                    />
                    <AlphaSpinner
                      label="α"
                      value={pane.thresholdAlpha}
                      onChange={(v) => onChange({ thresholdAlpha: v })}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
          {pane.ctInfo && (
            <div
              ref={editBoxRef}
              className="viewer-bottom-right"
              style={
                pane.editBoxPos
                  ? { left: pane.editBoxPos.x, top: pane.editBoxPos.y, right: 'auto', bottom: 'auto' }
                  : undefined
              }
            >
              <MaskEditor
                pane={pane}
                onChange={onChange}
                onCreateMask={doCreateMask}
                onSave={() => doSaveMask()}
                onDragHandleDown={handleEditBoxDragStart}
                onToggleContrast={requestContrastToggle}
                thresholdLocked={pane.contrastMode && pane.contrastThresholdLocked}
                seedRadiusMm={seedRadiusMm}
              />
              {pane.editMode && pane.maskInfo && (
                <div className="edit-quick-actions" onWheel={(e) => e.stopPropagation()}>
                  <button onClick={doResetMask} disabled={pane.loading} title="Reset to the last saved state">
                    ⟲ Reset
                  </button>
                  <button
                    className={pane.editActiveLabel === 0 ? 'active' : ''}
                    onClick={doErase}
                    title="Set the active label to Background so the next stroke erases"
                  >
                    ⌫ Erase mode
                  </button>
                </div>
              )}
            </div>
          )}
          {pane.ctInfo && pane.maskInfo && (
            <div
              ref={scoreComputeBoxRef}
              className="viewer-score-compute-box"
              style={
                pane.scoreComputeBoxPos
                  ? { left: pane.scoreComputeBoxPos.x, top: pane.scoreComputeBoxPos.y, transform: 'none' }
                  : undefined
              }
            >
              <LesionScoreBox
                pane={pane}
                onChange={onChange}
                onDragHandleDown={handleScoreComputeBoxDragStart}
                flashRowId={flashRowId}
                onRowClick={jumpToLesion}
                onComputeAll={computeAllScores}
                computingAll={computingVolumeScores}
                seedRadiusMm={seedRadiusMm}
              />
            </div>
          )}
        </div>

        {pane.ctInfo && (
          <input
            className="slice-slider"
            type="range"
            min={0}
            max={planeLength - 1}
            value={pane.index}
            onChange={(e) => onChange({ index: Number(e.target.value) })}
          />
        )}

        {settingsOpen && (
          <div className="pane-settings">
            <CaseLoader
              pane={pane}
              onChange={onChange}
              onLoadCt={doLoadCt}
              onLoadMask={doLoadMask}
              annotationSaveDir={annotationSaveDir}
              onAnnotationSaveDirChange={onAnnotationSaveDirChange}
              onRequestSelectRow={requestSelectRow}
              onLoadRow={onLoadRow}
              hasUnsavedMaskChanges={hasUnsavedMaskChanges}
            />

            <div className="settings-section">
              <LabelColorEditor colors={pane.maskColors} onChange={(colors) => onChange({ maskColors: colors })} />
            </div>

            <div className="settings-section">
              <div className="settings-title">HU threshold overlay color</div>
              <label>
                Color
                <input
                  type="color"
                  value={pane.thresholdColor}
                  onChange={(e) => onChange({ thresholdColor: e.target.value })}
                />
              </label>
            </div>

            <div className="settings-section">
              <InfoPanel title="CT image" info={pane.ctInfo} />
              <InfoPanel title="Segmentation mask" info={pane.maskInfo} />
            </div>
          </div>
        )}
      </div>

      {commentOpen && (
        <div className="comment-modal-backdrop" onClick={() => setCommentOpen(false)}>
          <div className="comment-modal" onClick={(e) => e.stopPropagation()}>
            <div className="comment-modal-title">
              Comment{currentRow ? ` — ${currentRow.patient_id || currentRow.label}` : ''}
            </div>
            <textarea
              autoFocus
              rows={6}
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              placeholder="Reason / notes for this case..."
            />
            {commentError && <div className="busy-msg manifest-error">{commentError}</div>}
            <div className="comment-modal-buttons">
              <button onClick={() => setCommentOpen(false)} disabled={commentSaving}>
                Cancel
              </button>
              <button className="add-label-btn" onClick={handleSaveComment} disabled={commentSaving}>
                {commentSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* A save conflict raised from inside this modal takes precedence, or
          the two stack on top of each other. The navigation intent is kept,
          so this modal comes back once the conflict is resolved. */}
      {(navModalDirection !== null || jumpPos !== null || seriesStepDirection !== null) && !saveConflict && (
        <div
          className="comment-modal-backdrop"
          onClick={() => {
            setNavModalDirection(null)
            setJumpPos(null)
            setSeriesStepDirection(null)
          }}
        >
          <div className="comment-modal" onClick={(e) => e.stopPropagation()}>
            <div className="comment-modal-title">Before you move on...</div>

            <button
              className="nav-modal-save-btn"
              onClick={() => doSaveMask()}
              disabled={pane.editBusy || !hasUnsavedMaskChanges}
              title={hasUnsavedMaskChanges ? 'Save the current annotation' : 'No changes since last save'}
            >
              {pane.editBusy
                ? 'Saving...'
                : hasUnsavedMaskChanges
                  ? 'Save'
                  : lastSavedAt
                    ? `Saved ${formatShortDate(lastSavedAt)}`
                    : 'No changes to save'}
            </button>

            {pane.manifestRows.length > 0 && (
              <div className="nav-modal-status-row">
                {statusOptions.map((s) => (
                  <button
                    key={s}
                    className={currentRow?.status === s ? 'active' : ''}
                    onClick={() => handleSetStatus(s)}
                    disabled={statusSaving}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {statusError && <div className="busy-msg manifest-error">{statusError}</div>}

            <div className="comment-modal-buttons">
              <button
                onClick={() => {
                  setNavModalDirection(null)
                  setJumpPos(null)
                  setSeriesStepDirection(null)
                }}
              >
                Cancel
              </button>
              <button
                className="add-label-btn"
                onClick={navModalDirection !== null ? confirmNavigate : jumpPos !== null ? confirmJump : confirmSeriesStep}
              >
                {(navModalDirection ?? seriesStepDirection) === 1
                  ? 'Continue to Next ▸'
                  : (navModalDirection ?? seriesStepDirection) === -1
                    ? '◂ Continue to Previous'
                    : 'Continue ▸'}
              </button>
            </div>
          </div>
        </div>
      )}

      {counterError && (
        <div className="comment-modal-backdrop" onClick={() => setCounterError(null)}>
          <div className="comment-modal" onClick={(e) => e.stopPropagation()}>
            <div className="comment-modal-title">Invalid case number</div>
            <div className="busy-msg manifest-error">{counterError}</div>
            <div className="comment-modal-buttons">
              <button className="add-label-btn" onClick={() => setCounterError(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {lesionNotFound && (
        <div className="comment-modal-backdrop" onClick={() => setLesionNotFound(false)}>
          <div className="comment-modal" onClick={(e) => e.stopPropagation()}>
            <div className="comment-modal-title">No lesion here</div>
            <div className="busy-msg">This location is not part of a segmented lesion.</div>
            <div className="comment-modal-buttons">
              <button className="add-label-btn" onClick={() => setLesionNotFound(false)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {saveConflict && (
        <div className="comment-modal-backdrop" onClick={() => setSaveConflict(null)}>
          <div className="comment-modal" onClick={(e) => e.stopPropagation()}>
            <div className="comment-modal-title">
              {saveConflict.conflict === 'collision'
                ? 'That name is already taken by a different scan'
                : saveConflict.conflict === 'overwrite'
                  ? 'An annotation for this scan already exists'
                  : 'You already saved this scan'}
            </div>
            <div className="nav-modal-body">
              {saveConflict.conflict === 'collision' ? (
                <>
                  <p>
                    <code>{saveConflict.folder_name}</code> already holds an annotation for a <strong>different</strong>{' '}
                    scan
                    {saveConflict.existing_source?.patient_id
                      ? ` (patient ${saveConflict.existing_source.patient_id})`
                      : ''}
                    :
                  </p>
                  <p>
                    <code>{saveConflict.existing_source?.ct_path || saveConflict.existing_dir}</code>
                  </p>
                  <p>Overwriting would destroy that annotation. Saving alongside it is almost always what you want.</p>
                </>
              ) : saveConflict.conflict === 'overwrite' ? (
                <>
                  <p>
                    This scan already has an annotation saved today
                    {saveConflict.existing_source?.updated_at ? ` at ${saveConflict.existing_source.updated_at}` : ''}.
                  </p>
                  <p>
                    <code>{saveConflict.annotation_path}</code>
                  </p>
                  <p>Saving replaces it with what is on screen now.</p>
                </>
              ) : (
                <>
                  <p>
                    You saved an annotation for this scan on an earlier date
                    {saveConflict.existing_source?.updated_at ? ` (${saveConflict.existing_source.updated_at})` : ''}:
                  </p>
                  <p>
                    <code>{saveConflict.existing_dir}</code>
                  </p>
                  <p>Saving now creates today's copy. The earlier one is kept.</p>
                </>
              )}
            </div>
            <div className="comment-modal-buttons">
              <button onClick={() => setSaveConflict(null)}>Cancel</button>
              {saveConflict.conflict === 'collision' && (
                <button
                  className="add-label-btn"
                  onClick={() => {
                    setSaveConflict(null)
                    doSaveMask('new_copy')
                  }}
                >
                  Save as {saveConflict.alternative_folder}
                </button>
              )}
              <button
                className={saveConflict.conflict === 'collision' ? 'danger-btn' : 'add-label-btn'}
                onClick={() => {
                  setSaveConflict(null)
                  doSaveMask('overwrite')
                }}
              >
                {saveConflict.conflict === 'collision'
                  ? 'Overwrite the other scan'
                  : saveConflict.conflict === 'overwrite'
                    ? 'Overwrite'
                    : "Save today's copy"}
              </button>
            </div>
          </div>
        </div>
      )}

      {contrastUnloadPending !== null && (
        <div className="comment-modal-backdrop" onClick={() => setContrastUnloadPending(null)}>
          <div className="comment-modal" onClick={(e) => e.stopPropagation()}>
            <div className="comment-modal-title">Unsaved annotation changes</div>
            <div className="nav-modal-body">
              Switching contrast mode will unload this mask, because it was annotated under the other threshold basis.
              It has unsaved changes that would be lost.
            </div>
            <div className="comment-modal-buttons">
              <button onClick={() => setContrastUnloadPending(null)}>Go back and save</button>
              <button className="danger-btn" onClick={() => applyContrastToggle(contrastUnloadPending)}>
                Discard and switch
              </button>
            </div>
          </div>
        </div>
      )}

      {scoreConfirmPending && (
        <div className="comment-modal-backdrop" onClick={declineComputeScore}>
          <div className="comment-modal" onClick={(e) => e.stopPropagation()}>
            <div className="comment-modal-title">{scoreConfirmPending.targetClass} score not found</div>
            <div className="busy-msg">
              This case has no {scoreConfirmPending.targetClass} score in the manifest. Compute it now from the mask?
              This may take a moment.
            </div>
            <div className="comment-modal-buttons">
              <button onClick={declineComputeScore} disabled={computingScore}>
                No
              </button>
              <button className="add-label-btn" onClick={confirmComputeScore} disabled={computingScore}>
                {computingScore ? 'Computing...' : 'Yes, compute'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
