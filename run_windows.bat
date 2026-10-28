@echo off
rem Double-click to start MFT-Parser. The first run creates a virtual environment and installs dependencies.
cd /d "%~dp0"
if not exist .venv (
    echo Creating virtual environment...
    py -3 -m venv .venv || python -m venv .venv || goto :nopython
    .venv\Scripts\python -m pip install --upgrade pip
    .venv\Scripts\python -m pip install -e . || goto :fail
)
.venv\Scripts\python -m mft_parser %*
goto :eof

:nopython
echo Python 3.10+ was not found. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
pause
goto :eof

:fail
echo Installation failed - see the messages above.
pause
