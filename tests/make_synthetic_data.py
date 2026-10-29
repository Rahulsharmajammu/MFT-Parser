"""Generate the synthetic test fixtures in tests/data/.

The files mimic the Microfader output format (tab-separated, CRLF line endings) but the
values are made up: a blue sample that fades along a power-law curve, plus random noise.

    python tests/make_synthetic_data.py
"""

from __future__ import annotations

import math
import random
from pathlib import Path

OUT = Path(__file__).parent / "data"
STEM = "DEMO_DEMO-01"
N_STEPS = 121  # plus the t=0 row -> 122 rows
DT = 4.0  # s between readings
T_END = 2.5 + DT * (N_STEPS - 1)  # 482.5 s


def ciede2000(lab1, lab2):
    """CIEDE2000 colour difference (kL = kC = kH = 1)."""
    L1, a1, b1 = lab1
    L2, a2, b2 = lab2
    C1, C2 = math.hypot(a1, b1), math.hypot(a2, b2)
    Cm = (C1 + C2) / 2
    G = 0.5 * (1 - math.sqrt(Cm**7 / (Cm**7 + 25**7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360
    h2p = math.degrees(math.atan2(b2, a2p)) % 360
    dLp = L2 - L1
    dCp = C2p - C1p
    if C1p * C2p == 0:
        dhp = 0.0
    else:
        dhp = h2p - h1p
        if dhp > 180:
            dhp -= 360
        elif dhp < -180:
            dhp += 360
    dHp = 2 * math.sqrt(C1p * C2p) * math.sin(math.radians(dhp) / 2)
    Lpm = (L1 + L2) / 2
    Cpm = (C1p + C2p) / 2
    if C1p * C2p == 0:
        hpm = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hpm = (h1p + h2p) / 2
    else:
        hpm = (h1p + h2p + 360) / 2 if h1p + h2p < 360 else (h1p + h2p - 360) / 2
    T = (1 - 0.17 * math.cos(math.radians(hpm - 30)) + 0.24 * math.cos(math.radians(2 * hpm))
         + 0.32 * math.cos(math.radians(3 * hpm + 6)) - 0.20 * math.cos(math.radians(4 * hpm - 63)))
    d_theta = 30 * math.exp(-(((hpm - 275) / 25) ** 2))
    Rc = 2 * math.sqrt(Cpm**7 / (Cpm**7 + 25**7))
    Sl = 1 + 0.015 * (Lpm - 50) ** 2 / math.sqrt(20 + (Lpm - 50) ** 2)
    Sc = 1 + 0.045 * Cpm
    Sh = 1 + 0.015 * Cpm * T
    Rt = -math.sin(math.radians(2 * d_theta)) * Rc
    return math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))


def fmt(v: float) -> str:
    return f"{v:.6g}"


def main_file(rng: random.Random) -> str:
    lab0 = (50.0, -5.0, -40.0)
    lines = [
        "# Date: Thu Jan  1 10:00:00 2026",
        "# Object: DEMO",
        "# Illuminant: D65",
        "# Sample integration time [ms]: 10",
        "# White standard integration time [ms]: 10",
        "# Sample: DEMO-01",
        "# Curr: 900 (Watts: 0, MLuxes: 0)",
        "#    : ",
        "#Time\tLux\tL\ta\tb\tdE76\tdE2000\tdL\tda\tdb",
    ]
    times = [0.0] + [2.5 + DT * i for i in range(N_STEPS)]
    for t in times:
        f = (t / T_END) ** 0.55  # fraction of the final change
        lab = lab0 if t == 0 else (
            lab0[0] + 3.0 * f + rng.gauss(0, 0.05),
            lab0[1] - 2.0 * f + rng.gauss(0, 0.15),
            lab0[2] + 7.0 * f + rng.gauss(0, 0.2),
        )
        d = [lab[i] - lab0[i] for i in range(3)]
        row = [t, 0.0, *lab, math.sqrt(sum(x * x for x in d)), ciede2000(lab0, lab), *d]
        lines.append("\t".join(fmt(v) for v in row))
    return "\r\n".join(lines) + "\r\n"


def spect_file(rng: random.Random) -> str:
    wl = [200 + 0.2 * i for i in range(4000)]  # 200-1000 nm

    def signal(peaks, noise):
        out = []
        for w in wl:
            if w < 380 or w > 720:
                out.append(0.0)  # the instrument pads outside its range with zeros
                continue
            v = sum(h * math.exp(-(((w - c) / s) ** 2)) for c, h, s in peaks)
            out.append(max(0.0, v + rng.gauss(0, noise)))
        return out

    lamp = [(450, 500, 25), (560, 300, 70)]
    rows = [
        [0.0, *wl],
        [0.0, *signal(lamp, 2)],  # white standard
        [0.0, *signal([(450, 6, 40)], 1)],  # dark
        [0.0, *signal([(450, 230, 22), (520, 110, 40), (680, 120, 35)], 2)],  # sample at start
        [T_END * 1000, *signal([(450, 225, 22), (520, 95, 40), (680, 100, 35)], 2)],  # sample at end (ms)
    ]
    return "\r\n".join("\t".join(fmt(v) for v in r) for r in rows) + "\r\n"


if __name__ == "__main__":
    rng = random.Random(12345)
    OUT.mkdir(exist_ok=True)
    (OUT / f"{STEM}.txt").write_bytes(main_file(rng).encode())
    (OUT / f"{STEM}-spect.txt").write_bytes(spect_file(rng).encode())
    print(f"wrote {STEM}.txt and {STEM}-spect.txt to {OUT}")
