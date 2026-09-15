import { useState } from 'react'
import './App.css'
import Pane from './components/Pane'
import KeybindSettings from './components/KeybindSettings'
import type { ManifestRow, PaneState } from './types'
import {
  CALCIFICATIONS_PRESET,
  DEFAULT_MANIFEST_CONFIG,
  DEFAULT_THRESHOLD_COLOR,
  DEFAULT_THRESHOLD_HU,
  DEFAULT_WINDOW_LEVEL,
  DEFAULT_WINDOW_WIDTH,
} from './types'
import { loadVolume, saveManifestComment, saveManifestReason } from './api'
import { useKeybinds } from './useKeybinds'

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
    batchLoadCollapsed: false,
    wlMinimized: false,
    reasonOptions: [],
    scoreClasses: [],
    scorePanelOpen: false,
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

    error: null,
    loading: false,

    editMode: false,
    editTool: 'brush',
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
  }
}

export default function App() {
  const [panes, setPanes] = useState<PaneState[]>([makePane()])
  const [linked, setLinked] = useState(true)
  const [syncNavByPatientId, setSyncNavByPatientId] = useState(false)
  const [activePaneId, setActivePaneId] = useState<string | null>(panes[0]?.id ?? null)
  const [keybinds, setKeybinds] = useKeybinds()
  const [keybindSettingsOpen, setKeybindSettingsOpen] = useState(false)
  const effectiveActivePaneId = panes.some((p) => p.id === activePaneId) ? activePaneId : (panes[0]?.id ?? null)

  function updatePane(id: string, partial: Partial<PaneState>) {
    setPanes((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, ...partial } : p))
      const syncKeys: (keyof PaneState)[] = ['plane', 'index', 'zoom', 'wlMinimized', 'showMask', 'thresholdEnabled']
      const shouldSync = linked && next.length > 1 && syncKeys.some((k) => k in partial)
      if (!shouldSync) return next
      return next.map((p) => {
        if (p.id === id) return p
        const syncedPartial: Partial<PaneState> = {}
        if ('plane' in partial) syncedPartial.plane = partial.plane
        if ('zoom' in partial) syncedPartial.zoom = partial.zoom
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
    try {
      const ctInfo = await loadVolume(row.image_path, false)
      updatePane(paneId, {
        ctPath: row.image_path,
        ctInfo,
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
    if (row.mask_path) {
      if (row.mask_exists) {
        updatePane(paneId, { loadingMessage: 'Loading mask...' })
        try {
          const maskInfo = await loadVolume(row.mask_path, true)
          updatePane(paneId, { maskPath: row.mask_path, maskInfo, showMask: true })
        } catch (e) {
          updatePane(paneId, { manifestError: e instanceof Error ? e.message : String(e) })
        }
      } else {
        updatePane(paneId, { maskPath: '', maskInfo: null, manifestError: `Mask not found: ${row.mask_path}` })
      }
    } else {
      updatePane(paneId, { maskPath: '', maskInfo: null })
    }
    updatePane(paneId, { loading: false, loadingMessage: null })
  }

  function clearPaneScan(paneId: string, errorMsg: string) {
    updatePane(paneId, {
      activeRowIndex: null,
      ctInfo: null,
      maskInfo: null,
      ctPath: '',
      maskPath: '',
      manifestError: errorMsg,
      error: null,
    })
  }

  function navigate(paneId: string, direction: 1 | -1) {
    const pane = panes.find((p) => p.id === paneId)
    if (!pane || pane.manifestRows.length === 0) return
    const rows = pane.manifestRows
    const curPos = rows.findIndex((r) => r.index === pane.activeRowIndex)
    const nextPos = curPos + direction
    if (nextPos < 0 || nextPos >= rows.length) return
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
        if (match) {
          loadRowIntoPane(other.id, match, other.plane)
        } else {
          clearPaneScan(other.id, `No image path for PatientID ${row.patient_id}`)
        }
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
      await saveManifestReason(other.manifestConfig.manifestPath, otherRow.index, sourceRow.reason)
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
            <label className="link-toggle">
              <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
              Sync scroll / plane / zoom across panes
            </label>
          )}
          {panes.length > 1 && (
            <label className="link-toggle" title="When on, clicking Previous/Next in one pane also loads the matching Patient ID case in the other pane">
              <input
                type="checkbox"
                checked={syncNavByPatientId}
                onChange={(e) => setSyncNavByPatientId(e.target.checked)}
              />
              Sync Previous/Next by Patient ID
            </label>
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
            isActive={pane.id === effectiveActivePaneId}
            onActivate={() => setActivePaneId(pane.id)}
            keybinds={keybinds}
            onCopyToOtherPane={panes.length > 1 ? () => copyReasonCommentToOtherPane(pane.id) : undefined}
          />
        ))}
      </div>
      {keybindSettingsOpen && (
        <KeybindSettings keybinds={keybinds} onChange={setKeybinds} onClose={() => setKeybindSettingsOpen(false)} />
      )}
    </div>
  )
}
