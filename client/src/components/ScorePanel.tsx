import { forwardRef } from 'react'
import type { LabelColor, ManifestRow, ScoreClass } from '../types'

// CAC is the aggregate of LAD/LCx/RCA (not one of the 6 segmentation
// labels), so it gets a fixed neutral color instead of a slot in the
// palette; the other 6 classes map onto the 6 label colors in this order.
const COLOR_ORDER: ScoreClass[] = ['LAD', 'LCx', 'RCA', 'TAC', 'AV', 'MV']
const CAC_COLOR = '#FFFFFF'

function colorForClass(cls: ScoreClass, maskColors: LabelColor[]): string {
  if (cls === 'CAC') return CAC_COLOR
  const idx = COLOR_ORDER.indexOf(cls)
  return maskColors[idx]?.color || '#6c6d7a'
}

function formatScore(val: number | null | undefined): string {
  return val === null || val === undefined ? '—' : val.toFixed(2)
}

function ScoreTile({ cls, value, color }: { cls: ScoreClass; value: number | null | undefined; color: string }) {
  return (
    <div className="score-tile" style={{ borderColor: color }}>
      <div className="score-tile-class" style={{ color }}>
        {cls}
      </div>
      <div className="score-tile-value">{formatScore(value)}</div>
    </div>
  )
}

// The three anatomical groupings: coronary (headed by the real CAC score,
// since it's the sum of the three arteries below it), thoracic aorta, and
// the two valves — the latter two have no aggregate score of their own, so
// their "header" is just a plain text label filling the same space.
const GROUPS: { key: string; headerClass?: ScoreClass; headerLabel?: string; members: ScoreClass[] }[] = [
  { key: 'coronary', headerClass: 'CAC', members: ['LAD', 'LCx', 'RCA'] },
  { key: 'aorta', headerLabel: 'Thoracic Aorta', members: ['TAC'] },
  { key: 'valve', headerLabel: 'Valve', members: ['AV', 'MV'] },
]

const ScorePanel = forwardRef<
  HTMLDivElement,
  {
    scoreClasses: ScoreClass[]
    row: ManifestRow
    maskColors: LabelColor[]
    open: boolean
    onToggleOpen: () => void
    onDragHandleDown: (e: React.MouseEvent) => void
    style?: React.CSSProperties
  }
>(function ScorePanel({ scoreClasses, row, maskColors, open, onToggleOpen, onDragHandleDown, style }, ref) {
  const present = new Set(scoreClasses)
  const groups = GROUPS.map((g) => ({ ...g, members: g.members.filter((m) => present.has(m)) })).filter(
    (g) => g.members.length > 0 || (g.headerClass && present.has(g.headerClass)),
  )

  return (
    <div ref={ref} className={open ? 'score-panel score-panel-open' : 'score-panel'} style={style}>
      <div className="score-panel-rail">
        <div className="score-panel-drag" onMouseDown={onDragHandleDown} title="Drag to move">
          ✥
        </div>
        <button
          type="button"
          className="score-panel-toggle"
          onClick={onToggleOpen}
          title={open ? 'Collapse scores' : 'Expand scores'}
        >
          {open ? '▼' : '▶'}
        </button>
      </div>
      {open && (
        <div className="score-panel-groups">
          {groups.map((g) => (
            <div className="score-group" key={g.key}>
              <div className="score-group-header">
                {g.headerClass && present.has(g.headerClass) ? (
                  <ScoreTile
                    cls={g.headerClass}
                    value={row.scores[g.headerClass]}
                    color={colorForClass(g.headerClass, maskColors)}
                  />
                ) : g.headerLabel ? (
                  <div className="score-group-label">{g.headerLabel}</div>
                ) : null}
              </div>
              <div className="score-group-members">
                {g.members.map((cls) => (
                  <ScoreTile key={cls} cls={cls} value={row.scores[cls]} color={colorForClass(cls, maskColors)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

export default ScorePanel
