import { useState } from 'react'
import { DEFAULT_KEYBINDS, type KeybindMap } from './types'

const STORAGE_KEY = 'ctviewer.keybinds'

function loadKeybinds(): KeybindMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_KEYBINDS
    const parsed = JSON.parse(raw)
    // Merge over the defaults so an action added in a later version (not
    // present in an older saved config) still has a binding.
    return { ...DEFAULT_KEYBINDS, ...parsed }
  } catch {
    return DEFAULT_KEYBINDS
  }
}

export function useKeybinds(): [KeybindMap, (next: KeybindMap) => void] {
  const [keybinds, setKeybindsState] = useState<KeybindMap>(loadKeybinds)

  function setKeybinds(next: KeybindMap) {
    setKeybindsState(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* localStorage unavailable (e.g. disabled) — keep working in-memory */
    }
  }

  return [keybinds, setKeybinds]
}
