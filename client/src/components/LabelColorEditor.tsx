import { CALCIFICATIONS_PRESET, type LabelColor } from '../types'

export default function LabelColorEditor({
  colors,
  onChange,
}: {
  colors: LabelColor[]
  onChange: (colors: LabelColor[]) => void
}) {
  function updateColor(label: number, color: string) {
    onChange(colors.map((c) => (c.label === label ? { ...c, color } : c)))
  }

  function removeLabel(label: number) {
    onChange(colors.filter((c) => c.label !== label))
  }

  function addLabel() {
    const nextLabel = colors.length ? Math.max(...colors.map((c) => c.label)) + 1 : 1
    onChange([...colors, { label: nextLabel, color: '#FFFFFF', name: `Label ${nextLabel}` }])
  }

  function resetToPreset() {
    onChange(CALCIFICATIONS_PRESET.map((c) => ({ ...c })))
  }

  return (
    <div className="label-editor">
      <div className="label-editor-header">
        <span>Segmentation label colors</span>
        <button type="button" onClick={resetToPreset} title="Reset to Calcifications preset">
          Calcifications preset
        </button>
      </div>
      <div className="label-grid">
        {colors.map((c) => (
          <div className="label-grid-item" key={c.label}>
            <span className="label-grid-value">{c.label}</span>
            <input type="color" value={c.color} onChange={(e) => updateColor(c.label, e.target.value)} />
            <button type="button" className="icon-btn" onClick={() => removeLabel(c.label)}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="add-label-btn" onClick={addLabel}>
        + Add label
      </button>
    </div>
  )
}
