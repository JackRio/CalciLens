"""Per-lesion and per-volume Agatston calcium scoring.

A "lesion" is the 3D 26-connected component of voxels sharing one mask label
AND clearing the calcium HU threshold, reachable from a clicked seed voxel
(see find_lesion_component). The score itself follows the classic per-slice
Agatston method (area_mm2 x density_factor, summed over axial slices), with a
slice-thickness correction factor applied since these scans use a 1.5mm
reconstruction increment against an assumed 3mm slice thickness — see
compute_agatston_score.
"""
from __future__ import annotations

from typing import Optional

import numpy as np
from scipy import ndimage

from volume_store import LoadedVolume, _seed_index_3d, _nearest_qualifying_voxel, _voxel_radius_from_mm

CORONARY_LABELS = (1, 2, 3)  # LAD, LCx, RCA
DEFAULT_HU_THRESHOLD = 130.0
AGATSTON_SLICE_THICKNESS_MM = 3.0

_CONNECTIVITY_26 = np.ones((3, 3, 3), dtype=bool)


def _density_weight(hu: float) -> int:
    if hu >= 400:
        return 4
    if hu >= 300:
        return 3
    if hu >= 200:
        return 2
    if hu >= 130:
        return 1
    return 0


def find_lesion_component(
    mask_vol: LoadedVolume,
    ct_vol: LoadedVolume,
    plane: str,
    index: int,
    row: float,
    col: float,
    hu_threshold: float = DEFAULT_HU_THRESHOLD,
    search_radius_mm: Optional[float] = None,
    flips: tuple = (False, False, False),
) -> Optional[tuple[np.ndarray, int]]:
    """Isolate the 3D lesion (same label as the clicked voxel, HU >=
    hu_threshold, 26-connected) containing the seed. Returns (region, label)
    or None if no qualifying voxel is found at or near the seed.

    search_radius_mm widens the seed lookup beyond the exact clicked voxel
    (see volume_store._nearest_qualifying_voxel) — None uses the always-on
    1-voxel tolerance (absorbs a sub-pixel click-rounding miss on a tiny
    lesion); a larger value backs the Shift+click circle-seed feature.
    """
    nz, ny, nx = ct_vol.array.shape
    z, y, x = _seed_index_3d(ct_vol, plane, index, row, col, flips)
    if not (0 <= z < nz and 0 <= y < ny and 0 <= x < nx):
        return None

    qualifies = (mask_vol.array != 0) & (ct_vol.array >= hu_threshold)
    seed = _nearest_qualifying_voxel(qualifies, z, y, x, _voxel_radius_from_mm(ct_vol.spacing_lps, search_radius_mm))
    if seed is None:
        return None
    z, y, x = seed
    label = int(mask_vol.array[z, y, x])

    candidate = (mask_vol.array == label) & (ct_vol.array >= hu_threshold)
    labeled, _ = ndimage.label(candidate, structure=_CONNECTIVITY_26)
    seed_component = labeled[z, y, x]
    region = labeled == seed_component
    return region, label


def compute_agatston_score(region: np.ndarray, ct_array: np.ndarray, spacing_lps) -> float:
    """Sum area_mm2 x density_factor per axial slice over `region`, then
    apply the slice-thickness/overlap correction factor (no resampling —
    just scales the raw sum by spacing.z / assumed 3mm slice thickness)."""
    pixel_area_mm2 = float(spacing_lps[0]) * float(spacing_lps[1])
    total = 0.0
    for z in range(region.shape[0]):
        slice_mask = region[z]
        if not slice_mask.any():
            continue
        area_mm2 = float(np.count_nonzero(slice_mask)) * pixel_area_mm2
        max_hu = float(ct_array[z][slice_mask].max())
        total += area_mm2 * _density_weight(max_hu)
    correction = float(spacing_lps[2]) / AGATSTON_SLICE_THICKNESS_MM
    return total * correction


def compute_volume_agatston(
    mask_vol: LoadedVolume,
    ct_vol: LoadedVolume,
    labels: tuple[int, ...] = CORONARY_LABELS,
    hu_threshold: float = DEFAULT_HU_THRESHOLD,
) -> float:
    """Total Agatston score across all lesions of the given labels in the
    whole volume — used as the fallback when the manifest has no CAC_Agatston
    value. Components are labeled in 3D first so each lesion's density
    factor is computed from its own voxels, not blurred across unrelated
    lesions that happen to share a slice."""
    candidate = np.isin(mask_vol.array, labels) & (ct_vol.array >= hu_threshold)
    labeled, num = ndimage.label(candidate, structure=_CONNECTIVITY_26)
    total = 0.0
    for component_id in range(1, num + 1):
        region = labeled == component_id
        total += compute_agatston_score(region, ct_vol.array, ct_vol.spacing_lps)
    return total
