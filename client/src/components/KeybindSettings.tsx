import { useEffect, useState } from 'react'
import type { KeyCombo, KeybindActionId, KeybindMap } from '../types'
import { DEFAULT_KEYBINDS, KEYBIND_LABELS, comboLabel, combosEqual } from '../types'

const ACTION_ORDER: KeybindActionId[] = ['toggleMask', 'toggleThresh', 'prevSlice', 'nextSlice', 'reloadCurrent']

export default function KeybindSettings({
  keybinds,
  onChange,
  onClose,
}: {
  keybinds: KeybindMap
  onChange: (next: KeybindMap) => void
  onClose: () => void
}) {
  const [capturing, setCapturing] = useState<KeybindActionId | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!capturing) return
    const action = capturing
    function handleKeyDown(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(null)
        return
      }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return // wait for a real key
      const combo: KeyCombo = {
        key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
        ctrl: e.ctrlKey || undefined,
        alt: e.altKey || undefined,
        shift: e.shiftKey || undefined,
        meta: e.metaKey || undefined,
      }
      const conflictAction = ACTION_ORDER.find(
        (a) => a !== action && keybinds[a].some((c) => combosEqual(c, combo)),
      )
      if (conflictAction) {
        setError(`${comboLabel(combo)} is already used for "${KEYBIND_LABELS[conflictAction]}"`)
        setCapturing(null)
        return
      }
      if (!keybinds[action].some((c) => combosEqual(c, combo))) {
        onChange({ ...keybinds, [action]: [...keybinds[action], combo] })
      }
      setCapturing(null)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [capturing, keybinds, onChange])

  function removeCombo(action: KeybindActionId, combo: KeyCombo) {
    onChange({ ...keybinds, [action]: keybinds[action].filter((c) => !combosEqual(c, combo)) })
  }

  function resetDefaults() {
    onChange(DEFAULT_KEYBINDS)
    setError(null)
    setCapturing(null)
  }

  return (
    <div className="comment-modal-backdrop" onClick={onClose}>
      <div className="comment-modal keybind-modal" onClick={(e) => e.stopPropagation()}>
        <div className="comment-modal-title">Keyboard Shortcuts</div>
        <div className="keybind-hint">
          Shortcuts act on whichever pane you last clicked into. Click "+ Add", then press a key
          (optionally holding Ctrl/Alt/Shift).
        </div>

        {ACTION_ORDER.map((action) => (
          <div className="keybind-row" key={action}>
            <span className="keybind-row-label">{KEYBIND_LABELS[action]}</span>
            <div className="keybind-chips">
              {keybinds[action].map((combo, i) => (
                <span className="keybind-chip" key={i}>
                  {comboLabel(combo)}
                  <button type="button" onClick={() => removeCombo(action, combo)} title="Remove this shortcut">
                    ✕
                  </button>
                </span>
              ))}
              {capturing === action ? (
                <span className="keybind-chip keybind-chip-capturing">Press a key... (Esc to cancel)</span>
              ) : (
                <button
                  type="button"
                  className="keybind-add-btn"
                  onClick={() => {
                    setError(null)
                    setCapturing(action)
                  }}
                >
                  + Add
                </button>
              )}
            </div>
          </div>
        ))}

        {error && <div className="busy-msg manifest-error">{error}</div>}

        <div className="comment-modal-buttons">
          <button onClick={resetDefaults}>Reset to defaults</button>
          <button className="add-label-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
