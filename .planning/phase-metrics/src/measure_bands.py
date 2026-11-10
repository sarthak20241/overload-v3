"""Compare a sim screenshot with the reference by text-band positions (in points).

python3 measure_bands.py <sim_screenshot.png>
Prints (y_pt, height_pt) of each bright band in the left column for both, so
spacing and type size can be matched number for number. The reference is
852x1846 with the phone bezel; its screen is ~812 px for 402 pt. A sim
screenshot is 3 px per pt.
"""
import sys
from PIL import Image

import os
REF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shots", "goal-screen-v2-reference.webp")


def bands(path, x0f, x1f, thr, scale_pt, y_off_pt=0.0):
    im = Image.open(path).convert("L")
    W, H = im.size
    x0, x1 = int(W * x0f), int(W * x1f)
    px = im.load()
    out, s = [], None
    for y in range(int(H * 0.03), int(H * 0.97)):
        on = any(px[x, y] > thr for x in range(x0, x1, 2))
        if on and s is None:
            s = y
        if not on and s is not None:
            if y - s > 2:
                out.append((round(s / scale_pt - y_off_pt), round((y - s) / scale_pt, 1)))
            s = None
    return out


if __name__ == "__main__":
    print("REF ", bands(REF, 0.07, 0.6, 120, 812 / 402, 4))
    print("SIM ", bands(sys.argv[1], 0.04, 0.6, 120, 3.0))
