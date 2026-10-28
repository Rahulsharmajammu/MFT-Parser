# MFT-Parser

A local web app for processing and visualising microfading tester (MFT) data.
Load many measurements, group the replicates, then overlay the groups as
individual curves or as mean ± SD. It replaces the usual copy-paste work in Excel.

Everything runs on your own machine. The browser talks to a small Python server
on `127.0.0.1`, and no data leaves the computer.

## Running it (Windows)

1. Install Python 3.10 or newer from <https://www.python.org/downloads/> and tick
   **"Add python.exe to PATH"** during installation.
2. Double-click `run_windows.bat`. The first run sets up a `.venv` folder and
   installs the dependencies, which takes a minute. After that it starts right away.
3. A browser tab opens at <http://127.0.0.1:8765/>. Close the console window to stop the app.

Manual / other platforms:

```bash
python -m venv .venv
.venv/Scripts/activate        # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -e .
mft-parser                     # or: python -m mft_parser [--port 8765] [--no-browser]
```

## Input files

Each measurement is a group of files that share a stem, for example `BWS1_BWS1-12`:

| File | Used for |
|---|---|
| `BWS1_BWS1-12.txt` | Colorimetric time series: Time, L\*, a\*, b\*, ΔE76, ΔE2000, ΔL\*, Δa\*, Δb\* |
| `BWS1_BWS1-12-spect.txt` | Raw start/end spectra, shown as recorded (optional) |
| `BWS1_BWS1-12-spect_convert.txt` | Ignored |

Drop a whole folder onto the app, or use **Add folder** / **Add files**.

## Workflow

1. **Load** the files. Measurements appear in the table, and you can hover a name to see its header metadata.
2. **Group** the replicates:
   - Select rows and click **New group from selection**. You can filter by text or by `/regex/`,
     use the header checkbox to select everything shown, and shift-click to select a range.
   - **Auto-group** groups measurements whose names differ only in the trailing number
     (`…-10`, `…-11`, `…-12`).
   - A measurement can belong to several groups.
3. **Control what's shown**:
   - Tick or untick a group to show or hide it, and untick a single replicate to drop it
     from that group's plots and average.
   - The chart chips pick which metrics are drawn.
   - **Replicates / Mean ± SD / Both** sets the display mode.
4. **Processing**:
   - **X axis**: dose in Mlux·h, or time in s or min.
   - **Max dose**: the total dose at the end of the run (default 0.5 Mlux·h). Time is scaled
     linearly to dose, which assumes constant illuminance. Each group can override it.
   - **Smoothing**: moving average or Savitzky–Golay, applied to each replicate before averaging.
   - **Averaging**: replicates are linearly interpolated onto a common grid over their
     overlapping range. The number of points defaults to the median replicate length.
     SD is the sample standard deviation (n−1).
5. **Export**:
   - **Export means CSV** / **Export replicates CSV** save the processed data.
   - The camera icon on each chart saves a PNG.
   - **Save session** writes a single JSON file with the data, groups and settings, which
     **Load session** restores.

## Development

```bash
pip install -e ".[dev]"
pytest
```

- `mft_parser/parsing.py` reads the file formats.
- `mft_parser/processing.py` handles dose conversion, smoothing and averaging.
- `mft_parser/server.py` holds the FastAPI endpoints.
- `mft_parser/static/` is the frontend, in plain JS. Plotly.js is served from the installed
  `plotly` package, so the app works offline.
