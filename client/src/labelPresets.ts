import { useSyncExternalStore } from 'react'
import { CALCIFICATIONS_PRESET, type LabelColor } from './types'

// The built-in preset is never stored and never modified: editing it forks a
// user preset instead. User presets live in localStorage, shared by every
// pane, so a colour scheme made once is there in the next session too.
export const BUILTIN_PRESET_ID = 'builtin:calcifications'
export const BUILTIN_PRESET_NAME = 'Calcifications'
export const DEFAULT_PRESET_BASE_NAME = 'user-preset'
export const MAX_PRESET_NAME_LENGTH = 40

export interface UserPreset {
  id: string
  name: string
  colors: LabelColor[]
}

const PRESETS_KEY = 'ctviewer.labelPresets'
const SELECTED_KEY = 'ctviewer.labelPresetSelected'

const cloneColors = (colors: LabelColor[]): LabelColor[] => colors.map((c) => ({ ...c }))

export const builtinColors = (): LabelColor[] => cloneColors(CALCIFICATIONS_PRESET)

function isValidColors(value: unknown): value is LabelColor[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (c) =>
        c &&
        typeof c === 'object' &&
        Number.isInteger((c as LabelColor).label) &&
        typeof (c as LabelColor).color === 'string',
    )
  )
}

// Anything unreadable in storage is dropped rather than trusted: a corrupt
// preset must not be able to take the label colours (and so the render) down.
function readPresets(): UserPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && isValidColors(p.colors))
      .map((p) => ({ id: p.id, name: p.name, colors: cloneColors(p.colors) }))
  } catch {
    return []
  }
}

function writePresets(next: UserPreset[]) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable or full — presets still work for this session */
  }
}

let presets: UserPreset[] = readPresets()
const listeners = new Set<() => void>()

function commit(next: UserPreset[]) {
  presets = next
  writePresets(next)
  listeners.forEach((l) => l())
}

export function getPresets(): UserPreset[] {
  return presets
}

export function findPreset(id: string): UserPreset | undefined {
  return presets.find((p) => p.id === id)
}

export function useLabelPresets(): UserPreset[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => presets,
  )
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

// Includes the built-in name: a user preset called "Calcifications" would be
// indistinguishable from it in the dropdown.
export function isNameTaken(name: string, exceptId?: string): boolean {
  if (sameName(name, BUILTIN_PRESET_NAME)) return true
  return presets.some((p) => p.id !== exceptId && sameName(p.name, name))
}

// "user-preset", then "user-preset-2", "-3", ... — the number only appears
// once there is another preset still carrying a default name, and it is the
// lowest one free (so deleting user-preset-2 makes the next new one reuse it).
export function nextDefaultName(): string {
  if (!isNameTaken(DEFAULT_PRESET_BASE_NAME)) return DEFAULT_PRESET_BASE_NAME
  for (let n = 2; ; n++) {
    const candidate = `${DEFAULT_PRESET_BASE_NAME}-${n}`
    if (!isNameTaken(candidate)) return candidate
  }
}

export function addPreset(colors: LabelColor[]): UserPreset {
  const preset: UserPreset = {
    id: `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: nextDefaultName(),
    colors: cloneColors(colors),
  }
  commit([...presets, preset])
  return preset
}

export function updatePresetColors(id: string, colors: LabelColor[]) {
  commit(presets.map((p) => (p.id === id ? { ...p, colors: cloneColors(colors) } : p)))
}

// Returns false (and changes nothing) for an empty or duplicate name.
export function renamePreset(id: string, name: string): boolean {
  const trimmed = name.trim().slice(0, MAX_PRESET_NAME_LENGTH)
  if (!trimmed || isNameTaken(trimmed, id)) return false
  commit(presets.map((p) => (p.id === id ? { ...p, name: trimmed } : p)))
  return true
}

export function removePreset(id: string) {
  // Read the remembered id before removing: afterwards getSelectedPresetId()
  // already hides a missing preset behind the built-in, so it could never
  // match and the stale id would stay in storage.
  const remembered = getSelectedPresetId()
  commit(presets.filter((p) => p.id !== id))
  if (remembered === id) setSelectedPresetId(BUILTIN_PRESET_ID)
}

// The preset a new session (or new pane) starts on. Falls back to the
// built-in when the remembered one no longer exists.
export function getSelectedPresetId(): string {
  try {
    const id = localStorage.getItem(SELECTED_KEY)
    if (id && findPreset(id)) return id
  } catch {
    /* ignore */
  }
  return BUILTIN_PRESET_ID
}

export function setSelectedPresetId(id: string) {
  try {
    localStorage.setItem(SELECTED_KEY, id)
  } catch {
    /* ignore */
  }
}

export function initialLabelColors(): { presetId: string; colors: LabelColor[] } {
  const id = getSelectedPresetId()
  const preset = findPreset(id)
  return preset ? { presetId: id, colors: cloneColors(preset.colors) } : { presetId: BUILTIN_PRESET_ID, colors: builtinColors() }
}
