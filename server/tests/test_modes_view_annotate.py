"""Regression tests for the View / Annotate screens' backend behaviour.

Covers: where annotations may be saved, display-only flips (which must never
move a brush stroke to the wrong voxel), on-screen orientation, and the
world-position fields used for the mask alignment warning. Run with:

    .venv/Scripts/python.exe -m pytest server/tests -v
"""
from __future__ import annotations

import itertools
import os
import random
import sys

import numpy as np
import pytest
import SimpleITK as sitk

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import volume_store as vs  # noqa: E402

NX, NY, NZ = 41, 37, 23


def write_ct(path, arr, spacing=(0.8, 0.8, 2.5), origin=(0.0, 0.0, 0.0)):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing(spacing)
    img.SetOrigin(origin)
    sitk.WriteImage(img, path)
    return path


@pytest.fixture
def unique_ct(tmp_path):
    """A CT where every voxel has its own value, so a displayed pixel names exactly one voxel."""
    arr = np.arange(NZ * NY * NX, dtype=np.float32).reshape(NZ, NY, NX)
    path = write_ct(str(tmp_path / "ct" / "scan.nii.gz"), arr)
    store = vs.VolumeStore()
    return store, store.load(path, False, False), path


# --------------------------------------------------------------------------
# Saving never lands beside the image, and only where the user chose
# --------------------------------------------------------------------------


def test_save_without_a_chosen_folder_asks_instead_of_writing(unique_ct):
    store, ct, ct_path = unique_ct
    mask = store.create_blank_mask(ct)
    res = vs.save_mask(mask, ct_path, base_dir=None)
    assert res["status"] == "needs_save_dir" and res["reason"] == "missing"
    assert os.listdir(os.path.dirname(ct_path)) == ["scan.nii.gz"]


def test_save_refuses_the_images_own_folder(unique_ct):
    store, ct, ct_path = unique_ct
    mask = store.create_blank_mask(ct)
    res = vs.save_mask(mask, ct_path, base_dir=os.path.dirname(ct_path))
    assert res["status"] == "needs_save_dir" and res["reason"] == "same_as_image"
    assert os.listdir(os.path.dirname(ct_path)) == ["scan.nii.gz"]


def test_save_goes_into_the_chosen_folder_only(unique_ct, tmp_path):
    store, ct, ct_path = unique_ct
    mask = store.create_blank_mask(ct)
    out = str(tmp_path / "out")
    res = vs.save_mask(mask, ct_path, base_dir=out)
    assert res["status"] == "saved"
    assert os.path.normcase(res["path"]).startswith(os.path.normcase(out))
    assert os.listdir(os.path.dirname(ct_path)) == ["scan.nii.gz"]


# --------------------------------------------------------------------------
# Display flips: what is drawn, and where a click lands, always agree
# --------------------------------------------------------------------------


@pytest.mark.parametrize("plane", ["axial", "sagittal", "coronal"])
def test_brush_lands_on_the_drawn_voxel_under_every_flip(unique_ct, plane):
    store, ct, _ = unique_ct
    mask = store.create_blank_mask(ct)
    rng = random.Random(3)
    scale_h, scale_w = vs.get_plane_display_scale(ct, plane)
    for flips in itertools.product([False, True], repeat=3):
        for _ in range(6):
            index = rng.randrange(ct.plane_length(plane))
            shown = vs.get_plane_slice(ct, plane, index, flips)
            r, c = rng.randrange(shown.shape[0]), rng.randrange(shown.shape[1])
            want = shown[r, c]  # the CT value drawn at that pixel
            mask.array[:] = 0
            # The client sends a whole display-pixel index.
            vs.paint_mask(mask, ct, plane, index, (r + 0.5) * scale_h - 0.5, (c + 0.5) * scale_w - 0.5, 0.2, 7, flips=flips)
            painted = np.argwhere(mask.array == 7)
            assert len(painted) == 1, (plane, flips)
            assert ct.array[tuple(painted[0])] == want, (plane, flips)


def test_flips_move_a_marker_the_way_the_names_say(tmp_path):
    """A marker at Left-Anterior-Superior: mirrored L-R it moves across on axial/coronal
    and not on sagittal; mirrored A-P it moves down on axial and across on sagittal."""
    arr = np.full((NZ, NY, NX), -1000, np.int16)
    arr[NZ - 6 : NZ - 2, 2:6, NX - 8 : NX - 3] = 500  # high x = Left, low y = Anterior, high z = Superior
    path = write_ct(str(tmp_path / "v.nii.gz"), arr)
    vol = vs.VolumeStore().load(path, False, False)

    def where(plane, flip):
        f = vs.parse_display_flips(flip)
        for i in range(vol.plane_length(plane)):
            sl = vs.get_plane_slice(vol, plane, i, f) > 0
            if sl.any():
                ys, xs = np.nonzero(sl)
                return ("top" if ys.mean() / sl.shape[0] < 0.5 else "bottom") + "-" + (
                    "left" if xs.mean() / sl.shape[1] < 0.5 else "right"
                )

    # Radiological: patient-left on screen-right; sagittal has the patient facing screen-left.
    assert (where("axial", ""), where("coronal", ""), where("sagittal", "")) == ("top-right", "top-right", "top-left")
    assert (where("axial", "l"), where("coronal", "l"), where("sagittal", "l")) == ("top-left", "top-left", "top-left")
    assert where("axial", "a") == "bottom-right" and where("sagittal", "a") == "top-right"
    assert where("coronal", "s") == "bottom-right" and where("sagittal", "s") == "bottom-left"


@pytest.mark.parametrize("code", ["LPS", "RAS", "LAS", "RPI", "PIR", "ASL"])
def test_orientation_is_right_whatever_the_file_stores(tmp_path, code):
    """The same Left-Anterior-Superior marker, saved in six different orientations,
    must display in the same place."""
    arr = np.full((NZ, NY, NX), -1000, np.int16)
    arr[NZ - 6 : NZ - 2, 2:6, NX - 8 : NX - 3] = 500
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing((0.7, 0.7, 2.5))
    path = str(tmp_path / f"{code}.nii.gz")
    sitk.WriteImage(sitk.DICOMOrient(img, code), path)
    vol = vs.VolumeStore().load(path, False, False)
    for plane, expected in (("axial", "top-right"), ("coronal", "top-right"), ("sagittal", "top-left")):
        for i in range(vol.plane_length(plane)):
            sl = vs.get_plane_slice(vol, plane, i) > 0
            if sl.any():
                ys, xs = np.nonzero(sl)
                got = ("top" if ys.mean() / sl.shape[0] < 0.5 else "bottom") + "-" + (
                    "left" if xs.mean() / sl.shape[1] < 0.5 else "right"
                )
                assert got == expected, (code, plane)
                break


# --------------------------------------------------------------------------
# World position, for the mask alignment warning
# --------------------------------------------------------------------------


def test_volume_info_reports_where_the_array_sits_in_the_world(tmp_path):
    arr = np.zeros((NZ, NY, NX), np.int16)
    a = vs.VolumeStore().load(write_ct(str(tmp_path / "a.nii.gz"), arr, origin=(0, 0, 0)), True, False)
    b = vs.VolumeStore().load(write_ct(str(tmp_path / "b.nii.gz"), arr, origin=(12, 0, 0)), True, False)
    ia, ib = a.info_dict(), b.info_dict()
    assert ia["shape_lps"] == ib["shape_lps"]  # same size...
    assert ia["origin_lps"] != ib["origin_lps"]  # ...but a different place, which is what the warning needs
    assert len(ia["direction_lps"]) == 9
