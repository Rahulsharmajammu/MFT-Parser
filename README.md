# MFT-Parser

A local web app for processing and visualising microfading tester (MFT) data.
It reads the data files produced by the **Microfader** developed by
[Instytut Fotonowy](https://www.fotonowy.pl/). MFT-Parser is an independent tool and is not
made or endorsed by Instytut Fotonowy.

Load many measurements, group the replicates, then overlay the groups as
individual curves or as mean ± SD. It replaces the usual copy-paste work in Excel.

Everything runs on your own machine. The browser talks to a small Python server
on `127.0.0.1`, and no data leaves the computer.

## Running it (Windows)

1. Install Python 3.10 or newer from <https://www.python.org/downloads/> and tick
   **"Add python.exe to PATH"** during installation.
2. Double-click `run_windows.bat`. The first run sets up a `.venv` folder and
   installs the dependencies, which takes a minute. After that it starts right away.
3. A browser tab opens at <http://127.0.0.1:8765/>. If port 8765 is already taken by another app
   (or an MFT-Parser that is still running), the next free port is used and the console says which.
4. To stop the app, click **Stop server** at the top of the sidebar, close the console window, or press
   Ctrl+C in it. Closing only the browser tab leaves the server running. Use **Save session** first if
   you want to keep your groups.

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
| `BWS1_BWS1-12.png`, `BWS1_BWS1-12_after.jpg`, … | Images of the measurement spot, shown in reports (PNG/JPEG/BMP/GIF/WebP) |

Drop a whole folder onto the app, or use **Add folder** / **Add files**. An image belongs to
the measurement whose name it starts with, followed by `-`, `_`, `.`, a space or `(`. When names
overlap, the longest match wins, so `BWS1_BWS1-12_after.jpg` goes to `BWS1_BWS1-12` and not to `BWS1_BWS1-1`.
Images are kept in the browser and downscaled to at most 1600 px.

## Workflow

1. **Load** the files. Measurements appear in the table, and you can hover a name to see its header metadata.
2. **Group** the replicates:
   - Select rows and click **New group from selection**. You can filter by text or by `/regex/`,
     use the header checkbox to select everything shown, and shift-click to select a range.
   - **Auto-group** groups measurements whose names differ only in the trailing number
     (`…-10`, `…-11`, `…-12`).
   - A measurement can belong to several groups.
   - **Drag and drop**: drag rows from the measurements table onto a group to add them. Dragging a
     selected row drags the whole selection. Drag a member from one group onto another to move it,
     or hold Ctrl to copy it. While you drag, drop zones appear for creating a new group and, for
     group members, for removing them from their group.
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
   - **Curve fit**: linear (`y = a + b·x`), power law (`y = A·xⁿ`) or exponential saturation
     (`y = A·(1 − e^(−k·x))`). Each group's mean curve is fitted for ΔE00, ΔE\*ab, ΔL\*, Δa\* and Δb\*.
     The fitted lines appear dotted on the charts, and a table below the charts lists the parameters and R².
   - **Tidying up**: click a sidebar section heading (Data, Processing, Charts, Groups,
     Measurements, Curve fits) to collapse it. ⊟ collapses or expands all group cards. « hides
     the whole side panel and **☰ Panel** brings it back. The browser remembers these choices.
5. **Charts**:
   - The **Height** slider and the **Columns** setting control the chart size.
   - The expand button in a chart's toolbar shows that chart full width; click it again to restore.
   - The minus button in a chart's toolbar hides that chart; turn it back on with its chip under Charts.
   - The **a\*b\* trajectory** chart plots b\* against a\* at equal scale. An open circle marks
     the start and a filled circle the end.
6. **Export**:
   - **Export means CSV** / **Export replicates CSV** / **Export fits CSV** save the processed data.
   - The camera button in a chart's toolbar opens the export dialog. There you set the title,
     light or dark theme, legend position, size, resolution and format (PNG, SVG or JPEG).
   - **Report…** (all visible groups) or the ▤ button on a group card produces a single,
     self-contained HTML report with one section per group:
     - before/after colour patches (sRGB renderings of the measured L\*a\*b\*)
     - mean ± SD at the end of exposure
     - a table of the measurements as recorded
     - curve fits, charts and matched images

     To get a PDF, open the report and use the browser's Print → Save as PDF.
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
