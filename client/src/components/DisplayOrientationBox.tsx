import {
  ORIENTATION_PRESETS,
  presetIdFor,
  setDisplayOrientation,
  useDisplayOrientation,
  type OrientationPresetId,
} from '../displayOrientation'

// Settings row for how the scan is oriented on screen. Display only: the
// data is untouched, and the choice is remembered between sessions.
export default function DisplayOrientationBox() {
  const o = useDisplayOrientation()
  const preset = presetIdFor(o)

  function choose(id: OrientationPresetId) {
    const p = ORIENTATION_PRESETS.find((x) => x.id === id)
    if (p) setDisplayOrientation({ ...p.flips })
  }

  return (
    <div className="settings-section orientation-box">
      <div className="settings-title">Display orientation</div>
      <div className="orientation-row">
        <select value={preset} onChange={(e) => choose(e.target.value as OrientationPresetId)}>
          {ORIENTATION_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {preset === 'custom' && <option value="custom">Custom</option>}
        </select>
        <label className="orientation-check" title="Mirror left and right (axial and coronal)">
          <input type="checkbox" checked={o.lr} onChange={(e) => setDisplayOrientation({ lr: e.target.checked })} />
          Flip L–R
        </label>
        <label className="orientation-check" title="Mirror anterior and posterior (axial and sagittal)">
          <input type="checkbox" checked={o.ap} onChange={(e) => setDisplayOrientation({ ap: e.target.checked })} />
          Flip A–P
        </label>
        <label className="orientation-check" title="Mirror superior and inferior (coronal and sagittal)">
          <input type="checkbox" checked={o.si} onChange={(e) => setDisplayOrientation({ si: e.target.checked })} />
          Flip S–I
        </label>
        <label className="orientation-check" title="Show L / R / A / P / S / I at the edges of each view">
          <input
            type="checkbox"
            checked={o.letters}
            onChange={(e) => setDisplayOrientation({ letters: e.target.checked })}
          />
          Edge letters
        </label>
      </div>
    </div>
  )
}
