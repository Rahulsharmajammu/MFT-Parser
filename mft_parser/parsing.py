"""Parsers for microfading tester output files.

A measurement ("file group") is identified by a common stem, e.g. ``BWS1_BWS1-12``:

* ``<stem>.txt``                - colorimetric time series (L*a*b*, dE, ...) with a ``#`` header
* ``<stem>-spect.txt``          - raw spectra: row 0 = wavelengths, then white, dark, samples
* ``<stem>-spect_convert.txt``  - transposed copy of the spectra (ignored)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

SPECT_SUFFIX = "-spect"
CONVERT_SUFFIX = "-spect_convert"

# Columns we expect in the colorimetric file, mapped to the keys used throughout the app.
COLUMN_KEYS = {
    "time": "time",
    "lux": "lux",
    "l": "L",
    "a": "a",
    "b": "b",
    "de76": "dE76",
    "de2000": "dE2000",
    "dl": "dL",
    "da": "da",
    "db": "db",
}


class ParseError(ValueError):
    pass


@dataclass
class Spectra:
    wavelengths: list[float]
    white: list[float]
    dark: list[float]
    samples: list[dict]  # [{"time_s": float, "values": [...]}, ...]


@dataclass
class Measurement:
    id: str
    meta: dict[str, str] = field(default_factory=dict)
    columns: dict[str, list[float]] = field(default_factory=dict)
    spectra: Spectra | None = None

    def to_dict(self) -> dict:
        d = {"id": self.id, "meta": self.meta, "columns": self.columns, "spectra": None}
        if self.spectra:
            d["spectra"] = {
                "wavelengths": self.spectra.wavelengths,
                "white": self.spectra.white,
                "dark": self.spectra.dark,
                "samples": self.spectra.samples,
            }
        return d


def classify_filename(filename: str) -> tuple[str, str] | None:
    """Return ``(stem, kind)`` where kind is ``main``, ``spect`` or ``convert``; None if not a .txt."""
    name = filename.replace("\\", "/").rsplit("/", 1)[-1]
    if not name.lower().endswith(".txt"):
        return None
    base = name[:-4]
    if base.endswith(CONVERT_SUFFIX):
        return base[: -len(CONVERT_SUFFIX)], "convert"
    if base.endswith(SPECT_SUFFIX):
        return base[: -len(SPECT_SUFFIX)], "spect"
    return base, "main"


def _floats(parts: list[str]) -> list[float]:
    return [float(p) for p in parts]


def parse_main(text: str, stem: str) -> Measurement:
    meta: dict[str, str] = {}
    header: list[str] | None = None
    rows: list[list[float]] = []

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            body = line[1:].strip()
            if "\t" in body and header is None:
                header = [h.strip() for h in body.split("\t")]
            elif ":" in body:
                key, _, value = body.partition(":")
                if key.strip():
                    meta[key.strip()] = value.strip()
            continue
        if header is None:
            raise ParseError(f"{stem}: data found before the column header line")
        parts = [p for p in line.split("\t")]
        try:
            rows.append(_floats(parts[: len(header)]))
        except ValueError as exc:
            raise ParseError(f"{stem}: could not parse data row {line!r}") from exc

    if header is None or not rows:
        raise ParseError(f"{stem}: no colorimetric data found")

    columns: dict[str, list[float]] = {}
    for i, name in enumerate(header):
        key = COLUMN_KEYS.get(re.sub(r"[^a-z0-9]", "", name.lower()), name)
        columns[key] = [r[i] for r in rows if i < len(r)]
    if "time" not in columns:
        raise ParseError(f"{stem}: no Time column")

    return Measurement(id=stem, meta=meta, columns=columns)


def parse_spect(text: str) -> Spectra:
    rows = [line.split("\t") for line in text.splitlines() if line.strip()]
    if len(rows) < 3:
        raise ParseError("spectrum file needs a wavelength row, a white row and a dark row")
    data = [_floats([p for p in r if p.strip()]) for r in rows]
    wl = data[0][1:]
    white, dark = data[1][1:], data[2][1:]
    samples = [{"time_s": r[0] / 1000.0, "values": r[1:]} for r in data[3:]]

    # Trim the wavelength range to where any row has signal (the instrument pads with zeros).
    signal_rows = [white, dark] + [s["values"] for s in samples]
    nonzero = [i for i in range(len(wl)) if any(row[i] != 0 for row in signal_rows if i < len(row))]
    lo, hi = (nonzero[0], nonzero[-1] + 1) if nonzero else (0, len(wl))
    return Spectra(
        wavelengths=wl[lo:hi],
        white=white[lo:hi],
        dark=dark[lo:hi],
        samples=[{"time_s": s["time_s"], "values": s["values"][lo:hi]} for s in samples],
    )


def parse_files(files: dict[str, str]) -> tuple[list[Measurement], list[str]]:
    """Parse a set of ``{filename: text}`` into measurements. Returns (measurements, warnings)."""
    groups: dict[str, dict[str, str]] = {}
    warnings: list[str] = []
    for name, text in files.items():
        cls = classify_filename(name)
        if cls is None:
            warnings.append(f"Skipped {name}: not a .txt file")
            continue
        stem, kind = cls
        if kind == "convert":
            continue
        groups.setdefault(stem, {})[kind] = text

    measurements = []
    for stem in sorted(groups):
        parts = groups[stem]
        if "main" not in parts:
            warnings.append(f"Skipped {stem}: spectrum file without a colorimetric file")
            continue
        try:
            m = parse_main(parts["main"], stem)
        except ParseError as exc:
            warnings.append(str(exc))
            continue
        if "spect" in parts:
            try:
                m.spectra = parse_spect(parts["spect"])
            except (ParseError, ValueError) as exc:
                warnings.append(f"{stem}: spectrum file ignored ({exc})")
        measurements.append(m)
    return measurements, warnings
