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

**Always run `npx tsc --noEmit -p tsconfig.json` from `client/` before building**, to catch type
errors that `vite build` alone can surface less clearly.

## Backend structure (`server/`)

- **`app.py`** — FastAPI routes. Key groups:
  - `/api/volumes/load`, `/api/volumes/{id}/info`, `/api/render`, `/api/probe` — volume
    load/cache/render/pixel-probe. `render` composites CT + mask + threshold overlay into a PNG on
    every request (no client-side caching of pixels).
  - `/api/mask/new`, `/api/mask/paint`, `/api/mask/refresh_labels`, `/api/mask/region_grow`,
    `/api/mask/save` — mask editing.
  - `/api/manifest_columns`, `/api/manifest_pairs`, `/api/manifest/comment`,
    `/api/manifest/status`, `/api/manifest/reason`, `/api/manifest/mask_path` — CSV/Excel
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
  directory as one). `save_comment`/`save_status`/`save_reason`/`save_mask_path`/`save_annotation_path`/
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
  `<root>/Manual_Annotations_<DD_Mon_YYYY>/<scan folder>/annotation.nii.gz`, alongside
  `_source.json` (provenance) and, for contrast scans, `contrast_seed.json`. `<root>` is the
  configured save directory, or the CT's own directory when none is set. `<scan folder>` is the
  DICOM SeriesInstanceUID, or the NIFTI/MHA stem. **The name is derived from the CT, never from the
  loaded mask** — deriving it from the mask made every save append another tag
  (`X_ManualAnnotations_ManualEdits...`) and orphan the previous file. `resolve_target()` reports a
  `conflict` of `None` / `"overwrite"` (same scan, today's file) / `"earlier"` (same scan, an
  earlier day) / `"collision"` (a *different* scan already owns this folder name) and **writes
  nothing** — the caller asks the user and calls back with `resolution="overwrite"` or
  `"new_copy"`. A folder name alone cannot tell a re-save from a collision, which is exactly why
  `_source.json` exists; `_same_scan()` decides by SeriesInstanceUID when both have one, else by CT
  path. `find_existing_scan_dirs()` searches **all** dated folders and **also the `__2`/`__3`
  variants** — once a collision diverted a scan into `<name>__2`, that is its folder from then on,
  and not searching it would make it collide with the original on every save and spawn `__3`,
  `__4`, ... forever. Don't regress either of those.
- **`contrast_threshold.py`** (contrast-viewer branch only) — per-scan calcium-detection threshold
  for contrast CT, in place of the fixed 130 HU used for non-contrast. `compute_sphere_stats()`
  takes a seed click (converted to a 3D index via `volume_store._seed_index_3d`, reused as-is) and
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
  (`KeybindActionId`, `KeybindMap`, `DEFAULT_KEYBINDS`), constants (`DEFAULT_REASON_TAGS`,
  `STATUS_OPTIONS`, `SCORE_CLASSES`, window presets, calcification label-color preset).
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
  - The Contrast CT toggle's logic lives here (`requestContrastToggle`/`applyContrastToggle`), not
    in `MaskEditor` — it can unload an edited mask, so it has to be able to ask first. Per-pane keyboard shortcuts (toggle mask,
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
- **`useContrastSettings.ts`** (contrast-viewer branch only) — same localStorage-hook pattern as
  `useKeybinds.ts`, persists the contrast threshold's target VOI volume (mm³) and k-multiplier
  defaults (used to seed `ContrastSeedBox`'s inputs, still overridable per placement).
- **`components/ContrastSeedBox.tsx`** (contrast-viewer branch only) — seed placement + computed
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
- **Score panel**: per-class Agatston scores from `<CLASS>_Agatston` manifest columns, shown only
  for classes actually present, grouped (coronary/aorta/valve), 2-decimal + thousands-separator
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
- **Annotation saving/reloading**: one folder per scan under `Manual_Annotations_<date>/` (see
  `annotation_paths.py`), reloaded automatically whenever that scan is opened again — through the
  manifest's `annotation_path` column when there is one, and otherwise straight from
  `/api/annotations/lookup`, so it works for a plain DICOM-directory load and for series
  Previous/Next too; a prompt rather than a silent overwrite in all three conflict cases
  (same scan today / same scan an earlier day / a different scan with the same name), the saved
  path recorded in the manifest's own `annotation_path` column, and a toolbar tag saying whether
  you are looking at **your annotation**, the **original prediction**, or a **new, unsaved** mask —
  plus "• unsaved edits" when it has diverged from disk.
- **Contrast CT mode** (contrast-viewer branch only, per-pane toggle **inside the Annotation
  floating window** — `MaskEditor.tsx`'s `contrastToggle`, not the pane toolbar — `pane.contrastMode`):
  non-contrast's fixed 130 HU threshold doesn't apply to contrast scans, so this derives one per scan
  instead. Toggle **"Set AO seed"**, click near the left ostium/center of ascending aorta (cursor
  becomes a crosshair while this mode is active) — this only records a candidate (`pane.pendingSeed`)
  and shows a crosshair marker (`.seed-marker`) plus a **live sphere-VOI preview circle**
  (`.seed-sphere-circle`, radius computed client-side straight from the target-volume setting via
  `sphereRadiusMmFromVolume` — no backend round-trip needed for the preview) so you can see the
  coverage before committing; it does **not** compute anything yet, since the user may need several
  tries to find the right spot. Click **Finalize Seed** to actually sample the sphere VOI and derive
  `threshold = mean + k*std` (`server/contrast_threshold.py`); the result is saved to a JSON sidecar
  next to the CT and mirrored into `pane.thresholdValue`/`editThresholdMin`/
  `editRegionGrowThreshold` (+ `thresholdEnabled: true`) all at once, then those three fields become
  **read-only** ("fixed for the session") until **Re-seed** is clicked. Loading a CT while contrast
  mode is on auto-checks for a saved sidecar and, if found, recomputes fresh from the current volume
  to both apply and verify it (a mismatch beyond a small tolerance shows a warning banner rather than
  silently trusting the saved number); if no sidecar exists for the new scan, the threshold fields
  reset to the plain 130 HU default rather than carrying over whatever the previous case left locked.
  **Contrast-ness is detected, not remembered by the user**: every CT load checks for a saved seed,
  a previous annotation's recorded type, and the manifest's `Contrast` column, and turns contrast
  mode on itself. If a scan is known to be contrast but has no seed yet, a banner says so and
  painting/region-grow are refused until one is finalized. Finalizing a seed writes the manifest
  flag too, so the next session knows before loading.
  Score Compute mode computes a physical **volume (mm³)** instead of an Agatston score for contrast
  panes (no manifest-baseline/confirm-total step per lesion click, since there's no
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
