import { useEffect, useRef, useState } from 'react'

export default function ReasonPicker({
  options,
  selected,
  onToggle,
  onAddTag,
  onClose,
}: {
  options: string[]
  selected: string[]
  onToggle: (tag: string) => void
  onAddTag: (tag: string) => void
  onClose: () => void
}) {
  const [newTag, setNewTag] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [onClose])

  function submitNewTag() {
    const t = newTag.trim()
    if (!t) return
    onAddTag(t)
    setNewTag('')
  }

  return (
    <div className="reason-picker" ref={rootRef} onMouseDown={(e) => e.stopPropagation()}>
      <div className="reason-picker-options">
        {options.map((opt) => (
          <label key={opt} className="reason-picker-option">
            <input type="checkbox" checked={selected.includes(opt)} onChange={() => onToggle(opt)} />
            {opt}
          </label>
        ))}
      </div>
      <div className="reason-picker-add">
        <input
          type="text"
          placeholder="New tag (this session)"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitNewTag()
            }
          }}
        />
        <button type="button" onClick={submitNewTag} disabled={!newTag.trim()}>
          + Add
        </button>
      </div>
    </div>
  )
}
