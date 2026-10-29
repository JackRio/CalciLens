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

import annotation_paths
from pathutil import clean_path

PLANES = ("axial", "sagittal", "coronal")


def _is_dicom_dir(path: str) -> bool:
    return os.path.isdir(path)


def _long_path_hint(directory: str) -> str:
    """Why a DICOM folder may be unreadable on Windows: the 260-character path
    limit. GDCM/ITK use the old Windows file APIs, so a file whose full path is
    longer than that is invisible to them unless the OS has long paths enabled
    (which is off by default). The same scan then loads from a shorter path,
    e.g. through a mapped drive. Returns "" when this isn't the problem."""
    if os.name != "nt":
        return ""
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\FileSystem") as key:
            if winreg.QueryValueEx(key, "LongPathsEnabled")[0]:
                return ""
    except OSError:
        pass
    try:
        longest = max((len(directory) + 1 + len(n) for n in os.listdir(directory)), default=0)
    except OSError:
        return ""
    if longest < 260:
        return ""
    return (
        f"This folder's file paths are {longest} characters long, over Windows' 260-character limit, "
        "so the DICOM files can't be read. Use a shorter path to the same folder (for example a mapped drive "
        "that starts closer to it), or turn on Windows long paths."
    )


def _find_dicom_series(root: str) -> tuple[str, str, list]:
    """Return (series_dir, series_uid, file_names) for the first directory
    (root itself, or any subdirectory, walked top-down and alphabetically)
    that contains a readable GDCM series. Previously only `root` itself was
    checked, so a DICOM series nested in a subfolder (rather than sitting
    directly in the chosen folder) silently failed to load. Raises
    ValueError if no series is found anywhere under root.

    Only the FIRST series id in a directory is used here even when a folder
    holds several — this is the auto-pick fallback for callers that don't
    care which series (mask loading, or any load with no explicit
    series_uid). See _find_all_dicom_series for enumerating every series."""
    for dirpath, dirnames, _ in os.walk(root):
        dirnames.sort()
        series_ids = sitk.ImageSeriesReader.GetGDCMSeriesIDs(dirpath)
        if series_ids:
            return dirpath, series_ids[0], sitk.ImageSeriesReader.GetGDCMSeriesFileNames(dirpath, series_ids[0])
    raise ValueError(f"No DICOM series found under directory: {root}")


def _find_all_dicom_series(root: str) -> list:
    """Return every (dirpath, series_uid) pair found anywhere under root —
    unlike _find_dicom_series, this does not stop at the first directory
    that has a series, and it does not stop at the first series id within a
    directory either, so a folder holding multiple series (the common case
    this exists for) yields all of them. Stable order: sorted by directory,
    then series_uid."""
    pairs = []
    for dirpath, dirnames, _ in os.walk(root):
        dirnames.sort()
        series_ids = sitk.ImageSeriesReader.GetGDCMSeriesIDs(dirpath)
        for series_id in series_ids:
            pairs.append((dirpath, series_id))
    pairs.sort()
    return pairs


# Single-file formats worth offering when scanning a folder. .raw/.zraw are
# the data half of an .mhd/.nhdr pair and must not be listed on their own.
IMAGE_FILE_SUFFIXES = (".nii.gz", ".nii", ".mha", ".mhd", ".nrrd", ".nhdr")


def _find_image_files(root: str) -> list:
    """Every readable single-file image (NIfTI/MHA/MHD/NRRD) anywhere under
    root, sorted by path. Only the extension is checked here — actually
    opening each file to validate it would make scanning a big tree slow, and
    a bad file reports its own error when it is loaded."""
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if name.lower().endswith(IMAGE_FILE_SUFFIXES):
                found.append(os.path.join(dirpath, name))
    return found


def _series_description(dirpath: str, series_id: str, file_names) -> str:
    """Best-effort SeriesDescription (DICOM tag 0008,103e) for one series, to
    show as a hover hint in the series picker. Never raises — an empty
    string means "no description available", not an error."""
    if not file_names:
        return ""
    try:
        reader = sitk.ImageFileReader()
        reader.SetFileName(file_names[0])
        reader.LoadPrivateTagsOn()
        reader.ReadImageInformation()
        return reader.GetMetaData("0008|103e").strip()
    except Exception:
        return ""


def _tag_float(reader, index: int, key: str) -> Optional[float]:
    """One numeric DICOM tag of slice `index`, or None when absent/garbled."""
    try:
        value = reader.GetMetaData(index, key).strip()
        return float(value.split("\\")[0]) if value else None
    except Exception:
        return None


def _tag_text(reader, index: int, key: str) -> str:
    try:
        return reader.GetMetaData(index, key).strip()
    except Exception:
        return ""


def _dicom_acquisition(reader, image, file_count: int) -> dict:
    """What the DICOM headers say about how the scan was acquired: slice
    thickness (0018,0050), tube voltage (0018,0060), reconstruction kernel
    (0018,1210), and whether the slices are evenly spaced. Best effort: every
    field can come back None. The image's own z spacing is reported next to
    them because that, not the thickness tag, is what the score scales by."""
    info = {
        "source": "dicom",
        "slice_thickness_mm": _tag_float(reader, 0, "0018|0050"),
        "kvp": _tag_float(reader, 0, "0018|0060"),
        "kernel": _tag_text(reader, 0, "0018|1210") or None,
        "non_uniform_spacing": False,
        "spacing_variation_mm": 0.0,
    }
    try:
        # Position of each slice along the slice normal.
        d = image.GetDirection()
        normal = np.array([d[2], d[5], d[8]], dtype=np.float64)
        positions = []
        for k in range(file_count):
            raw = _tag_text(reader, k, "0020|0032")
            if not raw:
                positions = []
                break
            ipp = np.array([float(v) for v in raw.split("\\")], dtype=np.float64)
            positions.append(float(ipp @ normal))
        if len(positions) > 2:
            gaps = np.abs(np.diff(np.sort(positions)))
            median = float(np.median(gaps))
            variation = float(np.max(np.abs(gaps - median)))
            info["spacing_variation_mm"] = round(variation, 4)
            info["non_uniform_spacing"] = bool(median > 0 and variation > 0.05 * median)
    except Exception:
        pass
    return info


def _hash_id(path: str, series_uid: Optional[str] = None) -> str:
    key = os.path.normcase(os.path.abspath(path)) + "|" + (series_uid or "")
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


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
    dicom_series_uid: Optional[str] = None  # SeriesInstanceUID, when path is a DICOM directory —
    # used instead of the folder's basename for save-path naming (see
    # annotation_paths.scan_folder_name), since a folder can hold multiple series and the
    # basename alone can't disambiguate them.
    dirty: bool = False  # has unsaved in-memory edits — see VolumeStore._register
    # How the scan was acquired, as far as the file says (see _dicom_acquisition).
    acquisition: dict = field(default_factory=dict)

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
            # Where the (LPS-reoriented) array really sits in the world:
            # origin of voxel [0,0,0] and the axis directions. Two volumes only
            # line up voxel-for-voxel when these match, not just their shape.
            "origin_lps": [round(float(v), 6) for v in (self.reoriented_origin or self.orig_origin)],
            "direction_lps": [round(float(v), 6) for v in (self.reoriented_direction or self.orig_direction)],
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
            "dicom_series_uid": self.dicom_series_uid,
            "acquisition": {
                # Non-DICOM files have no thickness tag: only the spacing is known.
                "source": "image",
                "slice_thickness_mm": None,
                "kvp": None,
                "kernel": None,
                "non_uniform_spacing": False,
                "spacing_variation_mm": 0.0,
                **(self.acquisition or {}),
                "slice_spacing_mm": round(float(self.spacing_lps[2]), 6) if self.spacing_lps[2] else None,
            },
        }


class VolumeStore:
    """Simple LRU cache of LoadedVolume keyed by volume_id (hash of abs path)."""

    def __init__(self, max_items: int = 24):
        self._max_items = max_items
        self._cache: "OrderedDict[str, LoadedVolume]" = OrderedDict()
        self._lock = threading.Lock()

    def load(
        self,
        path: str,
        is_mask: bool = False,
        force: bool = False,
        series_uid: Optional[str] = None,
    ) -> LoadedVolume:
        """force=True bypasses the cache hit and re-reads from disk even if
        already loaded, discarding any in-memory edits — used by "Reset" to
        revert a mask back to what's actually saved on disk.

        series_uid selects one specific series out of a DICOM directory that
        may hold several — the frontend passes it whenever it already knows
        which series it wants (from /api/volumes/list_dicom_series), so this
        loads that exact series instead of auto-picking the first one found.
        Two different series at the same directory path must not collide on
        the same cache entry, so series_uid is folded into the hash key.
        """
        path = os.path.abspath(clean_path(path))
        vol_id = _hash_id(path, series_uid) + ("_mask" if is_mask else "")
        if not force:
            with self._lock:
                existing = self._cache.get(vol_id)
                if existing is not None:
                    self._cache.move_to_end(vol_id)
                    return existing

        if not os.path.exists(path):
            raise FileNotFoundError(path)

        is_dicom_dir = _is_dicom_dir(path)
        resolved_series_uid = series_uid
        if is_dicom_dir:
            try:
                reader = sitk.ImageSeriesReader()
                reader.MetaDataDictionaryArrayUpdateOn()
                if series_uid:
                    file_names = sitk.ImageSeriesReader.GetGDCMSeriesFileNames(path, series_uid)
                else:
                    _, resolved_series_uid, file_names = _find_dicom_series(path)
                reader.SetFileNames(file_names)
                image = reader.Execute()
            except Exception as e:
                hint = _long_path_hint(path)
                if hint:
                    raise ValueError(hint) from e
                raise
            acquisition = {} if is_mask else _dicom_acquisition(reader, image, len(file_names))
        else:
            image = sitk.ReadImage(path)
            acquisition = {}

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
            _assert_looks_like_mask(uniq)
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
            dicom_series_uid=resolved_series_uid if is_dicom_dir else None,
            acquisition=acquisition,
        )

        self._register(vol)
        return vol

    def _register(self, vol: LoadedVolume):
        with self._lock:
            self._cache[vol.volume_id] = vol
            self._cache.move_to_end(vol.volume_id)
            self._evict_locked()

    def _evict_locked(self):
        """Drop least-recently-used entries, but NEVER one holding unsaved
        work.

        A brand-new in-app mask exists only here — it has no file on disk at
        all — and an edited-but-unsaved mask's changes likewise live only in
        this array. Evicting either silently destroys annotation work, and
        the client only finds out when the next paint request 404s. A CT is
        always safe to evict: it can be re-read from disk unchanged.

        If everything in the cache is unevictable the cache is simply allowed
        to grow. Using more memory is strictly better than discarding work
        the user cannot get back.
        """
        while len(self._cache) > self._max_items:
            evictable = next(
                (vid for vid, v in self._cache.items() if not (v.dirty or v.is_new_mask)),
                None,
            )
            if evictable is None:
                return
            self._cache.pop(evictable)

    def get(self, volume_id: str) -> LoadedVolume:
        with self._lock:
            vol = self._cache.get(volume_id)
            if vol is None:
                raise KeyError(f"volume not loaded: {volume_id}")
            self._cache.move_to_end(volume_id)
            return vol

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
            dicom_series_uid=ct_vol.dicom_series_uid,
        )
        self._register(vol)
        return vol


# Display-only orientation flips, named by patient axis. The volume is always
# held as LPS; these mirror what is *shown* (radiological <-> neurological and
# the like) without touching the data. Only the read-only render/probe paths
# accept them: editing endpoints convert display coordinates back to voxels
# without knowing about flips, so they must never be given a flipped view.
def parse_display_flips(flip: Optional[str]) -> tuple:
    """"l" = mirror left-right, "a" = mirror anterior-posterior, "s" = mirror
    superior-inferior. Any combination; unknown letters are ignored."""
    f = (flip or "").lower()
    return ("l" in f, "a" in f, "s" in f)


def _plane_flip_axes(plane: str, flips: tuple) -> tuple:
    """(flip_horizontal, flip_vertical) for one plane. Axial shows L-R across
    and A-P down, coronal L-R across and S-I down, sagittal A-P across and
    S-I down."""
    lr, ap, si = flips
    if plane == "axial":
        return lr, ap
    if plane == "coronal":
        return lr, si
    if plane == "sagittal":
        return ap, si
    raise ValueError(f"unknown plane {plane}")


def get_plane_slice(vol: LoadedVolume, plane: str, index: int, flips: tuple = (False, False, False)) -> np.ndarray:
    """Return a 2D array for the requested plane/index, oriented for display:
    row 0 = top of image, col 0 = left of image, following radiological
    convention (patient's right on screen-left) and superior-at-top for
    sagittal/coronal. `flips` (see parse_display_flips) mirrors that on
    request.
    """
    arr = vol.array
    nz, ny, nx = arr.shape
    index = max(0, min(index, vol.plane_length(plane) - 1))
    if plane == "axial":
        out = arr[index, :, :]
    elif plane == "sagittal":
        out = np.flipud(arr[:, :, index])
    elif plane == "coronal":
        out = np.flipud(arr[:, index, :])
    else:
        raise ValueError(f"unknown plane {plane}")
    flip_h, flip_v = _plane_flip_axes(plane, flips)
    if flip_h:
        out = np.fliplr(out)
    if flip_v:
        out = np.flipud(out)
    return out


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


def _display_to_view_coords(
    vol: LoadedVolume,
    plane: str,
    row: float,
    col: float,
    flipped: bool,
    view_shape: tuple,
    flips: tuple = (False, False, False),
):
    """Convert a display-space (row, col) — as sent by the frontend, in the
    rescaled/isotropic pixel space shown in the browser — to a float
    coordinate in the raw writable view's own space.

    `flips` are the display-only mirrors the slice was drawn with (see
    parse_display_flips). They are undone first, in the display slice's own
    row/col space, so that a click on a mirrored image lands on the voxel that
    is actually drawn there."""
    scale_h, scale_w = get_plane_display_scale(vol, plane)
    s_row = row / scale_h
    s_col = col / scale_w
    flip_h, flip_v = _plane_flip_axes(plane, flips)
    if flip_h:
        s_col = (view_shape[1] - 1) - s_col
    if flip_v:
        s_row = (view_shape[0] - 1) - s_row
    if flipped:
        s_row = (view_shape[0] - 1) - s_row
    return s_row, s_col


def _ellipse_mask(shape: tuple, center_row: float, center_col: float, radius_row: float, radius_col: float) -> np.ndarray:
    radius_row = max(radius_row, 0.5)
    radius_col = max(radius_col, 0.5)
    rows = np.arange(shape[0])[:, None]
    cols = np.arange(shape[1])[None, :]
    return (((rows - center_row) / radius_row) ** 2 + ((cols - center_col) / radius_col) ** 2) <= 1.0


# More distinct values than any segmentation has (TotalSegmentator, the
# largest common one, has ~120 classes); a CT has thousands.
MAX_MASK_LABELS = 1000


def _assert_looks_like_mask(uniq: np.ndarray) -> None:
    """Refuse an image opened as a segmentation (e.g. the CT itself dropped as
    one). Every HU value would become its own label, which the label list,
    colours and renderer cannot cope with. Only a count / non-integer test: a
    guess at label *values* false-positived on real whole-heart masks. Labels
    are never negative; a CT always is somewhere (air, padding)."""
    if len(uniq) and uniq[0] < 0:
        raise ValueError("This looks like an image, not a segmentation (it has negative values). Open it as an image instead.")
    if uniq.dtype.kind == "f" and not np.all(np.mod(uniq, 1) == 0):
        raise ValueError("This looks like an image, not a segmentation (it has fractional values). Open it as an image instead.")
    if len(uniq) > MAX_MASK_LABELS:
        raise ValueError(f"This looks like an image, not a segmentation ({len(uniq)} different values). Open it as an image instead.")


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
    flips: tuple = (False, False, False),
) -> int:
    """Stamp an (elliptical, so it reads as a circle in the isotropic display)
    brush at display coordinates (row, col). Returns the number of voxels
    changed."""
    assert_same_geometry(mask_vol, ct_vol)
    mask_view, flipped = get_plane_raw_view(mask_vol, plane, index)
    ct_view, _ = get_plane_raw_view(ct_vol, plane, index)

    scale_h, scale_w = get_plane_display_scale(ct_vol, plane)
    center_row, center_col = _display_to_view_coords(ct_vol, plane, row, col, flipped, mask_view.shape, flips)
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
        mask_vol.dirty = True
        # Deliberately not recomputing mask_vol.labels here: np.unique() over
        # the full 3D volume is expensive (tens of millions of voxels for a
        # real CT), and this runs on every brush dab — up to ~25x/sec while
        # dragging. Recomputed once at stroke-end instead (see
        # /api/mask/refresh_labels), which is what the label list is actually
        # needed for (the "existing label" overwrite dropdown).
    return changed


MAX_REGION_GROW_VOXELS = 5_000_000
MAX_SEARCH_RADIUS_MM = 20.0  # server-side clamp regardless of what the client sends


def _nearest_qualifying_voxel(condition: np.ndarray, z: int, y: int, x: int, radius=(1, 1, 1)):
    """If (z,y,x) already satisfies `condition`, return it as-is. Otherwise
    search the box of half-widths radius=(rz,ry,rx) around it (clipped to
    array bounds) and return the closest voxel (by Euclidean distance) that
    satisfies `condition`, or None if none do.

    Both region-grow and lesion scoring previously required the *exact*
    clicked voxel to already qualify before running ndimage.label — fine for
    a lesion spanning many voxels, but a 1-2 voxel lesion has zero margin for
    the sub-pixel rounding in _seed_index_3d, so an off-by-one click missed
    it entirely. The default radius=(1,1,1) is an always-on, small tolerance
    for that; a caller-supplied larger radius (see _voxel_radius_from_mm)
    backs the user-driven Shift+click circle-seed feature.
    """
    if condition[z, y, x]:
        return z, y, x
    nz, ny, nx = condition.shape
    rz, ry, rx = radius
    best, best_d2 = None, None
    for dz in range(-rz, rz + 1):
        for dy in range(-ry, ry + 1):
            for dx in range(-rx, rx + 1):
                if dz == dy == dx == 0:
                    continue
                zz, yy, xx = z + dz, y + dy, x + dx
                if 0 <= zz < nz and 0 <= yy < ny and 0 <= xx < nx and condition[zz, yy, xx]:
                    d2 = dz * dz + dy * dy + dx * dx
                    if best_d2 is None or d2 < best_d2:
                        best, best_d2 = (zz, yy, xx), d2
    return best


def _voxel_radius_from_mm(spacing_lps, radius_mm: Optional[float]) -> tuple:
    """Convert a physical mm search radius to a per-axis voxel radius
    (rz, ry, rx) matching the array's own axis order. spacing_lps is
    (sx, sy, sz); with no radius given, fall back to the always-on 1-voxel
    tolerance."""
    if not radius_mm:
        return (1, 1, 1)
    radius_mm = min(radius_mm, MAX_SEARCH_RADIUS_MM)
    sx, sy, sz = spacing_lps
    return (
        max(1, round(radius_mm / sz)),
        max(1, round(radius_mm / sy)),
        max(1, round(radius_mm / sx)),
    )


def _seed_index_3d(
    ct_vol: LoadedVolume, plane: str, index: int, row: float, col: float, flips: tuple = (False, False, False)
):
    """Convert a display-space click (plane, index, row, col) to a (z, y, x)
    index into the full 3D array — same axis order as vol.array (S, P, L)."""
    raw_view, flipped = get_plane_raw_view(ct_vol, plane, index)
    view_row, view_col = _display_to_view_coords(ct_vol, plane, row, col, flipped, raw_view.shape, flips)
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
    search_radius_mm: Optional[float] = None,
    flips: tuple = (False, False, False),
) -> int:
    """True 3D flood-fill over the whole volume starting at the clicked
    voxel, with 26-connectivity (every face/edge/corner neighbor — maximum
    possible connectivity for a voxel grid), over all connected voxels with
    CT value >= threshold_min. Returns the number of voxels changed.

    search_radius_mm widens the seed lookup beyond the exact clicked voxel
    (see _nearest_qualifying_voxel) — None uses the always-on 1-voxel
    tolerance; a larger value backs the Shift+click circle-seed feature for
    tiny/isolated qualifying voxels the exact click missed.
    """
    from scipy import ndimage

    assert_same_geometry(mask_vol, ct_vol)
    nz, ny, nx = ct_vol.array.shape
    z, y, x = _seed_index_3d(ct_vol, plane, index, row, col, flips)
    if not (0 <= z < nz and 0 <= y < ny and 0 <= x < nx):
        return 0

    above = ct_vol.array >= threshold_min
    seed = _nearest_qualifying_voxel(above, z, y, x, _voxel_radius_from_mm(ct_vol.spacing_lps, search_radius_mm))
    if seed is None:
        return 0
    z, y, x = seed

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
        mask_vol.dirty = True
        recompute_labels(mask_vol)
    return changed


def assert_same_geometry(mask_vol: LoadedVolume, ct_vol: LoadedVolume) -> None:
    """Refuse to let a mask and CT of different shapes be used together.

    Nothing used to check this. Every slice lookup clamps its index against
    the volume it came from *independently* (see get_plane_raw_view), so a
    mask with fewer slices than the CT didn't error — viewing CT slice 200
    and painting wrote into the mask's last slice instead, and that wrong
    data then got saved. A loud failure is the only safe behavior here: a
    silent partial write is worse than no write at all.
    """
    if mask_vol.array.shape != ct_vol.array.shape:
        raise ValueError(
            f"Mask and CT geometry do not match: mask is {tuple(int(v) for v in mask_vol.array.shape)} "
            f"(z,y,x), CT is {tuple(int(v) for v in ct_vol.array.shape)}. "
            "They must be the same volume geometry to be edited or scored together."
        )
    problems = alignment_problems(mask_vol, ct_vol)
    if problems:
        raise ValueError(
            f"The mask is the same size as the CT but {' and '.join(problems)}, so it does not line up "
            "with the anatomy. It cannot be edited or scored against this scan."
        )


def alignment_problems(mask_vol: LoadedVolume, ct_vol: LoadedVolume) -> list:
    """How a same-shaped mask sits differently from the CT (position, voxel
    spacing, orientation). Empty when they line up. A volume without the
    geometry (older objects) is given the benefit of the doubt."""
    mo, co = mask_vol.reoriented_origin, ct_vol.reoriented_origin
    md, cd = mask_vol.reoriented_direction, ct_vol.reoriented_direction
    problems = []
    try:
        min_spacing = min(float(v) for v in ct_vol.spacing_lps)
        if mo is not None and co is not None:
            shift = float(np.linalg.norm(np.array(mo, dtype=np.float64) - np.array(co, dtype=np.float64)))
            if shift > 0.1 * min_spacing:
                problems.append(f"its position is {shift:.1f} mm away from the CT's")
        if any(abs(float(m) - float(c)) > 1e-3 * float(c) for m, c in zip(mask_vol.spacing_lps, ct_vol.spacing_lps)):
            problems.append("its voxel spacing differs")
        if md is not None and cd is not None and max(abs(float(m) - float(c)) for m, c in zip(md, cd)) > 1e-3:
            problems.append("its orientation differs")
    except (TypeError, ValueError):
        return []
    return problems


def _atomic_write_image(img: "sitk.Image", out_path: str) -> None:
    """Write via a temp file in the same directory, then os.replace().

    Annotation files were previously written straight over the destination,
    so a crash or a hard kill mid-write (Electron kills the Python process on
    window close) truncated the file — and the previous good version was
    already gone. Manifest writes and seed sidecars were made atomic long
    ago; the annotations themselves, the most valuable output this app has,
    were not. os.replace is atomic on both POSIX and Windows.

    The temp file has to keep the real extension: SimpleITK picks its writer
    from the path's extension, and ".nii.gz.tmp" has no writer.
    """
    dirn = os.path.dirname(out_path) or "."
    os.makedirs(dirn, exist_ok=True)
    tmp_path = annotation_paths._temp_path(dirn, os.path.basename(out_path))
    try:
        sitk.WriteImage(img, tmp_path)
        os.replace(tmp_path, out_path)
    finally:
        annotation_paths._cleanup(tmp_path)


def _image_on_ct_grid(mask_vol: LoadedVolume, ct_vol: Optional[LoadedVolume]) -> "sitk.Image":
    """The mask as a SimpleITK image laid out on the CT's own voxel grid.

    In memory everything is reoriented to LPS, so writing the array back with
    the LPS header gave an annotation whose axes/direction differed from the CT
    it was drawn on (e.g. a CT stored RAS or with flipped slices). Physically
    aligned, but other tools (ITK-SNAP) then showed it flipped or refused to
    treat it as the same grid. Undoing the reorientation is an exact
    permute/flip of voxels, no resampling.
    """
    img = sitk.GetImageFromArray(mask_vol.array)
    img.SetSpacing(mask_vol.spacing_lps)
    img.SetOrigin(mask_vol.reoriented_origin)
    img.SetDirection(mask_vol.reoriented_direction)
    if ct_vol is None or ct_vol.orientation_code != "LPS" or not ct_vol.orig_direction:
        return img
    try:
        code = sitk.DICOMOrientImageFilter.GetOrientationFromDirectionCosines(ct_vol.orig_direction)
        out = sitk.DICOMOrient(img, code)
        if tuple(out.GetSize()) != tuple(ct_vol.orig_size):
            return img
        close = lambda a, b: max(abs(float(x) - float(y)) for x, y in zip(a, b)) < 1e-3
        if close(out.GetOrigin(), ct_vol.orig_origin) and close(out.GetDirection(), ct_vol.orig_direction):
            # Same grid; take the CT's header values verbatim.
            out.SetOrigin(ct_vol.orig_origin)
            out.SetDirection(ct_vol.orig_direction)
            out.SetSpacing(ct_vol.orig_spacing)
            return out
    except Exception:
        pass
    return img


def save_mask(
    mask_vol: LoadedVolume,
    ct_path: str,
    series_uid: Optional[str] = None,
    base_dir: Optional[str] = None,
    annotation_type: Optional[str] = None,
    patient_id: Optional[str] = None,
    resolution: Optional[str] = None,
    mask_source: Optional[str] = None,
    scoring: Optional[dict] = None,
    ct_vol: Optional[LoadedVolume] = None,
) -> dict:
    """Write the current in-memory mask into this scan's own annotation
    folder, preserving the geometry it currently occupies (LPS-reoriented
    space).

    The destination is derived from the **CT**, never from whatever mask
    happens to be loaded. Deriving it from the loaded mask is what made
    filenames grow a suffix per session ("X_ManualAnnotations_ManualEdits...")
    and left each previous save orphaned, since re-saving produced a
    different path every time. Keyed off the CT, re-saving the same scan
    lands on the same path and is an update.

    Returns either {"status": "saved", ...} or, when something is already at
    the destination, {"status": "conflict", ...} without writing anything —
    the caller asks the user and calls back with `resolution`.
    """
    try:
        target = annotation_paths.resolve_target(ct_path, series_uid, base_dir, resolution)
    except annotation_paths.SaveDirRequired as e:
        # Not an error: the caller asks the user where to save and tries again.
        return {"status": "needs_save_dir", "reason": e.reason, "message": str(e)}
    if target["conflict"]:
        return {"status": "conflict", **target}

    img = _image_on_ct_grid(mask_vol, ct_vol)
    _atomic_write_image(img, target["annotation_path"])

    record = annotation_paths.write_source_record(
        target["scan_dir"],
        ct_path=ct_path,
        series_uid=series_uid,
        patient_id=patient_id,
        annotation_type=annotation_type,
        source_mask_path=mask_vol.path or None,
        mask_source=mask_source,
        scoring=scoring,
        stats={
            "labels": [int(v) for v in np.unique(mask_vol.array) if v != 0],
            "labelled_voxels": int(np.count_nonzero(mask_vol.array)),
        },
    )
    mask_vol.dirty = False
    return {
        "status": "saved",
        "path": target["annotation_path"],
        "scan_dir": target["scan_dir"],
        "folder_name": target["folder_name"],
        "source_record": record,
    }


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
    flips: tuple = (False, False, False),
) -> bytes:
    if ct_vol is None:
        raise ValueError("ct_vol is required")

    ct_slice = get_plane_slice(ct_vol, plane, index, flips)
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
        mask_slice = get_plane_slice(mask_vol, plane, index, flips)
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
    flips: tuple = (False, False, False),
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
        s = get_plane_slice(ct_vol, plane, index, flips)
        if 0 <= raw_row < s.shape[0] and 0 <= raw_col < s.shape[1]:
            result["hu"] = float(s[raw_row, raw_col])
        if mask_vol is not None:
            ms = get_plane_slice(mask_vol, plane, index, flips)
            if 0 <= raw_row < ms.shape[0] and 0 <= raw_col < ms.shape[1]:
                result["label"] = int(ms[raw_row, raw_col])
    return result


store = VolumeStore()
