import { useEffect, useRef, useState } from 'react'

export interface LabelSelectOption {
  value: number
  text: string
  color?: string // omit for a hollow/background swatch
}

export default function LabelSelect({
  options,
  value,
  placeholder,
  onChange,
  grid,
}: {
  options: LabelSelectOption[]
  value: number | null
  placeholder?: string
  onChange: (v: number) => void
  // Lays out the menu as 2 columns (Background full-width on its own row,
  // then the rest in pairs) instead of a plain vertical list.
  grid?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [])

  const current = options.find((o) => o.value === value)

  return (
    <div className="label-select" ref={rootRef} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className="label-select-trigger" onClick={() => setOpen((v) => !v)}>
        {current ? (
          <>
            <span
              className={current.color ? 'label-swatch' : 'label-swatch label-swatch-empty'}
              style={current.color ? { background: current.color } : undefined}
            />
            <span>{current.text}</span>
          </>
        ) : (
          <span className="label-select-placeholder">{placeholder || 'select'}</span>
        )}
        <span className="label-select-caret">▾</span>
      </button>
      {open && (
        <div className={grid ? 'label-select-menu label-select-menu-grid' : 'label-select-menu'}>
          {options.map((o, i) => (
            <div
              key={o.value}
              className={
                grid && i === 0 ? 'label-select-option label-select-option-full' : 'label-select-option'
              }
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              <span
                className={o.color ? 'label-swatch' : 'label-swatch label-swatch-empty'}
                style={o.color ? { background: o.color } : undefined}
              />
              <span>{o.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
