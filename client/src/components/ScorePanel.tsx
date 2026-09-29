import { forwardRef } from 'react'
import type { LabelColor, ScoreClass, ScoringLabel } from '../types'
import { AGATSTON_PAPER_URL, DEFAULT_SCORING_LABELS, colorForScoreClass } from '../types'

function formatScore(val: number | null | undefined): string {
  return val === null || val === undefined
    ? '—'
    : val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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

interface Group {
  key: string
  headerClass?: ScoreClass
  headerLabel?: string
  members: ScoreClass[]
}

// The tiles follow the scoring table: the coronary labels sit under the CAC
// total (their sum), the others are grouped by name — the usual TAC, AV and MV
// get their familiar headings and anything the user added goes under "Other".
function buildGroups(scoringLabels: ScoringLabel[], present: Set<ScoreClass>): Group[] {
  // Manifest scores use the standard names whatever label set is selected, so a
  // standard class that is present but not in the set still gets its tile.
  const labels = [
    ...scoringLabels,
    ...DEFAULT_SCORING_LABELS.filter((d) => present.has(d.name) && !scoringLabels.some((l) => l.name === d.name)).map((d) => ({
      ...d,
      label: 0,
    })),
  ]
  const isPresent = (name: string) => present.has(name)
  const coronary = labels.filter((l) => l.coronary).map((l) => l.name)
  const rest = labels.filter((l) => !l.coronary).map((l) => l.name)
  const groups: Group[] = [
    { key: 'coronary', headerClass: 'CAC', members: coronary.filter(isPresent) },
    { key: 'aorta', headerLabel: 'Thoracic Aorta', members: rest.filter((n) => n === 'TAC' && isPresent(n)) },
    { key: 'valve', headerLabel: 'Valve', members: rest.filter((n) => (n === 'AV' || n === 'MV') && isPresent(n)) },
    { key: 'other', headerLabel: 'Other', members: rest.filter((n) => !['TAC', 'AV', 'MV'].includes(n) && isPresent(n)) },
  ]
  return groups.filter((g) => g.members.length > 0 || (g.headerClass && isPresent(g.headerClass)))
}

const ScorePanel = forwardRef<
  HTMLDivElement,
  {
    scoreClasses: ScoreClass[]
    scores: Partial<Record<ScoreClass, number | null>>
    labels: ScoringLabel[]
    maskColors: LabelColor[]
    // Agatston scores are calculated with a published method; volumes are not.
    showMethodNote?: boolean
    open: boolean
    onToggleOpen: () => void
    onDragHandleDown: (e: React.MouseEvent) => void
    onEditSetup?: () => void
    style?: React.CSSProperties
  }
>(function ScorePanel(
  { scoreClasses, scores, labels, maskColors, showMethodNote, open, onToggleOpen, onDragHandleDown, onEditSetup, style },
  ref,
) {
  const present = new Set(scoreClasses)
  const groups = buildGroups(labels, present)

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
        <div className="score-panel-body">
          <div className="score-panel-groups">
            {groups.map((g) => (
              <div className="score-group" key={g.key}>
                <div className="score-group-header">
                  {g.headerClass && present.has(g.headerClass) ? (
                    <ScoreTile
                      cls={g.headerClass}
                      value={scores[g.headerClass]}
                      color={colorForScoreClass(g.headerClass, maskColors, labels)}
                    />
                  ) : g.headerLabel ? (
                    <div className="score-group-label">{g.headerLabel}</div>
                  ) : null}
                </div>
                <div className="score-group-members">
                  {g.members.map((cls) => (
                    <ScoreTile key={cls} cls={cls} value={scores[cls]} color={colorForScoreClass(cls, maskColors, labels)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {(showMethodNote || onEditSetup) && (
            <div className="score-panel-note">
              {showMethodNote && (
                <>
                  Agatston method, 130 HU clinical standard ·{' '}
                  <a href={AGATSTON_PAPER_URL} target="_blank" rel="noreferrer">
                    Agatston et al., 1990
                  </a>
                </>
              )}
              {onEditSetup && (
                <button type="button" className="score-panel-setup-link" onClick={onEditSetup}>
                  Scoring setup
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

export default ScorePanel
