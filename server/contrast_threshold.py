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
    """Grow a VOI outward from the seed click, voxel by voxel in order of physical
    distance, until it holds exactly `round(target_volume_mm3 / voxel_volume)`
    voxels — i.e. actually grows to the target volume, rather than picking a fixed
    radius from the target volume and accepting whatever voxel count that radius
    happens to enclose (which can miss the target by 10%+ once the sphere is only a
    few voxels across, especially with anisotropic/coarse spacing). This keeps
    actual_volume_mm3 within one voxel's volume of target_volume_mm3 — as tight as
    it can possibly get on a discrete grid. Threshold = mean + k*std over those
    voxels' HU values.

    ct_vol.array is (z, y, x); ct_vol.spacing_lps is (sx, sy, sz) in mm — note this is
    NOT the same axis order as the array, so per-axis physical distance for array
    index (z, y, x) relative to seed (z0, y0, x0) is (z-z0)*sz, (y-y0)*sy, (x-x0)*sx.
    """
    z0, y0, x0 = _seed_index_3d(ct_vol, plane, index, row, col)
    nz, ny, nx = ct_vol.array.shape
    if not (0 <= z0 < nz and 0 <= y0 < ny and 0 <= x0 < nx):
        raise ValueError("Seed point is outside the volume")

    sx, sy, sz = ct_vol.spacing_lps
    voxel_volume = sx * sy * sz
    target_voxel_count = max(1, round(target_volume_mm3 / voxel_volume)) if voxel_volume else 1

    # Search box: the formula radius (from the target volume) scaled up with a
    # generous margin, so the box reliably contains at least target_voxel_count
    # candidates even at an unlucky grid alignment — the actual boundary is
    # decided below by voxel count, not this radius.
    r_mm = (3.0 * target_volume_mm3 / (4.0 * np.pi)) ** (1.0 / 3.0)
    margin = 1.5
    rz = max(1, int(np.ceil(r_mm * margin / sz))) if sz else 0
    ry = max(1, int(np.ceil(r_mm * margin / sy))) if sy else 0
    rx = max(1, int(np.ceil(r_mm * margin / sx))) if sx else 0

    z_lo, z_hi = max(0, z0 - rz), min(nz, z0 + rz + 1)
    y_lo, y_hi = max(0, y0 - ry), min(ny, y0 + ry + 1)
    x_lo, x_hi = max(0, x0 - rx), min(nx, x0 + rx + 1)

    zz, yy, xx = np.ogrid[z_lo:z_hi, y_lo:y_hi, x_lo:x_hi]
    dist2 = ((zz - z0) * sz) ** 2 + ((yy - y0) * sy) ** 2 + ((xx - x0) * sx) ** 2
    sub = ct_vol.array[z_lo:z_hi, y_lo:y_hi, x_lo:x_hi]

    flat_dist2 = np.broadcast_to(dist2, sub.shape).ravel()
    flat_vals = sub.ravel()
    if flat_dist2.size == 0:
        raise ValueError("Sphere VOI contains no voxels — seed too close to the volume edge")

    # Stable sort so voxels at an identical distance (common — the grid has a lot
    # of ties) keep a deterministic, reproducible order instead of an arbitrary
    # one that could vary between runs.
    order = np.argsort(flat_dist2, kind="stable")
    voxel_count = min(target_voxel_count, flat_dist2.size)
    chosen = order[:voxel_count]

    voxels = flat_vals[chosen].astype(np.float64)
    mean_hu = float(voxels.mean())
    std_hu = float(voxels.std())
    threshold_hu = mean_hu + float(k_multiplier) * std_hu
    actual_volume_mm3 = voxel_count * voxel_volume
    # The emergent radius — the farthest-included voxel's actual distance, not
    # the formula radius — so the sphere-VOI preview circle reflects what was
    # really sampled (which may differ from the formula radius once voxel
    # discretization is accounted for).
    actual_radius_mm = float(np.sqrt(flat_dist2[chosen[-1]])) if voxel_count > 0 else 0.0

    return {
        "mean_hu": mean_hu,
        "std_hu": std_hu,
        "threshold_hu": threshold_hu,
        "voxel_count": int(voxel_count),
        "actual_volume_mm3": actual_volume_mm3,
        "target_volume_mm3": float(target_volume_mm3),
        "k_multiplier": float(k_multiplier),
        "radius_mm": actual_radius_mm,
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
