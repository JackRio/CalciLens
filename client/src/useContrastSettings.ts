import { useState } from 'react'

const STORAGE_KEY = 'ctviewer.contrastSettings'

// How a contrast scan's calcium threshold is set. Two formulas from the
// literature (see CaseLoader for the references):
//  - 'aorta-sd': mean + k x SD of a sphere placed in the ascending aorta
//    (this app's default; k is a setting, not a different formula)
//  - 'fixed': one HU value for every scan (320 HU in Otton et al. 2012)
export type ThresholdMethod = 'aorta-sd' | 'fixed'

export interface ContrastSettings {
  method: ThresholdMethod
  targetVolumeMm3: number
  kMultiplier: number
  fixedHu: number
}

const DEFAULT_CONTRAST_SETTINGS: ContrastSettings = { method: 'aorta-sd', targetVolumeMm3: 200, kMultiplier: 3, fixedHu: 320 }

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
