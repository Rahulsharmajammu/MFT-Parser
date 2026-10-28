"""Dose conversion, smoothing and replicate averaging."""

from __future__ import annotations

import numpy as np
from scipy.signal import savgol_filter

METRICS = ["dE76", "dE2000", "L", "a", "b", "dL", "da", "db"]


def x_values(time_s: np.ndarray, x_axis: str, max_dose: float) -> np.ndarray:
    """Time in seconds, or dose in Mlux·h assuming constant irradiance over the run."""
    if x_axis == "dose":
        t_end = time_s[-1] if len(time_s) and time_s[-1] > 0 else 1.0
        return time_s / t_end * max_dose
    if x_axis == "time_min":
        return time_s / 60.0
    return time_s


def smooth(y: np.ndarray, method: str, window: int, polyorder: int = 2) -> np.ndarray:
    n = len(y)
    if method == "none" or n < 3 or window < 2:
        return y
    window = min(window, n if n % 2 else n - 1)
    if window % 2 == 0:
        window -= 1
    if window < 3:
        return y
    if method == "moving_average":
        half = window // 2
        out = np.empty_like(y)
        for i in range(n):
            lo, hi = max(0, i - half), min(n, i + half + 1)
            out[i] = y[lo:hi].mean()
        return out
    if method == "savgol":
        return savgol_filter(y, window, min(polyorder, window - 1), mode="interp")
    raise ValueError(f"unknown smoothing method {method!r}")


def prepare_replicate(columns: dict, settings: dict, max_dose: float) -> dict:
    t = np.asarray(columns["time"], dtype=float)
    x = x_values(t, settings.get("x_axis", "dose"), max_dose)
    out = {"x": x}
    for m in METRICS:
        if m in columns:
            y = np.asarray(columns[m], dtype=float)
            out[m] = smooth(y, settings.get("smoothing", "none"),
                            int(settings.get("window", 5)), int(settings.get("polyorder", 2)))
    return out


def average_replicates(reps: list[dict], n_points: int | None = None) -> dict:
    """Interpolate replicates onto a common x grid (their overlapping range) and return mean/sd."""
    x_max = min(r["x"][-1] for r in reps)
    x_min = max(r["x"][0] for r in reps)
    if n_points is None or n_points < 2:
        n_points = int(np.median([len(r["x"]) for r in reps]))
    grid = np.linspace(x_min, x_max, max(n_points, 2))
    out = {"x": grid, "n": len(reps)}
    for m in METRICS:
        stacks = [np.interp(grid, r["x"], r[m]) for r in reps if m in r]
        if not stacks:
            continue
        arr = np.vstack(stacks)
        out[m] = arr.mean(axis=0)
        out[m + "_sd"] = arr.std(axis=0, ddof=1) if len(stacks) > 1 else np.zeros_like(grid)
    return out


def process(request: dict) -> dict:
    """Request: {"settings": {...}, "groups": [{"id", "max_dose"?, "members": [{"id", "columns"}]}]}"""
    settings = request.get("settings", {})
    default_dose = float(settings.get("max_dose", 0.5))
    n_points = settings.get("avg_points")
    result = []
    for g in request.get("groups", []):
        dose = g.get("max_dose")
        dose = float(dose) if dose not in (None, "") else default_dose
        reps = []
        for mem in g.get("members", []):
            r = prepare_replicate(mem["columns"], settings, dose)
            reps.append((mem["id"], r))
        entry = {"id": g["id"], "replicates": [_tolist({"id": i, **r}) for i, r in reps]}
        if reps:
            entry["average"] = _tolist(average_replicates([r for _, r in reps],
                                                          int(n_points) if n_points else None))
        result.append(entry)
    return {"groups": result}


def _tolist(d: dict) -> dict:
    return {k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in d.items()}
