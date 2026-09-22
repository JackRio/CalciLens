"""Normalize user/frontend-supplied filesystem paths.

Paths typed or pasted by a user commonly carry surrounding double quotes
(Windows Explorer's "Copy as path"), leading/trailing whitespace, or a
trailing slash — all of which make os.path.isdir/isfile silently return
False even though the path is "obviously" correct to a human.
"""
import datetime
import os


def clean_path(path: str) -> str:
    if path is None:
        return path
    cleaned = path.strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in ("'", '"'):
        cleaned = cleaned[1:-1].strip()
    return cleaned


def dated_annotation_dir(base_dir: str) -> str:
    """<base_dir>/Manual_Annotations_<DD_Mon_YYYY>, created if missing. One
    folder per calendar day — every save/sidecar written on the same date
    lands in the same folder regardless of how many times the app restarts
    that day."""
    folder = os.path.join(base_dir, f"Manual_Annotations_{datetime.date.today().strftime('%d_%b_%Y')}")
    os.makedirs(folder, exist_ok=True)
    return folder
