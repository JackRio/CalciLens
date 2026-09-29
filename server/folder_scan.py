"""CSV / Excel manifest driven batch loading.

The manifest has one row per case with (at minimum) a column holding the
absolute image path and a column holding the absolute mask path. Column
names are user-configurable since every lab's spreadsheet is different.
"""
from __future__ import annotations

import os
import threading
import uuid
from typing import Optional

import pandas as pd

from pathutil import clean_path

DEFAULT_IMAGE_COLUMN = "image_path"
DEFAULT_MASK_COLUMN = "mask_path"
COMMENT_COLUMN = "Comment"
DEFAULT_STATUS_COLUMN = "Status"
STATUS_COLUMN = DEFAULT_STATUS_COLUMN  # back-compat alias
STATUS_OPTIONS = ["Not Started", "Annotated", "InProgress", "Review"]
DEFAULT_STATUS = STATUS_OPTIONS[0]

# Written by the app when an annotation is saved, so returning to a case
# re-opens the user's own work rather than the original prediction. Kept
# separate from the mask column on purpose: overwriting that column would
# destroy the reference to the prediction the annotation started from.
DEFAULT_ANNOTATION_COLUMN = "annotation_path"

# Records that a case is a contrast-enhanced scan. The fixed 130 HU calcium
# threshold is meaningless for those, so the app needs to know *before*
# anyone starts annotating — and "the user remembered to tick a checkbox" is
# not a record of anything.
DEFAULT_CONTRAST_COLUMN = "Contrast"
CONTRAST_TRUE_VALUES = {"yes", "y", "true", "1", "contrast", "ce"}
CONTRAST_FALSE_VALUES = {"no", "n", "false", "0", "non-contrast", "noncontrast", "nc"}

DEFAULT_REASON_COLUMN = "Reason"
REASON_DELIMITER = "; "
DEFAULT_REASON_TAGS = [
    "Mislabel",
    "Incorrect Prediction",
    "Empty Prediction",
    "Valve Class Error",
    "Foreign Object",
    "Corrupted Image",
    "Artefacts",
    "Region Growing Issue",
    "Image Noise",
]

# Score columns are named "<CLASS>_Agatston" in the manifest and are purely
# optional/informational — a case's per-class Agatston calcium scores,
# shown in the viewer if present, skipped entirely if not.
SCORE_CLASSES = ["CAC", "LAD", "LCx", "RCA", "TAC", "AV", "MV"]
SCORE_COLUMN_SUFFIX = "_Agatston"


def _read_table(manifest_path: str) -> pd.DataFrame:
    """Read every cell as text.

    Without dtype=str, pandas infers a type per column and a PatientID of
    "007" comes back as the integer 7 — so the app displayed the wrong ID and
    matched split-view panes on the wrong value, even though the cell on disk
    was correct. Nothing here needs a numeric dtype: the only numbers the app
    reads are the score columns, and _score_value parses those itself.
    """
    ext = os.path.splitext(manifest_path)[1].lower()
    if ext in (".xlsx", ".xls", ".xlsm"):
        return pd.read_excel(manifest_path, dtype=str)
    return pd.read_csv(manifest_path, dtype=str)


def _write_table(manifest_path: str, df: pd.DataFrame, reason_column: str = DEFAULT_REASON_COLUMN) -> None:
    """Full-file rewrite — only used for CSV, and for the rare case of an
    Excel file openpyxl cannot open in place.

    For .xlsx/.xlsm this is a LAST RESORT, because pandas' to_excel writes a
    brand-new single-sheet workbook: every other sheet in the file is lost,
    along with formatting, column widths and formulas, and values are
    re-inferred on the round trip (an ID of "007" comes back as 7). That used
    to happen on every comment/status save. See _set_cells_in_place.

    Writes to a per-call-unique temp file in the same directory and
    os.replace()s it into position, so a crash mid-write leaves the original
    file untouched.
    """
    ext = os.path.splitext(manifest_path)[1].lower()
    # pandas' to_excel() picks its writer engine from the path's own
    # extension, so the temp file must still end in the real one (e.g.
    # "file.xlsx") rather than something generic like "file.xlsx.tmp".
    dirname, basename = os.path.split(manifest_path)
    # Unique per call (pid + thread id + a random token) — two saves landing
    # close together (e.g. copying Comment+Reason to another pane, or just
    # fast back-to-back edits) run in different FastAPI threadpool threads,
    # and a shared temp filename let their writes interleave on disk and
    # corrupt the file before either one's os.replace() ran.
    tmp_path = os.path.join(dirname, f".tmp_{os.getpid()}_{threading.get_ident()}_{uuid.uuid4().hex[:8]}_{basename}")
    try:
        if ext in (".xlsx", ".xls", ".xlsm"):
            df.to_excel(tmp_path, index=False)
            if ext in (".xlsx", ".xlsm"):
                try:
                    _apply_list_dropdowns(
                        tmp_path,
                        df,
                        {
                            DEFAULT_STATUS_COLUMN: STATUS_OPTIONS,
                            reason_column: _collect_reason_tags(df, reason_column),
                        },
                    )
                except Exception:
                    pass
        else:
            df.to_csv(tmp_path, index=False)
        os.replace(tmp_path, manifest_path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _is_excel(manifest_path: str) -> bool:
    return os.path.splitext(manifest_path)[1].lower() in (".xlsx", ".xls", ".xlsm")


def _set_cells_in_place(manifest_path: str, edits: list, new_columns: list = None) -> bool:
    """Edit specific cells of an .xlsx/.xlsm workbook without rewriting it.

    `edits` is a list of (row_index, column_name, value) using the same
    0-based row index list_manifest_pairs reports; `new_columns` names
    columns to append if they don't exist yet.

    This exists because the previous read-with-pandas / write-with-pandas
    round trip silently destroyed things the app never intended to touch:
    any second sheet in the workbook, all formatting, and the exact text of
    values like zero-padded IDs. openpyxl opens the real workbook, changes
    the one cell, and saves it — everything else is carried through
    untouched.

    Returns False if the workbook can't be opened this way, so the caller can
    fall back to the full rewrite rather than failing the save outright.
    """
    from openpyxl import load_workbook

    ext = os.path.splitext(manifest_path)[1].lower()
    try:
        wb = load_workbook(manifest_path, keep_vba=(ext == ".xlsm"))
    except Exception:
        return False

    try:
        ws = wb.active
        header = {}
        for col_idx, cell in enumerate(ws[1], start=1):
            name = cell.value
            if name is not None:
                header[str(name)] = col_idx

        for column in (new_columns or []):
            if column and column not in header:
                col_idx = ws.max_column + 1
                ws.cell(row=1, column=col_idx, value=column)
                header[column] = col_idx

        for row_index, column, value in edits:
            if column not in header:
                col_idx = ws.max_column + 1
                ws.cell(row=1, column=col_idx, value=column)
                header[column] = col_idx
            # +2: worksheet rows are 1-based AND row 1 is the header, so
            # pandas row 0 is worksheet row 2.
            ws.cell(row=row_index + 2, column=header[column], value=value)

        _write_workbook_atomically(wb, manifest_path)
    finally:
        wb.close()
    return True


def _write_workbook_atomically(wb, manifest_path: str) -> None:
    dirname, basename = os.path.split(manifest_path)
    tmp_path = os.path.join(dirname, f".tmp_{os.getpid()}_{threading.get_ident()}_{uuid.uuid4().hex[:8]}_{basename}")
    try:
        wb.save(tmp_path)
        os.replace(tmp_path, manifest_path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _apply_list_dropdowns(path: str, df: pd.DataFrame, columns_and_options: dict) -> None:
    """Attach an Excel in-cell dropdown listing the given options to every
    data row of each column, in one load/save round trip. Note Excel's list
    validation only ever lets a *single* value be picked through its own
    UI — for Reason (which this app stores as multiple tags joined in one
    cell) it's still applied as a reference/suggestion list, but picking an
    option directly in Excel will replace the whole cell rather than add to
    it."""
    from openpyxl import load_workbook
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation

    applicable = {c: o for c, o in columns_and_options.items() if c in df.columns and o}
    if not applicable:
        return

    wb = load_workbook(path)
    ws = wb.active
    for column, options in applicable.items():
        formula1 = '"' + ",".join(options) + '"'
        if len(formula1) > 255:  # Excel's hard cap on an inline list formula
            continue
        col_letter = get_column_letter(list(df.columns).index(column) + 1)
        dv = DataValidation(
            type="list",
            formula1=formula1,
            allow_blank=True,
            showDropDown=False,  # openpyxl quirk: False is what actually shows the dropdown arrow
        )
        ws.add_data_validation(dv)
        dv.add(f"{col_letter}2:{col_letter}{max(len(df), 1) + 1}")
    wb.save(path)


def _split_reasons(value: str) -> list:
    return [t.strip() for t in value.split(REASON_DELIMITER.strip()) if t.strip()]


def _collect_reason_tags(
    df: pd.DataFrame, reason_column: Optional[str] = DEFAULT_REASON_COLUMN, include_defaults: bool = True
) -> list:
    """Every reason tag currently in use anywhere in the sheet, plus the
    built-in defaults (unless the caller opts out, e.g. because the reason
    column has been pointed at a sheet whose existing values have nothing to
    do with the built-in tag set) — defaults first, then any additional tags
    actually found (e.g. ones added as a one-off in a previous session), in
    the order first encountered."""
    tags = list(DEFAULT_REASON_TAGS) if include_defaults else []
    if reason_column in df.columns:
        for value in df[reason_column]:
            for tag in _split_reasons(_cell_text(value)):
                if tag not in tags:
                    tags.append(tag)
    return tags


def _cell_str(value) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)) or pd.isna(value):
        return ""
    return clean_path(str(value))


def _cell_text(value) -> str:
    """Like _cell_str but without clean_path's quote/whitespace stripping —
    for free-text fields (e.g. a reviewer's comment), not paths."""
    if value is None or (isinstance(value, float) and pd.isna(value)) or pd.isna(value):
        return ""
    return str(value)


def list_manifest_columns(manifest_path: str) -> list:
    manifest_path = clean_path(manifest_path)
    if not os.path.isfile(manifest_path):
        raise FileNotFoundError(manifest_path)
    df = _read_table(manifest_path)
    return [str(c) for c in df.columns]


def _ensure_tracking_columns(
    manifest_path: str,
    df: pd.DataFrame,
    reason_column=DEFAULT_REASON_COLUMN,
    status_column=DEFAULT_STATUS_COLUMN,
    annotation_column=DEFAULT_ANNOTATION_COLUMN,
    contrast_column=DEFAULT_CONTRAST_COLUMN,
) -> pd.DataFrame:
    """Make sure the tracking columns the app writes to exist, creating any
    that are missing so they are visible in the file straight away.

    What this deliberately does NOT do any more: rewrite values that are
    already there. The previous version replaced every Status cell whose
    value was not one of the app's four options with "Not Started" — so
    opening a manifest whose "Status" column already meant something else to
    the lab destroyed that column's entire contents, before the user had
    done anything at all. Existing values are now left exactly as found and
    simply offered alongside the built-in options (see
    _collect_status_options).

    `status_column` and `reason_column` are both user-configurable and both
    honour a falsy value as "none": do not track it, do not create it.
    """
    missing = []
    if status_column and status_column not in df.columns:
        df[status_column] = ""
        missing.append(status_column)
    if COMMENT_COLUMN not in df.columns:
        df[COMMENT_COLUMN] = ""
        missing.append(COMMENT_COLUMN)
    if reason_column and reason_column not in df.columns:
        df[reason_column] = ""
        missing.append(reason_column)
    # Created up front rather than on first write: if the annotation column
    # doesn't exist, saved annotations have nowhere to be recorded, and the
    # next visit re-opens the original prediction as though the work never
    # happened.
    if annotation_column and annotation_column not in df.columns:
        df[annotation_column] = ""
        missing.append(annotation_column)
    if contrast_column and contrast_column not in df.columns:
        df[contrast_column] = ""
        missing.append(contrast_column)

    if missing:
        _append_columns(manifest_path, df, missing, reason_column)
    return df


def _append_columns(manifest_path: str, df: pd.DataFrame, columns: list, reason_column) -> None:
    """Add empty columns to the real file. In-place for Excel (so nothing
    else in the workbook is disturbed just because the app wanted a Comment
    column), full rewrite for CSV, where there is nothing to preserve."""
    if _is_excel(manifest_path):
        try:
            if _set_cells_in_place(manifest_path, [], new_columns=columns):
                return
        except Exception:
            pass
    _write_table(manifest_path, df, reason_column=reason_column or DEFAULT_REASON_COLUMN)


def _collect_status_options(df: pd.DataFrame, status_column) -> list:
    """The built-in statuses plus whatever values the sheet already uses, in
    first-seen order — the same merge-do-not-replace treatment the reason
    column gets, so a lab's own Status vocabulary survives contact with the
    app."""
    options = list(STATUS_OPTIONS)
    if status_column and status_column in df.columns:
        for value in df[status_column]:
            text = _cell_text(value).strip()
            if text and text not in options:
                options.append(text)
    return options


def _score_columns_present(df: pd.DataFrame) -> list:
    return [c for c in SCORE_CLASSES if f"{c}{SCORE_COLUMN_SUFFIX}" in df.columns]


def _score_value(value) -> Optional[float]:
    if value is None or pd.isna(value):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _contrast_flag(value):
    """Read a contrast column cell as True / False / unknown. Unknown (blank
    or unrecognized) is a real third state, not a False: "nobody has said"
    must not read as "confirmed non-contrast"."""
    text = _cell_text(value).strip().lower()
    if not text:
        return None
    if text in CONTRAST_TRUE_VALUES:
        return True
    if text in CONTRAST_FALSE_VALUES:
        return False
    return None


def list_manifest_pairs(
    manifest_path: str,
    image_column: str = DEFAULT_IMAGE_COLUMN,
    mask_column=DEFAULT_MASK_COLUMN,
    id_column=None,
    patient_id_column=None,
    reason_column=DEFAULT_REASON_COLUMN,
    include_default_reason_tags: bool = True,
    status_column=DEFAULT_STATUS_COLUMN,
    annotation_column=DEFAULT_ANNOTATION_COLUMN,
    contrast_column=DEFAULT_CONTRAST_COLUMN,
    read_only: bool = False,
) -> dict:
    """`read_only` skips creating the tracking columns, so viewing a manifest
    never modifies the user's file. Every lookup below already tolerates a
    missing column."""
    manifest_path = clean_path(manifest_path)
    if not os.path.isfile(manifest_path):
        raise FileNotFoundError(manifest_path)

    df = _read_table(manifest_path)

    if image_column not in df.columns:
        raise ValueError(f"Column '{image_column}' not found. Available columns: {list(df.columns)}")
    has_mask_column = bool(mask_column) and mask_column in df.columns
    if id_column and id_column not in df.columns:
        raise ValueError(f"Column '{id_column}' not found. Available columns: {list(df.columns)}")
    if patient_id_column and patient_id_column not in df.columns:
        raise ValueError(f"Column '{patient_id_column}' not found. Available columns: {list(df.columns)}")

    if not read_only:
        df = _ensure_tracking_columns(
            manifest_path, df, reason_column, status_column, annotation_column, contrast_column
        )
    reason_options = _collect_reason_tags(df, reason_column, include_default_reason_tags)
    status_options = _collect_status_options(df, status_column)
    score_classes = _score_columns_present(df)
    has_annotation_column = bool(annotation_column) and annotation_column in df.columns
    has_contrast_column = bool(contrast_column) and contrast_column in df.columns

    rows = []
    for i, row in df.iterrows():
        image_path = _cell_str(row[image_column])
        if not image_path:
            continue
        mask_path = _cell_str(row[mask_column]) if has_mask_column else ""
        annotation_path = _cell_str(row[annotation_column]) if has_annotation_column else ""

        if id_column:
            label = _cell_str(row[id_column]) or f"row {i}"
        else:
            label = os.path.splitext(os.path.basename(image_path))[0]

        patient_id = _cell_str(row[patient_id_column]) if patient_id_column else ""
        comment = _cell_text(row[COMMENT_COLUMN]) if COMMENT_COLUMN in df.columns else ""
        status = _cell_text(row[status_column]).strip() if (status_column and status_column in df.columns) else ""
        reason = (
            _split_reasons(_cell_text(row[reason_column]))
            if (reason_column and reason_column in df.columns)
            else []
        )
        scores = {c: _score_value(row[f"{c}{SCORE_COLUMN_SUFFIX}"]) for c in score_classes}
        contrast = _contrast_flag(row[contrast_column]) if has_contrast_column else None

        rows.append(
            {
                "index": int(i),
                "label": label,
                "patient_id": patient_id,
                "image_path": image_path,
                "mask_path": mask_path,
                "annotation_path": annotation_path,
                "image_exists": os.path.exists(image_path),
                "mask_exists": bool(mask_path) and os.path.exists(mask_path),
                "annotation_exists": bool(annotation_path) and os.path.exists(annotation_path),
                "comment": comment,
                "status": status,
                "reason": reason,
                "scores": scores,
                "contrast": contrast,
            }
        )
    return {
        "rows": rows,
        "reason_options": reason_options,
        "status_options": status_options,
        "score_classes": score_classes,
        "has_annotation_column": has_annotation_column,
        "has_contrast_column": has_contrast_column,
    }


def _save_cell(
    manifest_path: str, row_index: int, column: str, value: str, reason_column: str = DEFAULT_REASON_COLUMN
) -> None:
    """Write a single cell back into the manifest.

    For Excel this edits that one cell in the existing workbook and leaves
    everything else — other sheets, formatting, formulas, the exact text of
    every other value — exactly as it was. Only CSV (and an Excel file
    openpyxl refuses to open) goes through the full rewrite, which rebuilds
    the file from a pandas DataFrame and cannot preserve any of that.

    row_index is the raw pandas row index returned as `index` in
    list_manifest_pairs, so this must be reading the identical file the rows
    were listed from.
    """
    manifest_path = clean_path(manifest_path)
    if not os.path.isfile(manifest_path):
        raise FileNotFoundError(manifest_path)

    if _is_excel(manifest_path):
        try:
            if _set_cells_in_place(manifest_path, [(row_index, column, value)]):
                return
        except Exception:
            # Fall through to the rewrite path rather than losing the edit.
            pass

    df = _read_table(manifest_path)
    if row_index not in df.index:
        raise ValueError(f"Row {row_index} not found in manifest (it may have changed on disk)")

    if column not in df.columns:
        df[column] = ""

    df[column] = df[column].astype(object)
    df.loc[row_index, column] = value
    _write_table(manifest_path, df, reason_column=reason_column)


def save_comment(manifest_path: str, row_index: int, comment: str) -> None:
    _save_cell(manifest_path, row_index, COMMENT_COLUMN, comment)


def save_status(manifest_path: str, row_index: int, status: str, status_column=DEFAULT_STATUS_COLUMN) -> None:
    if not status_column:
        raise ValueError("No status column configured for this manifest")
    _save_cell(manifest_path, row_index, status_column, status)


def save_reason(manifest_path: str, row_index: int, reasons: list, reason_column=DEFAULT_REASON_COLUMN) -> None:
    if not reason_column:
        raise ValueError("No reason column configured for this manifest")
    cleaned = [t.strip() for t in reasons if t and t.strip()]
    _save_cell(manifest_path, row_index, reason_column, REASON_DELIMITER.join(cleaned), reason_column=reason_column)


def save_mask_path(manifest_path: str, row_index: int, mask_column: str, mask_path: str) -> None:
    """Record a path into the manifest's mask column — for a row that had no
    mask configured yet, so re-opening this manifest (or navigating back to
    this case) picks the saved file up automatically instead of showing "no
    mask" again."""
    _save_cell(manifest_path, row_index, mask_column, mask_path)


def save_annotation_path(manifest_path: str, row_index: int, annotation_column: str, annotation_path: str) -> None:
    """Record where this case's saved annotation lives, in its own column.

    Separate from the mask column on purpose. Writing it into the mask column
    would lose the path of the original prediction the annotation started
    from; leaving it unrecorded (what used to happen whenever a row already
    had a mask) meant the next visit silently re-opened that prediction and
    the previous session's work was never seen again.
    """
    if not annotation_column:
        raise ValueError("No annotation column configured for this manifest")
    _save_cell(manifest_path, row_index, annotation_column, annotation_path)


def save_contrast_flag(manifest_path: str, row_index: int, contrast_column: str, is_contrast: bool) -> None:
    """Record that a case is (or is not) a contrast-enhanced scan, so the
    next session knows without relying on anyone remembering."""
    if not contrast_column:
        raise ValueError("No contrast column configured for this manifest")
    _save_cell(manifest_path, row_index, contrast_column, "Yes" if is_contrast else "No")
