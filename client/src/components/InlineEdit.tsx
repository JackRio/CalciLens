import { useEffect, useRef, useState } from 'react'

// A value that reads as plain, fixed text until you double-click it (or focus
// it and press Enter/F2), then becomes an input. Enter or clicking away
// commits, Escape cancels. `validate` decides whether the draft may be
// committed; while it fails the field is marked invalid, and committing it
// simply restores the old value rather than applying something half-typed.
export default function InlineEdit({
  value,
  onCommit,
  validate,
  type = 'text',
  placeholder,
  className = '',
  title,
  invalidTitle,
  maxLength,
  maxCh,
}: {
  value: string
  onCommit: (next: string) => void
  validate?: (draft: string) => boolean
  type?: 'text' | 'number'
  placeholder?: string
  className?: string
  title?: string
  invalidTitle?: string
  maxLength?: number
  // Grow with the text, but never wider than this many characters: longer
  // text is clipped (display) or scrolls inside the box (editing) instead of
  // stretching the layout.
  maxCh?: number
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const valid = !validate || validate(draft)
  const fit = (text: string) => (maxCh ? { width: `${Math.min(Math.max(text.length, 3) + 1, maxCh)}ch` } : undefined)

  function start() {
    setDraft(value)
    setEditing(true)
  }

  function finish(commit: boolean) {
    setEditing(false)
    if (commit && valid && draft !== value) onCommit(draft)
  }

  if (!editing) {
    return (
      <span
        className={`inline-edit ${className}${value ? '' : ' inline-edit-empty'}`}
        role="button"
        tabIndex={0}
        title={title ?? 'Double-click to edit'}
        style={maxCh ? { maxWidth: `${maxCh}ch` } : undefined}
        onDoubleClick={start}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'F2') {
            e.preventDefault()
            start()
          }
        }}
      >
        {value || placeholder || ''}
      </span>
    )
  }

  return (
    <input
      ref={inputRef}
      type={type}
      className={`inline-edit-input ${className}${valid ? '' : ' inline-edit-invalid'}`}
      value={draft}
      maxLength={maxLength}
      style={fit(draft)}
      title={valid ? undefined : invalidTitle}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
    />
  )
}
