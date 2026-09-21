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
    case-manifest read/write.
- **`volume_store.py`** — `VolumeStore` (in-memory LRU-ish cache of loaded volumes keyed by a hash
  of the path, `+"_mask"` suffix for masks), `LoadedVolume` dataclass, slice extraction
  (`get_plane_slice`), mask painting/region-growing, PNG compositing (`render_composited_png` —
  uses `compress_level=1` deliberately, since it's re-encoded on every request including every
  brush dab). `store.load(path, is_mask, force)` — `force=True` bypasses the cache and re-reads
  from disk (used by the reload shortcut and Reset).
- **`folder_scan.py`** — the manifest (CSV/XLSX) system. `list_manifest_pairs()` reads the sheet,
  auto-creates `Status`/`Comment`/the configured reason column if missing, returns rows + reason
  options + which `*_Agatston` score columns are present. Only `image_column` is required — `mask_
  column`, `patient_id_column`, and `reason_column` are all independently optional (falsy/"-- none
  --" means "don't track this"), so a CT-only manifest with no mask/PatientID/Reason column still
  loads. `reason_column` may point at any pre-existing column (e.g. a lab's `kernel_type` column
  repurposed as Reason tags) instead of the app's own default `"Reason"` name; `include_default_
  reason_tags` controls whether the built-in tag set (Mislabel, Artefacts, etc.) is merged into
  the picker's options alongside whatever's already in that column — off by default use case is a
  reason column whose existing values have nothing to do with those built-in tags. `image_exists`/
  `mask_exists` use `os.path.exists` (not `isfile`) since both columns may point at a DICOM series
  directory, not just a NIFTI/MHA file (see `volume_store.py`'s `_is_dicom_dir`, which treats any
  directory as one). `save_comment`/`save_status`/`save_reason`/`save_mask_path` each do a full
  read-modify-write of the sheet via `_save_cell`. **`_write_table` is atomic**: writes to a
  per-call-unique temp file (`.tmp_<pid>_<threadid>_<random>_<basename>`) in the same directory,
  then `os.replace()`s it into place — this uniqueness matters because FastAPI runs sync `def`
  endpoints in a threadpool, so two saves landing close together (e.g. the Copy-to-other-pane
  button) really do write concurrently; a shared temp filename previously let them corrupt each
  other mid-write. Never regress this to a shared/non-unique temp name.
- **`pathutil.py`** — `clean_path()`, small path normalization helper used everywhere a path comes
  from the frontend or a manifest cell.
- **`contrast_threshold.py`** (contrast-viewer branch only) — per-scan calcium-detection threshold
  for contrast CT, in place of the fixed 130 HU used for non-contrast. `compute_sphere_stats()`
  takes a seed click (converted to a 3D index via `volume_store._seed_index_3d`, reused as-is),
  samples a physical sphere VOI (default 200 mm³, solved directly as `r=(3V/4π)^(1/3)` — not an
  iterative grow, since there's no threshold/connectivity gating on this op, unlike
  `region_grow_mask`), and returns `threshold_hu = mean + k*std` (`k` default 3) over that sphere's
  voxels **inclusive of boundary voxels** (`<=` not `<`). `save_sidecar`/`load_sidecar` persist/read
  a `<stem>_contrast_seed.json` file next to the CT (atomic write, same convention as
  `folder_scan._write_table`) so a later session can reload the seed and recompute+verify instead of
  re-placing it. `compute_lesion_volume_mm3`/`compute_volume_total_mm3` are the contrast-mode
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
  `loadRowIntoPane`, `reloadPane`). `updatePane(id, partial)` is the single mutator; it also
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
  `isActive` — "whichever pane you last clicked into"). Per-pane keyboard shortcuts (toggle mask,
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
- **Contrast CT mode** (contrast-viewer branch only, per-pane toggle in the toolbar,
  `pane.contrastMode`): non-contrast's fixed 130 HU threshold doesn't apply to contrast scans, so
  this derives one per scan instead. Toggle **"Set AO seed"**, click near the left ostium/center of
  ascending aorta — this only records a candidate (`pane.pendingSeed`) and shows a crosshair
  (`.seed-marker`), it does **not** compute anything yet, since the user may need several tries to
  find the right spot. Click **Finalize Seed** to actually sample the sphere VOI and derive
  `threshold = mean + k*std` (`server/contrast_threshold.py`); the result is saved to a JSON sidecar
  next to the CT and mirrored into `pane.thresholdValue`/`editThresholdMin`/
  `editRegionGrowThreshold` (+ `thresholdEnabled: true`) all at once, then those three fields become
  **read-only** ("fixed for the session") until **Re-seed** is clicked. Loading a CT while contrast
  mode is on auto-checks for a saved sidecar and, if found, recomputes fresh from the current volume
  to both apply and verify it — a mismatch beyond a small tolerance shows a warning banner rather
  than silently trusting the saved number. Score Compute mode computes a physical **volume (mm³)**
  instead of an Agatston score for contrast panes (no manifest-baseline/confirm-total step, since
  there's no `<CLASS>_Agatston`-style baseline for a volume metric — always computed fresh); the
  Agatston-specific `ScorePanel` (per-class `<CLASS>_Agatston` tiles) is not shown at all in contrast
  mode.

## Known caveats

- Repeatedly hard-killing Electron/Python (`taskkill /F`) mid-write used to corrupt manifest files
  before the atomic-write fix; it's now safe, but still prefer waiting for in-flight saves to
  settle before restarting when possible.
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
