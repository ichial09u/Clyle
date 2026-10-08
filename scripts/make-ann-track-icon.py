#!/usr/bin/env python3
"""Turn the owner-uploaded "climbing the chart" artwork into the ANN tracking
button icon: knock out the near-white background, trim, square-pad, and ship a
crisp 128px PNG into the app's public/ folder (same pipeline shape as the
other one-off asset prep scripts)."""
from PIL import Image

SRC = "/home/z/my-project/upload/file_00000000b9d48230aa22f1dcd178bd52.png"
DST = "/home/z/my-project/src/public/ann-track.png"

img = Image.open(SRC).convert("RGBA")
px = img.load()
w, h = img.size

# near-white -> transparent, with a short feather band so edges don't halo
LO, HI = 232, 250
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        m = min(r, g, b)
        if m >= HI:
            px[x, y] = (r, g, b, 0)
        elif m >= LO:
            # the closer to pure white, the more transparent
            t = (m - LO) / float(HI - LO)
            px[x, y] = (r, g, b, int(a * (1.0 - t)))

# trim to visible content
bbox = img.getbbox()
img = img.crop(bbox)

# square-pad on the larger side so the circle crop never clips the art
side = max(img.size)
sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
sq.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
sq = sq.resize((128, 128), Image.LANCZOS)
sq.save(DST, optimize=True)
print("wrote", DST, sq.size)
