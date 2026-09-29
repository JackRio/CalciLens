"""Agatston scoring is the classic slice-by-slice method: 2D lesions, a minimum
area, a density weight from the lesion's peak HU, scaled by slice spacing / 3 mm.
Also: what is read from DICOM headers and how the scoring setup is recorded."""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace

import numpy as np
import SimpleITK as sitk

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agatston as ag  # noqa: E402
import annotation_paths as ap  # noqa: E402
import volume_store as vs  # noqa: E402


def _vols(hu, labels, spacing=(0.5, 0.5, 3.0)):
    ct = SimpleNamespace(array=np.asarray(hu, dtype=np.float32), spacing_lps=spacing)
    mask = SimpleNamespace(array=np.asarray(labels, dtype=np.uint8), spacing_lps=spacing)
    return mask, ct


def _blank(nz=4, ny=20, nx=20):
    return np.zeros((nz, ny, nx), dtype=np.float32), np.zeros((nz, ny, nx), dtype=np.uint8)


def test_score_is_area_times_weight_of_the_peak_and_scales_with_spacing():
    hu, lab = _blank()
    hu[1, 5:9, 5:9] = 150  # 16 px x 0.25 mm2 = 4 mm2
    hu[1, 6, 6] = 450  # peak 450 -> weight 4
    lab[1, 5:9, 5:9] = 1
    mask, ct = _vols(hu, lab)
    assert ag.compute_volume_agatston(mask, ct, (1,)) == 4.0 * 4 * (3.0 / 3.0)
    mask, ct = _vols(hu, lab, spacing=(0.5, 0.5, 1.5))
    assert ag.compute_volume_agatston(mask, ct, (1,)) == 4.0 * 4 * 0.5
    # a corrected slice spacing overrides the file's
    assert ag.compute_volume_agatston(mask, ct, (1,), slice_spacing_mm=3.0) == 16.0


def test_lesions_under_the_minimum_area_do_not_count():
    hu, lab = _blank()
    hu[2, 3, 3] = 500  # one pixel = 0.25 mm2, under the 1 mm2 default
    lab[2, 3, 3] = 1
    hu[2, 10:12, 10:12] = 250  # 4 px = 1 mm2, exactly the minimum
    lab[2, 10:12, 10:12] = 1
    mask, ct = _vols(hu, lab)
    assert ag.compute_volume_agatston(mask, ct, (1,)) == 1.0 * 2
    assert ag.compute_volume_agatston(mask, ct, (1,), min_area_mm2=0.0) == 1.0 * 2 + 0.25 * 4
    assert ag.compute_volume_agatston(mask, ct, (1,), min_area_mm2=2.0) == 0.0


def test_each_slice_is_its_own_lesion_with_its_own_peak():
    hu, lab = _blank()
    for z, peak in ((0, 150), (1, 350)):
        hu[z, 4:8, 4:8] = peak
        lab[z, 4:8, 4:8] = 2
    mask, ct = _vols(hu, lab)
    # 4 mm2 x weight 1 on one slice + 4 mm2 x weight 3 on the next, not one blob x its peak
    assert ag.compute_volume_agatston(mask, ct, (2,)) == 4.0 * 1 + 4.0 * 3


def test_a_total_over_several_labels_is_the_sum_of_each():
    hu, lab = _blank()
    hu[1, 2:6, 2:6] = 250
    lab[1, 2:6, 2:6] = 1
    hu[1, 6:10, 2:6] = 250  # touches label 1 but belongs to label 2
    lab[1, 6:10, 2:6] = 2
    mask, ct = _vols(hu, lab)
    one, two = (ag.compute_volume_agatston(mask, ct, (n,)) for n in (1, 2))
    assert ag.compute_volume_agatston(mask, ct, (1, 2)) == one + two == 2 * 4.0 * 2


def test_a_clicked_lesion_scores_the_same_as_the_total_when_it_is_the_only_one():
    hu, lab = _blank()
    hu[1:3, 4:9, 4:9] = 220
    lab[1:3, 4:9, 4:9] = 3
    mask, ct = _vols(hu, lab)
    region = (mask.array == 3) & (ct.array >= 130)
    assert ag.compute_agatston_score(region, ct.array, ct.spacing_lps) == ag.compute_volume_agatston(mask, ct, (3,))


def _write_series(root, thickness=2.0, kvp="100", gaps=None):
    os.makedirs(root, exist_ok=True)
    arr = (np.random.rand(5, 16, 16) * 100).astype(np.int16)
    w = sitk.ImageFileWriter()
    w.KeepOriginalImageUIDOn()
    z = 0.0
    for i in range(5):
        z += gaps[i] if gaps else 2.0
        # one-slice 3D image so the slice keeps its own z position
        sl = sitk.GetImageFromArray(arr[i : i + 1])
        sl.SetSpacing((1.0, 1.0, 2.0))
        sl.SetOrigin((0.0, 0.0, z))
        tags = {"0020|000e": "1.2.3.4.5", "0020|0013": str(i + 1), "0008|0060": "CT", "0010|0020": "P1",
                "0018|0050": str(thickness), "0018|0060": kvp, "0018|1210": "B35f"}
        for k, v in tags.items():
            sl.SetMetaData(k, v)
        w.SetFileName(os.path.join(root, f"s{i}.dcm"))
        w.Execute(sl)


def test_dicom_headers_are_read_into_the_volume_info(tmp_path):
    _write_series(str(tmp_path), thickness=3.0, kvp="100")
    store = vs.VolumeStore()
    info = store.load(str(tmp_path)).info_dict()["acquisition"]
    assert info["source"] == "dicom"
    assert info["slice_thickness_mm"] == 3.0
    assert info["kvp"] == 100.0
    assert info["kernel"] == "B35f"
    assert info["non_uniform_spacing"] is False
    assert abs(info["slice_spacing_mm"] - 2.0) < 1e-3


def test_uneven_dicom_slice_spacing_is_flagged(tmp_path):
    _write_series(str(tmp_path), gaps=[2.0, 2.0, 2.0, 5.0, 2.0])
    info = vs.VolumeStore().load(str(tmp_path)).info_dict()["acquisition"]
    assert info["non_uniform_spacing"] is True


def test_a_nifti_only_reports_its_spacing(tmp_path):
    img = sitk.GetImageFromArray(np.zeros((4, 8, 8), dtype=np.int16))
    img.SetSpacing((1.0, 1.0, 1.5))
    path = str(tmp_path / "ct.nii.gz")
    sitk.WriteImage(img, path)
    info = vs.VolumeStore().load(path).info_dict()["acquisition"]
    assert info["source"] == "image"
    assert info["slice_thickness_mm"] is None and info["kvp"] is None
    assert info["slice_spacing_mm"] == 1.5


def test_the_scoring_setup_is_kept_in_source_json_and_survives_later_saves(tmp_path):
    scan_dir = str(tmp_path / "scan")
    setup = {"slice_spacing_mm": 1.5, "min_lesion_area_mm2": 1.0, "labels": [{"label": 1, "name": "LAD", "coronary": True}]}
    ap.write_source_record(scan_dir, ct_path="C:/x/ct.nii.gz", series_uid=None, patient_id=None,
                           annotation_type="non-contrast", scoring=setup)
    assert ap.read_source_record(scan_dir)["scoring"] == setup
    # a later save that does not carry a setup must not erase it
    ap.write_source_record(scan_dir, ct_path="C:/x/ct.nii.gz", series_uid=None, patient_id=None,
                           annotation_type="non-contrast")
    assert ap.read_source_record(scan_dir)["scoring"] == setup


def test_a_shifted_or_respaced_mask_is_refused_even_at_the_same_shape():
    import pytest
    base = dict(array=np.zeros((3, 4, 4), dtype=np.uint8), reoriented_origin=(0.0, 0.0, 0.0),
                reoriented_direction=(1, 0, 0, 0, 1, 0, 0, 0, 1))
    ct = SimpleNamespace(**base, spacing_lps=(1.0, 1.0, 2.0))
    vs.assert_same_geometry(SimpleNamespace(**base, spacing_lps=(1.0, 1.0, 2.0)), ct)  # identical: fine
    with pytest.raises(ValueError, match="position"):
        vs.assert_same_geometry(SimpleNamespace(**{**base, "reoriented_origin": (5.0, 0.0, 0.0)}, spacing_lps=(1.0, 1.0, 2.0)), ct)
    with pytest.raises(ValueError, match="spacing"):
        vs.assert_same_geometry(SimpleNamespace(**base, spacing_lps=(1.0, 1.0, 3.0)), ct)
    with pytest.raises(ValueError, match="orientation"):
        vs.assert_same_geometry(SimpleNamespace(**{**base, "reoriented_direction": (0, 1, 0, 1, 0, 0, 0, 0, 1)}, spacing_lps=(1.0, 1.0, 2.0)), ct)


def test_a_fixed_threshold_is_recorded_beside_the_scan_and_found_again(tmp_path):
    import contrast_threshold as ct_mod
    out = str(tmp_path / "out")
    ct_path = str(tmp_path / "ct.nii.gz")
    record = {"method": "fixed", "threshold_hu": 320.0, "ct_path": ct_path}
    ct_mod.save_sidecar(ct_path, record, base_dir=out)
    loaded = ct_mod.load_sidecar(ct_path, base_dir=out)
    assert loaded["method"] == "fixed" and loaded["threshold_hu"] == 320.0
