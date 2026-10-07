import type { PaneState } from '../types'

export default function ContrastSeedBox({
  pane,
  minimized,
  onToggleMinimized,
  saving,
  onFinalize,
  onReSeed,
  onToggleSeedPlacement,
  fixedHu,
  onApplyFixed,
}: {
  pane: PaneState
  minimized: boolean
  onToggleMinimized: () => void
  saving: boolean
  onFinalize: () => void
  onReSeed: () => void
  onToggleSeedPlacement: () => void
  // The fixed value when Settings says to use one (no seed then), else null.
  fixedHu: number | null
  onApplyFixed: () => void
}) {
  if (!pane.ctInfo) return null

  return (
    <div className="wl-box contrast-seed-box" onWheel={(e) => e.stopPropagation()}>
      <div className="wl-title">
        <span>Contrast Threshold</span>
        <button className="wl-minimize-btn" onClick={onToggleMinimized} title={minimized ? 'Expand' : 'Minimize'}>
          {minimized ? '+' : '−'}
        </button>
      </div>

      {!minimized && (
        <>
          {pane.contrastThresholdLocked && pane.contrastMeta ? (
            <>
              <div className="contrast-stat-row">
                Threshold <strong>{pane.contrastThreshold?.toFixed(2)} HU</strong>
              </div>
              {pane.contrastMeta.method === 'fixed' ? (
                <div className="contrast-stat-row">Fixed value, no seed</div>
              ) : (
                <>
                  <div className="contrast-stat-row">
                    Mean {pane.contrastMeta.meanHu.toFixed(1)} · STD {pane.contrastMeta.stdHu.toFixed(1)}
                  </div>
                  <div className="contrast-stat-row">
                    VOI {pane.contrastMeta.voxelCount} vox · {pane.contrastMeta.actualVolumeMm3.toFixed(1)} mm³
                  </div>
                </>
              )}
              {pane.contrastMeta.mismatch && (
                <div className="busy-msg manifest-error">
                  Recomputed threshold differs from the saved value — the image or saved seed may have changed.
                </div>
              )}
              {/* Nothing to change when the setting already gives this value. */}
              {!(fixedHu !== null && pane.contrastMeta.method === 'fixed' && fixedHu === pane.contrastThreshold) && (
                <button className="add-label-btn" onClick={onReSeed}>
                  {fixedHu !== null ? `Use ${fixedHu} HU` : 'Re-seed'}
                </button>
              )}
            </>
          ) : fixedHu !== null ? (
            <>
              <div className="edit-hint">Settings use one fixed threshold for every scan (no seed).</div>
              <button className="add-label-btn" onClick={onApplyFixed}>
                {`Use ${fixedHu} HU`}
              </button>
            </>
          ) : (
            <>
              <label className="edit-header-label">
                <input type="checkbox" checked={pane.seedPlacementMode} onChange={onToggleSeedPlacement} />
                Set AO seed
              </label>
              <div className="edit-hint">
                {pane.seedPlacementMode
                  ? 'Click the middle of the aorta, on the slice where the left ostium originates. Click again to move it.'
                  : 'Tick "Set AO seed", then click the image.'}
              </div>
              {pane.pendingSeed ? (
                <div className="contrast-stat-row">
                  Seed at {pane.pendingSeed.plane} slice {pane.pendingSeed.index + 1}
                </div>
              ) : (
                <div className="contrast-stat-row">No seed placed yet</div>
              )}
              <button className="add-label-btn" onClick={onFinalize} disabled={!pane.pendingSeed || saving}>
                {saving ? 'Computing...' : 'Finalize Seed'}
              </button>
            </>
          )}
        </>
      )}
    </div>
  )
}
