import { useEffect, useState } from 'react'

export default function AlphaSpinner({
  label,
  value,
  onChange,
  step = 0.1,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
}) {
  const [text, setText] = useState(value.toFixed(2))

  useEffect(() => {
    setText(value.toFixed(2))
  }, [value])

  function clamp(v: number) {
    return Math.round(Math.max(0, Math.min(1, v)) * 100) / 100
  }

  function commit(raw: string) {
    const parsed = parseFloat(raw)
    const v = clamp(Number.isNaN(parsed) ? value : parsed)
    onChange(v)
    setText(v.toFixed(2))
  }

  function bump(delta: number) {
    onChange(clamp(value + delta))
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault()
    e.stopPropagation()
    bump(e.deltaY < 0 ? step : -step)
  }

  return (
    <div className="alpha-spinner" onWheel={onWheel}>
      <span className="alpha-spinner-label">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        className="alpha-spinner-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      <div className="alpha-spinner-arrows">
        <button type="button" onClick={() => bump(step)} tabIndex={-1}>
          ▲
        </button>
        <button type="button" onClick={() => bump(-step)} tabIndex={-1}>
          ▼
        </button>
      </div>
    </div>
  )
}
