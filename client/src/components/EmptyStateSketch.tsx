import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppMode } from '../types'

// What the empty viewer shows instead of a black box: a faint, hand-drawn
// how-to for getting a scan on screen. Purely decorative and click-through.
// The sketch's own drawing area (SVG viewBox), used to find where it really
// sits inside the viewer once it has been scaled to fit.
const HAND = "'Segoe Print','Ink Free','Bradley Hand','Comic Sans MS',cursive"

const VIEWBOX_W = 904
const VIEWBOX_H = 428

interface Geo {
  rootTop: number
  rootRight: number
  drawnTop: number
  // How big to draw the notes: they grow with the drawing (up to 1.5x) so
  // they stay in proportion on a large window.
  s: number
  tabs: DOMRect | null
  shortcuts: DOMRect | null
}

// A loose, looping arrow drawn along +x for length L (rotated into place by
// the caller) so it reads as a hand-drawn swirl, not a straight pointer.
function swirlPath(L: number): string {
  const r = Math.min(15, L * 0.11)
  return (
    `M0 0 C ${L * 0.15} ${-r * 1.6}, ${L * 0.3} ${-r * 2}, ${L * 0.42} ${-r * 0.8} ` +
    `C ${L * 0.5} ${r * 0.4}, ${L * 0.44} ${r * 1.9}, ${L * 0.36} ${r * 1.2} ` +
    `C ${L * 0.28} ${r * 0.5}, ${L * 0.44} ${-r * 1.6}, ${L * 0.62} ${-r * 0.9} ` +
    `C ${L * 0.8} ${-r * 0.2}, ${L * 0.88} ${r * 0.3}, ${L} 0`
  )
}

function Swirl({ from, to }: { from: [number, number]; to: [number, number] }) {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const len = Math.hypot(dx, dy)
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  return (
    <path
      d={swirlPath(len)}
      transform={`translate(${from[0]} ${from[1]}) rotate(${angle})`}
      markerEnd="url(#callout-arrow)"
    />
  )
}

// Arrows from the empty viewer up to the controls they talk about. Those
// controls live outside the viewer, so this is a click-through layer over the
// whole window, positioned from where the buttons really are.
function Callouts({ geo }: { geo: Geo }) {
  // Neon-ish so they stand out from the grey drawing (colour defined in App.css).
  const stroke = 'var(--sketch-neon)'
  const text = '#8f93a6'
  const font = "'Segoe Print','Ink Free','Bradley Hand','Comic Sans MS',cursive"
  const { rootTop, rootRight, tabs, shortcuts, s } = geo
  const fontSize = 18 * s

  return createPortal(
    <svg className="empty-callouts" width="100%" height="100%" aria-hidden>
      <defs>
        <filter id="callout-wobble" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="4" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="2.5" />
        </filter>
        <marker id="callout-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M1 1 L9 5 L1 9" fill="none" style={{ stroke }} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>

      <g filter="url(#callout-wobble)" fill="none" style={{ stroke }} strokeWidth={2 * s} strokeLinecap="round">
        {tabs && (
          <Swirl from={[tabs.left + 112 * s, rootTop + 38 + 16 * s]} to={[tabs.left + tabs.width / 2, tabs.bottom + 4]} />
        )}
        {shortcuts && (
          <Swirl
            from={[rootRight - 24 - 250 * s, rootTop + 36]}
            to={[shortcuts.left - 8, shortcuts.top + shortcuts.height / 2]}
          />
        )}
      </g>

      <g fill={text} fontFamily={font}>
        {tabs && (
          <text x={tabs.left + 6} y={rootTop + 44 + 34 * s} fontSize={fontSize}>
            all the views you need
          </text>
        )}
        {shortcuts && (
          <g textAnchor="end">
            <text x={rootRight - 24} y={rootTop + 40 + 22 * s} fontSize={fontSize}>
              For keyboard junkies:
            </text>
            <text x={rootRight - 24} y={rootTop + 40 + 22 * s + 24 * s} fontSize={fontSize}>
              check out the shortcut keys
            </text>
          </g>
        )}
      </g>
    </svg>,
    document.body,
  )
}

// ---- View mode: how to load a scan and move around it ----
function ViewArt({ line, text, viewOnly }: { line: string; text: string; viewOnly: boolean }) {
  return (
    <>
        <defs>
        {/* A slight wobble so the strokes look sketched, not ruled. */}
        <filter id="sketch-wobble" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.025" numOctaves="2" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" />
        </filter>
        <marker id="sketch-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M1 1 L9 5 L1 9" fill="none" stroke={line} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>

      <g
        filter="url(#sketch-wobble)"
        fill="none"
        stroke={line}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* ---- three step cards ---- */}
        <rect x="40" y="30" width="260" height="235" rx="16" strokeDasharray="7 6" />
        <rect x="350" y="30" width="260" height="235" rx="16" strokeDasharray="7 6" />
        <rect x="660" y="30" width="260" height="235" rx="16" strokeDasharray="7 6" />

        {/* arrows between the steps */}
        <path d="M304 148 C 318 138, 334 158, 346 148" markerEnd="url(#sketch-arrow)" />
        <path d="M614 148 C 628 138, 644 158, 656 148" markerEnd="url(#sketch-arrow)" />

        {/* step numbers */}
        <circle cx="68" cy="58" r="14" />
        <circle cx="378" cy="58" r="14" />
        <circle cx="688" cy="58" r="14" />

        {/* 1. the viewer, its settings panel, and the thread being pulled up */}
        <rect x="105" y="100" width="130" height="86" rx="6" />
        <path d="M105 168 L235 168" strokeDasharray="4 5" />
        <path d="M170 186 C 164 176, 176 170, 170 160" />
        <circle cx="170" cy="155" r="5" />
        <path d="M160 142 L170 131 L180 142" />
        <path d="M160 128 L170 117 L180 128" opacity="0.5" />

        {/* 2. a folder holding scans */}
        <path d="M415 190 L415 120 L455 120 L468 134 L545 134 L545 190 Z" />
        <path d="M415 190 L432 148 L560 148 L545 190" />
        <path d="M448 108 L448 96 L490 96 L490 108" opacity="0.5" />

        {/* 3. a CT slice with an optional mask blob on it */}
        <ellipse cx="790" cy="140" rx="58" ry="46" />
        <ellipse cx="790" cy="140" rx="46" ry="34" opacity="0.5" />
        <circle cx="782" cy="132" r="13" />
        <circle cx="808" cy="152" r="6" />
        <path d="M774 152 C 766 160, 780 168, 790 160 C 796 154, 786 148, 774 152 Z" strokeDasharray="3 4" />

        {/* ---- second row ---- */}
        <rect x="40" y="290" width="435" height="95" rx="14" strokeDasharray="7 6" />
        <rect x="485" y="290" width="435" height="95" rx="14" strokeDasharray="7 6" />

        {/* a small table, for "load a manifest" */}
        <rect x="62" y="316" width="52" height="42" rx="3" />
        <path d="M62 330 L114 330 M62 344 L114 344 M88 316 L88 358" opacity="0.6" />

        {/* mouse, for the controls */}
        <rect x="508" y="316" width="30" height="44" rx="14" />
        <path d="M523 316 L523 332 M508 332 L538 332" opacity="0.6" />
      </g>

      <g fill={text} fontFamily="'Segoe Print','Ink Free','Bradley Hand','Comic Sans MS',cursive" textAnchor="middle">
        <text x="68" y="63" fontSize="16">1</text>
        <text x="378" y="63" fontSize="16">2</text>
        <text x="688" y="63" fontSize="16">3</text>

        <text x="170" y="62" fontSize="20" fontWeight="700">Open settings</text>
        <text x="480" y="62" fontSize="20" fontWeight="700">Pick your scan</text>
        <text x="790" y="62" fontSize="20" fontWeight="700">Load it</text>

        <text x="170" y="222" fontSize="16">Pull the handle up</text>
        <text x="170" y="245" fontSize="14">or click “Settings”</text>

        <text x="480" y="222" fontSize="16">Browse file… or directory…</text>
        <text x="480" y="245" fontSize="13">.nii .nii.gz .mha .mhd .nrrd · DICOM</text>

        <text x="790" y="222" fontSize="16">Load CT</text>
        <text x="790" y="245" fontSize="14">then Load mask (optional)</text>

        <g textAnchor="start">
          <text x="132" y="326" fontSize="16" fontWeight="700">Many cases?</text>
          <text x="132" y="349" fontSize="14">Load a manifest (CSV / Excel), then</text>
          <text x="132" y="370" fontSize="14">step through with Previous / Next</text>

          <text x="552" y="326" fontSize="16" fontWeight="700">Once it’s open</text>
          <text x="552" y="349" fontSize="14">Wheel: slices · Ctrl+wheel: zoom</text>
          <text x="552" y="370" fontSize="14">
            {viewOnly ? 'Right-drag: window/level · Show all: 3 views' : 'Right-drag: window/level · Shift+drag: pan'}
          </text>
        </g>

        <text x="480" y="410" fontSize="12" opacity="0.7">Developed by a bored PhD student with vibes only</text>
      </g>
    </>
  )
}

// ---- Annotate, non-contrast: load, get a mask, paint, save ----
function AnnotateNonContrastArt({ line, text }: { line: string; text: string }) {
  return (
    <>
      <defs>
        <filter id="sketch-wobble" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.025" numOctaves="2" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" />
        </filter>
        <marker id="sketch-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M1 1 L9 5 L1 9" fill="none" stroke={line} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>

      <g filter="url(#sketch-wobble)" fill="none" stroke={line} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {/* three step cards; the middle and right ones are wider for their longer text */}
        <rect x="40" y="30" width="230" height="250" rx="16" strokeDasharray="7 6" />
        <rect x="314" y="30" width="290" height="250" rx="16" strokeDasharray="7 6" />
        <rect x="648" y="30" width="272" height="250" rx="16" strokeDasharray="7 6" />
        <path d="M274 155 C 286 145, 298 165, 310 155" markerEnd="url(#sketch-arrow)" />
        <path d="M608 155 C 620 145, 632 165, 644 155" markerEnd="url(#sketch-arrow)" />
        <circle cx="68" cy="58" r="14" />
        <circle cx="342" cy="58" r="14" />
        <circle cx="676" cy="58" r="14" />

        {/* 1. a CT slice */}
        <ellipse cx="155" cy="128" rx="58" ry="46" />
        <ellipse cx="155" cy="128" rx="46" ry="34" opacity="0.5" />
        <circle cx="147" cy="120" r="13" />
        <circle cx="173" cy="140" r="6" />

        {/* 2. the same slice with a dashed mask on it, and a "+ new mask" */}
        <ellipse cx="440" cy="128" rx="58" ry="46" />
        <ellipse cx="440" cy="128" rx="46" ry="34" opacity="0.5" />
        <circle cx="432" cy="120" r="13" strokeDasharray="3 4" />
        <circle cx="458" cy="140" r="6" strokeDasharray="3 4" />
        <circle cx="530" cy="98" r="17" />
        <path d="M530 89 L530 107 M521 98 L539 98" />

        {/* 3. a brush painting a blob, and label chips */}
        <g transform="translate(784 128) scale(0.85) translate(-800 -132)">
          <path d="M842 82 L862 96 L820 138 L802 122 Z" />
          <path d="M802 122 L820 138 C 806 152, 788 152, 780 142 C 786 134, 794 128, 802 122 Z" />
          <path d="M748 172 C 738 152, 760 140, 780 150 C 796 158, 790 178, 770 182 C 756 184, 750 180, 748 172 Z" strokeDasharray="3 4" />
          <circle cx="716" cy="100" r="8" />
          <circle cx="742" cy="100" r="8" />
          <circle cx="768" cy="100" r="8" />
        </g>

        {/* second row */}
        <rect x="40" y="296" width="435" height="95" rx="14" strokeDasharray="7 6" />
        <rect x="485" y="296" width="435" height="95" rx="14" strokeDasharray="7 6" />

        {/* a floppy disk, for saving */}
        <path d="M64 326 L64 368 L106 368 L106 334 L98 326 Z" />
        <path d="M72 326 L72 338 L96 338 L96 326" opacity="0.6" />
        <rect x="74" y="351" width="22" height="17" opacity="0.6" />

        {/* a mouse, for the controls */}
        <rect x="508" y="322" width="30" height="44" rx="14" />
        <path d="M523 322 L523 338 M508 338 L538 338" opacity="0.6" />
      </g>

      <g fill={text} fontFamily={HAND} textAnchor="middle">
        <text x="68" y="63" fontSize="16">1</text>
        <text x="342" y="63" fontSize="16">2</text>
        <text x="676" y="63" fontSize="16">3</text>

        <text x="165" y="62" fontSize="20" fontWeight="700">Load the CT</text>
        <text x="459" y="62" fontSize="20" fontWeight="700">Load the mask</text>
        <text x="784" y="62" fontSize="20" fontWeight="700">Paint it</text>

        <text x="155" y="204" fontSize="16">Load CT</text>
        <text x="155" y="226" fontSize="14">or a whole manifest</text>

        <text x="459" y="204" fontSize="14">Load a prediction / annotation</text>
        <text x="459" y="226" fontSize="14">or “+ New mask to edit”</text>

        <text x="784" y="204" fontSize="16">Pick a label</text>
        <text x="784" y="226" fontSize="14">select mode:</text>
        <text x="784" y="246" fontSize="14">Brush or Region-Growing</text>
        <text x="784" y="268" fontSize="13">Threshold defaults to 130 HU</text>

        <g textAnchor="start">
          <text x="132" y="332" fontSize="16" fontWeight="700">Save is safe</text>
          <text x="132" y="355" fontSize="14">Goes to Manual_Annotations/&lt;scan&gt;/</text>
          <text x="132" y="376" fontSize="14">Your prediction is never overwritten</text>

          <text x="552" y="332" fontSize="16" fontWeight="700">Handy</text>
          <text x="552" y="355" fontSize="14">Left-drag: paint · Ctrl+drag: erase</text>
          <text x="552" y="376" fontSize="14">0–9: switch label · Score: click a lesion</text>
        </g>

        <text x="480" y="414" fontSize="14" opacity="0.85">Working on contrast scan? Wrong window, dear user.</text>
        <text x="480" y="434" fontSize="13" opacity="0.75">Go back to Modes ▸ Annotate ▸ Contrast</text>
      </g>
    </>
  )
}

export default function EmptyStateSketch({ mode, showCallouts }: { mode: AppMode; showCallouts: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [geo, setGeo] = useState<Geo | null>(null)

  useLayoutEffect(() => {
    if (!showCallouts) {
      setGeo(null)
      return
    }
    const measure = () => {
      const root = rootRef.current
      const svg = svgRef.current
      if (!root || !svg) return
      const rr = root.getBoundingClientRect()
      const sr = svg.getBoundingClientRect()
      // The drawing is letterboxed inside its SVG box; find where it really starts.
      const scale = Math.min(sr.width / VIEWBOX_W, sr.height / VIEWBOX_H)
      const drawnH = VIEWBOX_H * scale
      const drawnTop = sr.top + (sr.height - drawnH) / 2
      const pane = root.closest('.pane')
      setGeo({
        rootTop: rr.top,
        rootRight: rr.right,
        drawnTop,
        s: Math.max(1, Math.min(1.5, scale * 0.72)),
        tabs: pane?.querySelector('.plane-tabs')?.getBoundingClientRect() ?? null,
        shortcuts: document.querySelector('button[title="Keyboard shortcut settings"]')?.getBoundingClientRect() ?? null,
      })
    }
    measure()
    window.addEventListener('resize', measure)
    const ro = new ResizeObserver(measure)
    if (rootRef.current) ro.observe(rootRef.current)
    return () => {
      window.removeEventListener('resize', measure)
      ro.disconnect()
    }
  }, [showCallouts])

  // The drawing is given room above it for the notes (see .empty-sketch-notes),
  // so this only guards against a window too small even for that.
  const roomAbove = geo ? geo.drawnTop - geo.rootTop : 0
  const line = '#565968'
  const text = '#666978'
  return (
    <div className={`empty-sketch${showCallouts ? ' empty-sketch-notes' : ''}`} aria-hidden ref={rootRef}>
      {geo && roomAbove >= 90 && <Callouts geo={geo} />}
      <svg ref={svgRef} viewBox="28 18 904 428" preserveAspectRatio="xMidYMid meet">
        {mode === 'annotate-noncontrast' ? <AnnotateNonContrastArt line={line} text={text} /> : <ViewArt line={line} text={text} viewOnly={mode === 'view'} />}
      </svg>
    </div>
  )
}
