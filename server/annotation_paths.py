"""Where a saved annotation goes, and whether saving there would destroy
something.

Every saved annotation lives in its own per-scan folder:

    <root>/Manual_Annotations_<DD_Mon_YYYY>/<scan folder>/annotation.nii.gz
                                           /_source.json
                                           /contrast_seed.json

`<root>` is the user-configured save directory, or the CT's own directory
when none is set. `<scan folder>` is the DICOM SeriesInstanceUID for a DICOM
series, or the NIFTI/MHA file's stem otherwise.

Why a folder per scan rather than a `<stem>_tag.nii.gz` file next to the
image: output names used to be built from the image's *basename*, which is
not unique. Two cases stored as `caseA/image.nii.gz` and `caseB/image.nii.gz`
both produced `image_ManualAnnotations.nii.gz`, and once a shared save
directory was configured they both produced it in the *same* directory — the
second save silently destroyed the first. A folder doesn't fix that on its
own (the folder name collides for exactly the same reason), so the folder
also carries `_source.json` recording which scan it actually belongs to.
That is what lets a save tell "I am re-saving this same scan" apart from "a
different scan already claimed this name" — two situations that look
identical from the filename alone but need opposite handling.

Nothing here ever overwrites without being told to: `resolve_target()`
reports what it found and the caller decides.
"""
from __future__ import annotations

import datetime
import glob
import json
import os
import threading
import uuid
from typing import Optional

from pathutil import clean_path

ANNOTATION_FILENAME = "annotation.nii.gz"
SOURCE_RECORD_NAME = "_source.json"
SEED_SIDECAR_NAME = "contrast_seed.json"
DATED_FOLDER_PREFIX = "Manual_Annotations_"


def dated_folder_name(when: Optional[datetime.date] = None) -> str:
    when = when or datetime.date.today()
    return f"{DATED_FOLDER_PREFIX}{when.strftime('%d_%b_%Y')}"


def scan_folder_name(ct_path: str, series_uid: Optional[str] = None) -> str:
    """The per-scan folder name for a CT: its SeriesInstanceUID for a DICOM
    series directory, its filename stem otherwise.

    A DICOM directory's own name is a dotted UID, not a filename — running it
    through splitext would treat the tail after the last dot as an extension
    (the same gotcha volume_store._insert_tag documents), so directories are
    checked first. The series UID is strongly preferred over the directory
    name because one directory can hold several series, which is precisely
    how the original overwrite bug got in.
    """
    ct_path = clean_path(ct_path or "")
    if not ct_path:
        return "unknown_scan"
    if os.path.isdir(ct_path):
        return _sanitize(series_uid or os.path.basename(os.path.normpath(ct_path)))
    base = os.path.basename(ct_path)
    if base.lower().endswith(".nii.gz"):
        return _sanitize(base[:-7])
    return _sanitize(os.path.splitext(base)[0] or base)


_ILLEGAL = '<>:"/\\|?*'


def _sanitize(name: str) -> str:
    """Make a folder name safe on Windows. Series UIDs and NIFTI stems are
    already tame in practice, but a manifest can hold anything."""
    cleaned = "".join("_" if c in _ILLEGAL or ord(c) < 32 else c for c in (name or "").strip())
    cleaned = cleaned.rstrip(" .")  # Windows rejects trailing dots/spaces
    return cleaned or "unknown_scan"


def annotation_root(ct_path: str, base_dir: Optional[str] = None) -> str:
    """Where the dated folders live: the configured save directory, or the
    CT's own directory when none is configured."""
    if base_dir:
        return clean_path(base_dir)
    ct_path = clean_path(ct_path or "")
    if os.path.isdir(ct_path):
        return ct_path
    return os.path.dirname(ct_path)


def _normalize_for_compare(path: str) -> str:
    if not path:
        return ""
    return os.path.normcase(os.path.abspath(clean_path(path))).rstrip("\\/")


def read_source_record(scan_dir: str) -> Optional[dict]:
    path = os.path.join(scan_dir, SOURCE_RECORD_NAME)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _same_scan(record: Optional[dict], ct_path: str, series_uid: Optional[str]) -> bool:
    """Does an existing folder's `_source.json` describe the scan we're about
    to save? A matching series UID is decisive on its own (it identifies the
    series no matter where the files were moved to); otherwise fall back to
    comparing the CT path."""
    if not record:
        # No provenance to check — an annotation folder written before this
        # scheme existed, or one a user created by hand. Treat it as
        # "unknown", which the caller surfaces as a collision rather than
        # silently assuming it's the same scan.
        return False
    rec_uid = record.get("series_uid") or ""
    if rec_uid and series_uid:
        return rec_uid == series_uid
    return _normalize_for_compare(record.get("ct_path", "")) == _normalize_for_compare(ct_path)


def find_existing_scan_dirs(root: str, folder_name: str) -> list:
    """Every `<root>/Manual_Annotations_*/<folder_name>` that already exists,
    most recently modified first.

    Searching *all* dated folders, not just today's, is what makes "you
    already saved this scan on the 18th" visible. If only today's folder were
    checked, saving the same scan on a later day would look brand new and the
    user would never learn that an earlier copy exists.
    """
    if not root or not os.path.isdir(root):
        return []
    matches = [
        d
        for d in glob.glob(os.path.join(root, f"{DATED_FOLDER_PREFIX}*", folder_name))
        if os.path.isdir(d)
    ]
    matches.sort(key=os.path.getmtime, reverse=True)
    return matches


def resolve_target(
    ct_path: str,
    series_uid: Optional[str] = None,
    base_dir: Optional[str] = None,
    resolution: Optional[str] = None,
) -> dict:
    """Work out where this scan's annotation should be written, and whether
    writing there needs the user's say-so first.

    Returns a dict with `scan_dir`, `annotation_path`, `folder_name`, and a
    `conflict` describing what's already there:

      None          nothing exists yet — safe to write
      "overwrite"   this same scan already has an annotation in TODAY's
                    folder; writing replaces it
      "earlier"     this same scan was saved on an earlier day; writing
                    creates today's copy and leaves that one alone
      "collision"   a DIFFERENT scan already owns this folder name; writing
                    would destroy someone else's annotation

    `resolution` is the user's answer to a previous conflict: "overwrite"
    accepts the reported target as-is, "new_copy" diverts to a suffixed
    folder name that is guaranteed not to exist. Every conflict is reported
    to the caller; nothing here decides on the user's behalf.
    """
    ct_path = clean_path(ct_path or "")
    root = annotation_root(ct_path, base_dir)
    folder_name = scan_folder_name(ct_path, series_uid)
    today_dir = os.path.join(root, dated_folder_name(), folder_name)

    existing = find_existing_scan_dirs(root, folder_name)
    conflict = None
    existing_source = None
    existing_dir = None

    for candidate in existing:
        record = read_source_record(candidate)
        has_annotation = os.path.isfile(os.path.join(candidate, ANNOTATION_FILENAME))
        if _same_scan(record, ct_path, series_uid):
            # A folder holding only a contrast seed (placed before any mask
            # was saved) is this scan's own folder with nothing at stake —
            # reporting a conflict there would make the very first save of
            # every contrast scan ask a pointless question.
            if not has_annotation:
                continue
            existing_source = record
            existing_dir = candidate
            # Replacing today's file is the only genuinely destructive case;
            # an earlier day's copy is kept either way, but the user is still
            # told it exists so "am I updating or branching?" is never a
            # guess.
            same_dir = _normalize_for_compare(candidate) == _normalize_for_compare(today_dir)
            conflict = "overwrite" if same_dir else "earlier"
            break
        if not has_annotation and record is None:
            # An empty/unclaimed folder — nothing to collide with.
            continue
        # Folder name taken by something that is NOT this scan — the exact
        # failure the per-scan folder scheme exists to catch.
        existing_source = record
        existing_dir = candidate
        conflict = "collision"
        break

    scan_dir = today_dir
    if resolution == "new_copy":
        scan_dir = _next_free_dir(os.path.join(root, dated_folder_name()), folder_name)
        folder_name = os.path.basename(scan_dir)
        conflict = None
    elif resolution == "overwrite":
        conflict = None

    return {
        "root": root,
        "folder_name": folder_name,
        "scan_dir": scan_dir,
        "annotation_path": os.path.join(scan_dir, ANNOTATION_FILENAME),
        "conflict": conflict,
        "existing_dir": existing_dir,
        "existing_source": existing_source,
        "alternative_folder": os.path.basename(_next_free_dir(os.path.join(root, dated_folder_name()), folder_name))
        if conflict == "collision"
        else None,
    }


def _next_free_dir(parent: str, folder_name: str) -> str:
    """`<parent>/<folder_name>__2`, `__3`, ... — the first that doesn't
    exist. Used to keep a colliding save out of another scan's folder."""
    suffix = 2
    while True:
        candidate = os.path.join(parent, f"{folder_name}__{suffix}")
        if not os.path.exists(candidate):
            return candidate
        suffix += 1


def write_source_record(
    scan_dir: str,
    ct_path: str,
    series_uid: Optional[str],
    patient_id: Optional[str],
    annotation_type: Optional[str],
    source_mask_path: Optional[str] = None,
    bump_count: bool = True,
) -> dict:
    """Create/update the folder's `_source.json`.

    This is the provenance that makes a later save able to tell a re-save
    from a collision, and it is also where the annotation *type* (contrast
    vs non-contrast) is recorded. Deliberately not encoded in the filename:
    filenames were previously the only record of it, which is how a mask
    loaded from disk got its type guessed from a substring match, and how
    re-saving kept appending another tag to an ever-growing name.
    """
    os.makedirs(scan_dir, exist_ok=True)
    existing = read_source_record(scan_dir) or {}
    now = datetime.datetime.now().isoformat(timespec="seconds")
    record = {
        **existing,
        "ct_path": clean_path(ct_path or ""),
        "series_uid": series_uid or existing.get("series_uid") or "",
        "patient_id": patient_id or existing.get("patient_id") or "",
        "annotation_type": annotation_type or existing.get("annotation_type") or "",
        "annotation_file": ANNOTATION_FILENAME,
        "created_at": existing.get("created_at") or now,
        "updated_at": now,
        "save_count": int(existing.get("save_count") or 0) + (1 if bump_count else 0),
    }
    if source_mask_path:
        record["source_mask_path"] = clean_path(source_mask_path)
    atomic_write_json(os.path.join(scan_dir, SOURCE_RECORD_NAME), record)
    return record


def atomic_write_json(path: str, payload: dict) -> None:
    dirn = os.path.dirname(path) or "."
    os.makedirs(dirn, exist_ok=True)
    tmp_path = _temp_path(dirn, os.path.basename(path))
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp_path, path)
    finally:
        _cleanup(tmp_path)


def _temp_path(dirn: str, basename: str) -> str:
    """Unique per call (pid + thread + random): FastAPI runs sync endpoints
    in a threadpool, so two saves really can land at the same moment, and a
    shared temp name lets them corrupt each other mid-write — the same
    hazard folder_scan._write_table documents."""
    return os.path.join(dirn, f".tmp_{os.getpid()}_{threading.get_ident()}_{uuid.uuid4().hex[:8]}_{basename}")


def _cleanup(tmp_path: str) -> None:
    if os.path.exists(tmp_path):
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def seed_sidecar_path(ct_path: str, series_uid: Optional[str], scan_dir: str) -> str:
    return os.path.join(scan_dir, SEED_SIDECAR_NAME)


def find_seed_sidecar(ct_path: str, series_uid: Optional[str] = None, base_dir: Optional[str] = None) -> Optional[str]:
    """Locate this scan's saved contrast seed, newest first, including the
    pre-folder-scheme locations so seeds saved by an earlier build still
    load."""
    ct_path = clean_path(ct_path or "")
    root = annotation_root(ct_path, base_dir)
    folder_name = scan_folder_name(ct_path, series_uid)

    for scan_dir in find_existing_scan_dirs(root, folder_name):
        record = read_source_record(scan_dir)
        if not _same_scan(record, ct_path, series_uid):
            continue
        candidate = os.path.join(scan_dir, SEED_SIDECAR_NAME)
        if os.path.isfile(candidate):
            return candidate

    for legacy in _legacy_sidecar_paths(ct_path, series_uid, base_dir):
        if os.path.isfile(legacy):
            return legacy
    return None


def _legacy_sidecar_paths(ct_path: str, series_uid: Optional[str], base_dir: Optional[str]) -> list:
    """Where the previous build put seed sidecars: `<stem>_contrast_seed.json`
    next to the image, or loose inside a dated folder."""
    dirn = os.path.dirname(ct_path)
    base = os.path.basename(ct_path)
    if ct_path and os.path.isdir(ct_path):
        stem = series_uid or base
    elif base.lower().endswith(".nii.gz"):
        stem = base[:-7]
    else:
        stem = os.path.splitext(base)[0]
    filename = f"{stem}_contrast_seed.json"

    paths = []
    if base_dir:
        paths.extend(
            sorted(
                glob.glob(os.path.join(clean_path(base_dir), f"{DATED_FOLDER_PREFIX}*", filename)),
                key=os.path.getmtime,
                reverse=True,
            )
        )
    paths.append(os.path.join(dirn, filename))
    return paths
