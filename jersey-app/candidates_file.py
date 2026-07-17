"""Parse candidate CSV / Excel uploads and free-text lists for Jersey Studio."""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from pathlib import Path

from openpyxl import load_workbook

REQUIRED_COLUMNS = ("first_name", "last_name")
OPTIONAL_COLUMNS = ("linkedin_profile_link",)
KNOWN_COLUMNS = REQUIRED_COLUMNS + OPTIONAL_COLUMNS
MAX_CANDIDATES = 25

_HEADER_ALIASES: dict[str, str] = {
    "first_name": "first_name",
    "firstname": "first_name",
    "first": "first_name",
    "last_name": "last_name",
    "lastname": "last_name",
    "last": "last_name",
    "linkedin_profile_link": "linkedin_profile_link",
    "linkedin": "linkedin_profile_link",
    "linkedin_url": "linkedin_profile_link",
    "linkedin_link": "linkedin_profile_link",
    "linkedin_profile": "linkedin_profile_link",
    "profile_link": "linkedin_profile_link",
    "linkedin_profile_url": "linkedin_profile_link",
}

_LINKEDIN_IN_TEXT = re.compile(
    r"(?:https?://)?(?:www\.)?linkedin\.com/\S+",
    flags=re.IGNORECASE,
)


@dataclass(frozen=True)
class Candidate:
    first_name: str
    last_name: str
    linkedin_profile_link: str

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()


class CandidatesFileError(ValueError):
    """Invalid candidates spreadsheet or text list."""


def _normalize_header(value: object) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    return _HEADER_ALIASES.get(text, text)


def _cell_str(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _normalize_linkedin(url: str) -> str:
    """Return a cleaned LinkedIn URL, or "" when blank (optional)."""
    cleaned = url.strip().rstrip(".,);]")
    if not cleaned:
        return ""
    lower = cleaned.lower()
    if "linkedin.com/" not in lower:
        raise CandidatesFileError(
            f"linkedin profile link must be a LinkedIn URL when provided (got {cleaned!r})."
        )
    if not re.match(r"^https?://", cleaned, flags=re.I):
        cleaned = "https://" + cleaned.lstrip("/")
    return cleaned


def _split_full_name(name: str) -> tuple[str, str]:
    """Split a free-text name into first / last (last may be multi-word)."""
    parts = name.split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def _parse_text_line(line: str, line_num: int) -> Candidate | None:
    """Parse one free-text candidate line. Blank / comment lines → None."""
    raw = line.strip()
    if not raw or raw.startswith("#"):
        return None

    linkedin = ""
    match = _LINKEDIN_IN_TEXT.search(raw)
    if match:
        linkedin = _normalize_linkedin(match.group(0))
        raw = (raw[: match.start()] + raw[match.end() :]).strip()

    # Drop leftover separators around a LinkedIn URL (comma, pipe, em dash, tabs).
    raw = re.sub(r"[\t|,;]+", " ", raw)
    raw = re.sub(r"\s*[—–]+\s*", " ", raw)
    raw = re.sub(r"\s+", " ", raw).strip(" ,|;")
    if not raw:
        raise CandidatesFileError(
            f"Line {line_num}: name is required"
            + (" (LinkedIn alone is not enough)." if linkedin else ".")
        )

    first, last = _split_full_name(raw)
    if not first:
        raise CandidatesFileError(f"Line {line_num}: name is required.")
    return Candidate(
        first_name=first,
        last_name=last,
        linkedin_profile_link=linkedin,
    )


def parse_candidates_text(text: str) -> list[Candidate]:
    """Parse a free-text list: one person per line.

    Accepted line shapes:
      Jane Doe
      Jane Doe https://linkedin.com/in/janedoe
      Jane Doe, linkedin.com/in/janedoe
      Jane Doe — https://www.linkedin.com/in/janedoe
    Blank lines and # comments are ignored. Single given names are allowed.
    """
    if not (text or "").strip():
        raise CandidatesFileError("Candidates text is empty.")

    candidates: list[Candidate] = []
    for line_num, line in enumerate(text.splitlines(), start=1):
        person = _parse_text_line(line, line_num)
        if person is not None:
            candidates.append(person)

    if not candidates:
        raise CandidatesFileError("Candidates text has no names.")
    if len(candidates) > MAX_CANDIDATES:
        raise CandidatesFileError(
            f"Too many candidates ({len(candidates)}). Max is {MAX_CANDIDATES}."
        )
    return candidates


def _map_headers(headers: list[str]) -> dict[str, int]:
    if len(headers) < 2:
        raise CandidatesFileError(
            "File must have columns in order: first_name, last_name, "
            "and optionally linkedin profile link."
        )

    # Prefer positional order: first_name, last_name, [linkedin profile link].
    positional: dict[str, int] = {
        "first_name": 0,
        "last_name": 1,
    }
    if len(headers) >= 3:
        positional["linkedin_profile_link"] = 2

    normalized = [_normalize_header(h) for h in headers]
    first_two = normalized[:2]
    if first_two == list(REQUIRED_COLUMNS):
        if len(normalized) >= 3 and normalized[2] in (
            "linkedin_profile_link",
            "",
            "column_3",
        ):
            return positional
        if len(normalized) == 2:
            return positional
        # first_name/last_name match; still try to pick up linkedin by name below.

    # Accept unlabeled columns in the expected order.
    if first_two[0] in ("", "first_name", "column_1") and first_two[1] in (
        "",
        "last_name",
        "column_2",
    ):
        return positional

    index_by_name: dict[str, int] = {}
    for idx, header in enumerate(headers):
        key = _normalize_header(header)
        if key in KNOWN_COLUMNS and key not in index_by_name:
            index_by_name[key] = idx

    missing = [col for col in REQUIRED_COLUMNS if col not in index_by_name]
    if missing:
        raise CandidatesFileError(
            "File must have columns in order: first_name, last_name, "
            "and optionally linkedin profile link. "
            f"Missing or unrecognized: {', '.join(missing)}."
        )
    return index_by_name


def _rows_to_candidates(headers: list[str], rows: list[list[object]]) -> list[Candidate]:
    mapping = _map_headers(headers)
    candidates: list[Candidate] = []

    for row_num, row in enumerate(rows, start=2):
        if not any(_cell_str(cell) for cell in row):
            continue

        def col(name: str) -> str:
            if name not in mapping:
                return ""
            idx = mapping[name]
            return _cell_str(row[idx] if idx < len(row) else "")

        first = col("first_name")
        last = col("last_name")
        linkedin = col("linkedin_profile_link")
        if not first:
            raise CandidatesFileError(
                f"Row {row_num}: first_name is required."
            )
        if not last and " " in first:
            # Allow a single full-name column pasted into first_name.
            first, last = _split_full_name(first)
        if not last:
            raise CandidatesFileError(
                f"Row {row_num}: last_name is required "
                "(or put a full name in first_name)."
            )
        try:
            linkedin_url = _normalize_linkedin(linkedin)
        except CandidatesFileError as exc:
            raise CandidatesFileError(f"Row {row_num}: {exc}") from exc
        candidates.append(
            Candidate(
                first_name=first,
                last_name=last,
                linkedin_profile_link=linkedin_url,
            )
        )

    if not candidates:
        raise CandidatesFileError("File has no candidate rows.")
    if len(candidates) > MAX_CANDIDATES:
        raise CandidatesFileError(
            f"Too many candidates ({len(candidates)}). Max is {MAX_CANDIDATES}."
        )
    return candidates


def _parse_csv(data: bytes) -> list[Candidate]:
    text = data.decode("utf-8-sig")
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        raise CandidatesFileError("CSV is empty.")
    headers = [_cell_str(h) for h in rows[0]]
    return _rows_to_candidates(headers, rows[1:])


def _parse_excel(data: bytes) -> list[Candidate]:
    wb = load_workbook(filename=io.BytesIO(data), read_only=True, data_only=True)
    try:
        ws = wb.active
        if ws is None:
            raise CandidatesFileError("Excel file has no active sheet.")
        rows_iter = ws.iter_rows(values_only=True)
        try:
            header_row = next(rows_iter)
        except StopIteration as exc:
            raise CandidatesFileError("Excel sheet is empty.") from exc
        headers = [_cell_str(h) for h in header_row]
        body = [list(row) for row in rows_iter]
        return _rows_to_candidates(headers, body)
    finally:
        wb.close()


def parse_candidates_file(filename: str | None, data: bytes) -> list[Candidate]:
    if not data:
        raise CandidatesFileError("Candidates file is empty.")

    name = (filename or "").strip().lower()
    suffix = Path(name).suffix

    if suffix in {".xlsx", ".xlsm", ".xltx", ".xltm"}:
        return _parse_excel(data)
    if suffix == ".xls":
        raise CandidatesFileError(
            "Legacy .xls is not supported. Save as .xlsx or .csv."
        )
    if suffix == ".csv" or not suffix:
        # Sniff: Excel zip/ole signatures vs text CSV
        if data[:2] == b"PK":
            return _parse_excel(data)
        return _parse_csv(data)

    raise CandidatesFileError(
        "Unsupported file type. Upload a .csv or .xlsx file with columns "
        "first_name, last_name, and optionally linkedin profile link."
    )
