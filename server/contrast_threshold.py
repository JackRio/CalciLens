"""Per-scan calcium-detection threshold for contrast CT.

Non-contrast CT uses a fixed 130 HU threshold (see agatston.DEFAULT_HU_THRESHOLD /
volume_store.DEFAULT_THRESHOLD_HU). Contrast CT has no such fixed threshold — the
user places a seed point in the ascending aorta (near the left ostium), we sample a
small sphere VOI around it, and derive a scan-specific threshold from that sample's
HU statistics: threshold = mean + k * stddev. The seed/threshold is saved to a JSON
sidecar next to the CT file so a later session can reload and re-verify it instead of
re-placing the seed.
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from typing import Optional

import numpy as np

from volume_store import LoadedVolume, _seed_index_3d
from pathutil import clean_path

DEFAULT_TARGET_VOLUME_MM3 = 200.0
DEFAULT_K_MULTIPLIER = 3.0


def compute_sphere_stats(
    ct_vol: LoadedVolume,
    plane: str,
    index: int,
    row: float,
    col: float,
    target_volume_mm3: float = DEFAULT_TARGET_VOLUME_MM3,
    k_multiplier: float = DEFAULT_K_MULTIPLIER,
) -> dict:
    """Sample a physical sphere of `target_volume_mm3` around the seed click and
    derive threshold = mean + k*std over its voxels (boundary voxels included, i.e.
    the sphere test is inclusive: distance <= radius, not strictly less than).

    ct_vol.array is (z, y, x); ct_vol.spacing_lps is (sx, sy, sz) in mm — note this is
    NOT the same axis order as the array, so per-axis physical distance for array
    index (z, y, x) relative to seed (z0, y0, x0) is (z-z0)*sz, (y-y0)*sy, (x-x0)*sx.
    """
    z0, y0, x0 = _seed_index_3d(ct_vol, plane, index, row, col)
    nz, ny, nx = ct_vol.array.shape
    if not (0 <= z0 < nz and 0 <= y0 < ny and 0 <= x0 < nx):
        raise ValueError("Seed point is outside the volume")

    sx, sy, sz = ct_vol.spacing_lps
    r_mm = (3.0 * target_volume_mm3 / (4.0 * np.pi)) ** (1.0 / 3.0)

    rz = max(1, int(np.ceil(r_mm / sz))) if sz else 0
    ry = max(1, int(np.ceil(r_mm / sy))) if sy else 0
    rx = max(1, int(np.ceil(r_mm / sx))) if sx else 0

    z_lo, z_hi = max(0, z0 - rz), min(nz, z0 + rz + 1)
    y_lo, y_hi = max(0, y0 - ry), min(ny, y0 + ry + 1)
    x_lo, x_hi = max(0, x0 - rx), min(nx, x0 + rx + 1)

    zz, yy, xx = np.ogrid[z_lo:z_hi, y_lo:y_hi, x_lo:x_hi]
    dist2 = ((zz - z0) * sz) ** 2 + ((yy - y0) * sy) ** 2 + ((xx - x0) * sx) ** 2
    sphere_mask = dist2 <= (r_mm**2)  # inclusive — boundary voxels count

    sub = ct_vol.array[z_lo:z_hi, y_lo:y_hi, x_lo:x_hi]
    voxels = sub[sphere_mask].astype(np.float64)
    if voxels.size == 0:
        raise ValueError("Sphere VOI contains no voxels — seed too close to the volume edge")

    mean_hu = float(voxels.mean())
    std_hu = float(voxels.std())
    threshold_hu = mean_hu + float(k_multiplier) * std_hu
    voxel_count = int(sphere_mask.sum())
    actual_volume_mm3 = voxel_count * sx * sy * sz

    return {
        "mean_hu": mean_hu,
        "std_hu": std_hu,
        "threshold_hu": threshold_hu,
        "voxel_count": voxel_count,
        "actual_volume_mm3": actual_volume_mm3,
        "target_volume_mm3": float(target_volume_mm3),
        "k_multiplier": float(k_multiplier),
        "radius_mm": r_mm,
        "seed_voxel": [int(z0), int(y0), int(x0)],
        "plane": plane,
        "index": int(index),
        "row": float(row),
        "col": float(col),
    }


def compute_lesion_volume_mm3(region: np.ndarray, spacing_lps) -> float:
    """Physical volume (mm3) of a 3D boolean region — no Agatston density
    weighting, just voxel_count * per-voxel physical volume."""
    sx, sy, sz = spacing_lps
    return float(np.count_nonzero(region)) * float(sx) * float(sy) * float(sz)


def compute_volume_total_mm3(mask_vol: LoadedVolume, ct_vol: LoadedVolume, labels: tuple, hu_threshold: float) -> float:
    """Total physical volume (mm3) across all 3D-connected lesions of the given
    labels clearing hu_threshold — same candidate-mask/connectivity pattern as
    agatston.compute_volume_agatston, but summing physical voxel volume instead of
    per-slice Agatston-weighted area (no density weighting)."""
    from scipy import ndimage

    candidate = np.isin(mask_vol.array, labels) & (ct_vol.array >= hu_threshold)
    connectivity_26 = np.ones((3, 3, 3), dtype=bool)
    labeled, num = ndimage.label(candidate, structure=connectivity_26)
    if num == 0:
        return 0.0
    sx, sy, sz = ct_vol.spacing_lps
    voxel_volume = float(sx) * float(sy) * float(sz)
    return float(np.count_nonzero(labeled)) * voxel_volume


def _sidecar_path(ct_path: str) -> str:
    dirn = os.path.dirname(ct_path)
    base = os.path.basename(ct_path)
    if ct_path and os.path.isdir(ct_path):
        # A DICOM series directory's name is a dotted UID (e.g.
        # "1.2.840.113654...") — not a file extension, so it must not be run
        # through splitext (same gotcha as volume_store._insert_tag).
        stem = base
    elif base.lower().endswith(".nii.gz"):
        stem = base[:-7]
    else:
        stem = os.path.splitext(base)[0]
    return os.path.join(dirn, f"{stem}_contrast_seed.json")


def save_sidecar(ct_path: str, record: dict) -> str:
    """Write the seed/threshold record next to the CT file, atomically (temp file
    + os.replace, matching folder_scan._write_table's convention)."""
    ct_path = clean_path(ct_path)
    path = _sidecar_path(ct_path)
    dirn = os.path.dirname(path) or "."
    tmp_path = os.path.join(dirn, f".tmp_{os.getpid()}_{threading.get_ident()}_{uuid.uuid4().hex[:8]}_{os.path.basename(path)}")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2)
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
    return path


def load_sidecar(ct_path: str) -> Optional[dict]:
    ct_path = clean_path(ct_path)
    path = _sidecar_path(ct_path)
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
