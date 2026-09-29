import { useSyncExternalStore } from 'react'
import type { Plane } from './types'

// Display-only orientation. The volume itself is always held as LPS; these
// choices mirror what is shown, like the radiological/neurological switch in
// other viewers. A flip is named by the patient axis it mirrors:
//   lr = left-right, ap = anterior-posterior, si = superior-inferior.
// Every combination of the three is one of the 8 sign variants of an
// orientation code (LPS, RAS, LAS, ...); axis permutations are not offered
// because the planes are already defined by anatomy.
export interface DisplayOrientation {
  lr: boolean
  ap: boolean
  si: boolean
  letters: boolean // show L/R/A/P/S/I at the image edges
}

const DEFAULT_ORIENTATION: DisplayOrientation = { lr: false, ap: false, si: false, letters: true }

export const ORIENTATION_PRESETS = [
  { id: 'radiological', name: 'Radiological (default)', flips: { lr: false, ap: false, si: false } },
  { id: 'neurological', name: 'Neurological', flips: { lr: true, ap: false, si: false } },
] as const

export type OrientationPresetId = (typeof ORIENTATION_PRESETS)[number]['id'] | 'custom'

export function presetIdFor(o: DisplayOrientation): OrientationPresetId {
  const hit = ORIENTATION_PRESETS.find((p) => p.flips.lr === o.lr && p.flips.ap === o.ap && p.flips.si === o.si)
  return hit ? hit.id : 'custom'
}

// The string the backend takes (`flip` query param): one letter per mirrored axis.
export function flipCode(o: DisplayOrientation): string {
  return (o.lr ? 'l' : '') + (o.ap ? 'a' : '') + (o.si ? 's' : '')
}

// Which screen directions a plane's flips mirror: axial shows L-R across and
// A-P down, coronal L-R across and S-I down, sagittal A-P across and S-I down.
export function planeFlips(plane: Plane, o: DisplayOrientation): { h: boolean; v: boolean } {
  if (plane === 'axial') return { h: o.lr, v: o.ap }
  if (plane === 'coronal') return { h: o.lr, v: o.si }
  return { h: o.ap, v: o.si }
}

// The letters that belong at each edge of a plane's image. Un-flipped, the
// display follows the radiological convention: patient-right on screen-left,
// anterior at the top of axial, superior at the top of coronal/sagittal, and
// the patient facing screen-left in sagittal.
export function edgeLabels(plane: Plane, o: DisplayOrientation): { left: string; right: string; top: string; bottom: string } {
  const base =
    plane === 'axial'
      ? { left: 'R', right: 'L', top: 'A', bottom: 'P' }
      : plane === 'coronal'
        ? { left: 'R', right: 'L', top: 'S', bottom: 'I' }
        : { left: 'A', right: 'P', top: 'S', bottom: 'I' }
  const f = planeFlips(plane, o)
  return {
    left: f.h ? base.right : base.left,
    right: f.h ? base.left : base.right,
    top: f.v ? base.bottom : base.top,
    bottom: f.v ? base.top : base.bottom,
  }
}

const KEY = 'ctviewer.displayOrientation'

function read(): DisplayOrientation {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_ORIENTATION
    const p = JSON.parse(raw)
    return {
      lr: p.lr === true,
      ap: p.ap === true,
      si: p.si === true,
      letters: p.letters !== false,
    }
  } catch {
    return DEFAULT_ORIENTATION
  }
}

let current: DisplayOrientation = read()
const listeners = new Set<() => void>()

export function setDisplayOrientation(partial: Partial<DisplayOrientation>) {
  current = { ...current, ...partial }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* storage unavailable — the choice still holds for this session */
  }
  listeners.forEach((l) => l())
}

export function useDisplayOrientation(): DisplayOrientation {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )
}
