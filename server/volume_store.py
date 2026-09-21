"""Load NIFTI / MHA(MHD) / DICOM-series volumes with SimpleITK, cache them in
memory, and produce 2D slice renders (axial / sagittal / coronal) with
window/level, segmentation label coloring, HU thresholding and alpha blending.

Orientation: every volume is reoriented to LPS on load so that axial /
sagittal / coronal slicing and flips are consistent regardless of the
original direction cosines in the file. The ORIGINAL (as-read) spacing /
origin / direction are kept around for the info panel, since that is what a
user expects to see (matches what ITK-SNAP's header info dialog reports).
"""
from __future__ import annotations

import hashlib
import io
import os
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import SimpleITK as sitk
from PIL import Image

from pathutil import clean_path

PLANES = ("axial", "sagittal", "coronal")


def _is_dicom_dir(path: str) -> bool:
    return os.path.isdir(path)


def _hash_id(path: str) -> str:
    return hashlib.sha1(os.path.normcase(os.path.abspath(path)).encode("utf-8")).hexdigest()[:16]


@dataclass
class LoadedVolume:
    volume_id: str
    path: str
    array: np.ndarray  # shape (S, P, L) i.e. (z, y, x) in LPS-reoriented space
    spacing_lps: tuple  # (spacing_L, spacing_P, spacing_S) i.e. sitk spacing after reorient
    orig_spacing: tuple
    orig_origin: tuple
    orig_direction: tuple  # 9-tuple row-major
    orig_size: tuple
    orientation_code: str
    dtype: str
    value_min: float
    value_max: float
    is_dicom_dir: bool
    labels: Optional[list] = field(default=None)  # unique nonzero integer values, if used as a mask
    reoriented_origin: tuple = None  # origin/direction of the array as currently laid out (LPS-reoriented),
    reoriented_direction: tuple = None  # needed to write the array back out correctly after editing
    is_new_mask: bool = False  # True for a blank mask created in-app (never loaded from a file)
    source_ct_path: Optional[str] = None  # the CT path a new mask was created against, for save-path naming

    def size_lps(self):
        nz, ny, nx = self.array.shape
        return (nx, ny, nz)  # (L, P, S) counts matching sitk size order

    def plane_length(self, plane: str) -> int:
        nz, ny, nx = self.array.shape
        if plane == "axial":
            return nz
        if plane == "sagittal":
            return nx
        if plane == "coronal":
            return ny
        raise ValueError(f"unknown plane {plane}")

    def info_dict(self) -> dict:
        nz, ny, nx = self.array.shape
        return {
            "volume_id": self.volume_id,
            "path": self.path,
            "size": [int(v) for v in self.orig_size],
            "spacing": [round(float(v), 6) for v in self.orig_spacing],
            # (sx, sy, sz) in the LPS-reoriented array's own axis order — NOT
            # necessarily the same order as "spacing" (orig_spacing) above,
            # which keeps the as-read file's own axis order. Anything doing
            # physical-space math against plane/index/row/col (as sent by the
            # frontend, e.g. the contrast-mode sphere-VOI preview) needs this
            # one, not "spacing".
            "spacing_lps": [round(float(v), 6) for v in self.spacing_lps],
            "origin": [round(float(v), 6) for v in self.orig_origin],
            "direction": [round(float(v), 6) for v in self.orig_direction],
            "orientation": self.orientation_code,
            "dtype": self.dtype,
            "value_min": float(self.value_min),
            "value_max": float(self.value_max),
            "is_dicom_dir": self.is_dicom_dir,
            "shape_lps": [int(nx), int(ny), int(nz)],
            "plane_lengths": {
                "axial": int(nz),
                "sagittal": int(nx),
                "coronal": int(ny),
            },
            "labels": self.labels,
            "is_new_mask": self.is_new_mask,
        }


class VolumeStore:
    """Simple LRU cache of LoadedVolume keyed by volume_id (hash of abs path)."""

    def __init__(self, max_items: int = 12):
        self._max_items = max_items
        self._cache: "OrderedDict[str, LoadedVolume]" = OrderedDict()
        self._lock = threading.Lock()

    def load(self, path: str, is_mask: bool = False, force: bool = False) -> LoadedVolume:
        """force=True bypasses the cache hit and re-reads from disk even if
        already loaded, discarding any in-memory edits — used by "Reset" to
        revert a mask back to what's actually saved on disk."""
        path = os.path.abspath(clean_path(path))
        vol_id = _hash_id(path) + ("_mask" if is_mask else "")
        if not force:
            with self._lock:
                existing = self._cache.get(vol_id)
                if existing is not None:
                    self._cache.move_to_end(vol_id)
                    return existing

        if not os.path.exists(path):
            raise FileNotFoundError(path)

        is_dicom_dir = _is_dicom_dir(path)
        if is_dicom_dir:
            reader = sitk.ImageSeriesReader()
            series_ids = sitk.ImageSeriesReader.GetGDCMSeriesIDs(path)
            if not series_ids:
                raise ValueError(f"No DICOM series found in directory: {path}")
            file_names = sitk.ImageSeriesReader.GetGDCMSeriesFileNames(path, series_ids[0])
            reader.SetFileNames(file_names)
            image = reader.Execute()
        else:
            image = sitk.ReadImage(path)

        orig_spacing = image.GetSpacing()
        orig_origin = image.GetOrigin()
        orig_direction = image.GetDirection()
        orig_size = image.GetSize()

        try:
            reoriented = sitk.DICOMOrient(image, "LPS")
            orientation_code = "LPS"
        except Exception:
            reoriented = image
            orientation_code = "?"

        array = sitk.GetArrayFromImage(reoriented)  # (z=S, y=P, x=L)
        dtype_name = str(array.dtype)
        arr_f = array.astype(np.float32, copy=False)
        vmin = float(np.min(arr_f)) if arr_f.size else 0.0
        vmax = float(np.max(arr_f)) if arr_f.size else 1.0

        labels = None
        if is_mask:
            uniq = np.unique(array)
            labels = [int(v) for v in uniq if v != 0]

        vol = LoadedVolume(
            volume_id=vol_id,
            path=path,
            array=array,
            spacing_lps=reoriented.GetSpacing(),
            orig_spacing=orig_spacing,
            orig_origin=orig_origin,
            orig_direction=orig_direction,
            orig_size=orig_size,
            orientation_code=orientation_code,
            dtype=dtype_name,
            value_min=vmin,
            value_max=vmax,
            is_dicom_dir=is_dicom_dir,
            labels=labels,
            reoriented_origin=reoriented.GetOrigin(),
            reoriented_direction=reoriented.GetDirection(),
        )

        self._register(vol)
        return vol

    def _register(self, vol: LoadedVolume):
        with self._lock:
            self._cache[vol.volume_id] = vol
            self._cache.move_to_end(vol.volume_id)
            while len(self._cache) > self._max_items:
                self._cache.popitem(last=False)

    def get(self, volume_id: str) -> LoadedVolume:
        with self._lock:
            vol = self._cache.get(volume_id)
            if vol is None:
                raise KeyError(f"volume not loaded: {volume_id}")
            self._cache.move_to_end(volume_id)
            return vol

    def evict(self, volume_id: str):
        with self._lock:
            self._cache.pop(volume_id, None)

    def create_blank_mask(self, ct_vol: "LoadedVolume") -> "LoadedVolume":
        """Create a new all-zero label mask matching ct_vol's geometry, for
        annotating a scan that has no existing segmentation."""
        array = np.zeros_like(ct_vol.array, dtype=np.uint8)
        vol_id = "newmask_" + hashlib.sha1(os.urandom(16)).hexdigest()[:16]
        vol = LoadedVolume(
            volume_id=vol_id,
            path="",
            array=array,
            spacing_lps=ct_vol.spacing_lps,
            orig_spacing=ct_vol.orig_spacing,
            orig_origin=ct_vol.orig_origin,
            orig_direction=ct_vol.orig_direction,
            orig_size=ct_vol.orig_size,
            orientation_code=ct_vol.orientation_code,
            dtype=str(array.dtype),
            value_min=0.0,
            value_max=0.0,
            is_dicom_dir=False,
            labels=[],
            reoriented_origin=ct_vol.reoriented_origin,
            reoriented_direction=ct_vol.reoriented_direction,
            is_new_mask=True,
            source_ct_path=ct_vol.path,
        )
        self._register(vol)
        return vol


def get_plane_slice(vol: LoadedVolume, plane: str, index: int) -> np.ndarray:
    """Return a 2D array for the requested plane/index, oriented for display:
    row 0 = top of image, col 0 = left of image, following radiological
    convention (patient's right on screen-left) and superior-at-top for
    sagittal/coronal.
    """
    arr = vol.array
    nz, ny, nx = arr.shape
    index = max(0, min(index, vol.plane_length(plane) - 1))
    if plane == "axial":
        return arr[index, :, :]
    if plane == "sagittal":
        return np.flipud(arr[:, :, index])
    if plane == "coronal":
        return np.flipud(arr[:, index, :])
    raise ValueError(f"unknown plane {plane}")


def get_plane_pixel_spacing(vol: LoadedVolume, plane: str) -> tuple:
    """Physical spacing (row_mm, col_mm) of a raw plane slice's pixels, i.e.
    voxel size along the two in-plane axes. CT voxels are rarely cubic (e.g.
    0.7mm in-plane vs 1.5-5mm slice thickness), so a sagittal/coronal slice's
    raw pixel grid is anisotropic and must be rescaled before display or it
    looks stretched/zoomed relative to axial.
    """
    sx, sy, sz = vol.spacing_lps  # (L, P, S)
    if plane == "axial":
        return sy, sx  # row=P, col=L
    if plane == "sagittal":
        return sz, sy  # row=S, col=P
    if plane == "coronal":
        return sz, sx  # row=S, col=L
    raise ValueError(f"unknown plane {plane}")


def get_plane_display_scale(vol: LoadedVolume, plane: str) -> tuple:
    """Scale factors (scale_h, scale_w) applied to a raw plane slice to make
    its pixels isotropic in physical space, relative to the volume's finest
    spacing axis (so no axis is ever downsampled/blurred).
    """
    row_sp, col_sp = get_plane_pixel_spacing(vol, plane)
    target = min(vol.spacing_lps) or min(row_sp, col_sp) or 1.0
    return row_sp / target, col_sp / target


def get_plane_raw_view(vol: LoadedVolume, plane: str, index: int):
    """Writable 2D view directly into vol.array for the given plane/index
    (no copy). `flipped` tells the caller whether this view is upside-down
    relative to what get_plane_slice()/the display show (True for sagittal
    and coronal) — any edit mask built in display-row/col space must be
    np.flipud'd before being applied against this view when flipped=True.
    """
    arr = vol.array
    index = max(0, min(index, vol.plane_length(plane) - 1))
    if plane == "axial":
        return arr[index, :, :], False
    if plane == "sagittal":
        return arr[:, :, index], True
    if plane == "coronal":
        return arr[:, index, :], True
    raise ValueError(f"unknown plane {plane}")


def _display_to_view_coords(vol: LoadedVolume, plane: str, row: float, col: float, flipped: bool, view_shape: tuple):
    """Convert a display-space (row, col) — as sent by the frontend, in the
    rescaled/isotropic pixel space shown in the browser — to a float
    coordinate in the raw writable view's own space."""
    scale_h, scale_w = get_plane_display_scale(vol, plane)
    s_row = row / scale_h
    s_col = col / scale_w
    if flipped:
        s_row = (view_shape[0] - 1) - s_row
    return s_row, s_col


def _ellipse_mask(shape: tuple, center_row: float, center_col: float, radius_row: float, radius_col: float) -> np.ndarray:
    radius_row = max(radius_row, 0.5)
    radius_col = max(radius_col, 0.5)
    rows = np.arange(shape[0])[:, None]
    cols = np.arange(shape[1])[None, :]
    return (((rows - center_row) / radius_row) ** 2 + ((cols - center_col) / radius_col) ** 2) <= 1.0


def recompute_labels(mask_vol: LoadedVolume):
    uniq = np.unique(mask_vol.array)
    mask_vol.labels = [int(v) for v in uniq if v != 0]


def paint_mask(
    mask_vol: LoadedVolume,
    ct_vol: LoadedVolume,
    plane: str,
    index: int,
    row: float,
    col: float,
    radius: float,
    new_label: int,
    overwrite_mode: str = "any",
    overwrite_label: Optional[int] = None,
    threshold_min: Optional[float] = None,
) -> int:
    """Stamp an (elliptical, so it reads as a circle in the isotropic display)
    brush at display coordinates (row, col). Returns the number of voxels
    changed."""
    mask_view, flipped = get_plane_raw_view(mask_vol, plane, index)
    ct_view, _ = get_plane_raw_view(ct_vol, plane, index)

    scale_h, scale_w = get_plane_display_scale(ct_vol, plane)
    center_row, center_col = _display_to_view_coords(ct_vol, plane, row, col, flipped, mask_view.shape)
    radius_row = radius / scale_h
    radius_col = radius / scale_w

    brush = _ellipse_mask(mask_view.shape, center_row, center_col, radius_row, radius_col)

    if overwrite_mode == "label" and overwrite_label is not None:
        eligible = mask_view == overwrite_label
    elif overwrite_mode == "threshold" and threshold_min is not None:
        eligible = ct_view >= threshold_min
    else:
        eligible = np.ones(mask_view.shape, dtype=bool)

    final = brush & eligible
    changed = int(np.count_nonzero(final))
    if changed:
        mask_view[final] = new_label
        # Deliberately not recomputing mask_vol.labels here: np.unique() over
        # the full 3D volume is expensive (tens of millions of voxels for a
        # real CT), and this runs on every brush dab — up to ~25x/sec while
        # dragging. Recomputed once at stroke-end instead (see
        # /api/mask/refresh_labels), which is what the label list is actually
        # needed for (the "existing label" overwrite dropdown).
    return changed


MAX_REGION_GROW_VOXELS = 5_000_000


def _seed_index_3d(ct_vol: LoadedVolume, plane: str, index: int, row: float, col: float):
    """Convert a display-space click (plane, index, row, col) to a (z, y, x)
    index into the full 3D array — same axis order as vol.array (S, P, L)."""
    _, flipped = get_plane_raw_view(ct_vol, plane, index)
    view_row, view_col = _display_to_view_coords(ct_vol, plane, row, col, flipped, ct_vol.array.shape[:2])
    view_row = int(round(view_row))
    view_col = int(round(view_col))
    index = max(0, min(index, ct_vol.plane_length(plane) - 1))
    if plane == "axial":
        return index, view_row, view_col
    if plane == "sagittal":
        return view_row, view_col, index
    if plane == "coronal":
        return view_row, index, view_col
    raise ValueError(f"unknown plane {plane}")


def region_grow_mask(
    mask_vol: LoadedVolume,
    ct_vol: LoadedVolume,
    plane: str,
    index: int,
    row: float,
    col: float,
    threshold_min: float,
    new_label: int,
) -> int:
    """True 3D flood-fill over the whole volume starting at the clicked
    voxel, with 26-connectivity (every face/edge/corner neighbor — maximum
    possible connectivity for a voxel grid), over all connected voxels with
    CT value >= threshold_min. Returns the number of voxels changed."""
    from scipy import ndimage

    nz, ny, nx = ct_vol.array.shape
    z, y, x = _seed_index_3d(ct_vol, plane, index, row, col)
    if not (0 <= z < nz and 0 <= y < ny and 0 <= x < nx):
        return 0

    above = ct_vol.array >= threshold_min
    if not above[z, y, x]:
        return 0

    structure = np.ones((3, 3, 3), dtype=bool)  # 26-connectivity ("max connectivity")
    labeled, _ = ndimage.label(above, structure=structure)
    seed_component = labeled[z, y, x]
    region = labeled == seed_component

    changed = int(np.count_nonzero(region))
    if changed > MAX_REGION_GROW_VOXELS:
        raise ValueError(
            f"Region grow would affect {changed} voxels (limit {MAX_REGION_GROW_VOXELS}); "
            "raise the threshold to select a smaller connected region."
        )
    if changed:
        mask_vol.array[region] = new_label
        recompute_labels(mask_vol)
    return changed


def _insert_tag(path: str, tag: str, default_dir: str = "", default_stem: str = "") -> str:
    if path:
        dirn = os.path.dirname(path)
        base = os.path.basename(path)
    else:
        dirn = default_dir
        base = default_stem
    if base.lower().endswith(".nii.gz"):
        stem, ext = base[:-7], ".nii.gz"
    else:
        stem, ext = os.path.splitext(base)
        ext = ext or ".nii.gz"
    return os.path.join(dirn, f"{stem}_{tag}{ext}")


def save_mask(mask_vol: LoadedVolume, tag: Optional[str] = None) -> str:
    """Write the current in-memory mask array to disk, preserving the
    geometry it currently occupies (LPS-reoriented space). If the mask was
    loaded from a file, it's saved alongside it with the tag appended; if it
    was created fresh in-app (no source file), it's saved alongside the CT
    image instead.
    """
    if mask_vol.is_new_mask:
        tag = tag or "ManualAnnotations"
        ct_path = mask_vol.source_ct_path or ""
        out_path = _insert_tag(ct_path, tag)
    else:
        tag = tag or "ManualEdits"
        out_path = _insert_tag(mask_vol.path, tag)

    img = sitk.GetImageFromArray(mask_vol.array)
    img.SetSpacing(mask_vol.spacing_lps)
    img.SetOrigin(mask_vol.reoriented_origin)
    img.SetDirection(mask_vol.reoriented_direction)
    sitk.WriteImage(img, out_path)
    return out_path


def window_to_uint8(slice_arr: np.ndarray, level: float, width: float) -> np.ndarray:
    width = max(1e-3, float(width))
    lo = level - width / 2.0
    hi = level + width / 2.0
    clipped = np.clip(slice_arr.astype(np.float32), lo, hi)
    scaled = (clipped - lo) / (hi - lo) * 255.0
    return scaled.astype(np.uint8)


DEFAULT_LABEL_COLORS = {
    1: "#FF0000",  # Red
    2: "#00FF00",  # Green
    3: "#0000FF",  # Blue
    4: "#FFFF00",  # Yellow
    5: "#00FFFF",  # Cyan
    6: "#FF00FF",  # Magenta
}

DEFAULT_THRESHOLD_COLOR = "#FF8000"  # Orange - distinct hue from all 6 default label colors
DEFAULT_THRESHOLD_HU = 130.0


def _hex_to_rgb(hex_color: str) -> tuple:
    hex_color = hex_color.lstrip("#")
    return tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))


def render_composited_png(
    ct_vol: Optional[LoadedVolume],
    mask_vol: Optional[LoadedVolume],
    plane: str,
    index: int,
    window_level: float = 40.0,
    window_width: float = 400.0,
    mask_colors: Optional[dict] = None,
    mask_alpha: float = 0.5,
    show_mask: bool = True,
    threshold_enabled: bool = False,
    threshold_value: float = DEFAULT_THRESHOLD_HU,
    threshold_color: str = DEFAULT_THRESHOLD_COLOR,
    threshold_alpha: float = 0.5,
) -> bytes:
    if ct_vol is None:
        raise ValueError("ct_vol is required")

    ct_slice = get_plane_slice(ct_vol, plane, index)
    gray = window_to_uint8(ct_slice, window_level, window_width)

    scale_h, scale_w = get_plane_display_scale(ct_vol, plane)
    needs_resize = abs(scale_h - 1.0) > 1e-3 or abs(scale_w - 1.0) > 1e-3
    new_w = max(1, round(gray.shape[1] * scale_w))
    new_h = max(1, round(gray.shape[0] * scale_h))

    # Grayscale CT is resized with bilinear (smooth). Label/threshold overlays
    # are resized with nearest-neighbor so a display pixel never blends two
    # different labels' colors together — every voxel keeps exactly one label.
    if needs_resize:
        gray = np.array(Image.fromarray(gray).resize((new_w, new_h), Image.BILINEAR))

    rgb = np.stack([gray, gray, gray], axis=-1).astype(np.float32)

    if threshold_enabled:
        thr_mask = ct_slice >= threshold_value
        if needs_resize:
            thr_mask = (
                np.array(Image.fromarray(thr_mask.astype(np.uint8) * 255).resize((new_w, new_h), Image.NEAREST)) > 0
            )
        if np.any(thr_mask):
            color = np.array(_hex_to_rgb(threshold_color), dtype=np.float32)
            a = float(threshold_alpha)
            rgb[thr_mask] = rgb[thr_mask] * (1 - a) + color * a

    if show_mask and mask_vol is not None:
        mask_slice = get_plane_slice(mask_vol, plane, index)
        if needs_resize:
            mask_slice = np.array(Image.fromarray(mask_slice).resize((new_w, new_h), Image.NEAREST))
        colors = mask_colors or DEFAULT_LABEL_COLORS
        a = float(mask_alpha)
        for label_str, hex_color in colors.items():
            try:
                label_val = int(label_str)
            except (TypeError, ValueError):
                continue
            if label_val == 0:
                continue
            sel = mask_slice == label_val
            if not np.any(sel):
                continue
            color = np.array(_hex_to_rgb(hex_color), dtype=np.float32)
            rgb[sel] = rgb[sel] * (1 - a) + color * a

    out = np.clip(rgb, 0, 255).astype(np.uint8)
    img = Image.fromarray(out, mode="RGB")

    buf = io.BytesIO()
    # This gets re-encoded on every render request, including on every brush
    # dab while actively painting — compress_level=1 trades a slightly
    # larger file (negligible on noisy CT data) for ~2x faster encoding,
    # since responsiveness during interactive editing matters far more than
    # a few % of extra bytes on a localhost connection.
    img.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


def probe_values(
    ct_vol: Optional[LoadedVolume],
    mask_vol: Optional[LoadedVolume],
    plane: str,
    index: int,
    row: int,
    col: int,
) -> dict:
    """row/col are in *display* pixel space (i.e. as shown in the browser,
    after the physical-spacing rescale applied in render_composited_png) and
    are converted back to raw array indices before lookup.
    """
    result = {"hu": None, "label": None}
    if ct_vol is not None:
        scale_h, scale_w = get_plane_display_scale(ct_vol, plane)
        raw_row = int(row / scale_h)
        raw_col = int(col / scale_w)
        s = get_plane_slice(ct_vol, plane, index)
        if 0 <= raw_row < s.shape[0] and 0 <= raw_col < s.shape[1]:
            result["hu"] = float(s[raw_row, raw_col])
        if mask_vol is not None:
            ms = get_plane_slice(mask_vol, plane, index)
            if 0 <= raw_row < ms.shape[0] and 0 <= raw_col < ms.shape[1]:
                result["label"] = int(ms[raw_row, raw_col])
    return result


store = VolumeStore()
