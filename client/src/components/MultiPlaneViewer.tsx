import { useEffect, useRef, useState } from 'react'
import { renderUrl } from '../api'
import type { PaneState, Plane } from '../types'
import { edgeLabels, flipCode, planeFlips, type DisplayOrientation } from '../displayOrientation'

// The three views at once, linked through one shared point.
//
// The volume is a single LPS-ordered array (z=S, y=P, x=L), so a voxel index
// (x, y, z) IS a physical position: all three views index the same grid, and
// moving the point in one view sets the slice shown in the other two. Each
// view's slice index is one coordinate of the point: axial = z, sagittal = x,
// coronal = y.
export interface MprCursor {
  x: number
  y: number
  z: number
}

type Lengths = Record<Plane, number>

export const MPR_PLANES: Plane[] = ['axial', 'sagittal', 'coronal']

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// Each view zooms and pans on its own. x/y are the shift, in pixels, of the
// image from its centred, fitted position.
export interface MprView {
  zoom: number
  x: number
  y: number
}

export const IDENTITY_VIEW: MprView = { zoom: 1, x: 0, y: 0 }
export const MPR_ZOOM_MAX = 8
const ZOOM_STEP = 1.15

export function isZoomed(v: MprView): boolean {
  return v.zoom !== 1 || v.x !== 0 || v.y !== 0
}

// Never let the image be dragged entirely out of the view.
function clampPan(v: MprView, fw: number, fh: number): MprView {
  const lx = (fw * v.zoom) / 2
  const ly = (fh * v.zoom) / 2
  return { ...v, x: clamp(v.x, -lx, lx), y: clamp(v.y, -ly, ly) }
}

// Zoom by `factor` keeping the image point under the cursor where it is.
// (mx, my) is the cursor relative to the centre of the view.
function zoomAbout(cur: MprView, factor: number, mx: number, my: number, fw: number, fh: number): MprView {
  const zoom = clamp(cur.zoom * factor, 1, MPR_ZOOM_MAX)
  if (zoom === cur.zoom) return cur
  if (zoom <= 1) return IDENTITY_VIEW
  const k = zoom / cur.zoom
  return clampPan({ zoom, x: mx - k * (mx - cur.x), y: my - k * (my - cur.y) }, fw, fh)
}

export function middleCursor(len: Lengths): MprCursor {
  return { x: Math.floor(len.sagittal / 2), y: Math.floor(len.coronal / 2), z: Math.floor(len.axial / 2) }
}

export function planeIndexOf(c: MprCursor, plane: Plane): number {
  return plane === 'axial' ? c.z : plane === 'sagittal' ? c.x : c.y
}

export function withPlaneIndex(c: MprCursor, plane: Plane, index: number, len: Lengths): MprCursor {
  const i = clamp(index, 0, len[plane] - 1)
  return plane === 'axial' ? { ...c, z: i } : plane === 'sagittal' ? { ...c, x: i } : { ...c, y: i }
}

// Where the point sits inside a view, as fractions of the image (from the
// left, from the top), before any display flip. Sagittal and coronal put
// superior at the top, hence 1 - z. This is the exact inverse of
// fromFraction, and matches how the backend lays the slices out.
function toFraction(plane: Plane, c: MprCursor, len: Lengths): { fx: number; fy: number } {
  const nx = len.sagittal
  const ny = len.coronal
  const nz = len.axial
  if (plane === 'axial') return { fx: (c.x + 0.5) / nx, fy: (c.y + 0.5) / ny }
  if (plane === 'sagittal') return { fx: (c.y + 0.5) / ny, fy: 1 - (c.z + 0.5) / nz }
  return { fx: (c.x + 0.5) / nx, fy: 1 - (c.z + 0.5) / nz }
}

function fromFraction(plane: Plane, c: MprCursor, len: Lengths, fx: number, fy: number): MprCursor {
  const nx = len.sagittal
  const ny = len.coronal
  const nz = len.axial
  if (plane === 'axial') return { ...c, x: clamp(Math.floor(fx * nx), 0, nx - 1), y: clamp(Math.floor(fy * ny), 0, ny - 1) }
  if (plane === 'sagittal')
    return { ...c, y: clamp(Math.floor(fx * ny), 0, ny - 1), z: clamp(Math.floor((1 - fy) * nz), 0, nz - 1) }
  return { ...c, x: clamp(Math.floor(fx * nx), 0, nx - 1), z: clamp(Math.floor((1 - fy) * nz), 0, nz - 1) }
}

const PLANE_TITLE: Record<Plane, string> = { axial: 'Axial', sagittal: 'Sagittal', coronal: 'Coronal' }

function MprTile({
  plane,
  pane,
  cursor,
  len,
  orient,
  active,
  view,
  onCursor,
  onStep,
  onView,
  onActivate,
}: {
  plane: Plane
  pane: PaneState
  cursor: MprCursor
  len: Lengths
  orient: DisplayOrientation
  active: boolean
  view: MprView
  onCursor: (c: MprCursor) => void
  onStep: (delta: 1 | -1) => void
  onView: (update: (cur: MprView) => MprView) => void
  onActivate: () => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)

  // Handlers registered once (window listeners, native wheel) read the
  // latest values through this ref instead of a stale closure.
  const live = useRef({ cursor, len, orient, view, onCursor, onStep, onView, fw: 0, fh: 0 })
  live.current = { ...live.current, cursor, len, orient, view, onCursor, onStep, onView }
  const dragCleanup = useRef<(() => void) | null>(null)

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Native, non-passive wheel so the page never scrolls under the cursor.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey) {
        const r = el.getBoundingClientRect()
        const mx = e.clientX - (r.left + r.width / 2)
        const my = e.clientY - (r.top + r.height / 2)
        const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP
        // Functional update, so a fast burst of wheel events compounds.
        live.current.onView((cur) => zoomAbout(cur, factor, mx, my, live.current.fw, live.current.fh))
        return
      }
      live.current.onStep(e.deltaY > 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => () => dragCleanup.current?.(), [])

  function setFromPointer(clientX: number, clientY: number) {
    const content = contentRef.current
    if (!content) return
    // Includes the zoom/pan transform, so this stays exact when zoomed.
    const r = content.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const { cursor: c, len: l, orient: o, onCursor: set } = live.current
    let fx = clamp((clientX - r.left) / r.width, 0, 0.999999)
    let fy = clamp((clientY - r.top) / r.height, 0, 0.999999)
    const f = planeFlips(plane, o)
    if (f.h) fx = 1 - fx
    if (f.v) fy = 1 - fy
    set(fromFraction(plane, c, l, fx, fy))
  }

  function onMouseDown(e: React.MouseEvent) {
    const wantsPan = e.button === 1 || (e.button === 0 && e.shiftKey)
    if (e.button !== 0 && e.button !== 1) return
    e.preventDefault()
    onActivate()
    if (wantsPan) {
      const startX = e.clientX
      const startY = e.clientY
      const start = live.current.view
      const move = (ev: MouseEvent) =>
        live.current.onView(() =>
          clampPan(
            { zoom: start.zoom, x: start.x + (ev.clientX - startX), y: start.y + (ev.clientY - startY) },
            live.current.fw,
            live.current.fh,
          ),
        )
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        dragCleanup.current = null
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      dragCleanup.current = up
      return
    }
    // Only the image itself moves the point, not the empty margin around it.
    if (!contentRef.current?.contains(e.target as Node)) return
    setFromPointer(e.clientX, e.clientY)
    const move = (ev: MouseEvent) => setFromPointer(ev.clientX, ev.clientY)
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      dragCleanup.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    dragCleanup.current = up
  }

  const index = planeIndexOf(cursor, plane)
  const src = renderUrl({
    ctId: pane.ctInfo!.volume_id,
    maskId: pane.maskInfo?.volume_id ?? null,
    plane,
    index,
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
    flip: flipCode(orient),
  })

  // Fit the image into the tile at its true proportions. The backend already
  // resamples each view to physical (isotropic) pixels, so the natural size's
  // aspect ratio is the real-world one.
  let frameW = box.w
  let frameH = box.h
  if (nat && box.w > 0 && box.h > 0) {
    const s = Math.min(box.w / nat.w, box.h / nat.h)
    frameW = Math.floor(nat.w * s)
    frameH = Math.floor(nat.h * s)
  }

  live.current.fw = frameW
  live.current.fh = frameH

  const f = planeFlips(plane, orient)
  let { fx, fy } = toFraction(plane, cursor, len)
  if (f.h) fx = 1 - fx
  if (f.v) fy = 1 - fy
  const letters = edgeLabels(plane, orient)

  return (
    <div className={`mpr-tile${active ? ' mpr-tile-active' : ''}`}>
      <div className="mpr-tile-head">
        <span />
        <span className="mpr-tile-name">{PLANE_TITLE[plane]}</span>
        <span className="mpr-tile-count">
          {index + 1}/{len[plane]}
        </span>
      </div>
      <div
        className="mpr-tile-body"
        ref={bodyRef}
        onMouseDown={onMouseDown}
        onDoubleClick={() => onView(() => IDENTITY_VIEW)}
        onContextMenu={(e) => e.preventDefault()}
        title="Click to move the point · Ctrl+wheel to zoom · Shift+drag to pan · double-click to reset this view"
      >
        <div
          className="mpr-frame"
          ref={contentRef}
          style={
            {
              width: frameW,
              height: frameH,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
              '--zoom': view.zoom,
            } as React.CSSProperties
          }
        >
          <img
            src={src}
            alt={`${plane} slice`}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget
              if (img.naturalWidth && (!nat || nat.w !== img.naturalWidth || nat.h !== img.naturalHeight)) {
                setNat({ w: img.naturalWidth, h: img.naturalHeight })
              }
            }}
          />
          <div className="mpr-cross mpr-cross-v" style={{ left: `${fx * 100}%` }} />
          <div className="mpr-cross mpr-cross-h" style={{ top: `${fy * 100}%` }} />
        </div>
        {/* Orientation letters stay at the edges of the view while the image zooms. */}
        {orient.letters && (
          <>
            <span className="mpr-letter mpr-letter-left">{letters.left}</span>
            <span className="mpr-letter mpr-letter-right">{letters.right}</span>
            <span className="mpr-letter mpr-letter-top">{letters.top}</span>
            <span className="mpr-letter mpr-letter-bottom">{letters.bottom}</span>
          </>
        )}
        {view.zoom > 1 && <span className="mpr-zoom-badge">{view.zoom.toFixed(1)}×</span>}
      </div>
    </div>
  )
}

export default function MultiPlaneViewer({
  pane,
  cursor,
  orient,
  activePlane,
  views,
  onCursor,
  onStep,
  onView,
  onActivePlane,
}: {
  pane: PaneState
  cursor: MprCursor
  orient: DisplayOrientation
  activePlane: Plane
  onCursor: (c: MprCursor) => void
  // Step one plane's slice. The pane owns the cursor and applies this to its
  // live value, so a fast wheel burst compounds instead of stalling.
  onStep: (plane: Plane, delta: 1 | -1) => void
  views: Record<Plane, MprView>
  onView: (plane: Plane, update: (cur: MprView) => MprView) => void
  onActivePlane: (p: Plane) => void
}) {
  const len = pane.ctInfo!.plane_lengths
  return (
    <div className="mpr-grid">
      {MPR_PLANES.map((plane) => (
        <MprTile
          key={plane}
          plane={plane}
          pane={pane}
          cursor={cursor}
          len={len}
          orient={orient}
          active={activePlane === plane}
          onCursor={onCursor}
          onStep={(d) => {
            onActivePlane(plane)
            onStep(plane, d)
          }}
          view={views[plane]}
          onView={(u) => onView(plane, u)}
          onActivate={() => onActivePlane(plane)}
        />
      ))}
    </div>
  )
}
