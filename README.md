# CT / Segmentation Viewer

A desktop app for viewing CT scans (NIFTI, MHA/MHD, DICOM series) with
segmentation mask overlays, HU thresholding, split-view comparison, and
synchronized scrolling.

## Architecture

- **server/** — Python FastAPI backend. Uses SimpleITK to read NIFTI, MHA/MHD
  and DICOM series uniformly, reorients every volume to LPS on load so
  axial/sagittal/coronal slicing is consistent, and renders composited PNG
  slices (grayscale CT + threshold overlay + colored mask overlay) on demand.
- **client/** — React + TypeScript (Vite) frontend. Plain REST calls to the
  backend; each slice is just an `<img>` pointed at `/api/render?...`.
- **electron/** — Electron main process + preload script. Spawns the Python
  backend, opens a native window pointed at it, and exposes a native
  file/folder picker (`window.electronAPI.pickPath`) to the frontend.

No GPU/WebGL viewer library is used — slices are rendered server-side with
SimpleITK/NumPy/Pillow, which trivially handles all three formats and correct
world-space metadata (spacing/origin/direction) without needing per-format JS
loaders.

## Running it

**First time setup:**

```bash
# Backend
cd server
python -m venv ../.venv
../.venv/Scripts/activate   # or source ../.venv/bin/activate on macOS/Linux
pip install -r requirements.txt
cd ..

# Frontend + Electron shell
cd client && npm install && cd ..
npm install
```

**Run as a desktop app** (builds the frontend, then launches the Electron
window, which spawns the Python backend automatically):

```bash
npm run app
```

If you haven't changed the frontend since the last build, `npm start` skips
the rebuild step.

**Frontend-only dev loop** (hot reload, browser instead of Electron — useful
when iterating on UI without the native file picker):

```bash
cd server && ../.venv/Scripts/activate && uvicorn app:app --port 8000   # terminal 1
cd client && npm run dev                                                 # terminal 2
```

Open the URL Vite prints (http://localhost:5173); it proxies `/api/*` to the
backend on port 8000. `window.electronAPI` is unavailable here, so the
"Browse..." buttons are hidden and you type paths directly instead.

## Features

- **Formats**: NIFTI (.nii/.nii.gz), MHA/MHD, and DICOM series (point at the
  folder containing the slice files).
- **Split view**: up to 2 panes side by side, each with its own CT/mask, plane,
  window/level, colors, threshold and zoom.
- **Sync scroll**: toggle at the top links slice index, plane and zoom across
  both panes — turn it off to browse independently.
- **Planes**: axial (default), sagittal, coronal, switchable per pane.
- **Segmentation colors**: editable label→color table, defaults to the
  "Calcifications" preset (1 Red, 2 Green, 3 Blue, 4 Yellow, 5 Cyan, 6 Magenta).
- **HU threshold overlay**: highlight voxels ≥ a value (default 130 HU) in
  Orange — chosen because it's the one hue not already used by the six preset
  label colors (which cover pure red/green/blue/yellow/cyan/magenta), so it
  stays visually distinct from any mask label while still reading as "warm/
  significant" against grayscale CT.
- **Alpha blending**: mask opacity and threshold-overlay opacity are each a
  small numeric spinner in the viewer's bottom-left corner (0–1, default 1.0)
  — type a value and click away to commit it, or use the up/down arrows.
- **Batch loading from a CSV/Excel manifest**: point a pane at a spreadsheet
  with one row per case; tell it which column holds the image path and which
  holds the mask path (an optional third column supplies a display label),
  click "Load manifest", then pick a case from the dropdown to load its
  image+mask pair directly — no folder-naming convention required.
- **Image info panel** (ITK-SNAP style): dimensions, spacing, origin, direction
  matrix, data type, value range, and detected mask label values, shown for
  both the CT and the mask.
- **Voxel probe**: hovering the image shows the row/col, HU value, and mask
  label under the cursor.
- **Window/level**: manual entry plus presets (Soft tissue, Lung, Bone, Brain,
  Calcium/Agatston).
- **Zoom/pan**: ctrl+scroll to zoom, click-drag to pan (per pane).
- **Native file/folder picker**: "Browse..." buttons next to every path field
  open a real Windows file dialog (via Electron) instead of requiring you to
  type or paste paths.

## Notes / things not yet implemented

- Orientation is normalized to LPS and displayed with a fixed radiological
  convention; this is correct for standard clinical CT (near-identity
  direction cosines) but has not been validated against heavily oblique
  acquisitions.
- World-space (mm) cursor coordinates aren't shown yet, only voxel row/col/
  slice — could be added if useful.
- No 3-pane simultaneous MPR (axial+sagittal+coronal at once) — each pane
  shows one plane at a time, switchable via tabs, matching what was asked for.
- No packaged installer (.exe) yet — `npm run app` runs from source using the
  local `.venv` and `node_modules`. A real installer would need to bundle the
  Python venv (including SimpleITK's compiled binaries) into the app package,
  which needs care — see the `electron-builder` config in `package.json` as a
  starting point if that's wanted later.
