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


def test_shutdown_without_launcher_is_refused():
    assert client.post("/api/shutdown").json()["stopped"] is False


def test_find_port_skips_busy_port():
    import socket

    from mft_parser.__main__ import HOST, find_port

    with socket.socket() as s:
        s.bind((HOST, 0))
        s.listen()
        busy = s.getsockname()[1]
        assert find_port(busy) not in (busy, None)
