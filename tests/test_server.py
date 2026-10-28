from pathlib import Path

from fastapi.testclient import TestClient

from mft_parser.server import app

DATA = Path(__file__).parent / "data"
client = TestClient(app)


def test_index_and_vendor():
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/vendor/plotly.min.js").status_code == 200


def test_parse_then_process():
    files = [("files", (p.name, p.read_bytes())) for p in DATA.glob("*.txt")]
    data = client.post("/api/parse", files=files).json()
    [m] = data["measurements"]
    res = client.post("/api/process", json={
        "settings": {"x_axis": "dose", "max_dose": 0.5, "smoothing": "savgol", "window": 7},
        "groups": [{"id": "g", "members": [{"id": m["id"], "columns": m["columns"]}]}],
    }).json()
    avg = res["groups"][0]["average"]
    assert avg["x"][-1] == 0.5
    assert len(avg["dE2000"]) == len(m["columns"]["time"])
