"""Where a saved annotation goes, and whether saving there would destroy
something.

Every saved annotation lives in its own per-scan folder:

    <root>/Manual_Annotations/<scan folder>/annotation.nii.gz
                                           /_source.json
                                           /contrast_seed.json

There is deliberately no date in the folder name. Dated folders split one
scan's work across several directories, so "where is this scan's annotation"
had more than one answer and the newest was whichever you looked in last.
The dates live in `_source.json` instead — `created_at`, `updated_at`, and a
`saves` entry per save — which is both more precise (a timestamp per save,
not per day) and in one place. Folders written by the earlier dated scheme
are still found, so nothing saved before this is stranded.

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
ANNOTATION_FOLDER_NAME = "Manual_Annotations"
# Folders written by the earlier one-per-day scheme. Read for discovery so
# existing work is still found; never written to again.
LEGACY_DATED_PREFIX = "Manual_Annotations_"
# How many save entries to keep in _source.json before dropping the oldest.
MAX_SAVE_HISTORY = 200


def annotation_dir(root: str) -> str:
    """`<root>/Manual_Annotations` — one folder, no date.

    Unless `root` already IS that folder, in which case we are already where
    we need to be. The save directory is a path the user types or browses to,
    and pointing it straight at an existing Manual_Annotations folder is the
    obvious thing to do — without this, every such pick would nest another
    one inside (`.../Manual_Annotations/Manual_Annotations/...`), burying the
    annotations a level deeper each time and hiding the ones already there.

    Compared case-insensitively via normcase, since the user may well type a
    different case from what is on disk.
    """
    root = clean_path(root or "")
    if os.path.normcase(os.path.basename(os.path.normpath(root))) == os.path.normcase(ANNOTATION_FOLDER_NAME):
        return root
    return os.path.join(root, ANNOTATION_FOLDER_NAME)


def legacy_dated_folder_name(when: Optional[datetime.date] = None) -> str:
    """The old one-folder-per-day name. Only used to find existing work."""
    when = when or datetime.date.today()
    return f"{LEGACY_DATED_PREFIX}{when.strftime('%d_%b_%Y')}"


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


class SaveDirRequired(ValueError):
    """Saving was asked for with no usable save folder. `reason` is
    "missing" (none chosen) or "same_as_image" (the image's own folder)."""

    def __init__(self, reason: str):
        super().__init__(
            "Choose a folder to save annotations in."
            if reason == "missing"
            else "Annotations cannot be saved in the same folder as the image. Choose a different folder."
        )
        self.reason = reason


def annotation_root(ct_path: str, base_dir: Optional[str] = None) -> Optional[str]:
    """Where the per-scan annotation folders live: the save directory the user
    chose, and nowhere else. It used to fall back to the CT's own directory,
    which quietly dropped annotations next to the images; now that is simply
    "no root", and a caller that needs one must ask the user."""
    if base_dir:
        return clean_path(base_dir)
    return None


def _image_dirs(ct_path: str) -> list:
    ct_path = clean_path(ct_path or "")
    dirs = [os.path.dirname(ct_path)]
    if os.path.isdir(ct_path):
        dirs.append(ct_path)
    return [_normalize_for_compare(d) for d in dirs if d]


def require_save_root(ct_path: str, base_dir: Optional[str]) -> str:
    """The save root, or SaveDirRequired. Refuses the image's own folder."""
    root = annotation_root(ct_path, base_dir)
    if not root:
        raise SaveDirRequired("missing")
    # Pointing at <image folder>/Manual_Annotations is fine; the image folder
    # itself is not.
    if _normalize_for_compare(root) in _image_dirs(ct_path):
        raise SaveDirRequired("same_as_image")
    return root


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
    """Every existing `<root>/Manual_Annotations_*/<folder_name>` — including
    the `__2`, `__3` … variants a previous collision was diverted into — most
    recently modified first.

    Searching *all* dated folders, not just today's, is what makes "you
    already saved this scan on the 18th" visible. If only today's folder were
    checked, saving the same scan on a later day would look brand new.

    Including the suffixed variants matters just as much: the scan that once
    lost a name clash lives in `<name>__2` from then on, and if its own folder
    weren't searched it would collide with the original every single time and
    spawn `__3`, `__4`, ... on every save.
    """
    if not root or not os.path.isdir(root):
        return []
    patterns = [folder_name, f"{folder_name}__*"]
    # annotation_dir() rather than a literal join, so a save directory that
    # already points at the Manual_Annotations folder is searched in place
    # instead of one level too deep — where it would find nothing and treat
    # every annotation already sitting there as new.
    parents = [annotation_dir(root), os.path.join(root, f"{LEGACY_DATED_PREFIX}*")]
    matches = [
        d
        for parent in parents
        for pattern in patterns
        for d in glob.glob(os.path.join(parent, pattern))
        if os.path.isdir(d)
    ]
    # Deduplicate (the glob patterns can't overlap today, but a future
    # pattern change shouldn't be able to return the same directory twice)
    # and put the most recently written first.
    matches = list(dict.fromkeys(matches))
    matches.sort(key=os.path.getmtime, reverse=True)
    return matches


def is_legacy_dir(scan_dir: str) -> bool:
    """True for a folder written by the old dated scheme."""
    return os.path.basename(os.path.dirname(scan_dir)).startswith(LEGACY_DATED_PREFIX)


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
      "overwrite"   this same scan already has an annotation here; writing
                    replaces it
      "earlier"     this same scan's only annotation is in a folder written
                    by the old dated scheme; writing creates the new-layout
                    copy and leaves that one alone
      "collision"   a DIFFERENT scan already owns this folder name; writing
                    would destroy someone else's annotation

    `resolution` is the user's answer to a previous conflict: "overwrite"
    accepts the reported target as-is, "new_copy" diverts to a suffixed
    folder name that is guaranteed not to exist. Every conflict is reported
    to the caller; nothing here decides on the user's behalf.
    """
    ct_path = clean_path(ct_path or "")
    root = require_save_root(ct_path, base_dir)
    folder_name = scan_folder_name(ct_path, series_uid)
    target_dir = os.path.join(annotation_dir(root), folder_name)

    existing = find_existing_scan_dirs(root, folder_name)
    conflict = None
    existing_source = None
    existing_dir = None

    # This scan's OWN folder wins over any name clash: once a previous save
    # was diverted to "<name>__2", that is where this scan lives, and it must
    # keep landing there instead of colliding with the original again.
    own = next((d for d in existing if _same_scan(read_source_record(d), ct_path, series_uid)), None)
    if own is not None:
        folder_name = os.path.basename(own)
        # A folder from the old dated scheme is not written to again — the
        # save lands in the undated layout, keeping the old copy intact.
        if not is_legacy_dir(own):
            target_dir = own
        else:
            target_dir = os.path.join(annotation_dir(root), folder_name)
        record = read_source_record(own)
        # A folder holding only a contrast seed (placed before any mask was
        # saved) is this scan's own folder with nothing at stake — reporting a
        # conflict there would make the very first save of every contrast
        # scan ask a pointless question.
        if os.path.isfile(os.path.join(own, ANNOTATION_FILENAME)):
            existing_source = record
            existing_dir = own
            # Replacing the file at the target is the genuinely destructive
            # case; a legacy copy is kept either way, but the user is still
            # told it exists so "am I updating or branching?" is never a guess.
            same_dir = _normalize_for_compare(own) == _normalize_for_compare(target_dir)
            conflict = "overwrite" if same_dir else "earlier"
    else:
        for candidate in existing:
            if os.path.basename(candidate) != folder_name:
                continue  # a "__N" folder belonging to some other scan is not in our way
            record = read_source_record(candidate)
            has_annotation = os.path.isfile(os.path.join(candidate, ANNOTATION_FILENAME))
            if not has_annotation and record is None:
                continue  # an empty/unclaimed folder — nothing to collide with
            # Folder name taken by something that is NOT this scan — the exact
            # failure the per-scan folder scheme exists to catch.
            existing_source = record
            existing_dir = candidate
            conflict = "collision"
            break

    scan_dir = target_dir
    if resolution == "new_copy":
        scan_dir = _next_free_dir(annotation_dir(root), folder_name)
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
        "alternative_folder": os.path.basename(_next_free_dir(annotation_dir(root), folder_name))
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
    mask_source: Optional[str] = None,
    stats: Optional[dict] = None,
) -> dict:
    """Create/update the folder's `_source.json`.

    This is the provenance that makes a later save able to tell a re-save
    from a collision, and it is also where the annotation *type* (contrast
    vs non-contrast) is recorded. Deliberately not encoded in the filename:
    filenames were previously the only record of it, which is how a mask
    loaded from disk got its type guessed from a substring match, and how
    re-saving kept appending another tag to an ever-growing name.

    Two fields exist because the record is rewritten on every save and would
    otherwise only ever describe the most recent one:

    `original_mask_path` is write-once — the first thing this annotation was
    derived from that wasn't the annotation itself. Without it, the second
    session overwrites `source_mask_path` with the annotation's own path
    (the app reloads your work, you edit it, you save) and the fact that it
    started life as a model prediction is gone for good.

    `saves` is one entry per save. It replaces what the old dated folders
    used to convey by accident, more precisely: a timestamp per save rather
    than a directory per day, and all of it in one place.
    """
    os.makedirs(scan_dir, exist_ok=True)
    existing = read_source_record(scan_dir) or {}
    now = datetime.datetime.now().isoformat(timespec="seconds")
    source_mask_path = clean_path(source_mask_path) if source_mask_path else ""
    own_annotation = os.path.join(scan_dir, ANNOTATION_FILENAME)

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
        record["source_mask_path"] = source_mask_path
        # Write-once, and never the annotation's own file: re-editing your own
        # saved work must not erase where that work originally came from.
        if not existing.get("original_mask_path") and _normalize_for_compare(
            source_mask_path
        ) != _normalize_for_compare(own_annotation):
            record["original_mask_path"] = source_mask_path
            record["original_mask_source"] = mask_source or ""

    if bump_count:
        entry = {"at": now, "mask_source": mask_source or "", "annotation_type": annotation_type or ""}
        if source_mask_path:
            entry["loaded_from"] = source_mask_path
        if stats:
            entry.update(stats)
        history = list(existing.get("saves") or [])
        history.append(entry)
        record["saves"] = history[-MAX_SAVE_HISTORY:]

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


def find_seed_sidecar(ct_path: str, series_uid: Optional[str] = None, base_dir: Optional[str] = None) -> Optional[str]:
    """Locate this scan's saved contrast seed, newest first, including the
    pre-folder-scheme locations so seeds saved by an earlier build still
    load."""
    ct_path = clean_path(ct_path or "")
    root = annotation_root(ct_path, base_dir)
    folder_name = scan_folder_name(ct_path, series_uid)

    # No chosen save folder means nothing to search there; the pre-folder-scheme
    # locations below are still checked so old seeds keep loading.
    for scan_dir in find_existing_scan_dirs(root, folder_name) if root else []:
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
                glob.glob(os.path.join(clean_path(base_dir), f"{LEGACY_DATED_PREFIX}*", filename)),
                key=os.path.getmtime,
                reverse=True,
            )
        )
    paths.append(os.path.join(dirn, filename))
    return paths
