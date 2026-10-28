"""Run with ``python -m mft_parser`` or the ``mft-parser`` command."""

import argparse
import socket
import threading
import webbrowser

import uvicorn

from .server import app

HOST = "127.0.0.1"


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((HOST, port))
        except OSError:
            return False
    return True


def find_port(preferred: int, attempts: int = 20) -> int | None:
    for port in range(preferred, preferred + attempts):
        if port_is_free(port):
            return port
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="MFT-Parser local web app")
    parser.add_argument("--port", type=int, default=8765, help="preferred port; the next free one is used if it is taken")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    args = parser.parse_args()

    port = find_port(args.port)
    if port is None:
        raise SystemExit(f"No free port found between {args.port} and {args.port + 19}. Try --port with another number.")
    if port != args.port:
        print(f"Port {args.port} is already in use (another app, or MFT-Parser still running) - using {port} instead.")

    url = f"http://{HOST}:{port}/"
    server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=port, log_level="warning"))
    app.state.server = server  # lets the "Stop server" button shut it down
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print(f"MFT-Parser running at {url}")
    print("Stop it with the 'Stop server' button in the app, by closing this window, or with Ctrl+C.")
    server.run()
    print("MFT-Parser stopped.")


if __name__ == "__main__":
    main()
