import type { LesionScoreResult, PaneState } from '../types'
import { CAC_COLOR, labelsFromColors } from '../types'

function formatScore(val: number | null | undefined): string {
  return val === null || val === undefined
    ? '—'
    : val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
  onComputeAll,
  computingAll,
  seedRadiusMm,
  onOpenSetup,
  onDeleteRow,
  onClearRows,
}: {
  pane: PaneState
  onChange: (partial: Partial<PaneState>) => void
  onDragHandleDown: (e: React.MouseEvent) => void
  flashRowId: number | null
  onRowClick: (result: LesionScoreResult) => void
  onComputeAll: () => void
  computingAll: boolean
  seedRadiusMm: number
  onOpenSetup: () => void
  onDeleteRow: (id: number) => void
  onClearRows: () => void
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

  const scoringLabels = pane.scoringSetup?.labels ?? labelsFromColors(pane.maskColors)
  const lesionName = (label: number) => scoringLabels.find((l) => l.label === label)?.name ?? `Label ${label}`
  const colorForLabel = (label: number) => pane.maskColors.find((c) => c.label === label)?.color || '#6c6d7a'
  const isVolumeMetric = pane.contrastMode
  // Removing a row only removes it from this list; nothing else depends on it.
  const deleteCell = (id: number) => (
    <td>
      <button
        type="button"
        className="lesion-row-delete"
        title="Remove this entry"
        onClick={(e) => {
          e.stopPropagation()
          onDeleteRow(id)
        }}
      >
        ✕
      </button>
    </td>
  )

  return (
    <div className="overlay-box edit-box lesion-score-box" onWheel={(e) => e.stopPropagation()}>
      <div className="overlay-toggle edit-header">
        <label className="edit-header-label">
          <input
            type="checkbox"
            checked={pane.scoreComputeMode}
            onChange={(e) => {
              onChange(e.target.checked ? { scoreComputeMode: true, editMode: false } : { scoreComputeMode: false })
              // Return focus to the document immediately rather than leaving
              // it on this checkbox — otherwise the user clicking this, then
              // moving to the image to Shift-click/scroll for the
              // circle-seed feature, does so with a lingering focus ring on
              // an unrelated control.
              e.target.blur()
            }}
          />
          {isVolumeMetric ? 'Volume Compute' : 'Score Compute'}
        </label>
        <div className="edit-header-buttons">
          <button
            className="wl-minimize-btn"
            onClick={onComputeAll}
            disabled={!pane.maskInfo || (isVolumeMetric && pane.contrastThreshold === null) || computingAll}
            title={
              isVolumeMetric
                ? 'Recompute total volume for every class (CAC/LAD/LCx/RCA/TAC/AV/MV) across the whole scan'
                : 'Recompute total Agatston score for every class (CAC/LAD/LCx/RCA/TAC/AV/MV) across the whole scan'
            }
          >
            {computingAll ? '…' : '▶'}
          </button>
          <button className="wl-minimize-btn" onClick={onOpenSetup} title="Scoring setup: slice spacing, minimum lesion area, labels">
            ⚙
          </button>
          {dragHandle}
          {minimizeBtn}
        </div>
      </div>
      {!pane.scoreComputeMinimized && (
        <>
          {pane.scoreComputeMode && (
            <div className="edit-hint">
              {isVolumeMetric
                ? pane.contrastThreshold === null
                  ? 'Finalize a seed first — the volume is measured above the threshold it gives.'
                  : 'Click a mask voxel to isolate its 3D lesion and compute its physical volume.'
                : 'Click a mask voxel to isolate its 3D lesion and compute its Agatston score.'}
              <br />
              {`Hold Ctrl (or Shift) + click to seed from a circle for tiny lesions (Shift+scroll to resize, ${seedRadiusMm.toFixed(1)} mm).`}
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
                    <th className="lesion-clear-cell">
                      <button type="button" className="lesion-row-delete" onClick={onClearRows} title="Clear all">
                        clear
                      </button>
                    </th>
                  </tr>
                ) : (
                  <tr>
                    <th>Lesion</th>
                    <th>Score</th>
                    <th>Old</th>
                    <th>New</th>
                    <th className="lesion-clear-cell">
                      <button type="button" className="lesion-row-delete" onClick={onClearRows} title="Clear all">
                        clear
                      </button>
                    </th>
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
                        {deleteCell(r.id)}
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
                      {deleteCell(r.id)}
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
