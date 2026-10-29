# CT Viewer

Desktop CT / segmentation-mask viewer. Electron wraps a React/TypeScript frontend and spawns a
Python FastAPI backend as a subprocess; the frontend talks to the backend over HTTP on
`localhost:8000`.

## Stack

- **Electron** (`electron/main.js`) — desktop shell. On startup it spawns the Python backend
  (`.venv/Scripts/python.exe -m uvicorn app:app --port 8000`, cwd=`server/`), polls
  `/api/defaults` until it's up, then loads `http://127.0.0.1:8000` into the window (the backend
  also serves the built React app as static files — see `app.py`'s `StaticFiles` mount). No dev
  server is used in normal runs; the frontend is always the production build in `client/dist`.
- **Frontend**: React 19 + TypeScript, built with Vite, in `client/`.
- **Backend**: FastAPI + SimpleITK + NumPy + Pillow + pandas + openpyxl, in `server/`.

## Running / building

```bash
cd client && npm run build          # build the React app to client/dist
cd .. && npm run app                # build client + launch Electron (or: npm start, after a build)
```

There is **no hot reload** — every frontend change requires `npm run build` in `client/`, and every
backend change requires fully restarting the Electron/Python process (`taskkill //F //IM
electron.exe //T` then relaunch `nohup npx electron . &`) since Python isn't running with
`--reload`. Wait for `/api/defaults` to return 200 before assuming the backend is up.

**Frontend-only changes**: just `npm run build` — no restart needed if Electron is already open,
just reload the window (or it'll show on next navigate in a test browser).

**Type-check with `npx tsc --noEmit -p tsconfig.app.json` from `client/`** (or just `npm run build`,
which runs `tsc -b` first and fails on type errors). `tsc -p tsconfig.json` checks NOTHING — that file
is only a list of project references. Backend tests: `.venv/Scripts/python.exe -m pytest server/tests`.

## Screens (modes) — the launcher and `modeConfig.ts`

The app opens on a launcher (`Launcher.tsx`: three cards — View ▸ Single screen / Split view, Review, and
Annotate ▸ Contrast / Non-contrast; no tabs). `main.tsx` holds the chosen `AppMode` (`types.ts`) plus the pane
count (1, or 2 for View ▸ Split view) and renders `<App mode initialPaneCount onExit>`; the original unrestricted app is still at `/#app`. Currently wired: **`view`**,
**`annotate-noncontrast`** and **`annotate-contrast`**.

- **`modeConfig.ts` is the single source of what a screen shows.** `capsFor(mode)` returns a `ModeCaps`
  (`edit`, `comment`, `reason`, `reviewMode`, `split`, `contrast`, `orientation`, `showAll`,
  `annotationLookup`, `readOnlyManifest`, `columns{reason,status,annotation,contrast}`).
  `manifestDefaultsFor(mode)` blanks the columns a mode doesn't show (blank = never read or written).
  `App` passes `caps` to `Pane`/`CaseLoader`/`KeybindSettings`; **add a capability there rather than
  sprinkling `mode === ...` checks.** A new screen = a new `ModeCaps` entry + a sketch (below).
- **View**: read-only. Manifest loads with `read_only` (no columns added to the user's file). Never looks up
  `Manual_Annotations` or contrast evidence. `caps.dropToLoad`: a file / DICOM folder dropped on the viewer asks
  "Open as" Image / Segmentation (Segmentation disabled until a CT is open) and goes through `doLoadCt` /
  `doLoadMask`, so a mismatched mask is refused with the error toast and the old one kept. The path comes from
  the preload's `pathForFile` (`webUtils.getPathForFile`; `File.path` is gone in Electron 33), and `main.js`
  blocks `will-navigate` off the app so a missed drop can't replace the page.
- **Annotate non-contrast**: `caps.edit`; no Review/Tags/Split/Contrast/Reason; Status + Annotation columns.
  Fixed 130 HU. It never writes the manifest Contrast column (blank column = never read or written).
- **Annotate contrast** (`annotate-contrast`, `caps.contrast`): same as non-contrast plus its own seed flow and
  the Contrast column. **There is no Contrast checkbox anywhere**: the threshold is per scan (from a seed),
  never a fixed 130 HU, so contrast is a property of the SCREEN. `PaneState.contrastMode` is fixed at
  `makePane` from `caps.contrast` (`/#app`, the full app, has `contrast: false` and behaves as non-contrast).
  Flow: place seed (`Set AO seed`, click near the left ostium / centre of the ascending aorta → crosshair +
  live sphere-VOI circle) → **Finalize** (mean + k·std over a voxel-count-grown VOI) → threshold / HU fields
  read-only until **Re-seed**. Painting, region-grow and the digit keys are refused until a seed is finalized
  (`annotationBlockedReason`; the amber `.pane-warning-contrast` banner says so). Scoring is a physical
  **volume (mm³)**, never Agatston (the manifest Agatston panel is hidden here).
  - **Threshold method** (Settings ▸ Contrast threshold, `useContrastSettings.method`): two formulas from the
    literature, each with its DOI linked next to the setting. `aorta-sd` (default): aortic sphere mean + k × SD
    (k = 3: Eberhard 2017, doi:10.4244/EIJ-D-17-00060; k = 2 is the SAME formula, Schuhbaeck 2015, so k is a
    number to edit, not another method). `fixed`: one HU for every scan (320: Otton 2012, doi:10.1016/j.jcct.2011.11.004),
    applied when the scan opens with no seed. Either is recorded in the scan's `contrast_seed.json` with a
    `method` field, and a scan's saved record wins over the current setting (switching method later needs
    the box's "Use N HU" / "Re-seed" button, which asks before erasing the mask).
  - **Show all is view-only here too**: the seed box and seed placement are hidden/off, Score Compute is off.
  - **Every contrast call carries the display `flip`** (`/api/contrast/compute_threshold`,
    `/api/mask/lesion_volume`; `compute_sphere_stats(..., flips)`), like paint/region-grow/lesion_score. A
    saved seed records the `flip` its click was made under and is replayed under it (`loadSavedSeed`), so it
    lands on the same voxel whatever the display is now; `PaneState.pendingSeed.flip` does the same for the
    marker and sphere, which `projectVoxelToPlaneDisplay(..., flip)` re-projects when the orientation changes.
  - **Output folder is asked up front**: as soon as the first CT of the session is up with no folder chosen
    (and no manifest `annotation_path` hint) the "No output path" prompt opens with `then: 'lookup'`; after the
    folder is chosen `reloadScanRecords` re-runs the lookup and loads the seed and saved annotation. Nothing is
    remembered across sessions. Cancelling is fine — **Finalize** asks again (`then: 'seed'`) and continues.
    `saveFolderPrompt.then` is `'save' | 'seed' | 'lookup'`.
  - **`save_sidecar` never prompts and never crosses scans**: re-seeding replaces the scan's own seed; if a
    *different* scan owns the folder name it is diverted to `<name>__N`, never written into the other scan's
    folder. It raises `SaveDirRequired` (HTTP 400) with no folder / the image's own folder.
  - **Cross-checks** (`scanRecordedAsContrast`, `NONCONTRAST_SCREEN_BLOCK`, `detectAnnotationTypeMismatch`):
    the non-contrast screen shows a banner and refuses painting when the lookup says the scan has a seed or a
    contrast-typed annotation, and re-checks right before a save (the folder is only known then); the contrast
    screen warns when the recorded type is non-contrast. The manifest Contrast flag is written only by the
    contrast screen, on Finalize.
- **Empty state** (`EmptyStateSketch.tsx`): a hand-drawn how-to per mode (`ViewArt`,
  `AnnotateNonContrastArt`, `AnnotateContrastArt` — four cards, lines kept ≤ ~23 chars so the wide handwriting font fits), swirly `Callouts` portalled to `document.body` and positioned from the real
  toolbar/Shortcuts buttons, plus `SettingsPullHandle`. Settings start closed; the close circle is
  `.settings-close-circle`. `--sketch-neon` (App.css) is the colour for anything that should catch the eye.
- **Show all** (`MultiPlaneViewer.tsx`): axial/sagittal/coronal linked through ONE voxel `(x,y,z)` (a voxel
  index in the LPS array IS a physical position: axial=z, sagittal=x, coronal=y). Per-view Ctrl+wheel zoom,
  Shift/middle-drag pan, double-click reset (state lives in `Pane`, so Reset view resets all three).
  **Editing is disabled while it is on** (`caps.edit && !pane.showAll`).
- **Display orientation** (`displayOrientation.ts`, `DisplayOrientationBox`): radiological/neurological and
  per-axis flips, **display only** (volume stays LPS). Sent as `flip` ("l"/"a"/"s" letters) to
  `/api/render`, `/api/probe` AND the editing endpoints (`paint`, `region_grow`, `lesion_score`), which undo
  the flips in `_display_to_view_coords` so a click lands on the voxel actually drawn (tested).
  `get_plane_slice(..., flips)` is the only place a flip is applied. Edge letters (R/L/A/P/S/I) show it.
- **Saving**: the folder is chosen **per session** (`useAnnotationSaveDir` no longer persists; the old
  localStorage key is deleted). First save with none chosen → "No output path" prompt (refuses the image's
  own folder, client and server). A re-save is quiet only when the mask on screen IS the saved file
  (`maskSource === 'annotation'` and same path); blank/prediction over an existing annotation still asks.
- **Alignment is blocking**: a mask must match the CT's size, position, spacing AND orientation
  (`detectGeometryMismatch` on load, `assert_same_geometry`/`alignment_problems` on the server for paint,
  region-grow and scoring). Same shape is not enough: a shifted mask draws and scores in the wrong place.
- **Scoring** (`agatston.py`, `ScoringSetupModal.tsx`, `Pane.tsx` `ensureScoringSetup`): the classic Agatston
  method, slice by slice — 2D 8-connected lesions of one label at >= 130 HU, ignored below a minimum area
  (1 mm² default), score = area x density weight of the lesion's PEAK HU, summed over slices, x (slice
  spacing / 3 mm). A clicked lesion is still picked in 3D (26-connected) but always holds whole 2D lesions, so
  lesion scores and totals agree; a total over several labels is the sum of each label's own score. The
  factor uses slice SPACING (the increment), not the thickness tag: that is what makes sums over overlapping
  slices comparable to the 3 mm standard. **Nothing scores on its own**: only a lesion click in Score Compute,
  the ▶ button, or confirming the class-total prompt. The first time a scan is scored the **scoring setup
  prompt** shows what was read (spacing; DICOM thickness/kVp/kernel, `info_dict.acquisition`), what is still
  needed, the minimum area, and the label table (name, counts-towards-CAC, add/remove; mask labels the table
  lacks are pre-added; it starts as the label set in use). It is kept in `PaneState.scoringSetup`, written to the scan's `_source.json` under
  `scoring` (`/api/scoring/record` when the folder exists, else sent with the annotation's first save) and
  read back through the lookup, so it is asked once per scan. Changing it clears the numbers computed
  under the old one. It can be reopened any time from the ⚙ in the Score Compute box or the score panel's
  "Scoring setup" link, and Score Compute rows can be removed one by one (✕) or all at once (clear). Score tiles follow the table (`ScorePanel` `labels`), not a fixed list. Contrast scans
  get the same prompt without the Agatston fields (volume above the scan's threshold).
- **Label colours**: `labelPresets.ts` (four read-only built-ins — Coronary Basic, Coronary Extended [SCCT 18-segment
  vessels and branches], Heart Calcification [coronaries + mitral/aortic annulus, valves, root, pericardium,
  myocardium], Heart and Aorta [the default] — each label carries `coronary`, which feeds the scoring table;
  user presets in localStorage,
  auto-named `user-preset`, `-2`...), `LabelColorEditor.tsx`, `InlineEdit.tsx` (double-click to edit).
  Score/lesion tile colours are looked up **by label number**, never list position. Digits 0-9 (row or numpad)
  switch the active label in edit screens; Ctrl/Shift+click in Region-grow seeds from a circle.
- **Prompts**: every modal shares one look (`.comment-modal`: short title, ≤ 1–2 lines, two big buttons —
  Cancel left, action right, red if destructive). `withUnsavedGuard` covers ← Modes, reload, and **closing
  the desktop window** (Electron `close` → `app-close-requested` IPC → the page acks and confirms; 1.5 s
  fallback so a blank page can still be closed).

- **Settings tabs** (`Pane.tsx`, `settingsTabs`): I/O (`CaseLoader`), Threshold Seed (`ThresholdSettings`, contrast screen
  only), Class Labels, Orientation (`caps.orientation`), Info. The panel has a FIXED height (46vh) so it never jumps
  between tabs. Contrast threshold UI = two stepper cards (`NumberStepper`: Sphere volume, k) with literature chips
  (`K_REFERENCES`) and a boxed formula; styles must not depend on `.case-loader` (the card lives outside it).
- **Errors** are one red toast at the bottom centre of each pane (`.error-toast`, shows `pane.error`, `pane.manifestError`
  and the contrast seed error). Never render an error inside Settings.
- **Manifest template**: the download button in the Batch Load header calls Electron's save dialog (`save-path` IPC, so
  the user picks the folder and renames) then `/api/manifest/template` (header-only `.xlsx` by default, `.csv` if chosen).
  The manifest reader tolerates cp1252/BOM CSVs and `;`/tab separators, and a manifest it cannot add its tracking
  columns to (locked in Excel) still loads.
- **Saved annotations are written on the CT's own voxel grid** (`volume_store._image_on_ct_grid`: exact permute/flip of
  the LPS array back to the CT's original orientation, header copied from the CT), so ITK-SNAP and other tools see the
  same size/direction/origin as the image. `save_mask` takes `ct_vol`; the endpoint loads it from the cache.
- "Image not found" in a manifest means the path does not exist ON THIS MACHINE (differently mapped drives such as
  `R:\standard\...` vs `R:\QIA\...`), not a reader problem. DICOM folders over Windows' 260-char path limit get an
  explicit message (`_long_path_hint`); `\?\` paths do not work with GDCM.

## Backend structure (`server/`)

- **`app.py`** — FastAPI routes. Key groups:
  - `/api/volumes/load`, `/api/volumes/{id}/info`, `/api/render`, `/api/probe` — volume
    load/cache/render/pixel-probe. `render` composites CT + mask + threshold overlay into a PNG on
    every request (no client-side caching of pixels).
  - `/api/mask/new`, `/api/mask/paint`, `/api/mask/refresh_labels`, `/api/mask/region_grow`,
    `/api/mask/save` — mask editing.
  - `/api/manifest_columns`, `/api/manifest_pairs`, `/api/manifest/comment`,
    `/api/manifest/status`, `/api/manifest/reason` — CSV/Excel
      case-manifest read/write, plus `/api/manifest/annotation_path` and `/api/manifest/contrast`.
  - `/api/annotations/lookup` — **what previous sessions already recorded about a scan**
    (annotation path, saved-at, annotation type, whether a contrast seed exists), independent of
    any UI state. Takes an optional `annotation_path` hint so the lookup doesn't depend on the save
    directory still being configured the way it was when the seed was saved.
- **`volume_store.py`** — `VolumeStore` (in-memory LRU-ish cache of loaded volumes keyed by a hash
  of the path, `+"_mask"` suffix for masks), `LoadedVolume` dataclass, slice extraction
  (`get_plane_slice`), mask painting/region-growing, PNG compositing (`render_composited_png` —
  uses `compress_level=1` deliberately, since it's re-encoded on every request including every
  brush dab). `store.load(path, is_mask, force)` — `force=True` bypasses the cache and re-reads
  from disk (used by the reload shortcut and Reset).
  - **`save_mask(mask_vol, ct_path, ...)` is atomic and conflict-aware**: it resolves its
    destination through `annotation_paths.resolve_target`, returns `{"status": "conflict", ...}`
    without writing when something is already there, and otherwise writes via a temp file +
    `os.replace` (`_atomic_write_image`). It used to write straight over the destination, so a
    crash or the Electron shutdown kill mid-write truncated the file with the previous good
    version already gone. Never regress to a direct `sitk.WriteImage(img, out_path)`.
  - **`assert_same_geometry(mask_vol, ct_vol)`** is called by `paint_mask` and `region_grow_mask`
    (and by the scoring endpoints in `app.py`). Nothing checked this before: `get_plane_raw_view`
    clamps the slice index against *each volume independently*, so a mask with fewer slices than
    the CT didn't error — viewing CT slice 200 and painting wrote the mask's **last** slice and
    saved it. A loud failure is the only safe behavior; a silent partial write is worse than none.
  - **The LRU never evicts unsaved work** (`_evict_locked`): a volume with `is_new_mask` or
    `dirty=True` is skipped, and the cache is allowed to grow rather than drop it. A brand-new mask
    exists *only* in this cache; evicting it destroyed the annotation and the client only found out
    when the next paint 404'd. `dirty` is set by `paint_mask`/`region_grow_mask` and cleared by a
    successful save.
- **`folder_scan.py`** — the manifest (CSV/XLSX) system. `list_manifest_pairs()` reads the sheet,
  auto-creates `Status`/`Comment`/the configured reason column if missing, returns rows + reason
  options + which `*_Agatston` score columns are present. Only `image_column` is required — `mask_
  column`, `patient_id_column`, and `reason_column` are all independently optional (falsy/"-- none
  --" means "don't track this"), so a CT-only manifest with no mask/PatientID/Reason column still
  loads. `status_column`, `annotation_column` and `contrast_column` are configurable the same way
  (`annotation_column`/`contrast_column` are auto-created if absent — an annotation with nowhere to
  be recorded is how a whole session's work went missing). `reason_column` may point at any
  pre-existing column (e.g. a lab's `kernel_type` column
  repurposed as Reason tags) instead of the app's own default `"Reason"` name; `include_default_
  reason_tags` controls whether the built-in tag set (Mislabel, Artefacts, etc.) is merged into
  the picker's options alongside whatever's already in that column — off by default use case is a
  reason column whose existing values have nothing to do with those built-in tags. `image_exists`/
  `mask_exists` use `os.path.exists` (not `isfile`) since both columns may point at a DICOM series
  directory, not just a NIFTI/MHA file (see `volume_store.py`'s `_is_dicom_dir`, which treats any
  directory as one). `save_comment`/`save_status`/`save_reason`/`save_annotation_path`/
  `save_contrast_flag` all go through `_save_cell`.
  - **Excel is edited in place, not rewritten** (`_set_cells_in_place`, openpyxl). The old
    read-with-pandas / write-with-pandas round trip rebuilt the workbook from a DataFrame, which
    **deleted every other sheet**, lost formatting and formulas, and re-inferred values. `_write_table`
    (the full rewrite) is now the CSV path and a last-resort fallback only — don't route Excel saves
    back through it.
  - **`_read_table` reads every cell as text** (`dtype=str`). Without it pandas infers a dtype per
    column and a PatientID of `007` comes back as the integer `7`, so the app displayed and matched
    on the wrong value even though the cell on disk was fine. Only the score columns need numbers and
    `_score_value` parses those itself.
  - **`_ensure_tracking_columns` creates missing columns but never rewrites existing values.** It
    used to replace every Status cell whose value wasn't one of the app's four options with
    "Not Started", so opening a manifest whose Status column meant something else to the lab wiped it
    before the user had done anything. Unknown values are merged into the options instead
    (`_collect_status_options`), the same way reason tags are.
  - Both `_write_table` and `_write_workbook_atomically` write to a per-call-unique temp file
    (`.tmp_<pid>_<threadid>_<random>_<basename>`) in the same directory, then `os.replace()`. The
    uniqueness matters because FastAPI runs sync `def` endpoints in a threadpool, so two saves
    landing close together (e.g. the Copy-to-other-pane button) really do write concurrently; a
    shared temp filename previously let them corrupt each other mid-write. Never regress this.
- **`pathutil.py`** — `clean_path()`, small path normalization helper used everywhere a path comes
  from the frontend or a manifest cell.
- **`annotation_paths.py`** — **where a saved annotation goes, and whether saving there would
  destroy something.** Every annotation lives in its own per-scan folder:
  `<root>/Manual_Annotations/<scan folder>/annotation.nii.gz`, alongside `_source.json`
  (provenance) and, for contrast scans, `contrast_seed.json`. `<root>` is the save directory the
  user chose — **there is no default and never the image's own folder**: `annotation_root()` returns
  `None` without one, `resolve_target()`/`save_mask()` then return `needs_save_dir` (reason `missing` or
  `same_as_image`) and write nothing, and the client asks (see "Screens"). `<scan folder>` is the DICOM
  SeriesInstanceUID, or the NIFTI/MHA stem. **The name is derived from the CT, never from the
  loaded mask** — deriving it from the mask made every save append another tag
  (`X_ManualAnnotations_ManualEdits...`) and orphan the previous file.
  - **No date in the folder name.** An earlier version used one folder per day
    (`Manual_Annotations_<DD_Mon_YYYY>`), which split a single scan's work across several
    directories, so "where is this scan's annotation" had more than one answer. The dates live in
    `_source.json` instead (`created_at`, `updated_at`, and a `saves` entry per save), which is
    both more precise and in one place. `legacy_dated_folder_name()`/`is_legacy_dir()` exist only
    so folders written by the old scheme are still *found* — they are never written to again, and
    a scan whose only copy is in one reports the `"earlier"` conflict.
  - **`annotation_dir(root)` returns `root` itself when `root` is already a Manual_Annotations
    folder** (case-insensitive). Pointing the save directory straight at an existing
    Manual_Annotations folder is the obvious thing for a user to do; without this every such pick
    would nest another one inside and hide everything already there. `find_existing_scan_dirs()`
    must go through it for the same reason — searching one level too deep finds nothing and treats
    every existing annotation as new.
  - `resolve_target()` reports a `conflict` of `None` / `"overwrite"` (same scan, same file) /
    `"earlier"` (same scan, only a legacy dated copy) / `"collision"` (a *different* scan already
    owns this folder name) and **writes nothing** — the caller asks the user and calls back with
    `resolution="overwrite"` or `"new_copy"`. A folder name alone cannot tell a re-save from a
    collision, which is exactly why `_source.json` exists; `_same_scan()` decides by
    SeriesInstanceUID when both have one, else by CT path.
  - `find_existing_scan_dirs()` also matches the **`__2`/`__3` variants** — once a collision
    diverted a scan into `<name>__2`, that is its folder from then on, and not searching it would
    make it collide with the original on every save and spawn `__3`, `__4`, ... forever.
  - `write_source_record()` keeps two things the plain fields cannot, because the record is
    rewritten on every save: **`original_mask_path` is write-once** (and never the annotation's own
    file), so re-editing your own saved work doesn't erase the fact that it started from a model
    prediction; **`saves`** is one entry per save (timestamp, what it was loaded from, `mask_source`,
    labels, voxel count), capped at `MAX_SAVE_HISTORY`. Together they replace what the dated folders
    used to convey by accident.
- **`contrast_threshold.py`** — per-scan calcium-detection threshold
  for contrast CT, in place of the fixed 130 HU used for non-contrast. `compute_sphere_stats()`
  takes a seed click (converted to a 3D index via `volume_store._seed_index_3d`, with the click's display `flips`) and
  **grows a VOI outward from it by voxel count, not a fixed radius**: it computes
  `target_voxel_count = round(target_volume_mm3 / voxel_volume)`, ranks every candidate voxel in a
  generously-sized search box by physical distance from the seed, and takes exactly that many
  closest ones — so `actual_volume_mm3` always lands within one voxel's volume of the target,
  regardless of seed position or how coarse/anisotropic the spacing is. (An earlier version picked a
  single formula-derived radius `r=(3V/4π)^(1/3)` and accepted whatever voxel count that radius
  happened to enclose — this could miss the target by 10%+ once the sphere was only a few voxels
  across, since the count is very sensitive to exactly where the grid boundary falls relative to the
  seed. Don't regress to that.) The *emergent* radius (the farthest included voxel's actual
  distance) is what's returned as `radius_mm` and used for the sphere-VOI preview circle, not the
  formula radius. Returns `threshold_hu = mean + k*std` (`k` default 3) over the selected voxels'
  HU values. `save_sidecar`/`load_sidecar` persist/read `contrast_seed.json` **inside the scan's own
  annotation folder** (`annotation_paths`), atomically. It used to be `<stem>_contrast_seed.json`
  next to the CT — a name derived from the image's basename, so two patients whose CTs were both
  `image.nii.gz` shared one sidecar and the second scan silently loaded the first one's threshold.
  `load_sidecar` still finds the old locations so existing seeds aren't stranded. `compute_lesion_volume_mm3`/`compute_volume_total_mm3` are the contrast-mode
  scoring functions — physical mm³, **no Agatston density weighting** — reusing
  `agatston.find_lesion_component` for lesion isolation (that function is generic; weighting only
  happens in `agatston.compute_agatston_score`, which contrast mode never calls). Watch the
  axis-order gotcha: `LoadedVolume.array` is `(z,y,x)` but `spacing_lps` is `(x,y,z)` — they do NOT
  line up positionally, see the comment at the top of `compute_sphere_stats`.

## Frontend structure (`client/src/`)

- **`App.tsx`** — top-level state: the `panes` array (1 or 2 `PaneState` objects — `panes.length`
  is capped at 2 via `addSplit`), split-view sync toggles (`linked`/"Interaction",
  `syncNavByPatientId`/"Iteration"), global Review mode state (`reviewModeOn`, `reviewTags`,
  `reviewParentPaneId`), keybinds, and the case-navigation logic (`navigate`, `goToPosition`,
  `loadRowIntoPane`, `reloadPane`).
  - **`loadRowIntoPane` is the ONLY correct way to load a manifest row** — it prefers the row's
    saved `annotation_path` over the original `mask_path`, checks CT/mask geometry, and applies
    whatever is recorded about the scan being contrast-enhanced. `CaseLoader` reaches it through the
    `onLoadRow` prop; it used to call `onLoadCt`/`onLoadMask` directly for the first case after a
    manifest load, which silently took a different route from every subsequent case.
  - **`applyContrastEvidence`** runs on *every* CT load regardless of whether contrast mode is on,
    and decides from recorded evidence (a saved seed, a previous annotation's own type, or the
    manifest's contrast column) — not from the checkbox. It **returns the lookup**, and both
    callers use it to reload the scan's saved annotation as well as its seed: `loadRowIntoPane`
    falls back to it when the manifest row has no `annotation_path`, and `Pane.loadCtEntry` relies
    on it entirely. Reloading an annotation was once driven *solely* by the manifest column while
    the seed went through the lookup — two different mechanisms for the same job — so a scan loaded
    outside a manifest (a DICOM directory, or stepping between series) came back with its seed
    restored and **no segmentation at all**. Keep both on the one mechanism. That check used to be gated behind
    `pane.contrastMode`, so a contrast scan opened without ticking the box was silently annotated
    against the fixed 130 HU threshold. It also clears per-scan contrast state so a threshold can
    never carry into the next case.
  - **`withUnsavedGuard(paneIds, what, action)`** wraps every App-level action that can destroy an
    in-memory mask — the reload-from-disk shortcut and cross-pane Patient-ID sync, neither of which
    used to ask at all (the guard only ever ran for the pane the user clicked in).
  - `CASE_RESET` is the single list of what a case change must clear. Add to it rather than
    scattering resets. `updatePane(id, partial)` is the single mutator; it also
  handles cross-pane sync for a fixed set of `syncKeys` (`plane`, `index`, `zoom`, `wlMinimized`,
  `showMask`, `thresholdEnabled`) when `linked` is on.
- **`types.ts`** — `PaneState` (the full per-pane state shape), `ManifestRow`, keybind types
  (`KeybindActionId`, `KeybindMap`, `DEFAULT_KEYBINDS`), constants (
  `STATUS_OPTIONS`, the scoring types, window presets, calcification label-color preset).
- **`api.ts`** — every backend call as a typed async function. `renderUrl()` builds the
  `/api/render` query string from a pane's current render params (window/level, mask colors,
  threshold, `editVersion` as a cache-buster).
- **`components/Pane.tsx`** (~1400 lines, the biggest file) — one CT viewport: toolbar, image
  viewer, mask painting/region-grow, Window/Level box, Score panel, case comment/reason UI,
  keyboard shortcut handling (`useEffect` + `window.addEventListener('keydown', ...)`, gated on
  `isActive` — "whichever pane you last clicked into").
  - **The unsaved-work guard tests `hasUnsavedMaskChanges`, never `editMode`.** `editMode &&
    maskInfo` both cried wolf when nothing had changed and stayed silent whenever edit mode had
    been switched off with edits pending — which seed placement, Re-seed and Score-compute mode all
    do on their own. `hasUnsavedMaskChanges`/`maskBaselineVersion`/`lastSavedAt` live on
    `PaneState` (not in the component) precisely so `App.tsx` can check them before loading
    something over the top.
  - `doSaveMask(resolution?)` handles the conflict round trip: a `status: "conflict"` response
    opens `saveConflict`'s modal and **nothing has been written**; the user's answer is passed back
    as `resolution`. The conflict modal suppresses the "Before you move on..." modal while it is
    open, or the two stack on top of each other.
  - `annotationBlockedReason()` refuses painting/region-grow on a contrast scan with no finalized
    threshold, instead of quietly drawing labels against 130 HU.
  - Seed finalize / Re-seed / saved-seed reload (`finalizeSeed`, `reSeed`, `loadSavedSeed`) live here; there is
    no contrast toggle. Per-pane keyboard shortcuts (toggle mask,
  toggle threshold, prev/next slice, toggle review mode) live here; **global** shortcuts that
  should apply regardless of which pane is active (reload-from-disk, in split view) live in
  `App.tsx`'s own `window.addEventListener` instead.
- **`components/CaseLoader.tsx`** — manifest file picker + column-mapping UI + case dropdown, and
  the batch-load flow (`selectRow` sequentially awaits CT then mask load — never fire both
  concurrently, that previously caused the loading indicator to clear early).
- **`components/ScorePanel.tsx`**, **`ReasonPicker.tsx`**, **`ReviewTagsPicker.tsx`**,
  **`MaskEditor.tsx`**, **`KeybindSettings.tsx`**, **`InfoPanel.tsx`**, **`LabelColorEditor.tsx`**,
  **`LabelSelect.tsx`**, **`AlphaSpinner.tsx`** — smaller focused pieces, names are self-describing.
- **`useKeybinds.ts`** — persists `KeybindMap` to `localStorage`.
- **`useContrastSettings.ts`** — same localStorage-hook pattern as
  `useKeybinds.ts`, persists the contrast threshold's target VOI volume (mm³) and k-multiplier
  defaults, edited in Settings (Contrast screen: "Seed sphere volume (mm³) / k").
- **`components/ContrastSeedBox.tsx`** — seed placement + computed
  threshold display, lives in `.viewer-left-controls` alongside the W/L box. See feature inventory
  below.

## Conventions / established patterns worth following

- **PaneState is per-pane** unless a setting is explicitly meant to feel identical across split
  view (e.g. Review mode is intentionally *global* app state, not per-pane — see below). When
  adding a new per-pane toggle, decide up front whether split view should sync it via
  `updatePane`'s `syncKeys` list or keep it independent (mask editing state is deliberately never
  synced).
- **Manifest writes are atomic and must stay that way.** Any new manifest-column feature should go
  through `_save_cell`/`_write_table` in `folder_scan.py`, not a bespoke write path.
- **Loading state**: `pane.loading` (bool) + `pane.loadingMessage` (phase text, e.g. "Loading
  mask...") drive both a small toolbar spinner tag and a large centered overlay. Set both together;
  clear both together on every success/error path.
- **Keyboard shortcuts** are data-driven through `KeybindActionId`/`KEYBIND_LABELS`/
  `DEFAULT_KEYBINDS` in `types.ts` + `ACTION_ORDER` in `KeybindSettings.tsx`, not hardcoded key
  checks — add new shortcuts to all three places so they show up in the Shortcuts settings UI and
  are user-remappable.
- **Confirmation modal reuse**: the "Before you move on..." unsaved-mask-edits modal
  (`navModalDirection`/`jumpPos` state in `Pane.tsx`) is shared by Previous/Next and the
  jump-to-case-number box — extend its existing state rather than adding a parallel modal.
- **Error popups** for user-input validation (e.g. invalid case number) reuse the
  `.comment-modal-backdrop`/`.comment-modal` CSS classes, not a new modal system.
- Frontend build artifacts (`client/dist`) are committed-adjacent but regenerated by `npm run
  build` — always rebuild after a source change before testing in the Electron window or a test
  browser.
- When testing via the in-tool browser against `http://127.0.0.1:8000`, remember Electron must
  already be running (it serves both the API and the static frontend on that port) — there's no
  separate Vite dev server to point at.
- Scratch test manifests/CSVs for manual testing go in `sample_data/` and should be deleted after
  use; `sample_data/CASE001/` (a small synthetic 128×128×40 volume) and `sample_data/manifest.csv`
  /`.xlsx` are the persistent fixtures, not scratch files.
- Git commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (or
  whichever model attribution the session's system reminder specifies).

## Feature inventory (so a fresh session doesn't need to rediscover these)

- **CT path field keeps what the user chose** (`PaneState.ctInputPath`), separate from `ctPath`, the scan that
  loaded. A DICOM folder search resolves to one series sub-folder; that used to overwrite the field, so pressing
  Load again only ever saw that one series. Load now always searches `ctInputPath`, and `CaseLoader`'s
  `PathField` shows the resolved remainder after it in grey (not part of the value).
- **Manifest-driven batch loading** with configurable image/mask/PatientID/Reason column names, only
  `image_path` required — mask/PatientID/Reason columns each have a "-- none --" option in
  `CaseLoader.tsx`'s column pickers and are skipped entirely if absent (no mask column ⇒ CT-only
  batch loads fine; no PatientID ⇒ label falls back to the image filename). Prev/Next case
  navigation and an editable case-counter box (type a number, Enter, jumps straight there; invalid
  input shows an error popup) — all in `Pane.tsx`'s toolbar + `App.tsx`'s `goToPosition`. Both
  `image_path` and `mask_path` accept a DICOM series directory as well as a NIFTI/MHA file.
- **Status** (dropdown: Not Started/Annotated/InProgress/Review) and **Reason** (multi-select tag
  picker, session-addable custom tags, Excel in-cell dropdown on save) columns, auto-created on
  manifest load if missing. The Reason column name is itself configurable (`reasonColumn` in
  `ManifestConfig`) — it can point at a pre-existing column that already means something else in the
  lab's sheet (e.g. `kernel_type`) instead of the app's own default `"Reason"` name, and an
  **"Include defaults"** checkbox next to the "Reason column" label (`CaseLoader.tsx`) controls
  whether the built-in tag set (Mislabel, Artefacts, etc.) gets merged into that column's options —
  turn it off when the column's existing values have nothing to do with those defaults. If Reason
  is set to "-- none --" *and* "Include defaults" is off, the Reason button itself is hidden from
  the pane toolbar (`Pane.tsx`) rather than shown disabled/empty.
- **Reason tag picker sorts by usage frequency**, snapshotted when opened (not live-recomputed
  while open, to avoid reordering under the user's cursor mid-click) — see `computeReason
  OptionsByFrequency`/`reasonOptionsSnapshot` in `Pane.tsx`.
- **Score panel**: per-class Agatston scores from `<CLASS>_Agatston` manifest columns (standard names), shown only
  for classes actually present, grouped (coronary/aorta/valve/other), 2-decimal + thousands-separator
  formatting, draggable, collapsible with fixed-size rail buttons regardless of open/collapsed
  state, anchored bottom-center by default.
- **Split view** (max 2 panes): "Interaction" (sync plane/index/zoom/W-L-minimized/mask-toggle/
  threshold-toggle across panes), "Iteration" (sync Prev/Next by matching Patient ID across panes).
- **Copy ⇄ button**: copies the active pane's Comment+Reason onto whatever case is active in the
  other pane and saves it to that pane's manifest (sequential saves, not concurrent — see the
  atomic-write note above for why).
- **Review mode** (global, not per-pane): toggle in the app header + a Reason-tag multi-select
  ("Tags" button) picks which tags count; Previous/Next then only stop on matching cases. In split
  view, a "Review pane: Left/Right" selector designates which pane's Reason data drives the
  skip-ahead search — the other pane navigates normally and only follows via Iteration sync if
  that's also on, rather than both independently jumping to unrelated cases.
- **Reload-from-disk shortcut** (default Ctrl+Shift+R, customizable): force-reloads the current
  CT/mask bypassing the backend cache without resetting slice/plane/zoom; reloads **both** panes in
  split view (it's a global App-level listener, not per-pane-scoped).
- **Mask editing**: brush + region-grow tools, overwrite modes (any/label/threshold), undo via
  `editVersion` counter, save/reset, never synced between split-view panes.
- **Mask sanity check on load** (`types.ts`): `detectGeometryMismatch` is **exact and blocking** — a mask
  whose size, position, spacing or orientation differs from the CT's is refused outright, because slice
  indices are clamped per-volume and painting one would silently write to the wrong slice. There is
  deliberately no "does this look like a CT" heuristic any more (it guessed, and false-positived on
  whole-heart masks whose label values run 205…850). The one server-side check (`_assert_looks_like_mask`)
  refuses only what can't be a label map — negative or fractional values, or > `MAX_MASK_LABELS` distinct
  values — so a CT opened as a segmentation errors instead of becoming thousands of "labels".
- **Annotation saving/reloading**: one folder per scan under `Manual_Annotations/` (see
  `annotation_paths.py` — no date in the name; the dates are in `_source.json`), reloaded
  automatically whenever that scan is opened again — through the manifest's `annotation_path`
  column when there is one, and otherwise straight from `/api/annotations/lookup`, so it works for
  a plain DICOM-directory load and for series Previous/Next too; a prompt rather than a silent
  overwrite in every conflict case (same scan / only a legacy dated copy / a different scan with
  the same name), the saved path recorded in the manifest's own `annotation_path` column, and a
  toolbar tag saying whether you are looking at **your annotation**, the **original prediction**,
  or a **new, unsaved** mask — plus "• unsaved edits" when it has diverged from disk. A save can
  never land on a model prediction: the destination is derived from the CT, and predictions live
  wherever the lab put them. `_source.json` keeps the lineage (`original_mask_path` write-once,
  plus a `saves` history), so "what was this derived from" survives re-editing your own work.
- **Contrast screen** (see "Screens (modes)" for the flow, flips, folder and cross-check rules): the seed
  and its threshold live in `contrast_seed.json` inside the scan's annotation folder; loading a CT looks for
  one, recomputes fresh from the current volume to apply and verify it (a mismatch beyond a small tolerance
  shows a warning rather than trusting the saved number), and otherwise leaves the threshold unset until a
  seed is finalized. Finalizing also writes the manifest Contrast flag when that column is enabled.
  Score Compute mode computes a physical **volume (mm³)** instead of an Agatston score on the contrast screen (no manifest-baseline/confirm-total step per lesion click, since there's no
  `<CLASS>_Agatston`-style baseline for a volume metric — always computed fresh); its box also gets a
  **▶ play button** (`computeAllVolumeScores` in `Pane.tsx`) that recomputes the total volume for
  every class (CAC/TAC/AV/MV) across the whole scan at once and opens the Score panel to show them.
  `ScorePanel.tsx` itself was generalized to take a plain `scores` map instead of a `ManifestRow`, so
  the same component renders both the manifest-backed Agatston tiles (non-contrast) and the
  freshly-computed volume tiles (contrast, from `pane.volumeScores`) — don't reintroduce a
  `ManifestRow`-typed prop there.

## Known caveats

- Repeatedly hard-killing Electron/Python (`taskkill /F`) mid-write used to corrupt manifest files
  and annotation files; **every write the app makes is now atomic** (manifest cells, annotation
  images, `_source.json`, seed sidecars), so a kill leaves the previous version intact. Still
  prefer waiting for in-flight saves to settle when possible.
- `electron/main.js` takes a single-instance lock and probes port 8000 before spawning Python. A
  second launch used to leave its uvicorn unable to bind while its window silently attached to the
  *first* copy's backend — two windows on one volume cache, and closing either killed the server
  for both.
- openpyxl preserves other sheets, formatting and formulas, but it is not perfectly lossless:
  charts, images and pivot tables can be dropped on save. Manifests here are plain single-sheet
  exports (sometimes with extra columns the app ignores), which is what this is designed for. If
  that ever changes, the alternative is to stop writing to the user's sheet entirely and keep
  status/comment/reason in a sidecar.
- `/api/render` recomposites the full PNG server-side on every request; it's fast (~15ms) against
  the small synthetic test volume, but scales with slice pixel count — full-resolution real
  clinical volumes will be slower, especially with several mask labels active.
- `.case-nav-tabs` (the centered Prev/Next/Comment/Reason button row) uses `transform:
  translateX(-50%)` to center itself, which creates its own CSS stacking context — any popup nested
  inside it (e.g. the Reason picker) needs `.case-nav-tabs` itself to carry a `z-index` at least as
  high as the viewer's own overlays (score panel, jump marker, label-select menu, up to z-index 10),
  otherwise the whole transformed box paints underneath them regardless of the popup's own z-index.
  Currently `z-index: 25` on `.case-nav-tabs` in `App.css`; bump it further rather than the popup's
  own z-index if a new viewer overlay ever needs a higher one.
- **Floating viewer boxes that pin both `top` and `bottom` (`.viewer-bottom-right`,
  `.viewer-score-compute-box`) silently swallow clicks in their empty space.** Setting both `top` and
  `bottom` (with no explicit `height`) makes the container stretch to fill that whole band regardless
  of how short its actual visible content is — and since it's a real DOM element, pointer events
  still hit-test against that full empty area, not just the visible box. This silently ate clicks
  meant for the CT image underneath (e.g. contrast-mode seed placement) whenever they landed in the
  box's "empty" zone below its content. Both containers now have `pointer-events: none` with
  `pointer-events: auto` restored on their direct children (`.viewer-bottom-right > *`,
  `.viewer-score-compute-box > *`) — any *new* fixed-band floating container needs the same treatment,
  or it'll reintroduce dead click zones over the image.
