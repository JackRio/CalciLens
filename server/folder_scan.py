"""CSV / Excel manifest driven batch loading.

The manifest has one row per case with (at minimum) a column holding the
absolute image path and a column holding the absolute mask path. Column
names are user-configurable since every lab's spreadsheet is different.
"""
from __future__ import annotations

import os
from typing import Optional

import pandas as pd

from pathutil import clean_path

DEFAULT_IMAGE_COLUMN = "image_path"
DEFAULT_MASK_COLUMN = "mask_path"
COMMENT_COLUMN = "Comment"
STATUS_COLUMN = "Status"
STATUS_OPTIONS = ["Not Started", "Annotated", "InProgress", "Review"]
DEFAULT_STATUS = STATUS_OPTIONS[0]

REASON_COLUMN = "Reason"
REASON_DELIMITER = "; "
DEFAULT_REASON_TAGS = [
    "Relabel Issue",
    "Incorrect Prediction",
    "Valve Class",
    "Foreign Object",
    "Corrupted Image",
]

# Score columns are named "<CLASS>_Agatston" in the manifest and are purely
# optional/informational — a case's per-class Agatston calcium scores,
# shown in the viewer if present, skipped entirely if not.
SCORE_CLASSES = ["CAC", "LAD", "LCx", "RCA", "TAC", "AV", "MV"]
SCORE_COLUMN_SUFFIX = "_Agatston"


def _read_table(manifest_path: str) -> pd.DataFrame:
    ext = os.path.splitext(manifest_path)[1].lower()
    if ext in (".xlsx", ".xls", ".xlsm"):
        return pd.read_excel(manifest_path)
    return pd.read_csv(manifest_path)


def _write_table(manifest_path: str, df: pd.DataFrame) -> None:
    ext = os.path.splitext(manifest_path)[1].lower()
    if ext in (".xlsx", ".xls", ".xlsm"):
        df.to_excel(manifest_path, index=False)
        if ext in (".xlsx", ".xlsm"):
            # Data validation (a real in-cell dropdown) is an openpyxl/xlsx
            # feature with no CSV equivalent, and pandas' to_excel doesn't
            # carry it over from a previous save — so it must be re-applied
            # after every write that could have touched this file. Best
            # effort: a manifest opened by something else entirely (a
            # workbook openpyxl can't parse) shouldn't block the save.
            try:
                _apply_list_dropdown(manifest_path, df, STATUS_COLUMN, STATUS_OPTIONS)
                _apply_list_dropdown(manifest_path, df, REASON_COLUMN, _collect_reason_tags(df))
            except Exception:
                pass
    else:
        df.to_csv(manifest_path, index=False)


def _apply_list_dropdown(manifest_path: str, df: pd.DataFrame, column: str, options: list) -> None:
    """Attach an Excel in-cell dropdown listing `options` to every data row
    of `column`. Note Excel's list validation only ever lets a *single*
    value be picked through its own UI — for Reason (which this app stores
    as multiple tags joined in one cell) it's still applied as a reference/
    suggestion list, but picking an option directly in Excel will replace
    the whole cell rather than add to it."""
    from openpyxl import load_workbook
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation

    if column not in df.columns or not options:
        return
    formula1 = '"' + ",".join(options) + '"'
    if len(formula1) > 255:  # Excel's hard cap on an inline list formula
        return
    col_letter = get_column_letter(list(df.columns).index(column) + 1)

    wb = load_workbook(manifest_path)
    ws = wb.active
    dv = DataValidation(
        type="list",
        formula1=formula1,
        allow_blank=True,
        showDropDown=False,  # openpyxl quirk: False is what actually shows the dropdown arrow
    )
    ws.add_data_validation(dv)
    dv.add(f"{col_letter}2:{col_letter}{len(df) + 1}")
    wb.save(manifest_path)


def _split_reasons(value: str) -> list:
    return [t.strip() for t in value.split(REASON_DELIMITER.strip()) if t.strip()]


def _collect_reason_tags(df: pd.DataFrame) -> list:
    """Every reason tag currently in use anywhere in the sheet, plus the
    built-in defaults — defaults first, then any additional tags actually
    found (e.g. ones added as a one-off in a previous session), in the
    order first encountered."""
    tags = list(DEFAULT_REASON_TAGS)
    if REASON_COLUMN in df.columns:
        for value in df[REASON_COLUMN]:
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


def _ensure_tracking_columns(manifest_path: str, df: pd.DataFrame) -> pd.DataFrame:
    """Make sure Status and Comment exist and every Status cell holds a
    valid value, writing the manifest immediately if anything was missing —
    so both columns (Status pre-filled "Not Started", Comment blank) are
    visible in the file itself as soon as it's loaded, not only after the
    first edit made through the app."""
    changed = False

    if STATUS_COLUMN not in df.columns:
        df[STATUS_COLUMN] = DEFAULT_STATUS
        changed = True
    else:
        df[STATUS_COLUMN] = df[STATUS_COLUMN].astype(object)
        blank = df[STATUS_COLUMN].apply(lambda v: _cell_text(v) not in STATUS_OPTIONS)
        if blank.any():
            df.loc[blank, STATUS_COLUMN] = DEFAULT_STATUS
            changed = True

    if COMMENT_COLUMN not in df.columns:
        df[COMMENT_COLUMN] = ""
        changed = True

    if REASON_COLUMN not in df.columns:
        df[REASON_COLUMN] = ""
        changed = True

    if changed:
        _write_table(manifest_path, df)
    return df


def _score_columns_present(df: pd.DataFrame) -> list:
    return [c for c in SCORE_CLASSES if f"{c}{SCORE_COLUMN_SUFFIX}" in df.columns]


def _score_value(value) -> Optional[float]:
    if value is None or pd.isna(value):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def list_manifest_pairs(
    manifest_path: str,
    image_column: str = DEFAULT_IMAGE_COLUMN,
    mask_column: str = DEFAULT_MASK_COLUMN,
    id_column: Optional[str] = None,
    patient_id_column: Optional[str] = None,
) -> dict:
    manifest_path = clean_path(manifest_path)
    if not os.path.isfile(manifest_path):
        raise FileNotFoundError(manifest_path)

    df = _read_table(manifest_path)

    if image_column not in df.columns:
        raise ValueError(f"Column '{image_column}' not found. Available columns: {list(df.columns)}")
    if mask_column not in df.columns:
        raise ValueError(f"Column '{mask_column}' not found. Available columns: {list(df.columns)}")
    if id_column and id_column not in df.columns:
        raise ValueError(f"Column '{id_column}' not found. Available columns: {list(df.columns)}")
    if patient_id_column and patient_id_column not in df.columns:
        raise ValueError(f"Column '{patient_id_column}' not found. Available columns: {list(df.columns)}")

    df = _ensure_tracking_columns(manifest_path, df)
    reason_options = _collect_reason_tags(df)
    score_classes = _score_columns_present(df)

    rows = []
    for i, row in df.iterrows():
        image_path = _cell_str(row[image_column])
        if not image_path:
            continue
        mask_path = _cell_str(row[mask_column])

        if id_column:
            label = _cell_str(row[id_column]) or f"row {i}"
        else:
            label = os.path.splitext(os.path.basename(image_path))[0]

        patient_id = _cell_str(row[patient_id_column]) if patient_id_column else ""
        comment = _cell_text(row[COMMENT_COLUMN]) if COMMENT_COLUMN in df.columns else ""
        status = _cell_text(row[STATUS_COLUMN]) if STATUS_COLUMN in df.columns else ""
        if status not in STATUS_OPTIONS:
            status = DEFAULT_STATUS
        reason = _split_reasons(_cell_text(row[REASON_COLUMN])) if REASON_COLUMN in df.columns else []
        scores = {c: _score_value(row[f"{c}{SCORE_COLUMN_SUFFIX}"]) for c in score_classes}

        rows.append(
            {
                "index": int(i),
                "label": label,
                "patient_id": patient_id,
                "image_path": image_path,
                "mask_path": mask_path,
                "image_exists": os.path.isfile(image_path),
                "mask_exists": bool(mask_path) and os.path.isfile(mask_path),
                "comment": comment,
                "status": status,
                "reason": reason,
                "scores": scores,
            }
        )
    return {"rows": rows, "reason_options": reason_options, "score_classes": score_classes}


def _save_cell(manifest_path: str, row_index: int, column: str, value: str) -> None:
    """Write a single cell back into the manifest file itself, creating the
    column if it doesn't already exist. row_index is the raw pandas row
    index returned as `index` in list_manifest_pairs (the row's position in
    this same file), so this must be reading the identical file the rows
    were listed from."""
    manifest_path = clean_path(manifest_path)
    if not os.path.isfile(manifest_path):
        raise FileNotFoundError(manifest_path)

    df = _read_table(manifest_path)
    if row_index not in df.index:
        raise ValueError(f"Row {row_index} not found in manifest (it may have changed on disk)")

    if column not in df.columns:
        df[column] = ""

    df[column] = df[column].astype(object)
    df.loc[row_index, column] = value
    _write_table(manifest_path, df)


def save_comment(manifest_path: str, row_index: int, comment: str) -> None:
    _save_cell(manifest_path, row_index, COMMENT_COLUMN, comment)


def save_status(manifest_path: str, row_index: int, status: str) -> None:
    if status not in STATUS_OPTIONS:
        raise ValueError(f"Invalid status '{status}'; must be one of {STATUS_OPTIONS}")
    _save_cell(manifest_path, row_index, STATUS_COLUMN, status)


def save_reason(manifest_path: str, row_index: int, reasons: list) -> None:
    cleaned = [t.strip() for t in reasons if t and t.strip()]
    _save_cell(manifest_path, row_index, REASON_COLUMN, REASON_DELIMITER.join(cleaned))


def save_mask_path(manifest_path: str, row_index: int, mask_column: str, mask_path: str) -> None:
    """Record a newly-saved annotation's file path into the manifest's mask
    column — for a row that had no mask configured yet, so re-opening this
    manifest (or navigating back to this case) picks the saved file up
    automatically instead of showing "no mask" again."""
    _save_cell(manifest_path, row_index, mask_column, mask_path)
