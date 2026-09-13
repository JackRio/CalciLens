import { useState } from 'react'
import './App.css'
import Pane from './components/Pane'
import type { PaneState } from './types'
import { CALCIFICATIONS_PRESET, DEFAULT_MANIFEST_CONFIG, DEFAULT_THRESHOLD_COLOR, DEFAULT_THRESHOLD_HU } from './types'

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

    ctPath: '',
    maskPath: '',
    ctInfo: null,
    maskInfo: null,

    plane: 'axial',
    index: 0,

    windowLevel: 40,
    windowWidth: 400,

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

  function updatePane(id: string, partial: Partial<PaneState>) {
    setPanes((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, ...partial } : p))
      const syncKeys: (keyof PaneState)[] = ['plane', 'index', 'zoom', 'wlMinimized']
      const shouldSync = linked && next.length > 1 && syncKeys.some((k) => k in partial)
      if (!shouldSync) return next
      return next.map((p) => {
        if (p.id === id) return p
        const syncedPartial: Partial<PaneState> = {}
        if ('plane' in partial) syncedPartial.plane = partial.plane
        if ('zoom' in partial) syncedPartial.zoom = partial.zoom
        if ('wlMinimized' in partial) syncedPartial.wlMinimized = partial.wlMinimized
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

  function addSplit() {
    setPanes((prev) => (prev.length >= 2 ? prev : [...prev, makePane()]))
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
          />
        ))}
      </div>
    </div>
  )
}
