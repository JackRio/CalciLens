import { useEffect, useState } from 'react'
import './App.css'
import Pane from './components/Pane'
import KeybindSettings from './components/KeybindSettings'
import ReviewTagsPicker from './components/ReviewTagsPicker'
import type { ManifestRow, PaneState, VolumeInfo } from './types'
import {
  CALCIFICATIONS_PRESET,
  DEFAULT_MANIFEST_CONFIG,
  DEFAULT_THRESHOLD_COLOR,
  DEFAULT_THRESHOLD_HU,
  DEFAULT_WINDOW_LEVEL,
  DEFAULT_WINDOW_WIDTH,
  inferMaskAnnotationType,
  detectMaskLooksLikeCt,
  detectGeometryMismatch,
  detectAnnotationTypeMismatch,
  comboMatches,
} from './types'
import { loadVolume, lookupAnnotation, resolveDicomLoad, saveManifestComment, saveManifestReason } from './api'
import { useKeybinds } from './useKeybinds'
import { useAnnotationSaveDir } from './useAnnotationSaveDir'

let paneCounter = 0
function makePane(): PaneState {
  paneCounter += 1
  return {
    id: `pane-${paneCounter}`,
    manifestConfig: { ...DEFAULT_MANIFEST_CONFIG },
    manifestColumns: [],
    manifestRows: [],
    activeRowIndex: null,
    manifestError: null,
    dicomSeriesList: [],
    dicomSeriesIndex: null,
    batchLoadCollapsed: false,
    wlMinimized: true,
    reasonOptions: [],
    statusOptions: [],
    hasAnnotationColumn: false,
    hasContrastColumn: false,
    scoreClasses: [],
    scorePanelOpen: true,
    scorePanelPos: null,
    loadingMessage: null,

    ctPath: '',
    maskPath: '',
    ctInfo: null,
    maskInfo: null,

    plane: 'axial',
    index: 0,

    windowLevel: DEFAULT_WINDOW_LEVEL,
    windowWidth: DEFAULT_WINDOW_WIDTH,

    showMask: true,
    maskColors: CALCIFICATIONS_PRESET.map((c) => ({ ...c })),
    maskAlpha: 1.0,

    thresholdEnabled: false,
    thresholdValue: DEFAULT_THRESHOLD_HU,
    thresholdColor: DEFAULT_THRESHOLD_COLOR,
    thresholdAlpha: 1.0,

    zoom: 1,
    panX: 0,
    panY: 0,

    error: null,
    loading: false,
    maskWarning: null,

    editMode: false,
    editTool: 'region-grow',
    editActiveLabel: 1,
    editOverwriteMode: 'any',
    editOverwriteLabel: null,
    editThresholdMin: DEFAULT_THRESHOLD_HU,
    editBrushRadius: 6,
    editRegionGrowThreshold: DEFAULT_THRESHOLD_HU,
    editVersion: 0,
    editBusy: false,
    editMessage: null,
    editMinimized: false,
    editBoxPos: null,

    scoreComputeMode: false,
    scoreComputeMinimized: false,
    scoreComputeBoxPos: null,
    lesionResults: [],

    contrastMode: false,
    seedPlacementMode: false,
    pendingSeed: null,
    contrastThreshold: null,
    contrastThresholdLocked: false,
    contrastMeta: null,
    volumeScores: null,
    agatstonScores: null,
    maskAnnotationType: null,

    hasUnsavedMaskChanges: false,
    maskBaselineVolumeId: null,
    maskBaselineVersion: 0,
    lastSavedAt: null,
    maskSource: null,
    annotationLookup: null,
    contrastNotice: null,
  }
}

// Everything a freshly-loaded case must start from, so nothing computed
// against the previous scan can survive into this one. Contrast state is in
// here deliberately: a per-scan threshold carried into the next case is a
// silently wrong threshold, and "the checkbox is still ticked" is not
// evidence that the new scan is contrast-enhanced.
const CASE_RESET: Partial<PaneState> = {
  maskAnnotationType: null,
  maskWarning: null,
  dicomSeriesList: [],
  dicomSeriesIndex: null,
  editMode: false,
  lesionResults: [],
  volumeScores: null,
  agatstonScores: null,
  maskSource: null,
  hasUnsavedMaskChanges: false,
  maskBaselineVolumeId: null,
  maskBaselineVersion: 0,
  lastSavedAt: null,
  annotationLookup: null,
  contrastNotice: null,
  seedPlacementMode: false,
  pendingSeed: null,
  contrastThreshold: null,
  contrastThresholdLocked: false,
  contrastMeta: null,
}

export default function App() {
  const [panes, setPanes] = useState<PaneState[]>([makePane()])
  const [linked, setLinked] = useState(true)
  const [syncNavByPatientId, setSyncNavByPatientId] = useState(true)
  const [activePaneId, setActivePaneId] = useState<string | null>(panes[0]?.id ?? null)
  const [keybinds, setKeybinds] = useKeybinds()
  const [keybindSettingsOpen, setKeybindSettingsOpen] = useState(false)
  const [annotationSaveDir, setAnnotationSaveDir] = useAnnotationSaveDir()
  // An action that would have discarded unsaved annotation work, held back
  // until the user says what to do with it. Previously these paths — the
  // reload shortcut, and loading a synced case into the *other* pane —
  // simply went ahead and the work was gone with no prompt at all.
  const [blockedAction, setBlockedAction] = useState<{ message: string; run: () => void } | null>(null)
  const effectiveActivePaneId = panes.some((p) => p.id === activePaneId) ? activePaneId : (panes[0]?.id ?? null)

  // Review mode — global (not per-pane), so it applies the same way in
  // single-pane view and to both panes in split view: Previous/Next only
  // stop on cases whose Reason tags intersect reviewTags. In split view,
  // reviewParentPaneId says whose Reason data actually drives the
  // skip-ahead search — the other pane just tags along via the existing
  // Patient-ID sync (if on) rather than independently searching its own,
  // possibly different, manifest and jumping somewhere unrelated.
  const [reviewModeOn, setReviewModeOn] = useState(false)
  const [reviewTags, setReviewTags] = useState<string[]>([])
  const [reviewTagsPickerOpen, setReviewTagsPickerOpen] = useState(false)
  const [reviewParentPaneId, setReviewParentPaneId] = useState<string | null>(null)
  const effectiveReviewParentId = panes.some((p) => p.id === reviewParentPaneId)
    ? reviewParentPaneId
    : (panes[0]?.id ?? null)
  const allReasonOptions = Array.from(new Set(panes.flatMap((p) => p.reasonOptions)))

  // Runs `action`, unless one of `paneIds` has unsaved annotation changes —
  // in which case it asks first. Every App-level path that can destroy an
  // in-memory mask goes through here.
  function withUnsavedGuard(paneIds: string[], what: string, action: () => void) {
    const dirty = panes.filter((p) => paneIds.includes(p.id) && p.hasUnsavedMaskChanges)
    if (dirty.length === 0) {
      action()
      return
    }
    const names = dirty.map((p) => (panes.length > 1 ? (panes[0].id === p.id ? 'Left' : 'Right') : 'This')).join(' and ')
    setBlockedAction({
      message: `${names} pane has unsaved annotation changes. ${what} will discard them.`,
      run: action,
    })
  }

  // Re-reads the CT/mask straight from disk (force=true bypasses the
  // backend's in-memory volume cache), keeping the pane's current view
  // (slice/plane/zoom) instead of resetting it the way a fresh load does.
  async function reloadPane(paneId: string) {
    const pane = panes.find((p) => p.id === paneId)
    if (!pane || !pane.ctPath) return
    updatePane(paneId, { loading: true, loadingMessage: 'Reloading...', error: null })
    try {
      // Pass the tracked series UID (when the CT came from a DICOM
      // directory) so a reload re-resolves the *same* series rather than
      // whichever one auto-pick would otherwise pick first if that
      // directory holds more than one.
      const ctInfo = await loadVolume(pane.ctPath, false, true, pane.ctInfo?.dicom_series_uid ?? undefined)
      const maskInfo = pane.maskPath
        ? await loadVolume(pane.maskPath, true, true, pane.maskInfo?.dicom_series_uid ?? undefined)
        : pane.maskInfo
      updatePane(paneId, {
        ctInfo,
        maskInfo,
        loading: false,
        loadingMessage: null,
        // Re-read from disk means the in-memory copy IS the on-disk copy
        // again, so the unsaved-changes baseline resets with it.
        hasUnsavedMaskChanges: false,
        maskBaselineVolumeId: maskInfo?.volume_id ?? null,
        maskBaselineVersion: pane.editVersion + 1,
        // Bumped so the <img> URL changes: the render request is otherwise
        // byte-identical to the one already in the browser cache, and a
        // reload-from-disk would appear to do nothing.
        editVersion: pane.editVersion + 1,
      })
    } catch (e) {
      updatePane(paneId, { loading: false, loadingMessage: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // Reloads every open pane — in split view that's both windows at once, not
  // just whichever one was last clicked into (unlike the other per-pane
  // shortcuts), since "refresh from disk" naturally applies wherever a scan
  // is loaded rather than to one active viewport.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const active = document.activeElement as HTMLElement | null
      if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return
      if (keybinds.reloadCurrent.some((c) => comboMatches(e, c))) {
        e.preventDefault()
        withUnsavedGuard(
          panes.map((p) => p.id),
          'Reloading from disk',
          () => panes.forEach((p) => reloadPane(p.id)),
        )
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [keybinds, panes])

  function updatePane(id: string, partial: Partial<PaneState>) {
    setPanes((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, ...partial } : p))
      const syncKeys: (keyof PaneState)[] = [
        'plane',
        'index',
        'zoom',
        'panX',
        'panY',
        'wlMinimized',
        'showMask',
        'thresholdEnabled',
      ]
      const shouldSync = linked && next.length > 1 && syncKeys.some((k) => k in partial)
      if (!shouldSync) return next
      return next.map((p) => {
        if (p.id === id) return p
        const syncedPartial: Partial<PaneState> = {}
        if ('plane' in partial) syncedPartial.plane = partial.plane
        if ('zoom' in partial) syncedPartial.zoom = partial.zoom
        if ('panX' in partial) syncedPartial.panX = partial.panX
        if ('panY' in partial) syncedPartial.panY = partial.panY
        if ('wlMinimized' in partial) syncedPartial.wlMinimized = partial.wlMinimized
        if ('showMask' in partial) syncedPartial.showMask = partial.showMask
        if ('thresholdEnabled' in partial) syncedPartial.thresholdEnabled = partial.thresholdEnabled
        if ('index' in partial && p.ctInfo) {
          const plane = ('plane' in partial ? partial.plane : p.plane) as PaneState['plane']
          const len = p.ctInfo.plane_lengths[plane]
          syncedPartial.index = Math.max(0, Math.min(len - 1, partial.index as number))
        } else if ('index' in partial) {
          syncedPartial.index = partial.index
        }
        return { ...p, ...syncedPartial }
      })
    })
  }

  async function loadRowIntoPane(paneId: string, row: ManifestRow, currentPlane: PaneState['plane']) {
    updatePane(paneId, {
      activeRowIndex: row.index,
      manifestError: null,
      error: null,
      loading: true,
      loadingMessage: 'Loading CT scan...',
      // Anything computed against the *previous* case's mask (or the mask
      // itself, cleared further below once we know whether this row has
      // one) belongs to that case, not this one — leaving it in place made
      // stale lesion results / recomputed totals look like they applied to
      // whatever case was just navigated to.
      ...CASE_RESET,
    })
    if (!row.image_exists) {
      // Clear whatever scan was showing before rather than leaving it up
      // under the new row's Patient ID/counter — a stale image next to a
      // "not found" error would otherwise look like it belongs to this row.
      updatePane(paneId, {
        ctPath: '',
        ctInfo: null,
        maskPath: '',
        maskInfo: null,
        loading: false,
        loadingMessage: null,
        manifestError: `Image not found: ${row.image_path}`,
      })
      return
    }
    let ctPathForMaskCheck = ''
    let loadedCtInfo: VolumeInfo | null = null
    try {
      const { directory, seriesUid, seriesList } = await resolveDicomLoad(row.image_path)
      const ctInfo = await loadVolume(directory, false, false, seriesUid)
      ctPathForMaskCheck = directory
      loadedCtInfo = ctInfo
      updatePane(paneId, {
        ctPath: directory,
        ctInfo,
        // A multi-series folder still just auto-loads its first series here
        // — manifest case navigation takes precedence over series
        // switching, so the series-nav bar stays hidden while a manifest is
        // active (see Pane.tsx).
        dicomSeriesList: seriesList.length > 1 ? seriesList : [],
        dicomSeriesIndex: seriesList.length > 1 ? 0 : null,
        index: Math.floor(ctInfo.plane_lengths[currentPlane] / 2),
      })
    } catch (e) {
      updatePane(paneId, {
        ctPath: '',
        ctInfo: null,
        maskPath: '',
        maskInfo: null,
        loading: false,
        loadingMessage: null,
        error: e instanceof Error ? e.message : String(e),
      })
      return
    }

    const isContrastScan = await applyContrastEvidence(paneId, ctPathForMaskCheck, loadedCtInfo, row)

    // Prefer this app's own saved annotation over the original prediction.
    // Without this, a case that shipped with a mask always re-opened that
    // mask, and every previous session's work stayed invisible on disk —
    // and got overwritten by the next save.
    const useAnnotation = row.annotation_exists && !!row.annotation_path
    const maskToLoad = useAnnotation ? row.annotation_path : row.mask_path
    const maskSource: PaneState['maskSource'] = useAnnotation ? 'annotation' : 'prediction'
    const maskIsPresent = useAnnotation || row.mask_exists

    if (maskToLoad) {
      if (maskIsPresent) {
        updatePane(paneId, { loadingMessage: useAnnotation ? 'Loading your annotation...' : 'Loading mask...' })
        try {
          const maskInfo = await loadVolume(maskToLoad, true)
          const mismatch = loadedCtInfo ? detectGeometryMismatch(loadedCtInfo, maskInfo) : null
          if (mismatch) {
            // Refuse rather than display: painting against a mismatched mask
            // writes to the wrong slice, and it saves that silently.
            updatePane(paneId, {
              maskPath: '',
              maskInfo: null,
              maskSource: null,
              manifestError: mismatch,
            })
          } else {
            const annotationType = inferMaskAnnotationType(maskToLoad)
            const contrastOn = isContrastScan
            updatePane(paneId, {
              maskPath: maskToLoad,
              maskInfo,
              maskSource,
              maskBaselineVolumeId: maskInfo.volume_id,
              maskBaselineVersion: 0,
              hasUnsavedMaskChanges: false,
              maskAnnotationType: annotationType,
              maskWarning:
                detectMaskLooksLikeCt(maskInfo, ctPathForMaskCheck, maskToLoad) ||
                detectAnnotationTypeMismatch(annotationType, contrastOn),
              showMask: true,
            })
          }
        } catch (e) {
          updatePane(paneId, { manifestError: e instanceof Error ? e.message : String(e) })
        }
      } else {
        updatePane(paneId, {
          maskPath: '',
          maskInfo: null,
          maskWarning: null,
          maskSource: null,
          manifestError: `Mask not found: ${maskToLoad}`,
        })
      }
    } else {
      updatePane(paneId, { maskPath: '', maskInfo: null, maskWarning: null, maskSource: null })
    }
    updatePane(paneId, { loading: false, loadingMessage: null })
  }

  // Decide whether this scan is contrast-enhanced from what is actually
  // recorded — a saved seed, a previous annotation's own record of its type,
  // or the manifest's contrast column — instead of from whether the Contrast
  // checkbox happens to be ticked. That check used to run only when contrast
  // mode was already on, so opening a contrast scan without ticking the box
  // silently annotated it against the fixed 130 HU non-contrast threshold.
  async function applyContrastEvidence(
    paneId: string,
    ctPath: string,
    ctInfo: PaneState['ctInfo'],
    row?: ManifestRow,
  ): Promise<boolean> {
    let lookup = null
    try {
      lookup = await lookupAnnotation(
        ctPath,
        ctInfo?.dicom_series_uid ?? null,
        annotationSaveDir || null,
        row?.annotation_path || null,
      )
    } catch {
      /* the lookup is advisory — a failure must not block loading a scan */
    }
    const isContrast = row?.contrast === true || !!lookup?.hasSeed || lookup?.annotationType === 'contrast'

    if (!isContrast) {
      // Nothing says this scan is contrast — make sure the previous case's
      // contrast threshold isn't still in force. Carrying a per-scan
      // threshold into a different scan is silently wrong every time.
      updatePane(paneId, {
        annotationLookup: lookup,
        contrastMode: false,
        contrastNotice: null,
        thresholdValue: DEFAULT_THRESHOLD_HU,
        thresholdEnabled: false,
        editThresholdMin: DEFAULT_THRESHOLD_HU,
        editRegionGrowThreshold: DEFAULT_THRESHOLD_HU,
      })
      return false
    }
    updatePane(paneId, {
      annotationLookup: lookup,
      contrastMode: true,
      // If there is a seed, Pane's own effect loads and re-verifies it and
      // clears this. If there isn't, this is the warning that stops someone
      // annotating a contrast scan against 130 HU.
      contrastNotice: lookup?.hasSeed
        ? null
        : 'This is recorded as a contrast scan, but no seed/threshold has been placed for it yet. Place and finalize a seed before annotating.',
    })
    return true
  }

  function clearPaneScan(paneId: string, errorMsg: string) {
    updatePane(paneId, {
      activeRowIndex: null,
      ctInfo: null,
      maskInfo: null,
      maskWarning: null,
      ctPath: '',
      maskPath: '',
      manifestError: errorMsg,
      error: null,
    })
  }

  // Scans rows[fromPos + direction, ...] (or from fromPos itself when
  // includeStart) for the first one carrying any of reviewTags. Returns -1
  // if none found before running off the end of the list.
  function findReviewPosition(
    rows: ManifestRow[],
    fromPos: number,
    direction: 1 | -1,
    reviewTags: string[],
    includeStart: boolean,
  ): number {
    let pos = includeStart ? fromPos : fromPos + direction
    while (pos >= 0 && pos < rows.length) {
      if (rows[pos].reason.some((t) => reviewTags.includes(t))) return pos
      pos += direction
    }
    return -1
  }

  function navigate(paneId: string, direction: 1 | -1) {
    const pane = panes.find((p) => p.id === paneId)
    if (!pane || pane.manifestRows.length === 0) return
    const curPos = pane.manifestRows.findIndex((r) => r.index === pane.activeRowIndex)

    // Only the designated review-parent pane's Previous/Next actually skip
    // by Reason tag — the other pane in split view navigates one row at a
    // time as normal (and still follows along via Patient-ID sync, if on,
    // through goToPosition below), rather than independently searching its
    // own manifest and landing somewhere unrelated.
    if (reviewModeOn && paneId === effectiveReviewParentId) {
      if (reviewTags.length === 0) {
        updatePane(paneId, {
          manifestError: 'Review mode is on but no reason tags are selected — pick tags via the Review button.',
        })
        return
      }
      const target = findReviewPosition(pane.manifestRows, curPos, direction, reviewTags, false)
      if (target === -1) {
        updatePane(paneId, {
          manifestError: `No ${direction === 1 ? 'next' : 'previous'} case matches the selected review tags.`,
        })
        return
      }
      goToPosition(paneId, target)
      return
    }

    const nextPos = curPos + direction
    if (nextPos < 0 || nextPos >= pane.manifestRows.length) return
    goToPosition(paneId, nextPos)
  }

  // Global toggle — jumps only the review-parent pane to its nearest
  // matching case; the other pane (if any) follows via Patient-ID sync
  // rather than doing its own independent search.
  function toggleReviewMode() {
    const next = !reviewModeOn
    setReviewModeOn(next)
    if (!next || !effectiveReviewParentId) return

    const pane = panes.find((p) => p.id === effectiveReviewParentId)
    if (!pane || pane.manifestRows.length === 0) return

    if (reviewTags.length === 0) {
      updatePane(pane.id, {
        manifestError: 'Review mode is on — pick which reason tags to review via the Review button.',
      })
      return
    }
    const curPos = pane.manifestRows.findIndex((r) => r.index === pane.activeRowIndex)
    const target = findReviewPosition(pane.manifestRows, curPos, 1, reviewTags, true)
    if (target === -1) {
      updatePane(pane.id, { manifestError: 'No case matches the selected review tags.' })
    } else if (target !== curPos) {
      goToPosition(pane.id, target)
    }
  }

  function goToPosition(paneId: string, nextPos: number) {
    const pane = panes.find((p) => p.id === paneId)
    if (!pane || nextPos < 0 || nextPos >= pane.manifestRows.length) return
    const rows = pane.manifestRows
    const row = rows[nextPos]
    loadRowIntoPane(paneId, row, pane.plane)

    const canSyncByPatientId =
      syncNavByPatientId &&
      panes.length > 1 &&
      !!pane.manifestConfig.patientIdColumn &&
      pane.manifestRows.length > 0

    if (canSyncByPatientId) {
      const other = panes.find((p) => p.id !== paneId)
      if (other && other.manifestRows.length > 0 && other.manifestConfig.patientIdColumn) {
        if (!row.patient_id) return
        const match = other.manifestRows.find((r) => r.patient_id === row.patient_id)
        // The other pane's own unsaved work is at stake here and it never
        // used to be asked about — only the pane the user clicked in was.
        withUnsavedGuard([other.id], 'Loading the matching case there', () => {
          if (match) {
            loadRowIntoPane(other.id, match, other.plane)
          } else {
            clearPaneScan(other.id, `No image path for PatientID ${row.patient_id}`)
          }
        })
      }
    }
  }

  async function copyReasonCommentToOtherPane(sourcePaneId: string) {
    const source = panes.find((p) => p.id === sourcePaneId)
    const other = panes.find((p) => p.id !== sourcePaneId)
    if (!source || !other) return
    const sourceRow = source.manifestRows.find((r) => r.index === source.activeRowIndex)
    const otherRow = other.manifestRows.find((r) => r.index === other.activeRowIndex)
    if (!sourceRow) return
    if (!otherRow || !other.manifestConfig.manifestPath) {
      updatePane(other.id, { manifestError: 'No case loaded in the other pane to copy into.' })
      return
    }
    try {
      // Sequential, not Promise.all — both calls read-modify-write the same
      // manifest row, and firing them concurrently risked one clobbering
      // the other's change (or worse: racing on the same temp file during
      // the write itself).
      await saveManifestComment(other.manifestConfig.manifestPath, otherRow.index, sourceRow.comment)
      await saveManifestReason(other.manifestConfig.manifestPath, otherRow.index, sourceRow.reason, other.manifestConfig.reasonColumn)
      updatePane(other.id, {
        manifestRows: other.manifestRows.map((r) =>
          r.index === otherRow.index ? { ...r, comment: sourceRow.comment, reason: sourceRow.reason } : r,
        ),
        reasonOptions: Array.from(new Set([...other.reasonOptions, ...sourceRow.reason])),
        manifestError: null,
      })
    } catch (e) {
      updatePane(other.id, { manifestError: e instanceof Error ? e.message : String(e) })
    }
  }

  function addSplit() {
    if (panes.length >= 2) return
    const p = makePane()
    setPanes((prev) => [...prev, p])
    setActivePaneId(p.id)
  }

  function closePane(id: string) {
    setPanes((prev) => (prev.length <= 1 ? prev : prev.filter((p) => p.id !== id)))
  }

  return (
    <div className="app">
      <div className="app-header">
        <h1>CT / Segmentation Viewer</h1>
        <div className="app-header-controls">
          {panes.length > 1 && (
            <label className="link-toggle" title="Sync scroll / plane / zoom across panes">
              <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
              Interaction
            </label>
          )}
          {panes.length > 1 && (
            <label className="link-toggle" title="When on, clicking Previous/Next in one pane also loads the matching Patient ID case in the other pane">
              <input
                type="checkbox"
                checked={syncNavByPatientId}
                onChange={(e) => setSyncNavByPatientId(e.target.checked)}
              />
              Iteration
            </label>
          )}
          <button
            className={reviewModeOn ? 'active' : ''}
            onClick={toggleReviewMode}
            title={
              reviewModeOn
                ? 'Review mode is on — Previous/Next only stop on cases matching the selected reason tags'
                : 'Turn on Review mode — Previous/Next will only stop on cases matching the selected reason tags'
            }
          >
            Review{reviewModeOn ? ' ●' : ''}
          </button>
          <div className="reason-picker-anchor">
            <button
              onClick={() => setReviewTagsPickerOpen((v) => !v)}
              title="Choose which reason tags Review mode looks for"
            >
              Tags{reviewTags.length ? ` (${reviewTags.length})` : ''}
            </button>
            {reviewTagsPickerOpen && (
              <ReviewTagsPicker
                options={allReasonOptions}
                selected={reviewTags}
                onToggle={(tag) =>
                  setReviewTags(reviewTags.includes(tag) ? reviewTags.filter((t) => t !== tag) : [...reviewTags, tag])
                }
                onClose={() => setReviewTagsPickerOpen(false)}
              />
            )}
          </div>
          {panes.length > 1 && (
            <div
              className="review-parent-select"
              title="Which pane's Reason tags drive Review mode's Previous/Next skipping"
            >
              <span>Review pane</span>
              <div className="plane-tabs">
                {panes.map((p, i) => (
                  <button
                    key={p.id}
                    className={effectiveReviewParentId === p.id ? 'active' : ''}
                    onClick={() => setReviewParentPaneId(p.id)}
                  >
                    {i === 0 ? 'Left' : 'Right'}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button onClick={() => setKeybindSettingsOpen(true)} title="Keyboard shortcut settings">
            ⌨ Shortcuts
          </button>
          {panes.length < 2 ? (
            <button onClick={addSplit}>+ Split view</button>
          ) : (
            <span className="split-hint">Split view active</span>
          )}
        </div>
      </div>
      <div className={`panes-container panes-${panes.length}`}>
        {panes.map((pane) => (
          <Pane
            key={pane.id}
            pane={pane}
            onChange={(partial) => updatePane(pane.id, partial)}
            onClose={() => closePane(pane.id)}
            closable={panes.length > 1}
            onNavigate={(direction) => navigate(pane.id, direction)}
            onJumpTo={(position) => goToPosition(pane.id, position)}
            isActive={pane.id === effectiveActivePaneId}
            onActivate={() => setActivePaneId(pane.id)}
            keybinds={keybinds}
            onCopyToOtherPane={panes.length > 1 ? () => copyReasonCommentToOtherPane(pane.id) : undefined}
            onToggleReviewMode={toggleReviewMode}
            annotationSaveDir={annotationSaveDir}
            onAnnotationSaveDirChange={setAnnotationSaveDir}
            onApplyContrastEvidence={(ctPath, ctInfo) => applyContrastEvidence(pane.id, ctPath, ctInfo)}
            onLoadRow={(row) => loadRowIntoPane(pane.id, row, pane.plane)}
          />
        ))}
      </div>
      {keybindSettingsOpen && (
        <KeybindSettings keybinds={keybinds} onChange={setKeybinds} onClose={() => setKeybindSettingsOpen(false)} />
      )}
      {blockedAction && (
        <div className="comment-modal-backdrop" onClick={() => setBlockedAction(null)}>
          <div className="comment-modal" onClick={(e) => e.stopPropagation()}>
            <div className="comment-modal-title">Unsaved annotation changes</div>
            <div className="nav-modal-body">{blockedAction.message}</div>
            <div className="comment-modal-buttons">
              <button onClick={() => setBlockedAction(null)}>Go back and save</button>
              <button
                className="danger-btn"
                onClick={() => {
                  const run = blockedAction.run
                  setBlockedAction(null)
                  run()
                }}
              >
                Discard and continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
