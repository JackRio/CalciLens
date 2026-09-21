import type { PaneState } from '../types'
import type { ContrastSettings } from '../useContrastSettings'

export default function ContrastSeedBox({
  pane,
  contrastSettings,
  onContrastSettingsChange,
  minimized,
  onToggleMinimized,
  saving,
  error,
  onFinalize,
  onReSeed,
  onToggleSeedPlacement,
}: {
  pane: PaneState
  contrastSettings: ContrastSettings
  onContrastSettingsChange: (next: ContrastSettings) => void
  minimized: boolean
  onToggleMinimized: () => void
  saving: boolean
  error: string | null
  onFinalize: () => void
  onReSeed: () => void
  onToggleSeedPlacement: () => void
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
                Threshold <strong>{pane.contrastThreshold?.toFixed(1)} HU</strong>
              </div>
              <div className="contrast-stat-row">
                Mean {pane.contrastMeta.meanHu.toFixed(1)} · STD {pane.contrastMeta.stdHu.toFixed(1)}
              </div>
              <div className="contrast-stat-row">
                VOI {pane.contrastMeta.voxelCount} vox · {pane.contrastMeta.actualVolumeMm3.toFixed(1)} mm³
              </div>
              {pane.contrastMeta.mismatch && (
                <div className="busy-msg manifest-error">
                  Recomputed threshold differs from the saved value — the image or saved seed may have changed.
                </div>
              )}
              <button className="add-label-btn" onClick={onReSeed}>
                Re-seed
              </button>
            </>
          ) : (
            <>
              <label className="edit-field">
                Target volume (mm³)
                <input
                  type="number"
                  min={1}
                  value={contrastSettings.targetVolumeMm3}
                  onChange={(e) =>
                    onContrastSettingsChange({ ...contrastSettings, targetVolumeMm3: Number(e.target.value) })
                  }
                />
              </label>
              <label className="edit-field">
                K multiplier
                <input
                  type="number"
                  step={0.1}
                  value={contrastSettings.kMultiplier}
                  onChange={(e) =>
                    onContrastSettingsChange({ ...contrastSettings, kMultiplier: Number(e.target.value) })
                  }
                />
              </label>
              <label className="edit-header-label">
                <input type="checkbox" checked={pane.seedPlacementMode} onChange={onToggleSeedPlacement} />
                Set AO seed
              </label>
              <div className="edit-hint">
                {pane.seedPlacementMode
                  ? 'Click near the left ostium, center of ascending aorta. Click again to move it.'
                  : 'Enable "Set AO seed", then click on the image.'}
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
          {error && <div className="busy-msg manifest-error">{error}</div>}
        </>
      )}
    </div>
  )
}
