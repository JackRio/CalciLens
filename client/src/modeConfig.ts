import type { AppMode, ManifestConfig } from './types'
import { DEFAULT_MANIFEST_CONFIG } from './types'

// What each launcher screen shows. Instead of one "view only" on/off switch
// that hides things, every screen lists what it has, and the UI asks this list
// ("does this mode have a Comment button?"). A new screen (Review, Contrast)
// is then a new entry here, not another round of hiding controls by hand.
export interface ModeCaps {
  edit: boolean // annotation window, score compute, saving, unsaved-work prompts
  comment: boolean // Comment button on a manifest case
  reason: boolean // Reason picker (and its manifest column)
  reviewMode: boolean // Review toggle, Tags, and the Review shortcut
  split: boolean // Split view and the Copy button
  contrast: boolean // Contrast toggle, seed box, contrast detection
  orientation: boolean // display orientation setting and edge letters
  showAll: boolean // the three-views-at-once button
  annotationLookup: boolean // reload this scan's saved annotation on load
  readOnlyManifest: boolean // loading a manifest never adds columns to the file
  // Manifest columns worth showing a picker for (Image / Mask / ID always are).
  columns: { reason: boolean; status: boolean; annotation: boolean; contrast: boolean }
}

const NO_COLUMNS = { reason: false, status: false, annotation: false, contrast: false }

const VIEW: ModeCaps = {
  edit: false,
  comment: false,
  reason: false,
  reviewMode: false,
  split: false,
  contrast: false,
  orientation: true,
  showAll: true,
  annotationLookup: false,
  readOnlyManifest: true,
  columns: NO_COLUMNS,
}

const ANNOTATE_NONCONTRAST: ModeCaps = {
  edit: true,
  comment: true,
  reason: false,
  reviewMode: false,
  split: false,
  contrast: false,
  orientation: true,
  showAll: true,
  annotationLookup: true,
  readOnlyManifest: false,
  // Status marks a case Annotated / InProgress; the annotation column is where
  // the saved annotation's path is recorded so the next visit finds it.
  columns: { reason: false, status: true, annotation: true, contrast: false },
}

// The original, unrestricted app (reachable at /#app).
const FULL: ModeCaps = {
  edit: true,
  comment: true,
  reason: true,
  reviewMode: true,
  split: true,
  contrast: true,
  orientation: false,
  showAll: false,
  annotationLookup: true,
  readOnlyManifest: false,
  columns: { reason: true, status: true, annotation: true, contrast: true },
}

export function capsFor(mode?: AppMode): ModeCaps {
  if (mode === 'view') return VIEW
  if (mode === 'annotate-noncontrast') return ANNOTATE_NONCONTRAST
  return FULL
}

// Column names a fresh pane starts with. A column the mode doesn't show is
// left blank, which means "don't track it" — so it is never read from, and
// never added to, the user's manifest.
export function manifestDefaultsFor(mode?: AppMode): ManifestConfig {
  return manifestDefaultsForCaps(capsFor(mode))
}

export function manifestDefaultsForCaps(caps: ModeCaps): ManifestConfig {
  return {
    ...DEFAULT_MANIFEST_CONFIG,
    reasonColumn: caps.columns.reason ? DEFAULT_MANIFEST_CONFIG.reasonColumn : '',
    includeDefaultReasonTags: caps.columns.reason ? DEFAULT_MANIFEST_CONFIG.includeDefaultReasonTags : false,
    statusColumn: caps.columns.status ? DEFAULT_MANIFEST_CONFIG.statusColumn : '',
    annotationColumn: caps.columns.annotation ? DEFAULT_MANIFEST_CONFIG.annotationColumn : '',
    contrastColumn: caps.columns.contrast ? DEFAULT_MANIFEST_CONFIG.contrastColumn : '',
  }
}
