"""FastAPI app: parses uploaded files, processes groups and serves the frontend."""

from __future__ import annotations

from pathlib import Path

import plotly
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .parsing import parse_files
from .processing import process

STATIC = Path(__file__).parent / "static"
PLOTLY_JS = Path(plotly.__file__).parent / "package_data" / "plotly.min.js"

app = FastAPI(title="MFT-Parser", version=__version__)


@app.post("/api/parse")
async def api_parse(files: list[UploadFile] = File(...)):
    texts = {}
    for f in files:
        raw = await f.read()
        texts[f.filename or "unnamed"] = raw.decode("utf-8", errors="replace")
    measurements, warnings = parse_files(texts)
    return {"measurements": [m.to_dict() for m in measurements], "warnings": warnings}


@app.post("/api/process")
async def api_process(request: dict):
    return process(request)


@app.post("/api/shutdown")
async def api_shutdown(request: Request):
    server = getattr(request.app.state, "server", None)
    if server is None:
        return {"stopped": False, "reason": "not started from the mft-parser launcher"}
    server.should_exit = True  # uvicorn finishes this response, then exits
    return {"stopped": True}


@app.get("/vendor/plotly.min.js")
async def plotly_js():
    # Served from the installed plotly package so the app works offline.
    return FileResponse(PLOTLY_JS, media_type="application/javascript")


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
