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
      <table className="label-table">
        <thead>
          <tr>
            <th>Value</th>
            <th>Color</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {colors.map((c) => (
            <tr key={c.label}>
              <td>{c.label}</td>
              <td>
                <input
                  type="color"
                  value={c.color}
                  onChange={(e) => updateColor(c.label, e.target.value)}
                />
              </td>
              <td>
                <button type="button" className="icon-btn" onClick={() => removeLabel(c.label)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="add-label-btn" onClick={addLabel}>
        + Add label
      </button>
    </div>
  )
}
