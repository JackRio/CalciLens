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


def _read_table(manifest_path: str) -> pd.DataFrame:
    ext = os.path.splitext(manifest_path)[1].lower()
    if ext in (".xlsx", ".xls", ".xlsm"):
        return pd.read_excel(manifest_path)
    return pd.read_csv(manifest_path)


def _cell_str(value) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)) or pd.isna(value):
        return ""
    return clean_path(str(value))


def list_manifest_columns(manifest_path: str) -> list:
    manifest_path = clean_path(manifest_path)
    if not os.path.isfile(manifest_path):
        raise FileNotFoundError(manifest_path)
    df = _read_table(manifest_path)
    return [str(c) for c in df.columns]


def list_manifest_pairs(
    manifest_path: str,
    image_column: str = DEFAULT_IMAGE_COLUMN,
    mask_column: str = DEFAULT_MASK_COLUMN,
    id_column: Optional[str] = None,
) -> list:
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

        rows.append(
            {
                "index": int(i),
                "label": label,
                "image_path": image_path,
                "mask_path": mask_path,
                "image_exists": os.path.isfile(image_path),
                "mask_exists": bool(mask_path) and os.path.isfile(mask_path),
            }
        )
    return rows
