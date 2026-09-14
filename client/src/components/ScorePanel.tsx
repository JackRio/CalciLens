import { forwardRef } from 'react'
import type { ManifestRow, ScoreClass } from '../types'

const ScorePanel = forwardRef<
  HTMLDivElement,
  {
    scoreClasses: ScoreClass[]
    row: ManifestRow
    colorFor: (index: number) => string
    open: boolean
    onToggleOpen: () => void
    onDragHandleDown: (e: React.MouseEvent) => void
    style?: React.CSSProperties
  }
>(function ScorePanel({ scoreClasses, row, colorFor, open, onToggleOpen, onDragHandleDown, style }, ref) {
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
          {open ? '→' : '↓'}
        </button>
      </div>
      {open && (
        <div className="score-panel-tiles">
          {scoreClasses.map((cls, i) => {
            const val = row.scores[cls]
            const color = colorFor(i)
            return (
              <div key={cls} className="score-tile" style={{ borderColor: color }}>
                <div className="score-tile-class" style={{ color }}>
                  {cls}
                </div>
                <div className="score-tile-value">{val === null || val === undefined ? '—' : val}</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
})

export default ScorePanel
