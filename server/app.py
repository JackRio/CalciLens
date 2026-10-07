from __future__ import annotations

import datetime
import json
import os
from typing import Optional

import numpy as np
import SimpleITK as sitk
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import annotation_paths
from pathutil import clean_path
from volume_store import (
    store,
    render_composited_png,
    probe_values,
    paint_mask,
    region_grow_mask,
    recompute_labels,
    save_mask,
    assert_same_geometry,
    _find_all_dicom_series,
    _find_image_files,
    parse_display_flips,
    _series_description,
    DEFAULT_LABEL_COLORS,
    DEFAULT_THRESHOLD_COLOR,
    DEFAULT_THRESHOLD_HU,
    PLANES,
)
from agatston import (
    find_lesion_component,
    compute_agatston_score,
    compute_volume_agatston,
    DEFAULT_MIN_LESION_AREA_MM2,
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
    series_uid: Optional[str] = None


@app.post("/api/volumes/load")
def load_volume(req: LoadRequest):
    try:
        vol = store.load(req.path, is_mask=req.is_mask, force=req.force, series_uid=req.series_uid)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Path not found: {req.path}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to load volume: {e}")
    return vol.info_dict()


@app.get("/api/volumes/list_dicom_series")
def list_dicom_series(path: str):
    """Enumerate every scan found under `path` (root itself or any
    subdirectory): each DICOM series, and each single image file
    (NIfTI/MHA/MHD/NRRD). The frontend uses this for its Previous/Next
    navigator when a folder holds more than one. A non-directory path or a
    directory with nothing loadable returns an empty list rather than an
    error — callers treat that as "just load it plainly", so this never
    blocks a normal single-file load.

    `kind` is "dicom" (directory + series_uid identify it) or "file"
    (directory is the file's own path and series_uid is empty)."""
    path = os.path.abspath(clean_path(path))
    if not os.path.isdir(path):
        return {"series": []}
    try:
        pairs = _find_all_dicom_series(path)
    except Exception:
        return {"series": []}
    result = []
    for dirpath, series_id in pairs:
        file_names = sitk.ImageSeriesReader.GetGDCMSeriesFileNames(dirpath, series_id)
        result.append({
            "kind": "dicom",
            "series_uid": series_id,
            "directory": dirpath,
            "label": os.path.relpath(dirpath, path) if dirpath != path else os.path.basename(path),
            "description": _series_description(dirpath, series_id, file_names),
            "num_files": len(file_names),
        })
    for file_path in _find_image_files(path):
        result.append({
            "kind": "file",
            "series_uid": "",
            "directory": file_path,
            "label": os.path.relpath(file_path, path),
            "description": "",
            "num_files": 1,
        })
    result.sort(key=lambda r: (r["directory"].lower(), r["series_uid"]))
    return {"series": result}


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
    flip: str = "",
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
            flips=parse_display_flips(flip),
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"render failed: {e}")

    return Response(content=png_bytes, media_type="image/png")


@app.get("/api/probe")
def probe(ct_id: str, plane: str, index: int, row: int, col: int, mask_id: Optional[str] = None, flip: str = ""):
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
    return probe_values(ct_vol, mask_vol, plane, index, row, col, parse_display_flips(flip))


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
    flip: str = ""  # display-only mirrors the click was made on, see parse_display_flips


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
            flips=parse_display_flips(req.flip),
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
    search_radius_mm: Optional[float] = None
    flip: str = ""


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
            search_radius_mm=req.search_radius_mm,
            flips=parse_display_flips(req.flip),
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
    search_radius_mm: Optional[float] = None
    flip: str = ""
    min_area_mm2: float = DEFAULT_MIN_LESION_AREA_MM2
    slice_spacing_mm: Optional[float] = None


@app.post("/api/mask/lesion_score")
def mask_lesion_score(req: LesionScoreRequest):
    try:
        mask_vol = store.get(req.mask_id)
        ct_vol = store.get(req.ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="volume not loaded")
    try:
        assert_same_geometry(mask_vol, ct_vol)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    result = find_lesion_component(
        mask_vol,
        ct_vol,
        req.plane,
        req.index,
        req.row,
        req.col,
        req.hu_threshold,
        search_radius_mm=req.search_radius_mm,
        flips=parse_display_flips(req.flip),
    )
    if result is None:
        return {"found": False, "label": None, "voxel_count": 0, "agatston_score": 0.0}
    region, label = result
    score = compute_agatston_score(
        region, ct_vol.array, ct_vol.spacing_lps, req.min_area_mm2, req.slice_spacing_mm
    )
    return {
        "found": True,
        "label": label,
        "voxel_count": int(np.count_nonzero(region)),
        "agatston_score": score,
    }


class VolumeAgatstonRequest(BaseModel):
    mask_id: str
    ct_id: str
    labels: list[int] = list(CORONARY_LABELS)
    hu_threshold: float = DEFAULT_HU_THRESHOLD
    min_area_mm2: float = DEFAULT_MIN_LESION_AREA_MM2
    slice_spacing_mm: Optional[float] = None


@app.post("/api/volumes/agatston_total")
def volumes_agatston_total(req: VolumeAgatstonRequest):
    try:
        mask_vol = store.get(req.mask_id)
        ct_vol = store.get(req.ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="volume not loaded")
    try:
        assert_same_geometry(mask_vol, ct_vol)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    total = compute_volume_agatston(
        mask_vol, ct_vol, tuple(req.labels), req.hu_threshold, req.min_area_mm2, req.slice_spacing_mm
    )
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
    search_radius_mm: Optional[float] = None
    flip: str = ""


@app.post("/api/mask/lesion_volume")
def mask_lesion_volume(req: LesionVolumeRequest):
    try:
        mask_vol = store.get(req.mask_id)
        ct_vol = store.get(req.ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="volume not loaded")
    try:
        assert_same_geometry(mask_vol, ct_vol)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    result = find_lesion_component(
        mask_vol, ct_vol, req.plane, req.index, req.row, req.col, req.hu_threshold,
        search_radius_mm=req.search_radius_mm, flips=parse_display_flips(req.flip),
    )
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
    try:
        assert_same_geometry(mask_vol, ct_vol)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
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
    save_dir: Optional[str] = None
    flip: str = ""


@app.post("/api/contrast/compute_threshold")
def contrast_compute_threshold(req: ContrastThresholdRequest):
    try:
        ct_vol = store.get(req.ct_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="volume not loaded")
    try:
        stats = compute_sphere_stats(
            ct_vol, req.plane, req.index, req.row, req.col, req.target_volume_mm3, req.k_multiplier,
            flips=parse_display_flips(req.flip),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if req.save:
        if not req.ct_path:
            raise HTTPException(status_code=400, detail="ct_path is required to save the seed")
        record = {
            **stats,
            "method": "aorta-sd",
            "ct_path": req.ct_path,
            "mask_path": req.mask_path,
            "patient_id": req.patient_id,
            "saved_at": datetime.datetime.now().isoformat(),
        }
        try:
            save_sidecar(
                req.ct_path,
                record,
                base_dir=req.save_dir,
                series_uid=ct_vol.dicom_series_uid,
                patient_id=req.patient_id,
            )
        except annotation_paths.SaveDirRequired as e:
            raise HTTPException(status_code=400, detail=str(e))

    return stats


class FixedThresholdRequest(BaseModel):
    threshold_hu: float
    ct_path: str
    series_uid: Optional[str] = None
    mask_path: Optional[str] = None
    patient_id: Optional[str] = None
    save_dir: Optional[str] = None


@app.post("/api/contrast/set_fixed_threshold")
def contrast_set_fixed_threshold(req: FixedThresholdRequest):
    """Record a fixed-HU threshold for this scan (no seed involved), in the same
    per-scan sidecar a seed is kept in, so it is found again when the scan is
    reopened."""
    record = {
        "method": "fixed",
        "threshold_hu": float(req.threshold_hu),
        "ct_path": req.ct_path,
        "mask_path": req.mask_path,
        "patient_id": req.patient_id,
        "saved_at": datetime.datetime.now().isoformat(),
    }
    try:
        save_sidecar(
            req.ct_path, record, base_dir=req.save_dir, series_uid=req.series_uid, patient_id=req.patient_id
        )
    except annotation_paths.SaveDirRequired as e:
        raise HTTPException(status_code=400, detail=str(e))
    return record


@app.get("/api/contrast/load_threshold")
def contrast_load_threshold(ct_path: str, save_dir: Optional[str] = None, series_uid: Optional[str] = None):
    record = load_sidecar(ct_path, base_dir=save_dir, series_uid=series_uid)
    if record is None:
        raise HTTPException(status_code=404, detail="No saved contrast seed for this image")
    return record


class SaveMaskRequest(BaseModel):
    mask_id: str
    # The CT the annotation belongs to. The save path is derived from this,
    # never from the loaded mask's own filename — see volume_store.save_mask.
    ct_path: str
    series_uid: Optional[str] = None
    save_dir: Optional[str] = None
    annotation_type: Optional[str] = None  # "contrast" | "non-contrast"
    patient_id: Optional[str] = None
    # Where the mask being saved came from, as the pane knows it:
    # "prediction" | "annotation" | "new" | "manual". Recorded so a later
    # session can tell what this annotation was originally derived from.
    mask_source: Optional[str] = None
    # How this scan was scored (spacing, labels, minimum lesion area, ...), kept
    # in `_source.json` next to the annotation. See /api/scoring/record.
    scoring: Optional[dict] = None
    # The user's answer to a conflict reported by a previous call:
    # "overwrite" or "new_copy". None means "tell me if there's a conflict".
    resolution: Optional[str] = None


@app.post("/api/mask/save")
def mask_save(req: SaveMaskRequest):
    try:
        mask_vol = store.get(req.mask_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="mask volume not loaded")
    if not req.ct_path:
        raise HTTPException(status_code=400, detail="ct_path is required to save an annotation")
    try:
        # The CT supplies the voxel grid the annotation is written on.
        try:
            ct_vol = store.load(req.ct_path, False, False, req.series_uid)
        except Exception:
            ct_vol = None
        result = save_mask(
            mask_vol,
            ct_vol=ct_vol,
            ct_path=req.ct_path,
            series_uid=req.series_uid,
            base_dir=req.save_dir,
            annotation_type=req.annotation_type,
            patient_id=req.patient_id,
            resolution=req.resolution,
            mask_source=req.mask_source,
            scoring=req.scoring,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"save failed: {e}")
    # A conflict comes back as a normal 200 with status="conflict" and
    # nothing written — the client asks the user and calls again with a
    # resolution. It is not an error, so it must not be an HTTP error.
    return result


def _find_scan_records(ct_path: str, series_uid: Optional[str], save_dir: Optional[str], annotation_path: Optional[str]):
    """The (scan_dir, source record) of the saved work for this scan, or None.

    The manifest already records exactly where this case's annotation
    folder is, so that is trusted before searching. Without it the search is
    rooted at the *currently configured* save directory, and a seed saved
    under a different (or since-cleared) save folder became invisible —
    which would silently put a contrast scan back on the 130 HU default.
    Without a chosen save folder there is nothing else to search (the CT's own
    folder is not treated as one)."""
    candidates = []
    if annotation_path:
        hinted = os.path.dirname(clean_path(annotation_path))
        if os.path.isdir(hinted):
            candidates.append(hinted)
    root = annotation_paths.annotation_root(ct_path, save_dir)
    if root:
        folder_name = annotation_paths.scan_folder_name(ct_path, series_uid)
        candidates.extend(annotation_paths.find_existing_scan_dirs(root, folder_name))
    for scan_dir in candidates:
        record = annotation_paths.read_source_record(scan_dir)
        if annotation_paths._same_scan(record, ct_path, series_uid):
            return scan_dir, record
    return None


@app.get("/api/annotations/lookup")
def annotations_lookup(
    ct_path: str,
    series_uid: Optional[str] = None,
    save_dir: Optional[str] = None,
    annotation_path: Optional[str] = None,
):
    """What this app already knows about a scan, before anything is loaded:
    whether an annotation was saved for it, when, whether it was annotated as
    contrast, and how it was scored.

    This is what makes "is this a contrast scan?" answerable from the data
    rather than from whether the user remembered to tick a checkbox."""
    ct_path = clean_path(ct_path)
    found = _find_scan_records(ct_path, series_uid, save_dir, annotation_path)
    if found:
        scan_dir, record = found
        annotation_file = os.path.join(scan_dir, annotation_paths.ANNOTATION_FILENAME)
        return {
            "found": True,
            "scan_dir": scan_dir,
            "annotation_path": annotation_file if os.path.isfile(annotation_file) else None,
            "has_seed": os.path.isfile(os.path.join(scan_dir, annotation_paths.SEED_SIDECAR_NAME)),
            "source_record": record,
        }
    return {
        "found": False,
        "scan_dir": None,
        "annotation_path": None,
        "has_seed": load_sidecar(ct_path, base_dir=save_dir, series_uid=series_uid) is not None,
        "source_record": None,
    }


class ScoringRecordRequest(BaseModel):
    ct_path: str
    series_uid: Optional[str] = None
    save_dir: Optional[str] = None
    annotation_path: Optional[str] = None
    scoring: dict


@app.post("/api/scoring/record")
def scoring_record(req: ScoringRecordRequest):
    """Write how this scan is scored into its `_source.json`, if the scan
    already has a folder there. Never creates a folder: with none yet, the
    client keeps the setup and sends it along with the annotation's first save."""
    ct_path = clean_path(req.ct_path)
    found = _find_scan_records(ct_path, req.series_uid, req.save_dir, req.annotation_path)
    if not found:
        return {"saved": False}
    scan_dir, record = found
    annotation_paths.atomic_write_json(
        os.path.join(scan_dir, annotation_paths.SOURCE_RECORD_NAME), {**(record or {}), "scoring": req.scoring}
    )
    return {"saved": True, "scan_dir": scan_dir}


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
    status_column: Optional[str] = folder_scan.DEFAULT_STATUS_COLUMN
    annotation_column: Optional[str] = folder_scan.DEFAULT_ANNOTATION_COLUMN
    contrast_column: Optional[str] = folder_scan.DEFAULT_CONTRAST_COLUMN
    read_only: bool = False


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
            status_column=req.status_column,
            annotation_column=req.annotation_column,
            contrast_column=req.contrast_column,
            read_only=req.read_only,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Manifest not found: {req.manifest_path}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except PermissionError:
        raise HTTPException(status_code=400, detail="Can't open the manifest. Close it in Excel and try again.")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Couldn't read the manifest: {e}")
    return result


class ManifestTemplateRequest(BaseModel):
    path: str


@app.post("/api/manifest/template")
def manifest_template(req: ManifestTemplateRequest):
    try:
        return {"path": folder_scan.write_manifest_template(req.path)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Couldn't save the template: {e}")


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
    status_column: Optional[str] = folder_scan.DEFAULT_STATUS_COLUMN


@app.post("/api/manifest/status")
def manifest_status(req: ManifestStatusRequest):
    try:
        folder_scan.save_status(req.manifest_path, req.row_index, req.status, req.status_column)
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


class ManifestAnnotationPathRequest(BaseModel):
    manifest_path: str
    row_index: int
    annotation_column: str
    annotation_path: str


@app.post("/api/manifest/annotation_path")
def manifest_annotation_path(req: ManifestAnnotationPathRequest):
    try:
        folder_scan.save_annotation_path(
            req.manifest_path, req.row_index, req.annotation_column, req.annotation_path
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Manifest not found: {req.manifest_path}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to record the annotation path: {e}")
    return {"ok": True}


class ManifestContrastRequest(BaseModel):
    manifest_path: str
    row_index: int
    contrast_column: str
    is_contrast: bool


@app.post("/api/manifest/contrast")
def manifest_contrast(req: ManifestContrastRequest):
    try:
        folder_scan.save_contrast_flag(
            req.manifest_path, req.row_index, req.contrast_column, req.is_contrast
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Manifest not found: {req.manifest_path}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to record the contrast flag: {e}")
    return {"ok": True}


# ---- Serve the built React client (production) ----
_client_dist = os.path.join(os.path.dirname(__file__), "..", "client", "dist")
if os.path.isdir(_client_dist):
    app.mount("/", StaticFiles(directory=_client_dist, html=True), name="client")
