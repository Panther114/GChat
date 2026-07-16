#!/usr/bin/env python3
"""Regenerate desktop icon pack from public/gchat_icon.png (current brand)."""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "gchat_icon.png"
BUILD = ROOT / "build"
ICONS = BUILD / "icons"


def main() -> None:
    img = Image.open(SRC).convert("RGBA")
    print(f"source {SRC} size={img.size} bytes={SRC.stat().st_size}")
    print(f"corner pixel={img.getpixel((10, 10))}")

    ICONS.mkdir(parents=True, exist_ok=True)
    sizes = [16, 32, 48, 64, 128, 256, 512]
    ico_images = []
    for size in sizes:
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        out = ICONS / f"{size}x{size}.png"
        resized.save(out, format="PNG", optimize=True)
        print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size} bytes)")
        if size in (16, 32, 48, 64, 128, 256):
            ico_images.append(resized)

    ico_path = BUILD / "icon.ico"
    # PIL multi-size ICO: pass sizes on the largest image.
    ico_images[-1].save(
        ico_path,
        format="ICO",
        sizes=[(im.width, im.height) for im in ico_images],
    )
    print(f"wrote {ico_path.relative_to(ROOT)} ({ico_path.stat().st_size} bytes)")
    sample = Image.open(ICONS / "256x256.png").convert("RGBA")
    opaque = None
    for y in range(0, sample.height, 8):
        for x in range(0, sample.width, 8):
            pixel = sample.getpixel((x, y))
            if pixel[3] > 200 and sum(pixel[:3]) > 30:
                opaque = pixel
                break
        if opaque:
            break
    print(f"256 sample opaque pixel={opaque}")
    if not opaque or opaque[2] < opaque[0]:
        raise SystemExit("Regenerated icon does not look like the blue brand mark")


if __name__ == "__main__":
    main()
