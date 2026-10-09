#!/usr/bin/env python3
"""South Park assets — banner + genre-tile background (uploaded town sign)
and the wooden-sign logo with its white background made transparent.

Inputs:  /home/z/my-project/upload/be161868884d91d258e8e36e00c83f5f.jpg  (town sign scene)
         /home/z/my-project/upload/53efd886f013aaaa8e84f2b659e2cdea.jpg  (wooden sign logo)
Outputs: src/public/art/south-park-banner.jpg      (details hero banner)
         src/public/tiles/southpark-bg.jpg         (genre tile background)
         src/public/tiles/southpark-logo.png       (genre tile overlay — transparent)
         src/public/art/south-park-logo.png        (Anime.logoUrl)
"""
from PIL import Image
import os

UP = "/home/z/my-project/upload"
PUB = "/home/z/my-project/src/public"

scene = Image.open(f"{UP}/be161868884d91d258e8e36e00c83f5f.jpg").convert("RGB")
logo = Image.open(f"{UP}/53efd886f013aaaa8e84f2b659e2cdea.jpg").convert("RGB")
print("scene:", scene.size, "| logo:", logo.size)

# ---- banner + tile background: straight copy (the scene is the art) ----
scene.save(f"{PUB}/art/south-park-banner.jpg", quality=88)
scene.save(f"{PUB}/tiles/southpark-bg.jpg", quality=85)

# ---- logo: white -> transparent (flood-tolerant threshold), trim margins ----
rgba = logo.convert("RGBA")
px = rgba.load()
w, h = rgba.size
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        # near-white AND near-neutral -> transparent (keeps the brown wood)
        if r > 235 and g > 235 and b > 235:
            px[x, y] = (r, g, b, 0)
        elif r > 218 and g > 218 and b > 218 and abs(r - g) < 14 and abs(g - b) < 14:
            px[x, y] = (r, g, b, 0)
# soft edge: pixels close to white keep partial alpha for antialiasing
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if a == 255 and r > 200 and g > 200 and b > 200 and abs(r - g) < 16 and abs(g - b) < 16:
            lum = (r + g + b) / 3
            alpha = max(0, min(255, int((245 - lum) * 255 / 45)))
            if alpha < 255:
                px[x, y] = (r, g, b, alpha)
bbox = rgba.getbbox()
if bbox:
    rgba = rgba.crop(bbox)
rgba.save(f"{PUB}/tiles/southpark-logo.png")
rgba.save(f"{PUB}/art/south-park-logo.png")
print("outputs written; logo trimmed to", rgba.size)
for f in ["art/south-park-banner.jpg", "tiles/southpark-bg.jpg", "tiles/southpark-logo.png", "art/south-park-logo.png"]:
    p = f"{PUB}/{f}"
    print(f"  {f}: {os.path.getsize(p)} bytes")
