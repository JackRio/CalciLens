import { useEffect, useState } from 'react'
import type { KeyCombo, KeybindActionId, KeybindMap } from '../types'
import { DEFAULT_KEYBINDS, KEYBIND_LABELS, comboLabel, combosEqual } from '../types'

const ACTION_ORDER: KeybindActionId[] = [
  'toggleMask',
  'toggleThresh',
  'prevSlice',
  'nextSlice',
  'reloadCurrent',
  'toggleReviewMode',
  'toggleScoreComputeMode',
]

// Edit/review-only actions that mean nothing in View mode.
const VIEW_HIDDEN: KeybindActionId[] = ['toggleReviewMode', 'toggleScoreComputeMode']

// Fixed mouse gestures — not rebindable key actions, so they don't belong in
// ACTION_ORDER/KEYBIND_LABELS, but they're still worth documenting here since
// this is the one place users look for "how do I do X".
const MOUSE_CONTROLS: { label: string; combo: string }[] = [
  { label: 'Scroll slices', combo: 'Scroll' },
  { label: 'Zoom in/out', combo: 'Right-click + drag up/down' },
  { label: 'Adjust window level', combo: 'Right-click + drag left/right' },
  { label: 'Pan the image', combo: 'Hold scroll + drag (or left-click + drag outside Annotation Mode)' },
]

export default function KeybindSettings({
  keybinds,
  onChange,
  onClose,
  viewOnly = false,
}: {
  keybinds: KeybindMap
  onChange: (next: KeybindMap) => void
  onClose: () => void
  viewOnly?: boolean
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

        {ACTION_ORDER.filter((a) => !viewOnly || !VIEW_HIDDEN.includes(a)).map((action) => (
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

        <div className="keybind-hint" style={{ marginTop: 10 }}>
          Mouse controls (fixed, not remappable):
        </div>
        {MOUSE_CONTROLS.map((c) => (viewOnly ? { ...c, combo: c.combo.replace(' (or left-click + drag outside Annotation Mode)', ' (or left-click + drag)') } : c)).map((c) => (
          <div className="keybind-row" key={c.label + c.combo}>
            <span className="keybind-row-label">{c.label}</span>
            <span className="keybind-chip">{c.combo}</span>
          </div>
        ))}

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
