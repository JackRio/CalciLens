import type { EditTool, OverwriteMode, PaneState } from '../types'
import { DEFAULT_THRESHOLD_HU } from '../types'
import LabelSelect from './LabelSelect'

export default function MaskEditor({
  pane,
  onChange,
  onCreateMask,
  onSave,
  onDragHandleDown,
  thresholdLocked,
  seedRadiusMm,
}: {
  pane: PaneState
  onChange: (partial: Partial<PaneState>) => void
  onCreateMask: () => void
  onSave: () => void
  onDragHandleDown: (e: React.MouseEvent) => void
  thresholdLocked?: boolean
  seedRadiusMm: number
}) {
  if (!pane.ctInfo) return null

  const title = !pane.maskInfo ? 'New Mask' : pane.maskInfo.is_new_mask ? 'New Annotation' : 'Edit Annotation'

  const dragHandle = (
    <button
      className="wl-minimize-btn drag-handle"
      onMouseDown={onDragHandleDown}
      title="Drag to move"
    >
      ✥
    </button>
  )

  const minimizeBtn = (
    <button
      className="wl-minimize-btn"
      onClick={() => onChange({ editMinimized: !pane.editMinimized })}
      title={pane.editMinimized ? 'Expand' : 'Minimize'}
    >
      {pane.editMinimized ? '+' : '−'}
    </button>
  )

  function handleToggleContrast(checked: boolean) {
    const targetType = checked ? 'contrast' : 'non-contrast'
    // A mask painted under the other threshold basis isn't meaningful here —
    // contrast annotations are gated by a per-scan computed threshold, non-
    // contrast by the fixed 130 HU, so a label boundary drawn under one
    // doesn't mean the same thing under the other. Only auto-unload on a
    // *confirmed* mismatch (maskAnnotationType known and different) — an
    // unknown type (e.g. a mask loaded from outside this app) is left alone
    // rather than guessed at and possibly discarded.
    const mismatched = pane.maskInfo && pane.maskAnnotationType && pane.maskAnnotationType !== targetType
    const unload = mismatched
      ? {
          maskPath: '',
          maskInfo: null,
          maskAnnotationType: null,
          editMode: false,
          lesionResults: [],
          volumeScores: null,
          agatstonScores: null,
          editMessage: `Unloaded the mask — it was annotated ${pane.maskAnnotationType === 'contrast' ? 'with' : 'without'} contrast mode, which no longer matches.`,
        }
      : {}
    onChange(
      checked
        ? { contrastMode: true, editMode: mismatched ? false : pane.editMode, scoreComputeMode: false, ...unload }
        : {
            // Leaving contrast mode entirely clears the seed/sphere and the
            // computed threshold — it shouldn't keep driving the render
            // overlay / paint / region-grow HU fields once contrast mode is
            // off, and a stale seed marker/sphere for a threshold that no
            // longer applies would be confusing to still see.
            contrastMode: false,
            seedPlacementMode: false,
            pendingSeed: null,
            contrastThreshold: null,
            contrastThresholdLocked: false,
            contrastMeta: null,
            volumeScores: null,
            thresholdValue: DEFAULT_THRESHOLD_HU,
            thresholdEnabled: false,
            editThresholdMin: DEFAULT_THRESHOLD_HU,
            editRegionGrowThreshold: DEFAULT_THRESHOLD_HU,
            ...unload,
          },
    )
  }

  const contrastToggle = (
    <label
      className="edit-header-label contrast-toggle-row"
      title="Contrast CT: derive a per-scan calcium threshold from a seed point instead of the fixed 130 HU"
    >
      <input type="checkbox" checked={pane.contrastMode} onChange={(e) => handleToggleContrast(e.target.checked)} />
      Contrast CT
    </label>
  )

  if (!pane.maskInfo) {
    return (
      <div className="overlay-box edit-box" onWheel={(e) => e.stopPropagation()}>
        {contrastToggle}
        <div className="overlay-toggle edit-header">
          <span>{title}</span>
          <div className="edit-header-buttons">
            {dragHandle}
            {minimizeBtn}
          </div>
        </div>
        {!pane.editMinimized && (
          <button className="add-label-btn" onClick={onCreateMask}>
            + New mask to edit
          </button>
        )}
      </div>
    )
  }

  const existingLabels = pane.maskInfo.labels || []

  const activeLabelOptions = [
    { value: 0, text: 'Background' },
    ...pane.maskColors.map((c) => ({ value: c.label, text: String(c.label), color: c.color })),
  ]

  const colorForLabel = (l: number) => pane.maskColors.find((c) => c.label === l)?.color

  const overwriteLabelOptions = [
    { value: 0, text: 'Background' },
    ...existingLabels
      .filter((l) => l !== 0)
      .map((l) => ({ value: l, text: String(l), color: colorForLabel(l) })),
  ]

  return (
    <div className="overlay-box edit-box" onWheel={(e) => e.stopPropagation()}>
      {contrastToggle}
      <div className="overlay-toggle edit-header">
        <label className="edit-header-label">
          <input
            type="checkbox"
            checked={pane.editMode}
            onChange={(e) =>
              onChange(e.target.checked ? { editMode: true, scoreComputeMode: false } : { editMode: false })
            }
          />
          {title}
        </label>
        <div className="edit-header-buttons">
          {dragHandle}
          {minimizeBtn}
        </div>
      </div>

      {pane.editMode && !pane.editMinimized && (
        <>
          <div className="edit-field">
            Label
            <LabelSelect
              options={activeLabelOptions}
              value={pane.editActiveLabel}
              onChange={(v) => onChange({ editActiveLabel: v })}
              grid
            />
          </div>

          <label className="edit-field">
            Tool
            <select
              value={pane.editTool}
              onChange={(e) => {
                const tool = e.target.value as EditTool
                // Switching to Brush defaults its overwrite mode to HU
                // threshold (RG's own threshold field is unaffected when
                // switching back, since RG doesn't use editOverwriteMode).
                onChange(tool === 'brush' ? { editTool: tool, editOverwriteMode: 'threshold' } : { editTool: tool })
              }}
            >
              <option value="brush">Brush</option>
              <option value="region-grow">RG</option>
            </select>
          </label>

          {pane.editTool === 'brush' && (
            <>
              <label className="edit-field">
                Overwrite
                <select
                  value={pane.editOverwriteMode}
                  onChange={(e) => onChange({ editOverwriteMode: e.target.value as OverwriteMode })}
                >
                  <option value="any">Any voxel</option>
                  <option value="label">Existing label</option>
                  <option value="threshold">HU threshold</option>
                </select>
              </label>
              {pane.editOverwriteMode === 'label' && (
                <div className="edit-field">
                  Which label
                  <LabelSelect
                    options={overwriteLabelOptions}
                    value={pane.editOverwriteLabel}
                    placeholder="-- select --"
                    onChange={(v) => onChange({ editOverwriteLabel: v })}
                  />
                </div>
              )}
              {pane.editOverwriteMode === 'threshold' && (
                <label className="edit-field" title={thresholdLocked ? 'Locked to the computed contrast threshold for this session' : undefined}>
                  HU &ge;
                  <input
                    type="number"
                    value={pane.editThresholdMin}
                    disabled={thresholdLocked}
                    onChange={(e) => onChange({ editThresholdMin: Number(e.target.value) })}
                  />
                </label>
              )}
              <label className="edit-field">
                Brush size
                <input
                  type="number"
                  min={1}
                  value={pane.editBrushRadius}
                  onChange={(e) => onChange({ editBrushRadius: Number(e.target.value) })}
                />
              </label>
            </>
          )}

          {pane.editTool === 'region-grow' && (
            <label className="edit-field" title={thresholdLocked ? 'Locked to the computed contrast threshold for this session' : undefined}>
              HU &ge; (grow)
              <input
                type="number"
                value={pane.editRegionGrowThreshold}
                disabled={thresholdLocked}
                onChange={(e) => onChange({ editRegionGrowThreshold: Number(e.target.value) })}
              />
            </label>
          )}

          <div className="edit-hint">
            {pane.editTool === 'brush'
              ? 'Left-drag on image to paint'
              : 'Left-click to 3D-grow (26-connectivity, whole volume)'}
            {pane.editTool === 'region-grow' && (
              <>
                <br />
                {`Hold Shift + click to seed from a circle for tiny/isolated voxels (Shift+scroll to resize, ${seedRadiusMm.toFixed(1)} mm).`}
              </>
            )}
          </div>

          <button className="add-label-btn" onClick={onSave} disabled={pane.editBusy}>
            {pane.editBusy ? 'Saving...' : 'Save'}
          </button>
          {pane.editMessage && <div className="busy-msg edit-message">{pane.editMessage}</div>}
        </>
      )}
    </div>
  )
}
