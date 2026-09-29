// The drawings on the launcher, shown when you hover an option. They say what a
// screen is FOR (each screen explains its own flow once you are inside).
//
// View and Annotate are built like building blocks: hovering the block shows a
// general drawing, and hovering one of its buttons keeps that same drawing and
// adds to it (View ▸ Split view even splits the one viewer into two). That is
// why each block is ONE svg whose parts fade/move by `data-state`; the rules
// live in Launcher.css (`.lp-*`).

export type PreviewId =
  | 'view'
  | 'view-single'
  | 'view-split'
  | 'review'
  | 'annotate'
  | 'annotate-contrast'
  | 'annotate-noncontrast'

type Family = 'view' | 'annotate' | 'review' | 'idle'
type State = 'base' | 'single' | 'split' | 'contrast' | 'noncontrast'

const HAND = "'Segoe Print','Ink Free','Bradley Hand','Comic Sans MS',cursive"
const LINE = '#5f6274'
const TEXT = '#8a8d9f'
const NEON = 'var(--sketch-neon)'

function familyOf(id: PreviewId | null): Family {
  if (!id) return 'idle'
  if (id.startsWith('view')) return 'view'
  if (id.startsWith('annotate')) return 'annotate'
  return 'review'
}

function stateOf(id: PreviewId | null): State {
  if (id === 'view-single') return 'single'
  if (id === 'view-split') return 'split'
  if (id === 'annotate-contrast') return 'contrast'
  if (id === 'annotate-noncontrast') return 'noncontrast'
  return 'base'
}

function Defs() {
  return (
    <defs>
      <filter id="lp-wobble" filterUnits="userSpaceOnUse" x="-100" y="-100" width="1200" height="600">
        <feTurbulence type="fractalNoise" baseFrequency="0.025" numOctaves="2" seed="7" result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale="3" />
      </filter>
    </defs>
  )
}

// Every drawing shares this stroke setup.
function Ink({ children, color = LINE, dash }: { children: React.ReactNode; color?: string; dash?: string }) {
  return (
    <g
      filter="url(#lp-wobble)"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={dash}
    >
      {children}
    </g>
  )
}

function Words({ children, anchor = 'start' }: { children: React.ReactNode; anchor?: 'start' | 'middle' }) {
  return (
    <g fill={TEXT} fontFamily={HAND} textAnchor={anchor}>
      {children}
    </g>
  )
}

// A part that is only visible in some states (`show` lists them). `late` waits
// for the movement to finish before fading in.
function Part({ show, late, children }: { show: State[]; late?: boolean; children: React.ReactNode }) {
  const cls = ['lp-part', ...show.map((s) => `lp-s-${s}`), late ? 'lp-late' : ''].join(' ')
  return <g className={cls}>{children}</g>
}

// A CT slice, drawn the same way everywhere.
function Slice({ cx, cy, rx, ry }: { cx: number; cy: number; rx: number; ry: number }) {
  return (
    <>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} />
      <ellipse cx={cx} cy={cy} rx={rx * 0.8} ry={ry * 0.78} opacity="0.5" />
      <circle cx={cx - rx * 0.12} cy={cy - ry * 0.14} r={ry * 0.26} />
      <circle cx={cx + rx * 0.18} cy={cy + ry * 0.05} r={ry * 0.1} />
      <circle cx={cx} cy={cy + ry * 0.55} r={ry * 0.13} />
    </>
  )
}

// ---------------------------------------------------------------- View

// One viewer, drawn in its own 340 x 240 box so it can be moved and copied.
function Viewer({ tabs, overlay }: { tabs?: boolean; overlay?: State[] }) {
  return (
    <>
      <Ink>
        <rect x="0" y="0" width="340" height="240" rx="14" strokeDasharray="7 6" />
        <Slice cx={170} cy={128} rx={100} ry={78} />
      </Ink>
      {tabs && (
        <Part show={['single']} late>
          <Ink>
            <rect x="12" y="12" width="56" height="22" rx="6" />
            <rect x="74" y="12" width="66" height="22" rx="6" />
            <rect x="146" y="12" width="62" height="22" rx="6" />
            <path d="M16 224 L324 224" opacity="0.6" />
            <circle cx="196" cy="224" r="7" />
          </Ink>
          <Words anchor="middle">
            <text x="40" y="28" fontSize="12">Axial</text>
            <text x="107" y="28" fontSize="12">Sagittal</text>
            <text x="177" y="28" fontSize="12">Coronal</text>
          </Words>
        </Part>
      )}
      {overlay && (
        <Part show={overlay} late>
          <Ink color={NEON} dash="4 5">
            <path d="M136 108 C 132 78, 190 70, 204 100 C 214 124, 190 148, 160 142 C 142 138, 136 126, 136 108 Z" />
          </Ink>
        </Part>
      )}
    </>
  )
}

function ViewFamily() {
  return (
    <>
      <g className="lp-view-a">
        <Viewer tabs overlay={['single']} />
      </g>
      <g className="lp-view-b">
        <Viewer overlay={['split']} />
      </g>

      {/* the general drawing */}
      <Part show={['base']}>
        <Words anchor="middle">
          <text x="450" y="334" fontSize="21" fontWeight="700">Look at scans</text>
          <text x="450" y="362" fontSize="15">nothing here can change a file</text>
        </Words>
      </Part>

      {/* + Single screen */}
      <Part show={['single']} late>
        <Words>
          <text x="440" y="84" fontSize="21" fontWeight="700">Look at one scan</text>
          {['scroll through the slices', 'zoom, pan, window / level', 'overlay a mask or prediction', 'all 3 views at once'].map(
            (line, i) => (
              <g key={line}>
                <circle cx="448" cy={122 + i * 34} r="3" />
                <text x="462" y={127 + i * 34} fontSize="15">
                  {line}
                </text>
              </g>
            ),
          )}
          <text x="440" y="290" fontSize="14" opacity="0.75">nothing here can change a file</text>
        </Words>
      </Part>

      {/* + Split view: the viewer above has split into two */}
      <Part show={['split']} late>
        <Ink color={NEON}>
          <circle cx="436" cy="177" r="17" strokeWidth="2.5" />
          <circle cx="464" cy="177" r="17" strokeWidth="2.5" />
          <path d="M380 177 L419 177 M481 177 L520 177" strokeDasharray="5 5" />
        </Ink>
        <Words anchor="middle">
          <text x="210" y="46" fontSize="16">scan A</text>
          <text x="690" y="46" fontSize="16">scan B</text>
          <text x="450" y="222" fontSize="13" fill={NEON}>linked</text>
          <text x="450" y="334" fontSize="21" fontWeight="700">Two scans, side by side</text>
          <text x="450" y="362" fontSize="15">scroll and zoom together · same patient over time, or a scan against its prediction</text>
        </Words>
      </Part>
    </>
  )
}

// ---------------------------------------------------------------- Annotate

function AnnotateFamily() {
  const steps = ["first, find this scan's own threshold", 'then pick an annotation label', 'and last… go wild.']
  return (
    <>
      {/* the slice being marked up: always there, and slides aside when there is more to say */}
      <g className="lp-ann-slice">
        <Ink>
          <Slice cx={170} cy={120} rx={150} ry={112} />
          {/* the label being painted, and the brush painting it */}
          <path d="M116 104 C 114 70, 172 62, 188 96 C 198 122, 174 146, 146 140 C 126 136, 116 124, 116 104 Z" strokeDasharray="4 5" />
          <path d="M236 34 L256 48 L214 90 L196 74 Z" />
          <path d="M196 74 L214 90 C 200 104, 182 104, 174 94 C 180 86, 188 80, 196 74 Z" />
        </Ink>

        {/* Contrast: a seed on the aorta and the region it samples */}
        <Part show={['contrast']} late>
          <Ink color={NEON} dash="4 5">
            <circle cx="78" cy="96" r="30" />
          </Ink>
          <Ink color={NEON}>
            <path d="M78 86 L78 106 M68 96 L88 96" />
          </Ink>
        </Part>

        {/* both: the small calcifications the score is about */}
        <Part show={['contrast', 'noncontrast']} late>
          <Ink dash="3 4">
            <circle cx="210" cy="160" r="8" />
            <circle cx="232" cy="178" r="6" />
            <circle cx="184" cy="180" r="6" />
          </Ink>
        </Part>

        {/* Non-contrast: one fixed threshold, tagged on a lesion */}
        <Part show={['noncontrast']} late>
          <Ink color={NEON}>
            <rect x="226" y="126" width="66" height="26" rx="13" />
            <path d="M228 146 C 222 152, 218 156, 214 158" />
          </Ink>
          <Words anchor="middle">
            <text x="259" y="144" fontSize="14" fill={NEON}>130 HU</text>
          </Words>
        </Part>
      </g>

      {/* the general drawing */}
      <Part show={['base']}>
        <Words anchor="middle">
          <text x="450" y="334" fontSize="21" fontWeight="700">Mark the calcium yourself</text>
          <text x="450" y="362" fontSize="15">brush it, grow it, score it</text>
        </Words>
      </Part>

      {/* + Contrast: a good order to do things in */}
      <Part show={['contrast']} late>
        <Words>
          <text x="440" y="76" fontSize="21" fontWeight="700">Contrast scans</text>
          {steps.map((line, i) => (
            <g key={line}>
              <circle cx="452" cy={122 + i * 50} r="14" fill="none" stroke={NEON} strokeWidth="2" />
              <text x="452" y={128 + i * 50} fontSize="15" fill={NEON} textAnchor="middle">
                {i + 1}
              </text>
              <text x="482" y={128 + i * 50} fontSize="15">
                {line}
              </text>
            </g>
          ))}
        </Words>
        <Ink>
          <path d="M440 330 L700 330" opacity="0.6" />
          <path d="M470 330 C 510 330, 522 272, 570 272 C 618 272, 630 330, 670 330" />
        </Ink>
        <Ink color={NEON} dash="5 5">
          <path d="M622 262 L622 334" />
        </Ink>
        <Words anchor="middle">
          <text x="622" y="352" fontSize="13" fill={NEON}>this scan's threshold</text>
        </Words>
      </Part>

      {/* + Non-contrast */}
      <Part show={['noncontrast']} late>
        <Words>
          <text x="440" y="76" fontSize="21" fontWeight="700">Non-contrast scans</text>
          <text x="440" y="122" fontSize="15">one fixed threshold: 130 HU</text>
          <text x="440" y="156" fontSize="15">paint or grow the lesions</text>
          <text x="440" y="190" fontSize="15">a score for each lesion (Agatston)</text>
        </Words>
        <Ink>
          <path d="M440 300 L860 300" />
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
            <path key={i} d={`M${450 + i * 44} 294 L${450 + i * 44} 306`} />
          ))}
        </Ink>
        <Ink color={NEON}>
          <path d="M620 270 L620 300" />
        </Ink>
        <Words anchor="middle">
          <text x="620" y="264" fontSize="14" fill={NEON}>130 HU</text>
          <text x="530" y="328" fontSize="12">soft tissue</text>
          <text x="760" y="328" fontSize="12">calcium →</text>
        </Words>
      </Part>
    </>
  )
}

// ---------------------------------------------------------------- Review and idle

function Review() {
  const rows = ['verify annotations', 'judge model predictions', 'sort mistakes into types', 'rate scan quality']
  return (
    <>
      <Ink>
        <Slice cx={170} cy={185} rx={110} ry={88} />
        <circle cx="235" cy="160" r="62" />
        <path d="M280 205 L338 262" strokeWidth="7" />
        {rows.map((_, i) => (
          <rect key={i} x="470" y={78 + i * 42} width="26" height="26" rx="5" />
        ))}
        <rect x="470" y="262" width="390" height="92" rx="14" strokeDasharray="7 6" />
      </Ink>
      <Words anchor="middle">
        <text x="235" y="175" fontSize="46">?</text>
        {rows.map((_, i) => (
          <text key={i} x="483" y={98 + i * 42} fontSize="16">?</text>
        ))}
        <text x="665" y="296" fontSize="18" fontWeight="700">Exact plan: still loading…</text>
        <text x="665" y="322" fontSize="14">the developer is thinking. do not disturb.</text>
        <text x="665" y="345" fontSize="15">{'¯\\_(^_^)_/¯'}</text>
      </Words>
      <Words>
        <text x="470" y="52" fontSize="21" fontWeight="700">Review, eventually</text>
        {rows.map((r, i) => (
          <text key={r} x="512" y={98 + i * 42} fontSize="16">{r}</text>
        ))}
      </Words>
    </>
  )
}

function Idle() {
  return (
    <>
      <Ink>
        <path d="M430 150 C 400 110, 360 96, 330 92" />
        <path d="M330 92 L346 84 M330 92 L340 106" />
      </Ink>
      <Words anchor="middle">
        <text x="560" y="170" fontSize="22" fontWeight="700">Hover an option to see what it does</text>
        <text x="560" y="204" fontSize="15">(no clicking required. i dare you.)</text>
      </Words>
    </>
  )
}

export function LauncherPreview({ id }: { id: PreviewId | null }) {
  const family = familyOf(id)
  return (
    // Keyed by family, not by option: moving between a block and its buttons
    // keeps the same svg so the drawing grows instead of being replaced.
    <svg
      className="launcher-stage-svg"
      key={family}
      data-state={stateOf(id)}
      viewBox="0 0 900 380"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      <Defs />
      {family === 'view' && <ViewFamily />}
      {family === 'annotate' && <AnnotateFamily />}
      {family === 'review' && <Review />}
      {family === 'idle' && <Idle />}
    </svg>
  )
}

// The mark: a lens with a CT slice inside and one bright spot, the calcification
// it is looking for.
export function AppLogo({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <circle cx="27" cy="27" r="19" stroke="var(--sketch-neon)" strokeWidth="4" />
      <path d="M41 41 L57 57" stroke="var(--sketch-neon)" strokeWidth="6" strokeLinecap="round" />
      <ellipse cx="27" cy="27" rx="11" ry="9" stroke="#8a8d9f" strokeWidth="2" />
      <ellipse cx="27" cy="27" rx="6.5" ry="5" stroke="#5f6274" strokeWidth="1.5" />
      <circle cx="30" cy="25" r="3.2" fill="var(--sketch-neon)" />
    </svg>
  )
}
