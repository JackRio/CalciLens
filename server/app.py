from __future__ import annotations

import datetime
import json
import os
from typing import Optional

import numpy as np
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
from agatston import (
    find_lesion_component,
    compute_agatston_score,
    compute_volume_agatston,
    CORONARY_LABELS,
    DEFAULT_HU_THRESHOLD,
)
from contrast_threshold import (
    compute_sphere_stats,
    compute_lesion_volume_mm3,
    compute_volume_total_mm3,
    save_sidecar,
    load_sidecar,
    DEFAULT_TARGET_VOLUME_MM3,
    DEFAULT_K_MULTIPLIER,
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


# ---- Per-lesion Agatston scoring ----


class LesionScoreRequest(BaseModel):
    mask_id: str
    ct_id: str
    plane: str
    index: int
    row: float
    col: float
    hu_threshold: float = DEFAULT_HU_THRESHOLD


@app.post("/api/mask/lesion_score")
def mask_lesion_score(req: LesionScoreRequest):
    try:
        mask_vol = store.get(req.mask_id)
        ct_vol = store.get(req.ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="volume not loaded")
    result = find_lesion_component(
        mask_vol, ct_vol, req.plane, req.index, req.row, req.col, req.hu_threshold
    )
    if result is None:
        return {"found": False, "label": None, "voxel_count": 0, "agatston_score": 0.0, "is_coronary": False}
    region, label = result
    score = compute_agatston_score(region, ct_vol.array, ct_vol.spacing_lps)
    return {
        "found": True,
        "label": label,
        "voxel_count": int(np.count_nonzero(region)),
        "agatston_score": score,
        "is_coronary": label in CORONARY_LABELS,
    }


class VolumeAgatstonRequest(BaseModel):
    mask_id: str
    ct_id: str
    labels: list[int] = list(CORONARY_LABELS)
    hu_threshold: float = DEFAULT_HU_THRESHOLD


@app.post("/api/volumes/agatston_total")
def volumes_agatston_total(req: VolumeAgatstonRequest):
    try:
        mask_vol = store.get(req.mask_id)
        ct_vol = store.get(req.ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="volume not loaded")
    total = compute_volume_agatston(mask_vol, ct_vol, tuple(req.labels), req.hu_threshold)
    return {"total_score": total}


# ---- Contrast CT: per-lesion/per-volume physical volume (no Agatston weighting) ----


class LesionVolumeRequest(BaseModel):
    mask_id: str
    ct_id: str
    plane: str
    index: int
    row: float
    col: float
    hu_threshold: float


@app.post("/api/mask/lesion_volume")
def mask_lesion_volume(req: LesionVolumeRequest):
    try:
        mask_vol = store.get(req.mask_id)
        ct_vol = store.get(req.ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="volume not loaded")
    result = find_lesion_component(mask_vol, ct_vol, req.plane, req.index, req.row, req.col, req.hu_threshold)
    if result is None:
        return {"found": False, "label": None, "voxel_count": 0, "volume_mm3": 0.0}
    region, label = result
    volume_mm3 = compute_lesion_volume_mm3(region, ct_vol.spacing_lps)
    return {
        "found": True,
        "label": label,
        "voxel_count": int(np.count_nonzero(region)),
        "volume_mm3": volume_mm3,
    }


class VolumeTotalRequest(BaseModel):
    mask_id: str
    ct_id: str
    labels: list[int] = list(CORONARY_LABELS)
    hu_threshold: float


@app.post("/api/volumes/volume_total")
def volumes_volume_total(req: VolumeTotalRequest):
    try:
        mask_vol = store.get(req.mask_id)
        ct_vol = store.get(req.ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="volume not loaded")
    total_volume_mm3 = compute_volume_total_mm3(mask_vol, ct_vol, tuple(req.labels), req.hu_threshold)
    return {"total_volume_mm3": total_volume_mm3}


# ---- Contrast CT: seed placement + per-scan threshold derivation ----


class ContrastThresholdRequest(BaseModel):
    ct_id: str
    plane: str
    index: int
    row: float
    col: float
    target_volume_mm3: float = DEFAULT_TARGET_VOLUME_MM3
    k_multiplier: float = DEFAULT_K_MULTIPLIER
    save: bool = True
    ct_path: Optional[str] = None
    mask_path: Optional[str] = None
    patient_id: Optional[str] = None


@app.post("/api/contrast/compute_threshold")
def contrast_compute_threshold(req: ContrastThresholdRequest):
    try:
        ct_vol = store.get(req.ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="volume not loaded")
    try:
        stats = compute_sphere_stats(
            ct_vol, req.plane, req.index, req.row, req.col, req.target_volume_mm3, req.k_multiplier
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if req.save:
        if not req.ct_path:
            raise HTTPException(status_code=400, detail="ct_path is required to save the seed")
        record = {
            **stats,
            "ct_path": req.ct_path,
            "mask_path": req.mask_path,
            "patient_id": req.patient_id,
            "saved_at": datetime.datetime.now().isoformat(),
        }
        save_sidecar(req.ct_path, record)

    return stats


@app.get("/api/contrast/load_threshold")
def contrast_load_threshold(ct_path: str):
    record = load_sidecar(ct_path)
    if record is None:
        raise HTTPException(status_code=404, detail="No saved contrast seed for this image")
    return record


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
    mask_column: Optional[str] = folder_scan.DEFAULT_MASK_COLUMN
    id_column: Optional[str] = None
    patient_id_column: Optional[str] = None
    reason_column: Optional[str] = folder_scan.DEFAULT_REASON_COLUMN
    include_default_reason_tags: bool = True


@app.post("/api/manifest_pairs")
def manifest_pairs(req: ManifestPairsRequest):
    try:
        result = folder_scan.list_manifest_pairs(
            req.manifest_path,
            image_column=req.image_column,
            mask_column=req.mask_column,
            id_column=req.id_column,
            patient_id_column=req.patient_id_column,
            reason_column=req.reason_column,
            include_default_reason_tags=req.include_default_reason_tags,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Manifest not found: {req.manifest_path}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result


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


class ManifestReasonRequest(BaseModel):
    manifest_path: str
    row_index: int
    reasons: list[str]
    reason_column: str = folder_scan.DEFAULT_REASON_COLUMN


@app.post("/api/manifest/reason")
def manifest_reason(req: ManifestReasonRequest):
    try:
        folder_scan.save_reason(req.manifest_path, req.row_index, req.reasons, req.reason_column)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Manifest not found: {req.manifest_path}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to save reason: {e}")
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
