import {
  ORIENTATION_PRESETS,
  presetIdFor,
  setDisplayOrientation,
  useDisplayOrientation,
  type OrientationPresetId,
} from '../displayOrientation'

const PRESET_NOTES: Record<string, string> = {
  radiological: 'Patient right on screen left',
  neurological: 'Patient left on screen left',
}

// How the scan is oriented on screen. Display only: the data is untouched,
// and the choice is remembered between sessions.
export default function DisplayOrientationBox() {
  const o = useDisplayOrientation()
  const preset = presetIdFor(o)

  function choose(id: OrientationPresetId) {
    const p = ORIENTATION_PRESETS.find((x) => x.id === id)
    if (p) setDisplayOrientation({ ...p.flips })
  }

  const flips: { key: 'lr' | 'ap' | 'si'; label: string; title: string }[] = [
    { key: 'lr', label: 'Flip L–R', title: 'Mirror left and right (axial and coronal)' },
    { key: 'ap', label: 'Flip A–P', title: 'Mirror anterior and posterior (axial and sagittal)' },
    { key: 'si', label: 'Flip S–I', title: 'Mirror superior and inferior (coronal and sagittal)' },
  ]

  return (
    <div className="settings-section orientation-box">
      <div className="orientation-cards" role="group" aria-label="Orientation preset">
        {ORIENTATION_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`orientation-card${preset === p.id ? ' active' : ''}`}
            aria-pressed={preset === p.id}
            onClick={() => choose(p.id)}
          >
            <span className="orientation-card-name">{p.name.replace(' (default)', '')}</span>
            <span className="orientation-card-note">{PRESET_NOTES[p.id]}</span>
          </button>
        ))}
        <div className={`orientation-card orientation-card-custom${preset === 'custom' ? ' active' : ''}`}>
          <span className="orientation-card-name">Custom</span>
          <span className="orientation-card-note">Set by the flips below</span>
        </div>
      </div>
      <div className="orientation-chips">
        {flips.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`orientation-chip${o[f.key] ? ' active' : ''}`}
            aria-pressed={o[f.key]}
            title={f.title}
            onClick={() => setDisplayOrientation({ [f.key]: !o[f.key] })}
          >
            {f.label}
          </button>
        ))}
        <button
          type="button"
          className={`orientation-chip${o.letters ? ' active' : ''}`}
          aria-pressed={o.letters}
          title="Show L / R / A / P / S / I at the edges of each view"
          onClick={() => setDisplayOrientation({ letters: !o.letters })}
        >
          Edge letters
        </button>
      </div>
    </div>
  )
}
