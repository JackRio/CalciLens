"""Normalize user/frontend-supplied filesystem paths.

Paths typed or pasted by a user commonly carry surrounding double quotes
(Windows Explorer's "Copy as path"), leading/trailing whitespace, or a
trailing slash — all of which make os.path.isdir/isfile silently return
False even though the path is "obviously" correct to a human.
"""


def clean_path(path: str) -> str:
    if path is None:
        return path
    cleaned = path.strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in ("'", '"'):
        cleaned = cleaned[1:-1].strip()
    return cleaned
