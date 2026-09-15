import { useEffect, useRef } from 'react'

export default function ReviewTagsPicker({
  options,
  selected,
  onToggle,
  onClose,
}: {
  options: string[]
  selected: string[]
  onToggle: (tag: string) => void
  onClose: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [onClose])

  return (
    <div className="reason-picker" ref={rootRef} onMouseDown={(e) => e.stopPropagation()}>
      <div className="reason-picker-hint">Review cases tagged with any of:</div>
      <div className="reason-picker-options">
        {options.length === 0 ? (
          <div className="reason-picker-empty">No reason tags yet</div>
        ) : (
          options.map((opt) => (
            <label key={opt} className="reason-picker-option">
              <input type="checkbox" checked={selected.includes(opt)} onChange={() => onToggle(opt)} />
              {opt}
            </label>
          ))
        )}
      </div>
    </div>
  )
}
