from __future__ import annotations

import json
import os
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from volume_store import (
    store,
    render_composited_png,
    probe_values,
    paint_mask,
    region_grow_mask,
    recompute_labels,
    save_mask,
    DEFAULT_LABEL_COLORS,
    DEFAULT_THRESHOLD_COLOR,
    DEFAULT_THRESHOLD_HU,
    PLANES,
)
import folder_scan

app = FastAPI(title="CT Viewer API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def no_cache_index_html(request, call_next):
    """The Electron window's Chromium profile persists on disk across app
    restarts (user-data-dir), so without this, index.html — which is what
    points the browser at the current build's hashed JS/CSS filenames — can
    be served from that cache after an update, silently showing a stale
    build even on a fresh launch. The hashed asset files themselves are
    still free to be cached indefinitely; only the HTML entry point (that
    names them) needs to always be revalidated."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.endswith("/index.html"):
        response.headers["Cache-Control"] = "no-cache"
    return response


class LoadRequest(BaseModel):
    path: str
    is_mask: bool = False
    force: bool = False


@app.post("/api/volumes/load")
def load_volume(req: LoadRequest):
    try:
        vol = store.load(req.path, is_mask=req.is_mask, force=req.force)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Path not found: {req.path}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to load volume: {e}")
    return vol.info_dict()


@app.get("/api/volumes/{volume_id}/info")
def volume_info(volume_id: str):
    try:
        vol = store.get(volume_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="volume not loaded")
    return vol.info_dict()


@app.get("/api/defaults")
def defaults():
    return {
        "label_colors": DEFAULT_LABEL_COLORS,
        "threshold_color": DEFAULT_THRESHOLD_COLOR,
        "threshold_hu": DEFAULT_THRESHOLD_HU,
        "planes": PLANES,
    }


@app.get("/api/render")
def render(
    ct_id: str,
    plane: str,
    index: int,
    mask_id: Optional[str] = None,
    ww: float = 400.0,
    wl: float = 40.0,
    mask_colors: Optional[str] = None,
    mask_alpha: float = 0.5,
    show_mask: bool = True,
    threshold_enabled: bool = False,
    threshold_value: float = DEFAULT_THRESHOLD_HU,
    threshold_color: str = DEFAULT_THRESHOLD_COLOR,
    threshold_alpha: float = 0.5,
):
    try:
        ct_vol = store.get(ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="ct volume not loaded")

    mask_vol = None
    if mask_id:
        try:
            mask_vol = store.get(mask_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="mask volume not loaded")

    colors = None
    if mask_colors:
        try:
            colors = json.loads(mask_colors)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="mask_colors must be JSON")

    try:
        png_bytes = render_composited_png(
            ct_vol=ct_vol,
            mask_vol=mask_vol,
            plane=plane,
            index=index,
            window_level=wl,
            window_width=ww,
            mask_colors=colors,
            mask_alpha=mask_alpha,
            show_mask=show_mask,
            threshold_enabled=threshold_enabled,
            threshold_value=threshold_value,
            threshold_color=threshold_color,
            threshold_alpha=threshold_alpha,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"render failed: {e}")

    return Response(content=png_bytes, media_type="image/png")


@app.get("/api/probe")
def probe(ct_id: str, plane: str, index: int, row: int, col: int, mask_id: Optional[str] = None):
    try:
        ct_vol = store.get(ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="ct volume not loaded")
    mask_vol = None
    if mask_id:
        try:
            mask_vol = store.get(mask_id)
        except KeyError:
            pass
    return probe_values(ct_vol, mask_vol, plane, index, row, col)


# ---- Mask editing ----


class NewMaskRequest(BaseModel):
    ct_id: str


@app.post("/api/mask/new")
def new_mask(req: NewMaskRequest):
    try:
        ct_vol = store.get(req.ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="ct volume not loaded")
    mask_vol = store.create_blank_mask(ct_vol)
    return mask_vol.info_dict()


class PaintRequest(BaseModel):
    mask_id: str
    ct_id: str
    plane: str
    index: int
    row: float
    col: float
    radius: float
    new_label: int
    overwrite_mode: str = "any"  # "any" | "label" | "threshold"
    overwrite_label: Optional[int] = None
    threshold_min: Optional[float] = None


@app.post("/api/mask/paint")
def mask_paint(req: PaintRequest):
    try:
        mask_vol = store.get(req.mask_id)
        ct_vol = store.get(req.ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="volume not loaded")
    try:
        changed = paint_mask(
            mask_vol,
            ct_vol,
            req.plane,
            req.index,
            req.row,
            req.col,
            req.radius,
            req.new_label,
            overwrite_mode=req.overwrite_mode,
            overwrite_label=req.overwrite_label,
            threshold_min=req.threshold_min,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"paint failed: {e}")
    return {"changed": changed, "labels": mask_vol.labels}


class RefreshLabelsRequest(BaseModel):
    mask_id: str


@app.post("/api/mask/refresh_labels")
def mask_refresh_labels(req: RefreshLabelsRequest):
    """Recompute the mask's unique-label list (np.unique over the full
    volume). Deliberately NOT called per brush dab (see paint_mask) — call
    this once after a stroke ends instead."""
    try:
        mask_vol = store.get(req.mask_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="mask volume not loaded")
    recompute_labels(mask_vol)
    return {"labels": mask_vol.labels}


class RegionGrowRequest(BaseModel):
    mask_id: str
    ct_id: str
    plane: str
    index: int
    row: float
    col: float
    threshold_min: float
    new_label: int


@app.post("/api/mask/region_grow")
def mask_region_grow(req: RegionGrowRequest):
    try:
        mask_vol = store.get(req.mask_id)
        ct_vol = store.get(req.ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="volume not loaded")
    try:
        changed = region_grow_mask(
            mask_vol,
            ct_vol,
            req.plane,
            req.index,
            req.row,
            req.col,
            req.threshold_min,
            req.new_label,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"changed": changed, "labels": mask_vol.labels}


class SaveMaskRequest(BaseModel):
    mask_id: str
    tag: Optional[str] = None


@app.post("/api/mask/save")
def mask_save(req: SaveMaskRequest):
    try:
        mask_vol = store.get(req.mask_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="mask volume not loaded")
    try:
        out_path = save_mask(mask_vol, tag=req.tag)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"save failed: {e}")
    return {"path": out_path}


# ---- CSV / Excel manifest driven batch loading ----


class ManifestColumnsRequest(BaseModel):
    manifest_path: str


@app.post("/api/manifest_columns")
def manifest_columns(req: ManifestColumnsRequest):
    try:
        return {"columns": folder_scan.list_manifest_columns(req.manifest_path)}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Manifest not found: {req.manifest_path}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read manifest: {e}")


class ManifestPairsRequest(BaseModel):
    manifest_path: str
    image_column: str = folder_scan.DEFAULT_IMAGE_COLUMN
    mask_column: str = folder_scan.DEFAULT_MASK_COLUMN
    id_column: Optional[str] = None
    patient_id_column: Optional[str] = None


@app.post("/api/manifest_pairs")
def manifest_pairs(req: ManifestPairsRequest):
    try:
        rows = folder_scan.list_manifest_pairs(
            req.manifest_path,
            image_column=req.image_column,
            mask_column=req.mask_column,
            id_column=req.id_column,
            patient_id_column=req.patient_id_column,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Manifest not found: {req.manifest_path}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"rows": rows}


class ManifestCommentRequest(BaseModel):
    manifest_path: str
    row_index: int
    comment: str


@app.post("/api/manifest/comment")
def manifest_comment(req: ManifestCommentRequest):
    try:
        folder_scan.save_comment(req.manifest_path, req.row_index, req.comment)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Manifest not found: {req.manifest_path}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to save comment: {e}")
    return {"ok": True}


class ManifestStatusRequest(BaseModel):
    manifest_path: str
    row_index: int
    status: str


@app.post("/api/manifest/status")
def manifest_status(req: ManifestStatusRequest):
    try:
        folder_scan.save_status(req.manifest_path, req.row_index, req.status)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Manifest not found: {req.manifest_path}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to save status: {e}")
    return {"ok": True}


class ManifestMaskPathRequest(BaseModel):
    manifest_path: str
    row_index: int
    mask_column: str
    mask_path: str


@app.post("/api/manifest/mask_path")
def manifest_mask_path(req: ManifestMaskPathRequest):
    try:
        folder_scan.save_mask_path(req.manifest_path, req.row_index, req.mask_column, req.mask_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Manifest not found: {req.manifest_path}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to update manifest mask path: {e}")
    return {"ok": True}


# ---- Serve the built React client (production) ----
_client_dist = os.path.join(os.path.dirname(__file__), "..", "client", "dist")
if os.path.isdir(_client_dist):
    app.mount("/", StaticFiles(directory=_client_dist, html=True), name="client")
