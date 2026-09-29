import { useSyncExternalStore } from 'react'
import { CALCIFICATIONS_PRESET, type LabelColor } from './types'

// The built-in presets are never stored and never modified: editing one forks
// a user preset instead. User presets live in localStorage, shared by every
// pane, so a colour scheme made once is there in the next session too.
//
// Vessel and branch names follow the SCCT 18-segment coronary model; the
// non-coronary structures are the ones cardiac-CT calcification consensus
// statements name (mitral and aortic annulus, valve leaflets, aortic root,
// pericardium, myocardium). The papers are linked from the label editor.
export interface PresetSource {
  label: string
  url: string
}

export interface BuiltinPreset {
  id: string
  name: string
  colors: LabelColor[]
  // Where the names come from, shown next to the preset.
  sources?: PresetSource[]
}

// SCCT guidelines for the interpretation and reporting of coronary CT angiography
// (coronary segments and branches, incl. ramus intermedius and posterolateral branch).
const SCCT_SEGMENTS: PresetSource = {
  label: 'SCCT coronary segments',
  url: 'https://www.journalofcardiovascularct.com/article/S1934-5925(09)00070-7/fulltext',
}
// SCCT 2021 expert consensus on coronary CT angiography.
const SCCT_2021: PresetSource = {
  label: 'SCCT 2021 consensus',
  url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8713482/',
}
// Consensus statement on reporting coronary, aortic valve and other cardiac
// calcification (mitral valve/annulus, pericardium, myocardium).
const BSCI_CARDIAC_CALCIFICATION: PresetSource = {
  label: 'BSCI/BSCCT/BSTI cardiac calcification',
  url: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7774698/',
}
// Care differentiating aortic valve from aortic root, mitral annulus and coronary calcification.
const AORTIC_VALVE_CALCIUM: PresetSource = {
  label: 'Aortic valve calcium (Agatston method)',
  url: 'https://www.jacc.org/doi/10.1016/j.jcmg.2019.01.045',
}

const coronary = (label: number, color: string, name: string): LabelColor => ({ label, color, name, coronary: true })
const other = (label: number, color: string, name: string): LabelColor => ({ label, color, name, coronary: false })

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: 'builtin:coronary-basic',
    name: 'Coronary Basic',
    sources: [SCCT_SEGMENTS],
    colors: [
      coronary(1, '#FFFF00', 'LM'),
      coronary(2, '#FF0000', 'LAD'),
      coronary(3, '#00FF00', 'LCx'),
      coronary(4, '#0000FF', 'RCA'),
    ],
  },
  {
    id: 'builtin:coronary-extended',
    name: 'Coronary Extended',
    sources: [SCCT_SEGMENTS, SCCT_2021],
    colors: [
      coronary(1, '#FFFF00', 'LM'), // left main
      coronary(2, '#FF0000', 'LAD'), // left anterior descending
      coronary(3, '#FF8080', 'D1'), // first diagonal
      coronary(4, '#B22222', 'D2'), // second diagonal
      coronary(5, '#FF00FF', 'RI'), // ramus intermedius
      coronary(6, '#00FF00', 'LCx'), // left circumflex
      coronary(7, '#90EE90', 'OM1'), // first obtuse marginal
      coronary(8, '#00A86B', 'OM2'), // second obtuse marginal
      coronary(9, '#0000FF', 'RCA'), // right coronary
      coronary(10, '#4DA6FF', 'PDA'), // posterior descending
      coronary(11, '#00FFFF', 'PLB'), // posterolateral branch
    ],
  },
  {
    id: 'builtin:heart-calcification',
    name: 'Heart Calcification',
    sources: [SCCT_SEGMENTS, BSCI_CARDIAC_CALCIFICATION, AORTIC_VALVE_CALCIUM],
    colors: [
      coronary(1, '#FFFF00', 'LM'),
      coronary(2, '#FF0000', 'LAD'),
      coronary(3, '#00FF00', 'LCx'),
      coronary(4, '#0000FF', 'RCA'),
      other(5, '#FF00FF', 'MAC'), // mitral annulus
      other(6, '#00FFFF', 'AoAnn'), // aortic annulus
      other(7, '#9966FF', 'AV'), // aortic valve leaflets
      other(8, '#FF66CC', 'MV'), // mitral valve leaflets
      other(9, '#99FF33', 'AoRoot'), // aortic root
      other(10, '#CCCCCC', 'Peri'), // pericardium
      other(11, '#FFB84D', 'Myo'), // myocardium / papillary muscle
    ],
  },
  { id: 'builtin:heart-aorta', name: 'Heart and Aorta', colors: CALCIFICATIONS_PRESET },
]

// What a new pane starts on.
export const BUILTIN_PRESET_ID = 'builtin:heart-aorta'
// Selections saved before there were several built-ins.
const LEGACY_BUILTIN_ID = 'builtin:calcifications'

export function findBuiltinPreset(id: string): BuiltinPreset | undefined {
  const wanted = id === LEGACY_BUILTIN_ID ? BUILTIN_PRESET_ID : id
  return BUILTIN_PRESETS.find((p) => p.id === wanted)
}
export const isBuiltinId = (id: string) => !!findBuiltinPreset(id)
const DEFAULT_PRESET_BASE_NAME = 'user-preset'
export const MAX_PRESET_NAME_LENGTH = 40

export interface UserPreset {
  id: string
  name: string
  colors: LabelColor[]
}

const PRESETS_KEY = 'ctviewer.labelPresets'
const SELECTED_KEY = 'ctviewer.labelPresetSelected'

const cloneColors = (colors: LabelColor[]): LabelColor[] => colors.map((c) => ({ ...c }))

export const builtinColors = (id: string = BUILTIN_PRESET_ID): LabelColor[] =>
  cloneColors((findBuiltinPreset(id) ?? findBuiltinPreset(BUILTIN_PRESET_ID)!).colors)

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

// Includes the built-in names: a user preset called "Coronary Basic" would be
// indistinguishable from it in the dropdown.
export function isNameTaken(name: string, exceptId?: string): boolean {
  if (BUILTIN_PRESETS.some((b) => sameName(b.name, name))) return true
  return presets.some((p) => p.id !== exceptId && sameName(p.name, name))
}

// "user-preset", then "user-preset-2", "-3", ... — the number only appears
// once there is another preset still carrying a default name, and it is the
// lowest one free (so deleting user-preset-2 makes the next new one reuse it).
function nextDefaultName(): string {
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
function getSelectedPresetId(): string {
  try {
    const id = localStorage.getItem(SELECTED_KEY)
    if (id && findPreset(id)) return id
    const builtin = id ? findBuiltinPreset(id) : undefined
    if (builtin) return builtin.id
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
  if (preset) return { presetId: id, colors: cloneColors(preset.colors) }
  return { presetId: findBuiltinPreset(id)?.id ?? BUILTIN_PRESET_ID, colors: builtinColors(id) }
}
