import { useEffect, useRef, useState, type ReactNode } from 'react'
import InlineEdit from './InlineEdit'
import type { LabelColor } from '../types'
import {
  BUILTIN_PRESETS,
  BUILTIN_PRESET_ID,
  MAX_PRESET_NAME_LENGTH,
  addPreset,
  builtinColors,
  findBuiltinPreset,
  findPreset,
  isNameTaken,
  removePreset,
  renamePreset,
  setSelectedPresetId,
  updatePresetColors,
  useLabelPresets,
  type UserPreset,
} from '../labelPresets'

// A dropdown built by hand because a native <select> cannot show a delete
// button on hover. Closes on outside click or Escape.
function PresetDropdown({
  selectedId,
  presets,
  nameNode,
  hint,
  onSelect,
  onRequestDelete,
}: {
  selectedId: string
  presets: UserPreset[]
  // What the control shows as the current preset: plain text for the default,
  // an InlineEdit for a user preset (so renaming happens right here).
  nameNode: ReactNode
  hint?: string
  onSelect: (id: string) => void
  onRequestDelete: (preset: UserPreset) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function pick(id: string) {
    setOpen(false)
    onSelect(id)
  }

  return (
    <div className="preset-dropdown" ref={rootRef}>
      <div className="preset-combo" title={hint}>
        <span className="preset-combo-name">{nameNode}</span>
        <button
          type="button"
          className="preset-combo-chevron"
          aria-label="Choose a preset"
          onClick={() => setOpen((v) => !v)}
        >
          ▾
        </button>
      </div>
      {open && (
        <div className="preset-dropdown-menu" role="listbox">
          {BUILTIN_PRESETS.map((b) => (
            <div
              key={b.id}
              className={`preset-dropdown-item${selectedId === b.id ? ' selected' : ''}`}
              role="option"
              aria-selected={selectedId === b.id}
              onClick={() => pick(b.id)}
            >
              <span className="preset-dropdown-name">
                {b.name}
                {b.id === BUILTIN_PRESET_ID ? ' (default)' : ''}
              </span>
            </div>
          ))}
          {presets.map((p) => (
            <div
              key={p.id}
              className={`preset-dropdown-item${selectedId === p.id ? ' selected' : ''}`}
              role="option"
              aria-selected={selectedId === p.id}
              onClick={() => pick(p.id)}
            >
              <span className="preset-dropdown-name">{p.name}</span>
              <button
                type="button"
                className="preset-dropdown-delete"
                title={`Delete "${p.name}"`}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  onRequestDelete(p)
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="preset-dropdown-item preset-dropdown-new" role="option" onClick={() => pick(NEW_PRESET_VALUE)}>
            <span className="preset-dropdown-name">+ New preset…</span>
          </div>
        </div>
      )}
    </div>
  )
}

const MAX_LABEL_NAME_LENGTH = 40

// Sentinel <option> value: picking it creates a preset instead of selecting one.
const NEW_PRESET_VALUE = '__new__'

export default function LabelColorEditor({
  colors,
  presetId,
  onChange,
}: {
  colors: LabelColor[]
  presetId: string
  onChange: (colors: LabelColor[], presetId: string) => void
}) {
  const presets = useLabelPresets()
  const [pendingDelete, setPendingDelete] = useState<UserPreset | null>(null)
  const builtinPreset = findBuiltinPreset(presetId)
  const userPreset = builtinPreset ? undefined : findPreset(presetId)
  // A preset id that no longer exists (deleted elsewhere) is treated as the
  // default built-in, so the next edit forks a new preset rather than vanishing.
  const isBuiltin = !userPreset
  const shownBuiltin = builtinPreset ?? findBuiltinPreset(BUILTIN_PRESET_ID)!

  function select(id: string) {
    if (id === NEW_PRESET_VALUE) return newPreset()
    setSelectedPresetId(id)
    const b = findBuiltinPreset(id)
    if (b) return onChange(builtinColors(b.id), b.id)
    const p = findPreset(id)
    if (p) onChange(p.colors.map((c) => ({ ...c })), p.id)
  }

  // The one path every colour edit goes through. A user preset is edited in
  // place; the built-in never is — the edit lands in a fresh preset instead.
  function applyEdit(next: LabelColor[]) {
    if (userPreset) {
      updatePresetColors(userPreset.id, next)
      onChange(next, userPreset.id)
    } else {
      const created = addPreset(next)
      setSelectedPresetId(created.id)
      onChange(next, created.id)
    }
  }

  function newPreset() {
    const created = addPreset(colors)
    setSelectedPresetId(created.id)
    onChange(colors.map((c) => ({ ...c })), created.id)
  }

  // Deleting goes through a confirmation modal. The preset being removed need
  // not be the selected one (the dropdown offers ✕ on every user preset); only
  // when it is does the pane fall back to the built-in colours.
  function confirmDelete() {
    if (!pendingDelete) return
    const wasSelected = pendingDelete.id === presetId
    removePreset(pendingDelete.id)
    setPendingDelete(null)
    if (wasSelected) onChange(builtinColors(), BUILTIN_PRESET_ID)
  }

  const updateColor = (label: number, color: string) =>
    applyEdit(colors.map((c) => (c.label === label ? { ...c, color } : c)))
  const updateName = (label: number, name: string) =>
    applyEdit(colors.map((c) => (c.label === label ? { ...c, name } : c)))
  const renumber = (label: number, next: number) =>
    applyEdit(colors.map((c) => (c.label === label ? { ...c, label: next } : c)))
  const removeLabel = (label: number) => applyEdit(colors.filter((c) => c.label !== label))
  const addLabel = () => {
    const nextLabel = colors.length ? Math.max(...colors.map((c) => c.label)) + 1 : 1
    applyEdit([...colors, { label: nextLabel, color: '#FFFFFF', name: `Label ${nextLabel}` }])
  }

  return (
    <div className="label-editor">
      <div className="label-editor-header">
        <span className="label-editor-title">Label colors</span>
        <PresetDropdown
          selectedId={isBuiltin ? shownBuiltin.id : presetId}
          presets={presets}
          hint={
            isBuiltin
              ? 'Built-in presets are read-only. Any change saves as a new preset.'
              : 'Double-click the name to rename'
          }
          nameNode={
            userPreset ? (
              <InlineEdit
                key={userPreset.id}
                className="preset-name"
                value={userPreset.name}
                maxLength={MAX_PRESET_NAME_LENGTH}
                maxCh={24}
                validate={(d) => !!d.trim() && !isNameTaken(d, userPreset.id)}
                invalidTitle="Give the preset a name no other preset uses"
                onCommit={(next) => renamePreset(userPreset.id, next)}
              />
            ) : (
              <span className="preset-default-name">{shownBuiltin.name}</span>
            )
          }
          onSelect={select}
          onRequestDelete={setPendingDelete}
        />
        <button type="button" className="add-label-btn" onClick={addLabel} title="Add a label to this preset">
          + Add label
        </button>
      </div>
      {isBuiltin && shownBuiltin.sources && (
        <div className="label-editor-sources">
          Based on:{' '}
          {shownBuiltin.sources.map((s, i) => (
            <span key={s.url}>
              {i > 0 && ' · '}
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.label}
              </a>
            </span>
          ))}
        </div>
      )}
      <div className="label-grid">
        {colors.map((c) => (
          <div className="label-grid-item" key={c.label}>
            <InlineEdit
              type="number"
              className="label-grid-number"
              value={String(c.label)}
              title="Label number. Double-click to edit"
              validate={(d) => {
                const n = Number(d)
                return Number.isInteger(n) && n >= 1 && !colors.some((o) => o.label !== c.label && o.label === n)
              }}
              invalidTitle="Must be a whole number that no other label uses"
              onCommit={(next) => renumber(c.label, Number(next))}
            />
            <input type="color" value={c.color} onChange={(e) => updateColor(c.label, e.target.value)} />
            <InlineEdit
              className="label-grid-name"
              value={c.name ?? ''}
              placeholder="Name"
              maxLength={MAX_LABEL_NAME_LENGTH}
              onCommit={(next) => updateName(c.label, next.trim())}
            />
            <button
              type="button"
              className="icon-btn"
              disabled={colors.length <= 1}
              title={colors.length <= 1 ? 'A preset needs at least one label' : 'Remove this label'}
              onClick={() => removeLabel(c.label)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      {pendingDelete && (
        <div className="comment-modal-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="comment-modal" onClick={(e) => e.stopPropagation()}>
            <div className="comment-modal-title">Delete preset?</div>
            <div className="nav-modal-body">
              "{pendingDelete.name}" will be removed. This can't be undone.
            </div>
            <div className="comment-modal-buttons">
              <button onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className="danger-btn" onClick={confirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
