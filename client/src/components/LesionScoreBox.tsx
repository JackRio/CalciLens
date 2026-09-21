import type { LesionScoreResult, PaneState } from '../types'
import { CAC_COLOR, SCORE_CLASS_BY_LABEL } from '../types'

function formatScore(val: number | null | undefined): string {
  return val === null || val === undefined
    ? '—'
    : val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function lesionName(label: number): string {
  return SCORE_CLASS_BY_LABEL[label - 1] || `Label ${label}`
}

const SOURCE_LABEL: Record<LesionScoreResult['scoreSource'], string> = {
  manifest: 'From manifest',
  computed: 'Computed this session',
  unavailable: 'Not available',
}

export default function LesionScoreBox({
  pane,
  onChange,
  onDragHandleDown,
  flashRowId,
  onRowClick,
}: {
  pane: PaneState
  onChange: (partial: Partial<PaneState>) => void
  onDragHandleDown: (e: React.MouseEvent) => void
  flashRowId: number | null
  onRowClick: (result: LesionScoreResult) => void
}) {
  if (!pane.ctInfo || !pane.maskInfo) return null

  const dragHandle = (
    <button className="wl-minimize-btn drag-handle" onMouseDown={onDragHandleDown} title="Drag to move">
      ✥
    </button>
  )

  const minimizeBtn = (
    <button
      className="wl-minimize-btn"
      onClick={() => onChange({ scoreComputeMinimized: !pane.scoreComputeMinimized })}
      title={pane.scoreComputeMinimized ? 'Expand' : 'Minimize'}
    >
      {pane.scoreComputeMinimized ? '+' : '−'}
    </button>
  )

  const colorForLabel = (label: number) => pane.maskColors[label - 1]?.color || '#6c6d7a'
  const isVolumeMetric = pane.contrastMode

  return (
    <div className="overlay-box edit-box lesion-score-box" onWheel={(e) => e.stopPropagation()}>
      <div className="overlay-toggle edit-header">
        <label className="edit-header-label">
          <input
            type="checkbox"
            checked={pane.scoreComputeMode}
            onChange={(e) =>
              onChange(e.target.checked ? { scoreComputeMode: true, editMode: false } : { scoreComputeMode: false })
            }
          />
          {isVolumeMetric ? 'Volume Compute' : 'Score Compute'}
        </label>
        <div className="edit-header-buttons">
          {dragHandle}
          {minimizeBtn}
        </div>
      </div>
      {!pane.scoreComputeMinimized && (
        <>
          {pane.scoreComputeMode && (
            <div className="edit-hint">
              {isVolumeMetric
                ? 'Click a mask voxel to isolate its 3D lesion and compute its physical volume.'
                : 'Click a mask voxel to isolate its 3D lesion and compute its Agatston score.'}
            </div>
          )}
          {pane.lesionResults.length > 0 && (
            <table className="lesion-score-table">
              <thead>
                {isVolumeMetric ? (
                  <tr>
                    <th>Lesion</th>
                    <th>Voxels</th>
                    <th>Volume (mm³)</th>
                  </tr>
                ) : (
                  <tr>
                    <th>Lesion</th>
                    <th>Score</th>
                    <th>Old</th>
                    <th>New</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {pane.lesionResults.map((r) => {
                  const lesionColor = colorForLabel(r.label)
                  if (r.metric === 'volume') {
                    return (
                      <tr
                        key={r.id}
                        className={flashRowId === r.id ? 'lesion-row lesion-row-flash' : 'lesion-row'}
                        onClick={() => onRowClick(r)}
                        title={`${r.plane} slice ${r.index + 1} — click to jump here`}
                      >
                        <td style={{ color: lesionColor }}>{lesionName(r.label)}</td>
                        <td>{r.voxelCount.toLocaleString('en-US')}</td>
                        <td>{formatScore(r.volumeMm3)}</td>
                      </tr>
                    )
                  }
                  const classColor = r.targetClass === 'CAC' ? CAC_COLOR : lesionColor
                  const sourceLabel = SOURCE_LABEL[r.scoreSource]
                  const unavailable = r.scoreSource === 'unavailable'
                  return (
                    <tr
                      key={r.id}
                      className={flashRowId === r.id ? 'lesion-row lesion-row-flash' : 'lesion-row'}
                      onClick={() => onRowClick(r)}
                      title={`${r.plane} slice ${r.index + 1} — click to jump here`}
                    >
                      <td style={{ color: lesionColor }}>{lesionName(r.label)}</td>
                      <td>{formatScore(r.agatstonScore)}</td>
                      <td style={{ color: classColor }} title={`Old ${r.targetClass} Score — ${sourceLabel}`}>
                        {unavailable ? '—' : formatScore(r.oldScore)}
                      </td>
                      <td
                        style={{ color: classColor }}
                        title={`New ${r.targetClass} Score = Old Score − Lesion Score`}
                      >
                        {unavailable ? '—' : formatScore(r.newScore)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
