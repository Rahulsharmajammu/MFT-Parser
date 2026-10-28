import numpy as np
import pytest

from mft_parser.processing import average_replicates, process, smooth, x_values


def test_dose_scaling():
    t = np.array([0.0, 100.0, 400.0])
    assert x_values(t, "dose", 0.5).tolist() == [0.0, 0.125, 0.5]
    assert x_values(t, "time_min", 0.5).tolist() == pytest.approx([0, 100 / 60, 400 / 60])


def test_smoothing_preserves_lines():
    y = np.linspace(0, 10, 21)
    assert smooth(y, "savgol", 7) == pytest.approx(y)
    ma = smooth(y, "moving_average", 5)
    assert ma[5:-5] == pytest.approx(y[5:-5])
    assert smooth(y, "none", 5) is y


def test_average_uses_overlap_and_sd():
    a = {"x": np.array([0.0, 1.0, 2.0]), "dE2000": np.array([0.0, 1.0, 2.0])}
    b = {"x": np.array([0.0, 1.5]), "dE2000": np.array([0.0, 3.0])}
    avg = average_replicates([a, b], n_points=4)
    assert avg["x"].tolist() == [0.0, 0.5, 1.0, 1.5]
    assert avg["dE2000"].tolist() == pytest.approx([0.0, 0.75, 1.5, 2.25])
    assert avg["dE2000_sd"][-1] == pytest.approx(np.std([1.5, 3.0], ddof=1))
    assert avg["n"] == 2


def test_process_group_dose_override():
    cols = {"time": [0, 10, 20], "dE2000": [0, 1, 2]}
    out = process({
        "settings": {"x_axis": "dose", "max_dose": 0.5},
        "groups": [
            {"id": "g1", "members": [{"id": "m1", "columns": cols}]},
            {"id": "g2", "max_dose": 2, "members": [{"id": "m1", "columns": cols}]},
        ],
    })
    g1, g2 = out["groups"]
    assert g1["replicates"][0]["x"][-1] == 0.5
    assert g2["replicates"][0]["x"][-1] == 2
    assert g1["average"]["dE2000_sd"] == [0, 0, 0]


@pytest.mark.parametrize("model,true", [
    ("linear", lambda x: 0.2 + 3 * x),
    ("power", lambda x: 4 * x ** 0.6),
    ("exp", lambda x: 5 * (1 - np.exp(-6 * x))),
])
def test_fit_recovers_known_curves(model, true):
    from mft_parser.processing import fit_curve
    x = np.linspace(0, 0.5, 60)
    fit = fit_curve(x, true(x), model)
    assert fit["r2"] == pytest.approx(1.0, abs=1e-6)
    assert fit["y"][-1] == pytest.approx(true(0.5), rel=1e-4)


def test_process_returns_fits_for_delta_metrics():
    t = list(np.linspace(0, 400, 50))
    cols = {"time": t, "dE2000": [4 * (v / 800) ** 0.5 for v in t], "L": [50.0] * 50}
    out = process({"settings": {"fit_model": "power"},
                   "groups": [{"id": "g", "members": [{"id": "m", "columns": cols}]}]})
    fits = out["groups"][0]["fits"]
    assert list(fits) == ["dE2000"]
    assert fits["dE2000"]["params"]["n"] == pytest.approx(0.5, abs=1e-3)
