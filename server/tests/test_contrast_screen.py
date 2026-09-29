"""Backend tests for the Annotate > Contrast screen: the seed and lesion-volume
clicks must land on the voxel that is drawn under every display flip, the seed
sidecar is never written without a chosen folder (or into the image's folder),
and the manifest's contrast flag exists only when its column is enabled."""
from __future__ import annotations

import itertools
import os
import random
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import annotation_paths  # noqa: E402
import contrast_threshold as ct_mod  # noqa: E402
import folder_scan  # noqa: E402
import volume_store as vs  # noqa: E402
from agatston import find_lesion_component  # noqa: E402
from test_modes_view_annotate import NX, NY, NZ, unique_ct, write_ct  # noqa: E402,F401


@pytest.mark.parametrize("plane", ["axial", "sagittal", "coronal"])
def test_seed_voxel_is_the_drawn_voxel_under_every_flip(unique_ct, plane):
    store, ct, _ = unique_ct
    rng = random.Random(5)
    scale_h, scale_w = vs.get_plane_display_scale(ct, plane)
    for flips in itertools.product([False, True], repeat=3):
        for _ in range(5):
            index = rng.randrange(ct.plane_length(plane))
            shown = vs.get_plane_slice(ct, plane, index, flips)
            r, c = rng.randrange(shown.shape[0]), rng.randrange(shown.shape[1])
            want = shown[r, c]
            row, col = (r + 0.5) * scale_h - 0.5, (c + 0.5) * scale_w - 0.5
            stats = ct_mod.compute_sphere_stats(ct, plane, index, row, col, 50.0, 3.0, flips=flips)
            assert ct.array[tuple(stats["seed_voxel"])] == want, (plane, flips)


@pytest.mark.parametrize("plane", ["axial", "sagittal", "coronal"])
def test_lesion_click_finds_the_drawn_voxel_under_every_flip(unique_ct, plane):
    store, ct, _ = unique_ct
    mask = store.create_blank_mask(ct)
    # One single-voxel lesion; only a click on exactly that drawn pixel may find it.
    zyx = (NZ // 2, NY // 3, NX // 4)
    mask.array[zyx] = 3
    scale_h, scale_w = vs.get_plane_display_scale(ct, plane)
    for flips in itertools.product([False, True], repeat=3):
        index = {"axial": zyx[0], "coronal": zyx[1], "sagittal": zyx[2]}[plane]
        shown = vs.get_plane_slice(ct, plane, index, flips)
        r, c = [tuple(p) for p in np.argwhere(shown == ct.array[zyx])][0]
        found = find_lesion_component(
            mask, ct, plane, index, (r + 0.5) * scale_h - 0.5, (c + 0.5) * scale_w - 0.5, -1e9, flips=flips
        )
        assert found is not None and found[1] == 3, (plane, flips)


def test_sidecar_refused_without_a_folder_and_in_the_images_folder(unique_ct):
    _, ct, ct_path = unique_ct
    with pytest.raises(annotation_paths.SaveDirRequired):
        ct_mod.save_sidecar(ct_path, {"x": 1}, base_dir=None)
    with pytest.raises(annotation_paths.SaveDirRequired):
        ct_mod.save_sidecar(ct_path, {"x": 1}, base_dir=os.path.dirname(ct_path))
    assert os.listdir(os.path.dirname(ct_path)) == ["scan.nii.gz"]


def test_sidecar_saves_into_the_chosen_folder(unique_ct, tmp_path):
    _, ct, ct_path = unique_ct
    out = str(tmp_path / "out")
    path = ct_mod.save_sidecar(ct_path, {"x": 1}, base_dir=out)
    assert os.path.normcase(path).startswith(os.path.normcase(out))
    assert ct_mod.load_sidecar(ct_path, base_dir=out) == {"x": 1}


def _manifest(tmp_path):
    p = tmp_path / "m.csv"
    pd.DataFrame({"image_path": ["a.nii.gz"], "keep": ["k"]}).to_csv(p, index=False)
    return str(p)


def test_contrast_column_only_exists_when_enabled(tmp_path):
    p = _manifest(tmp_path)
    folder_scan.list_manifest_pairs(p, "image_path", None, contrast_column="")
    assert "Contrast" not in pd.read_csv(p).columns
    res = folder_scan.list_manifest_pairs(p, "image_path", None, contrast_column="Contrast")
    assert "Contrast" in pd.read_csv(p).columns and res["has_contrast_column"]
    with pytest.raises(ValueError):
        folder_scan.save_contrast_flag(p, 0, "", True)


def test_reseeding_never_lands_in_another_scans_folder(tmp_path):
    out = str(tmp_path / "out")
    a = write_ct(str(tmp_path / "p1" / "image.nii.gz"), np.zeros((4, 5, 6), np.float32))
    b = write_ct(str(tmp_path / "p2" / "image.nii.gz"), np.zeros((4, 5, 6), np.float32))
    pa = ct_mod.save_sidecar(a, {"who": "a"}, base_dir=out)
    pb = ct_mod.save_sidecar(b, {"who": "b"}, base_dir=out)  # same folder name, different scan
    assert os.path.dirname(pa) != os.path.dirname(pb)
    assert ct_mod.load_sidecar(a, base_dir=out) == {"who": "a"}
    assert ct_mod.load_sidecar(b, base_dir=out) == {"who": "b"}
    # Re-seeding scan a replaces its own seed, in its own folder.
    assert ct_mod.save_sidecar(a, {"who": "a2"}, base_dir=out) == pa
    assert ct_mod.load_sidecar(a, base_dir=out) == {"who": "a2"}
