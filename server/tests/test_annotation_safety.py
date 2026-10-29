"""Regression tests for the annotation-flow hardening.

Each test here stands for a specific way the app used to lose or corrupt a
user's work. The test names say which. Run with:

    .venv/Scripts/python.exe -m pytest server/tests -v
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pytest
import SimpleITK as sitk
from openpyxl import Workbook, load_workbook

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import annotation_paths as ap  # noqa: E402
import folder_scan  # noqa: E402
import volume_store as vs  # noqa: E402


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def make_ct(path: str, shape=(8, 16, 16), value: int = 0) -> str:
    """Write a tiny NIFTI so the path is real on disk."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    arr = np.full(shape, value, dtype=np.int16)
    sitk.WriteImage(sitk.GetImageFromArray(arr), path)
    return path


def fake_volume(shape=(8, 16, 16), path: str = "", is_new_mask: bool = True) -> vs.LoadedVolume:
    arr = np.zeros(shape, dtype=np.uint8)
    return vs.LoadedVolume(
        volume_id="test",
        path=path,
        array=arr,
        spacing_lps=(1.0, 1.0, 1.0),
        orig_spacing=(1.0, 1.0, 1.0),
        orig_origin=(0.0, 0.0, 0.0),
        orig_direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
        orig_size=(shape[2], shape[1], shape[0]),
        orientation_code="LPS",
        dtype="uint8",
        value_min=0.0,
        value_max=0.0,
        is_dicom_dir=False,
        labels=[],
        reoriented_origin=(0.0, 0.0, 0.0),
        reoriented_direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
        is_new_mask=is_new_mask,
    )


# --------------------------------------------------------------------------
# Finding 1 — two scans with the same filename must not share an output
# --------------------------------------------------------------------------


def test_same_filename_different_scans_is_reported_as_a_collision(tmp_path):
    """caseA/image.nii.gz and caseB/image.nii.gz used to produce the exact
    same output file in a shared save directory; the second save destroyed
    the first with no warning."""
    save_dir = str(tmp_path / "out")
    ct_a = make_ct(str(tmp_path / "caseA" / "image.nii.gz"))
    ct_b = make_ct(str(tmp_path / "caseB" / "image.nii.gz"))

    first = ap.resolve_target(ct_a, None, save_dir)
    assert first["conflict"] is None
    os.makedirs(first["scan_dir"], exist_ok=True)
    open(first["annotation_path"], "w").write("annotation")
    ap.write_source_record(first["scan_dir"], ct_a, None, "P1", "non-contrast")

    second = ap.resolve_target(ct_b, None, save_dir)
    assert second["conflict"] == "collision", "a different scan claiming the same name must be flagged"
    assert second["alternative_folder"], "the user must be offered a non-destructive alternative"

    diverted = ap.resolve_target(ct_b, None, save_dir, resolution="new_copy")
    assert diverted["conflict"] is None
    assert diverted["scan_dir"] != first["scan_dir"]
    assert os.path.isfile(first["annotation_path"]), "case A's annotation must still be intact"


def test_resaving_the_same_scan_is_an_overwrite_not_a_collision(tmp_path):
    save_dir = str(tmp_path / "out")
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))

    first = ap.resolve_target(ct, None, save_dir)
    os.makedirs(first["scan_dir"], exist_ok=True)
    open(first["annotation_path"], "w").write("annotation")
    ap.write_source_record(first["scan_dir"], ct, None, "P1", "non-contrast")

    again = ap.resolve_target(ct, None, save_dir)
    assert again["conflict"] == "overwrite", "re-saving the same scan is an update, not a name clash"
    assert again["annotation_path"] == first["annotation_path"]


def test_dicom_series_uid_beats_the_folder_name(tmp_path):
    """One folder can hold several series. Naming the output after the folder
    made every series in it overwrite the previous one."""
    series_dir = str(tmp_path / "1.2.840.113654.2.55.PARENT")
    os.makedirs(series_dir)
    assert ap.scan_folder_name(series_dir, "1.3.6.1.SERIES_A") == "1.3.6.1.SERIES_A"
    assert ap.scan_folder_name(series_dir, "1.3.6.1.SERIES_B") == "1.3.6.1.SERIES_B"
    # And a dotted directory name is never treated as a file extension.
    assert ap.scan_folder_name(series_dir) == "1.2.840.113654.2.55.PARENT"


def test_seed_sidecar_is_scoped_to_the_scan_not_the_filename(tmp_path):
    """Two patients whose CTs are both `image.nii.gz` used to share one seed
    sidecar, so the second scan silently loaded the first one's threshold."""
    import contrast_threshold as ct_mod

    save_dir = str(tmp_path / "out")
    ct_a = make_ct(str(tmp_path / "caseA" / "image.nii.gz"))
    ct_b = make_ct(str(tmp_path / "caseB" / "image.nii.gz"))

    ct_mod.save_sidecar(ct_a, {"threshold_hu": 111.0}, base_dir=save_dir, patient_id="P1")
    assert ct_mod.load_sidecar(ct_a, base_dir=save_dir)["threshold_hu"] == 111.0
    assert ct_mod.load_sidecar(ct_b, base_dir=save_dir) is None, "patient B must not inherit patient A's seed"


# --------------------------------------------------------------------------
# Finding 2 — saving must be crash-safe
# --------------------------------------------------------------------------


def test_save_is_atomic_and_leaves_no_temp_files(tmp_path):
    save_dir = str(tmp_path / "out")
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))
    mask = fake_volume()
    mask.array[2, 3, 4] = 1

    result = vs.save_mask(mask, ct_path=ct, base_dir=save_dir, annotation_type="non-contrast")
    assert result["status"] == "saved"
    assert os.path.isfile(result["path"])
    leftovers = [f for f in os.listdir(result["scan_dir"]) if f.startswith(".tmp_")]
    assert leftovers == [], "a temp file left behind means the atomic swap did not complete"

    written = sitk.GetArrayFromImage(sitk.ReadImage(result["path"]))
    assert written[2, 3, 4] == 1


def test_save_refuses_to_overwrite_without_being_told_to(tmp_path):
    save_dir = str(tmp_path / "out")
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))

    first = fake_volume()
    first.array[1, 1, 1] = 1
    saved = vs.save_mask(first, ct_path=ct, base_dir=save_dir, annotation_type="non-contrast")
    assert saved["status"] == "saved"

    second = fake_volume()
    second.array[5, 5, 5] = 2
    blocked = vs.save_mask(second, ct_path=ct, base_dir=save_dir, annotation_type="non-contrast")
    assert blocked["status"] == "conflict"

    # The file on disk must be untouched until the user actually says so.
    on_disk = sitk.GetArrayFromImage(sitk.ReadImage(saved["path"]))
    assert on_disk[1, 1, 1] == 1 and on_disk[5, 5, 5] == 0

    confirmed = vs.save_mask(
        second, ct_path=ct, base_dir=save_dir, annotation_type="non-contrast", resolution="overwrite"
    )
    assert confirmed["status"] == "saved"
    after = sitk.GetArrayFromImage(sitk.ReadImage(saved["path"]))
    assert after[5, 5, 5] == 2


# --------------------------------------------------------------------------
# Finding 4 — the output name must not grow per session
# --------------------------------------------------------------------------


def test_repeated_saves_land_on_one_stable_path(tmp_path):
    """The path used to be derived from the loaded mask, so every save
    appended another tag and orphaned the previous file."""
    save_dir = str(tmp_path / "out")
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))

    mask = fake_volume()
    paths = []
    for _ in range(3):
        res = vs.save_mask(
            mask, ct_path=ct, base_dir=save_dir, annotation_type="non-contrast", resolution="overwrite"
        )
        paths.append(res["path"])
        # Simulate re-opening the saved file as the next session's starting point.
        mask = fake_volume(path=res["path"], is_new_mask=False)

    assert len(set(paths)) == 1, f"expected one stable output path, got {paths}"


# --------------------------------------------------------------------------
# Finding 5 — the manifest workbook must survive being written to
# --------------------------------------------------------------------------


def _make_workbook(path: str) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Cases"
    ws.append(["image_path", "PatientId", "Status"])
    ws.append(["C:/data/a.nii.gz", "007", "Reviewed by Sam"])
    ws.append(["C:/data/b.nii.gz", "012", "Reviewed by Sam"])
    extra = wb.create_sheet("Lab notes")
    extra.append(["do not delete me"])
    wb.save(path)


def test_saving_a_comment_keeps_every_other_sheet_and_value(tmp_path):
    """Every save used to rewrite the workbook through pandas, which drops
    all other sheets, all formatting, and re-infers values ("007" -> 7)."""
    path = str(tmp_path / "manifest.xlsx")
    _make_workbook(path)

    folder_scan.save_comment(path, 0, "looks fine")

    wb = load_workbook(path)
    assert "Lab notes" in wb.sheetnames, "a second sheet must not be destroyed by saving a comment"
    assert wb["Lab notes"]["A1"].value == "do not delete me"
    ws = wb["Cases"]
    assert ws.title == "Cases"
    assert ws["B2"].value == "007", "a zero-padded ID must not be re-inferred as a number"
    header = [c.value for c in ws[1]]
    assert "Comment" in header
    assert ws.cell(row=2, column=header.index("Comment") + 1).value == "looks fine"


def test_comment_lands_on_the_right_row(tmp_path):
    path = str(tmp_path / "manifest.xlsx")
    _make_workbook(path)
    folder_scan.save_comment(path, 1, "second row only")
    ws = load_workbook(path)["Cases"]
    header = [c.value for c in ws[1]]
    col = header.index("Comment") + 1
    assert ws.cell(row=2, column=col).value in (None, "")
    assert ws.cell(row=3, column=col).value == "second row only"


# --------------------------------------------------------------------------
# Finding 6 — a pre-existing Status column must not be wiped
# --------------------------------------------------------------------------


def test_existing_status_values_are_preserved_and_offered(tmp_path):
    """Opening a manifest used to overwrite every Status cell whose value
    wasn't one of the app's four options."""
    path = str(tmp_path / "manifest.xlsx")
    _make_workbook(path)

    result = folder_scan.list_manifest_pairs(path, image_column="image_path", mask_column=None)

    ws = load_workbook(path)["Cases"]
    assert ws["C2"].value == "Reviewed by Sam", "the lab's own Status value must survive being opened"
    assert result["rows"][0]["status"] == "Reviewed by Sam"
    assert "Reviewed by Sam" in result["status_options"], "unknown values must be offered, not replaced"
    assert "Not Started" in result["status_options"]


def test_annotation_and_contrast_columns_are_created_on_load(tmp_path):
    path = str(tmp_path / "manifest.xlsx")
    _make_workbook(path)
    result = folder_scan.list_manifest_pairs(path, image_column="image_path", mask_column=None)
    assert result["has_annotation_column"]
    assert result["has_contrast_column"]
    header = [c.value for c in load_workbook(path)["Cases"][1]]
    assert "annotation_path" in header and "Contrast" in header


def test_contrast_flag_reads_back_as_a_real_tri_state(tmp_path):
    path = str(tmp_path / "manifest.xlsx")
    _make_workbook(path)
    folder_scan.list_manifest_pairs(path, image_column="image_path", mask_column=None)

    rows = folder_scan.list_manifest_pairs(path, image_column="image_path", mask_column=None)["rows"]
    assert rows[0]["contrast"] is None, "blank must mean unknown, never 'confirmed non-contrast'"

    folder_scan.save_contrast_flag(path, 0, "Contrast", True)
    rows = folder_scan.list_manifest_pairs(path, image_column="image_path", mask_column=None)["rows"]
    assert rows[0]["contrast"] is True
    assert rows[1]["contrast"] is None


def test_csv_manifests_still_work(tmp_path):
    path = str(tmp_path / "manifest.csv")
    with open(path, "w", encoding="utf-8") as f:
        f.write("image_path,PatientId\nC:/data/a.nii.gz,007\n")
    result = folder_scan.list_manifest_pairs(path, image_column="image_path", mask_column=None)
    assert len(result["rows"]) == 1
    folder_scan.save_comment(path, 0, "csv comment")
    assert "csv comment" in open(path, encoding="utf-8").read()


# --------------------------------------------------------------------------
# Finding 13 — unsaved work must never be evicted from the cache
# --------------------------------------------------------------------------


def test_unsaved_masks_are_never_evicted(tmp_path):
    """A brand-new mask exists ONLY in this cache — evicting it destroys the
    annotation outright, and the client only found out when the next paint
    request 404'd."""
    store = vs.VolumeStore(max_items=3)
    precious = fake_volume()
    precious.volume_id = "newmask_precious"
    store._register(precious)

    for i in range(10):
        filler = fake_volume(is_new_mask=False)
        filler.volume_id = f"ct_{i}"
        store._register(filler)

    assert store.get("newmask_precious") is precious


def test_edited_masks_are_never_evicted():
    store = vs.VolumeStore(max_items=3)
    edited = fake_volume(path="C:/data/mask.nii.gz", is_new_mask=False)
    edited.volume_id = "mask_edited"
    edited.dirty = True
    store._register(edited)

    for i in range(10):
        filler = fake_volume(is_new_mask=False)
        filler.volume_id = f"ct_{i}"
        store._register(filler)

    assert store.get("mask_edited") is edited


def test_clean_volumes_are_still_evicted():
    store = vs.VolumeStore(max_items=2)
    for i in range(5):
        filler = fake_volume(is_new_mask=False)
        filler.volume_id = f"ct_{i}"
        store._register(filler)
    assert len(store._cache) == 2, "clean CTs are safe to drop and should still be dropped"


# --------------------------------------------------------------------------
# Finding 17 — a mismatched mask must fail loudly, not write to the wrong slice
# --------------------------------------------------------------------------


def test_painting_a_mismatched_mask_raises_instead_of_writing(tmp_path):
    """Slice indices used to be clamped per-volume, so viewing CT slice 30
    with a 10-slice mask painted the mask's LAST slice and saved it."""
    ct = fake_volume(shape=(32, 16, 16), is_new_mask=False)
    mask = fake_volume(shape=(10, 16, 16))

    with pytest.raises(ValueError, match="geometry do not match"):
        vs.paint_mask(mask, ct, "axial", 30, 8.0, 8.0, 3.0, 1)

    assert not mask.array.any(), "nothing must have been written"


def test_matching_geometry_still_paints():
    ct = fake_volume(shape=(16, 16, 16), is_new_mask=False)
    mask = fake_volume(shape=(16, 16, 16))
    changed = vs.paint_mask(mask, ct, "axial", 5, 8.0, 8.0, 3.0, 1)
    assert changed > 0
    assert mask.array[5].any()
    assert mask.dirty, "a paint must mark the mask as holding unsaved work"


# --------------------------------------------------------------------------
# provenance
# --------------------------------------------------------------------------


def test_source_record_captures_what_a_later_save_needs(tmp_path):
    save_dir = str(tmp_path / "out")
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))
    mask = fake_volume()
    res = vs.save_mask(mask, ct_path=ct, base_dir=save_dir, annotation_type="contrast", patient_id="P42")

    record = json.load(open(os.path.join(res["scan_dir"], "_source.json"), encoding="utf-8"))
    assert record["ct_path"] == ct
    assert record["patient_id"] == "P42"
    assert record["annotation_type"] == "contrast", "the type belongs in the record, not in the filename"
    assert record["save_count"] == 1


def test_zero_padded_ids_survive_being_read(tmp_path):
    """pandas infers a dtype per column, so a PatientID of "007" used to come
    back as the integer 7 — the file was fine, but the app showed and matched
    on the wrong value."""
    path = str(tmp_path / "manifest.xlsx")
    _make_workbook(path)
    rows = folder_scan.list_manifest_pairs(
        path, image_column="image_path", mask_column=None, patient_id_column="PatientId"
    )["rows"]
    assert rows[0]["patient_id"] == "007", f"expected '007', got {rows[0]['patient_id']!r}"
    assert rows[1]["patient_id"] == "012"


def test_score_columns_still_parse_as_numbers(tmp_path):
    """Reading everything as text must not break the Agatston score columns."""
    path = str(tmp_path / "manifest.csv")
    with open(path, "w", encoding="utf-8") as f:
        f.write("image_path,CAC_Agatston,LAD_Agatston\nC:/data/a.nii.gz,123.45,\n")
    result = folder_scan.list_manifest_pairs(path, image_column="image_path", mask_column=None)
    assert result["rows"][0]["scores"]["CAC"] == pytest.approx(123.45)
    assert result["rows"][0]["scores"]["LAD"] is None


def test_a_diverted_scan_keeps_its_own_folder_on_later_saves(tmp_path):
    """Once a collision pushed a scan into "<name>__2", that is its folder.
    If only the plain name were searched it would collide with the original
    on every subsequent save and spawn __3, __4, ... forever."""
    save_dir = str(tmp_path / "out")
    ct_a = make_ct(str(tmp_path / "caseA" / "image.nii.gz"))
    ct_b = make_ct(str(tmp_path / "caseB" / "image.nii.gz"))

    mask = fake_volume()
    vs.save_mask(mask, ct_path=ct_a, base_dir=save_dir, annotation_type="non-contrast", patient_id="A")

    clash = vs.save_mask(fake_volume(), ct_path=ct_b, base_dir=save_dir, annotation_type="non-contrast")
    assert clash["status"] == "conflict" and clash["conflict"] == "collision"
    diverted = vs.save_mask(
        fake_volume(), ct_path=ct_b, base_dir=save_dir, annotation_type="non-contrast",
        patient_id="B", resolution="new_copy",
    )
    assert diverted["folder_name"] == "image__2"

    # Saving case B again must target image__2 as an update, not clash anew.
    again = vs.save_mask(fake_volume(), ct_path=ct_b, base_dir=save_dir, annotation_type="non-contrast")
    assert again["status"] == "conflict", "an existing annotation must still be confirmed before replacing"
    assert again["conflict"] == "overwrite", f"expected an update prompt, got {again['conflict']}"
    assert again["folder_name"] == "image__2"

    final = vs.save_mask(
        fake_volume(), ct_path=ct_b, base_dir=save_dir, annotation_type="non-contrast", resolution="overwrite"
    )
    assert final["path"] == diverted["path"]
    dated = ap.annotation_dir(save_dir)
    assert sorted(os.listdir(dated)) == ["image", "image__2"], "no __3 should ever appear"


# --------------------------------------------------------------------------
# Reloading a saved annotation must not depend on a manifest
# --------------------------------------------------------------------------


def test_lookup_reports_the_saved_annotation_without_a_manifest(tmp_path):
    """Reloading an annotation used to be driven solely by the manifest's
    annotation_path column, so a scan loaded outside a manifest (a DICOM
    directory, or stepping between series) came back with no segmentation —
    while its contrast seed, which goes through this same lookup, came back
    fine. The frontend now loads `annotation_path` from here, so this
    endpoint reporting it is what makes that work."""
    import app as app_mod
    import contrast_threshold as ct_mod

    save_dir = str(tmp_path / "out")
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))

    saved = vs.save_mask(fake_volume(), ct_path=ct, base_dir=save_dir, annotation_type="contrast")
    ct_mod.save_sidecar(ct, {"threshold_hu": 250.0}, base_dir=save_dir)

    found = app_mod.annotations_lookup(ct_path=ct, save_dir=save_dir)
    assert found["found"] is True
    assert found["annotation_path"] == saved["path"], "the saved annotation must be discoverable"
    assert found["has_seed"] is True, "the seed and the annotation must both come back, not just the seed"
    assert found["source_record"]["annotation_type"] == "contrast"


def test_lookup_is_keyed_by_series_uid_for_a_dicom_directory(tmp_path):
    """Two series in one DICOM folder must not see each other's annotation."""
    import app as app_mod

    save_dir = str(tmp_path / "out")
    series_dir = str(tmp_path / "1.2.840.PARENT")
    os.makedirs(series_dir)

    a = vs.save_mask(
        fake_volume(), ct_path=series_dir, series_uid="1.3.6.SERIES_A",
        base_dir=save_dir, annotation_type="contrast",
    )
    vs.save_mask(
        fake_volume(), ct_path=series_dir, series_uid="1.3.6.SERIES_B",
        base_dir=save_dir, annotation_type="non-contrast",
    )

    found_a = app_mod.annotations_lookup(ct_path=series_dir, series_uid="1.3.6.SERIES_A", save_dir=save_dir)
    found_b = app_mod.annotations_lookup(ct_path=series_dir, series_uid="1.3.6.SERIES_B", save_dir=save_dir)
    assert found_a["annotation_path"] == a["path"]
    assert found_b["annotation_path"] != a["path"]
    assert found_a["source_record"]["annotation_type"] == "contrast"
    assert found_b["source_record"]["annotation_type"] == "non-contrast"


def test_lookup_finds_an_annotation_via_the_recorded_path_hint(tmp_path):
    """The save directory may have been changed or cleared since the
    annotation was saved; the manifest's recorded path still points at it."""
    import app as app_mod

    save_dir = str(tmp_path / "out")
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))
    saved = vs.save_mask(fake_volume(), ct_path=ct, base_dir=save_dir, annotation_type="non-contrast")

    # No save_dir passed at all — only the recorded path.
    found = app_mod.annotations_lookup(ct_path=ct, annotation_path=saved["path"])
    assert found["found"] is True
    assert found["annotation_path"] == saved["path"]


# --------------------------------------------------------------------------
# Undated folder + provenance kept in _source.json instead
# --------------------------------------------------------------------------


def test_annotations_land_in_one_undated_folder(tmp_path):
    save_dir = str(tmp_path / "out")
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))
    res = vs.save_mask(fake_volume(), ct_path=ct, base_dir=save_dir, annotation_type="non-contrast")
    assert os.path.basename(os.path.dirname(os.path.dirname(res["path"]))) == "Manual_Annotations"
    assert os.listdir(save_dir) == ["Manual_Annotations"], "no dated folders should be created"


def test_dates_are_recorded_per_save_not_per_folder(tmp_path):
    """The dated folders used to convey 'when' by accident, one directory per
    day. That information now lives in _source.json, per save."""
    save_dir = str(tmp_path / "out")
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))

    vs.save_mask(fake_volume(), ct_path=ct, base_dir=save_dir, annotation_type="non-contrast")
    res = vs.save_mask(
        fake_volume(), ct_path=ct, base_dir=save_dir, annotation_type="non-contrast", resolution="overwrite"
    )
    record = json.load(open(os.path.join(res["scan_dir"], "_source.json"), encoding="utf-8"))

    assert record["created_at"] and record["updated_at"]
    assert record["save_count"] == 2
    assert len(record["saves"]) == 2, "one history entry per save"
    assert all(e.get("at") for e in record["saves"])
    assert os.listdir(save_dir) == ["Manual_Annotations"]


def test_original_source_survives_re_editing_your_own_annotation(tmp_path):
    """Session 1 edits the model prediction; session 2 reopens the saved
    annotation and edits that. source_mask_path gets rewritten to the
    annotation's own path, so without a write-once field the fact that this
    started as a prediction would be lost."""
    save_dir = str(tmp_path / "out")
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))
    prediction = make_ct(str(tmp_path / "case" / "prediction.nii.gz"))

    from_prediction = fake_volume(path=prediction, is_new_mask=False)
    first = vs.save_mask(
        from_prediction, ct_path=ct, base_dir=save_dir, annotation_type="non-contrast", mask_source="prediction"
    )
    rec = json.load(open(os.path.join(first["scan_dir"], "_source.json"), encoding="utf-8"))
    assert rec["original_mask_path"] == prediction
    assert rec["original_mask_source"] == "prediction"

    # Next session: the app reloads the saved annotation and it is edited again.
    from_annotation = fake_volume(path=first["path"], is_new_mask=False)
    second = vs.save_mask(
        from_annotation, ct_path=ct, base_dir=save_dir, annotation_type="non-contrast",
        mask_source="annotation", resolution="overwrite",
    )
    rec = json.load(open(os.path.join(second["scan_dir"], "_source.json"), encoding="utf-8"))
    assert rec["source_mask_path"] == first["path"], "the latest source is the annotation itself"
    assert rec["original_mask_path"] == prediction, "but where it came from must survive"
    assert [e["mask_source"] for e in rec["saves"]] == ["prediction", "annotation"]


def test_a_legacy_dated_folder_is_found_and_left_alone(tmp_path):
    """Work saved by the dated scheme must still be discoverable, and a new
    save must not write into that old folder."""
    save_dir = str(tmp_path / "out")
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))

    legacy = os.path.join(save_dir, ap.legacy_dated_folder_name(), "image")
    os.makedirs(legacy)
    open(os.path.join(legacy, ap.ANNOTATION_FILENAME), "w").write("old")
    ap.write_source_record(legacy, ct, None, "P1", "non-contrast")

    target = ap.resolve_target(ct, None, save_dir)
    assert target["conflict"] == "earlier", "the user must be told an older copy exists"
    assert not ap.is_legacy_dir(target["scan_dir"]), "the save must go to the new undated layout"

    saved = vs.save_mask(
        fake_volume(), ct_path=ct, base_dir=save_dir, annotation_type="non-contrast", resolution="overwrite"
    )
    assert open(os.path.join(legacy, ap.ANNOTATION_FILENAME)).read() == "old", "legacy copy untouched"
    assert ap.ANNOTATION_FOLDER_NAME in saved["path"]


def test_legacy_annotation_is_still_discoverable_by_lookup(tmp_path):
    import app as app_mod

    save_dir = str(tmp_path / "out")
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))
    legacy = os.path.join(save_dir, ap.legacy_dated_folder_name(), "image")
    os.makedirs(legacy)
    open(os.path.join(legacy, ap.ANNOTATION_FILENAME), "w").write("old")
    ap.write_source_record(legacy, ct, None, "P1", "contrast")

    found = app_mod.annotations_lookup(ct_path=ct, save_dir=save_dir)
    assert found["found"] is True
    assert found["annotation_path"] == os.path.join(legacy, ap.ANNOTATION_FILENAME)


def test_pointing_the_save_folder_at_manual_annotations_does_not_nest(tmp_path):
    """Picking the Manual_Annotations folder itself is the obvious thing to
    do. Nesting another one inside would bury the annotations a level deeper
    on every re-pick, and hide the ones already there."""
    ct = make_ct(str(tmp_path / "case" / "image.nii.gz"))
    outer = str(tmp_path / "out")

    first = vs.save_mask(fake_volume(), ct_path=ct, base_dir=outer, annotation_type="non-contrast")
    inner = os.path.join(outer, ap.ANNOTATION_FOLDER_NAME)
    assert os.path.isdir(inner)

    # Now the user points the save folder straight at Manual_Annotations.
    target = ap.resolve_target(ct, None, inner)
    assert target["conflict"] == "overwrite", "the existing annotation must still be seen"
    assert target["annotation_path"] == first["path"], "and resolve to the very same file"
    assert ap.ANNOTATION_FOLDER_NAME not in os.path.relpath(target["scan_dir"], inner)

    again = vs.save_mask(
        fake_volume(), ct_path=ct, base_dir=inner, annotation_type="non-contrast", resolution="overwrite"
    )
    assert again["path"] == first["path"]
    assert not os.path.isdir(os.path.join(inner, ap.ANNOTATION_FOLDER_NAME)), "no nested folder"


def test_nesting_check_ignores_case_and_trailing_separators(tmp_path):
    outer = str(tmp_path / "out")
    inner = os.path.join(outer, ap.ANNOTATION_FOLDER_NAME)
    assert ap.annotation_dir(inner) == inner
    assert ap.annotation_dir(inner + os.sep) == inner + os.sep or ap.annotation_dir(inner + os.sep).rstrip(os.sep) == inner
    assert ap.annotation_dir(inner.upper()).rstrip(os.sep).lower() == inner.lower()
    # A folder that merely starts with the name is NOT the folder itself.
    other = os.path.join(outer, ap.ANNOTATION_FOLDER_NAME + "_old")
    assert ap.annotation_dir(other) == os.path.join(other, ap.ANNOTATION_FOLDER_NAME)


def test_saved_mask_uses_the_cts_own_voxel_grid(tmp_path):
    import numpy as np
    import SimpleITK as sitk
    from volume_store import VolumeStore, _image_on_ct_grid

    img = sitk.GetImageFromArray(np.zeros((5, 6, 7), dtype=np.int16))
    img.SetSpacing((1, 2, 3))
    img.SetOrigin((10, 20, 30))
    img = sitk.DICOMOrient(img, "RAS")
    ct_path = str(tmp_path / "ct.nii.gz")
    sitk.WriteImage(img, ct_path)

    store = VolumeStore()
    ct = store.load(ct_path)
    mask = store.create_blank_mask(ct)
    out = _image_on_ct_grid(mask, ct)
    assert out.GetDirection() == img.GetDirection()
    assert out.GetOrigin() == img.GetOrigin()
    assert out.GetSize() == img.GetSize()


def test_semicolon_cp1252_csv_loads(tmp_path):
    path = tmp_path / "m.csv"
    path.write_bytes(b"image_path;PatientId\nD:\\caf\xe9\\ct.nii.gz;p1\n")
    result = folder_scan.list_manifest_pairs(str(path), image_column="image_path", mask_column=None, read_only=True)
    assert result["rows"][0]["image_path"].endswith("ct.nii.gz")


def test_manifest_template_round_trips(tmp_path):
    out = folder_scan.write_manifest_template(str(tmp_path / "t"))
    assert out.endswith(".xlsx")
    assert folder_scan.list_manifest_columns(out) == folder_scan.TEMPLATE_COLUMNS


def test_locked_manifest_gives_a_clear_error_and_never_rewrites(tmp_path, monkeypatch):
    import pandas as pd
    import pytest

    path = tmp_path / "m.xlsx"
    pd.DataFrame({"image_path": ["a"], "annotation_path": [""]}).to_excel(path, index=False)
    before = path.read_bytes()

    def locked(src, dst):
        raise PermissionError(5, "Access is denied")

    monkeypatch.setattr(folder_scan.os, "replace", locked)
    monkeypatch.setattr(folder_scan.time, "sleep", lambda s: None)
    written = []
    monkeypatch.setattr(folder_scan, "_write_table", lambda *a, **k: written.append(1))
    with pytest.raises(PermissionError, match="open in another program"):
        folder_scan.save_annotation_path(str(path), 0, "annotation_path", "x.nii.gz")
    assert not written  # no fall-back to the sheet-destroying full rewrite
    monkeypatch.undo()
    assert path.read_bytes() == before
