import { useState } from 'react'

const STORAGE_KEY = 'ctviewer.contrastSettings'

export interface ContrastSettings {
  targetVolumeMm3: number
  kMultiplier: number
}

const DEFAULT_CONTRAST_SETTINGS: ContrastSettings = { targetVolumeMm3: 200, kMultiplier: 3 }

function loadContrastSettings(): ContrastSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_CONTRAST_SETTINGS
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_CONTRAST_SETTINGS, ...parsed }
  } catch {
    return DEFAULT_CONTRAST_SETTINGS
  }
}

export function useContrastSettings(): [ContrastSettings, (next: ContrastSettings) => void] {
  const [settings, setSettingsState] = useState<ContrastSettings>(loadContrastSettings)

  function setSettings(next: ContrastSettings) {
    setSettingsState(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* localStorage unavailable (e.g. disabled) — keep working in-memory */
    }
  }

  return [settings, setSettings]
}
