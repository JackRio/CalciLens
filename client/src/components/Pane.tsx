import { useCallback, useEffect, useRef, useState } from 'react'
import type { PaneState, Plane } from '../types'
import { WINDOW_PRESETS, DEFAULT_WINDOW_LEVEL, DEFAULT_WINDOW_WIDTH } from '../types'
import {
  loadVolume,
  probeVoxel,
  renderUrl,
  createBlankMask,
  paintMask,
  regionGrowMask,
  refreshMaskLabels,
  saveMask,
} from '../api'
import InfoPanel from './InfoPanel'
import LabelColorEditor from './LabelColorEditor'
import CaseLoader from './CaseLoader'
import AlphaSpinner from './AlphaSpinner'
import MaskEditor from './MaskEditor'

const PLANES: Plane[] = ['axial', 'sagittal', 'coronal']

export default function Pane({
  pane,
  onChange,
  onClose,
  closable,
  onNavigate,
}: {
  pane: PaneState
  onChange: (partial: Partial<PaneState>) => void
  onClose: () => void
  closable: boolean
  onNavigate: (direction: 1 | -1) => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [probe, setProbe] = useState<{ hu: number | null; label: number | null; row: number; col: number } | null>(
    null,
  )
  // Brush-cursor tracking deliberately bypasses React state: it's a
  // high-frequency, purely-visual value with no data anyone else reads, so
  // we write straight to the DOM node (via ref) in a requestAnimationFrame
  // callback instead of paying for a React re-render on every mouse move.
  const cursorDivRef = useRef<HTMLDivElement>(null)
  const pendingCursor = useRef<{ x: number; y: number; diameter: number } | null>(null)
  const cursorRafId = useRef<number | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const viewerAreaRef = useRef<HTMLDivElement>(null)
  const wlBoxRef = useRef<HTMLDivElement>(null)
  const bottomLeftRef = useRef<HTMLDivElement>(null)
  const editBoxRef = useRef<HTMLDivElement>(null)
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
  const lastPaintTs = useRef(0)
  const lastRenderBumpTs = useRef(0)
  const editBoxDrag = useRef<{ active: boolean; offsetX: number; offsetY: number }>({
    active: false,
    offsetX: 0,
    offsetY: 0,
  })

  const planeLength = pane.ctInfo ? pane.ctInfo.plane_lengths[pane.plane] : 1
  const currentRowPos = pane.manifestRows.findIndex((r) => r.index === pane.activeRowIndex)
  const currentRow = currentRowPos >= 0 ? pane.manifestRows[currentRowPos] : null

  useEffect(() => {
    return () => {
      if (cursorRafId.current !== null) cancelAnimationFrame(cursorRafId.current)
    }
  }, [])

  async function doLoadCt(path: string) {
    onChange({ loading: true, error: null })
    try {
      const info = await loadVolume(path, false)
      onChange({
        ctPath: path,
        ctInfo: info,
        loading: false,
        index: Math.floor(info.plane_lengths[pane.plane] / 2),
      })
    } catch (e) {
      onChange({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  async function doLoadMask(path: string) {
    onChange({ loading: true, error: null })
    try {
      const info = await loadVolume(path, true)
      onChange({ maskPath: path, maskInfo: info, loading: false, showMask: true })
    } catch (e) {
      onChange({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  async function doCreateMask() {
    if (!pane.ctInfo) return
    onChange({ loading: true, error: null })
    try {
      const info = await createBlankMask(pane.ctInfo.volume_id)
      onChange({ maskPath: '', maskInfo: info, loading: false, showMask: true, editMode: true })
    } catch (e) {
      onChange({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  async function doSaveMask() {
    if (!pane.maskInfo) return
    onChange({ editBusy: true, editMessage: null })
    try {
      const res = await saveMask(pane.maskInfo.volume_id)
      onChange({ editBusy: false, editMessage: `Saved to ${res.path}` })
    } catch (e) {
      onChange({ editBusy: false, editMessage: e instanceof Error ? e.message : String(e) })
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

  async function doPaint(row: number, col: number, forceRefresh = false) {
    if (!pane.ctInfo || !pane.maskInfo) return
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
    } catch {
      /* ignore transient paint errors during a drag */
    }
  }

  async function doRegionGrow(row: number, col: number) {
    if (!pane.ctInfo || !pane.maskInfo) return
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

  function isOverUIBox(target: EventTarget | null): boolean {
    const node = target as Node | null
    if (!node) return false
    return Boolean(
      (wlBoxRef.current && wlBoxRef.current.contains(node)) ||
        (editBoxRef.current && editBoxRef.current.contains(node)) ||
        (bottomLeftRef.current && bottomLeftRef.current.contains(node)),
    )
  }

  function onMouseDown(e: React.MouseEvent) {
    if (isOverUIBox(e.target)) return
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
    if (e.button === 0 && pane.editMode && pane.ctInfo && pane.maskInfo) {
      const coords = getDisplayCoords(e.clientX, e.clientY)
      if (!coords) return
      if (pane.editTool === 'brush') {
        paintDrag.current.active = true
        paintDrag.current.didPaint = false
        paintDrag.current.erasing = e.ctrlKey
        doPaint(coords.row, coords.col, true)
      } else {
        doRegionGrow(coords.row, coords.col)
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

  function onMouseMove(e: React.MouseEvent) {
    // Self-heal against a missed mouseup (e.g. the button was released while
    // briefly outside the window, or a fast click dropped/coalesced the
    // event): if our own flag says a drag is still active but the browser
    // says the button that started it is no longer actually held, end the
    // drag right here instead of continuing to paint/zoom/drag wherever the
    // cursor travels next with no button down at all.
    if (paintDrag.current.active && !(e.buttons & 1)) onMouseUp()
    if (rightDrag.current.active && !(e.buttons & 2)) onMouseUp()
    if (editBoxDrag.current.active && !(e.buttons & 1)) onMouseUp()

    if (pane.editMode && pane.editTool === 'brush' && !isOverUIBox(e.target)) {
      const container = viewerAreaRef.current
      const img = imgRef.current
      if (container && img) {
        const containerRect = container.getBoundingClientRect()
        const imgRect = img.getBoundingClientRect()
        const scale = imgRect.width / (img.naturalWidth || 1)
        const diameter = Math.max(4, 2 * pane.editBrushRadius * scale)
        pendingCursor.current = { x: e.clientX - containerRect.left, y: e.clientY - containerRect.top, diameter }
        scheduleCursorApply()
      }
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
    editBoxDrag.current.active = false
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
    onChange({ zoom: 1, windowLevel: DEFAULT_WINDOW_LEVEL, windowWidth: DEFAULT_WINDOW_WIDTH })
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
    <div className="pane">
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
              onClick={() => onNavigate(-1)}
              disabled={currentRowPos <= 0}
              title="Load previous case in manifest"
            >
              ◂ Previous
            </button>
            <span className="case-nav-count">
              {currentRowPos >= 0 ? currentRowPos + 1 : '-'}/{pane.manifestRows.length}
            </span>
            <button
              onClick={() => onNavigate(1)}
              disabled={currentRowPos < 0 || currentRowPos >= pane.manifestRows.length - 1}
              title="Load next case in manifest"
            >
              Next ▸
            </button>
          </div>
        )}
        <div className="pane-toolbar-right">
          {pane.loading && <span className="loading-tag">Loading...</span>}
          {pane.ctInfo &&
            (pane.zoom !== 1 ||
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

      <div className="pane-body">
        <div
          ref={viewerAreaRef}
          className="viewer-area"
          style={pane.editMode && pane.editTool === 'brush' ? { cursor: 'none' } : undefined}
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
              style={{ transform: `scale(${pane.zoom})` }}
            />
          ) : (
            <div className="viewer-placeholder">No CT loaded — open Settings to load a scan</div>
          )}
          {/* Always mounted (just hidden) so cursorDivRef is available the
              moment a mouse move needs it — positioned and shown/hidden via
              direct DOM writes in scheduleCursorApply, not React state. */}
          <div ref={cursorDivRef} className="brush-cursor" hidden />
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
                      onChange={(e) => onChange({ thresholdValue: Number(e.target.value) })}
                      onWheel={wheelStep('thresholdValue', 5, (v) => onChange({ thresholdValue: v }))}
                      title="Threshold (HU)"
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
                onSave={doSaveMask}
                onDragHandleDown={handleEditBoxDragStart}
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
            <CaseLoader pane={pane} onChange={onChange} onLoadCt={doLoadCt} onLoadMask={doLoadMask} />

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
    </div>
  )
}
