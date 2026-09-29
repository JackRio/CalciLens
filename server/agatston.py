"""Per-lesion and per-volume Agatston calcium scoring.

The classic Agatston (1990) method, done slice by slice:

  * a "lesion" on one axial slice is a 2D 8-connected group of pixels with the
    same mask label and HU >= 130;
  * it counts only if its area is at least `min_area_mm2` (1 mm^2 by default,
    the usual noise floor);
  * its score is area (mm^2) x density weight from its PEAK HU
    (130-199 -> 1, 200-299 -> 2, 300-399 -> 3, >= 400 -> 4);
  * the slice scores are summed, then scaled by (slice spacing / 3 mm) so scans
    that are not 3 mm apart are expressed on the standard 3 mm scale.

Which lesion a click means is still decided in 3D (find_lesion_component): the
clicked voxel's 26-connected component. That component always contains whole
2D lesions (8-connected in-plane is a subset of 26-connected), so a lesion's
score and the volume totals add up consistently.

Reference: Agatston AS, Janowitz WR, Hildner FJ, et al. Quantification of
coronary artery calcium using ultrafast computed tomography. J Am Coll Cardiol
1990;15(4):827-832. https://doi.org/10.1016/0735-1097(90)90282-T
"""
from __future__ import annotations

from typing import Optional

import numpy as np
from scipy import ndimage

from volume_store import LoadedVolume, _seed_index_3d, _nearest_qualifying_voxel, _voxel_radius_from_mm

CORONARY_LABELS = (1, 2, 3)  # LAD, LCx, RCA
DEFAULT_HU_THRESHOLD = 130.0
# The standard's reference: 3 mm slices. Scores from other spacings are scaled
# onto this scale (see compute_agatston_score).
AGATSTON_REFERENCE_SPACING_MM = 3.0
DEFAULT_MIN_LESION_AREA_MM2 = 1.0

_CONNECTIVITY_26 = np.ones((3, 3, 3), dtype=bool)
_CONNECTIVITY_8 = np.ones((3, 3), dtype=bool)


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


def compute_agatston_score(
    region: np.ndarray,
    ct_array: np.ndarray,
    spacing_lps,
    min_area_mm2: float = DEFAULT_MIN_LESION_AREA_MM2,
    slice_spacing_mm: Optional[float] = None,
) -> float:
    """Agatston score of the voxels in `region` (a boolean (z, y, x) array):
    per axial slice, per 2D 8-connected lesion of at least `min_area_mm2`,
    area x density weight of the lesion's peak HU; summed over slices and scaled
    by slice spacing / 3 mm. `slice_spacing_mm` overrides the image's own z
    spacing (used when the user corrects it)."""
    pixel_area_mm2 = float(spacing_lps[0]) * float(spacing_lps[1])
    total = 0.0
    for z in range(region.shape[0]):
        slice_mask = region[z]
        if not slice_mask.any():
            continue
        labeled, count = ndimage.label(slice_mask, structure=_CONNECTIVITY_8)
        if count == 0:
            continue
        slice_hu = ct_array[z]
        for lesion_id in range(1, count + 1):
            lesion = labeled == lesion_id
            area_mm2 = float(np.count_nonzero(lesion)) * pixel_area_mm2
            if area_mm2 < min_area_mm2:
                continue
            total += area_mm2 * _density_weight(float(slice_hu[lesion].max()))
    spacing = float(slice_spacing_mm) if slice_spacing_mm else float(spacing_lps[2])
    return total * (spacing / AGATSTON_REFERENCE_SPACING_MM)


def compute_volume_agatston(
    mask_vol: LoadedVolume,
    ct_vol: LoadedVolume,
    labels: tuple[int, ...] = CORONARY_LABELS,
    hu_threshold: float = DEFAULT_HU_THRESHOLD,
    min_area_mm2: float = DEFAULT_MIN_LESION_AREA_MM2,
    slice_spacing_mm: Optional[float] = None,
) -> float:
    """Total Agatston score of the given labels over the whole volume: each
    label is scored on its own (a lesion belongs to one artery) and the results
    are added, so a total of several labels always equals the sum of theirs."""
    total = 0.0
    for label in labels:
        region = (mask_vol.array == label) & (ct_vol.array >= hu_threshold)
        if region.any():
            total += compute_agatston_score(region, ct_vol.array, ct_vol.spacing_lps, min_area_mm2, slice_spacing_mm)
    return total
