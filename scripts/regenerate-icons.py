#!/usr/bin/env python3
"""Regenerate desktop icon packs from public/gchat_icon.png (current brand).

Writes:
  - src-tauri/icons/app-icon-source.png  (navy square + white mark for tray/installer)
  - build/icon.ico + build/icons/*.png   (legacy Electron/build path)
  - then run: npx tauri icon src-tauri/icons/app-icon-source.png --output src-tauri/icons
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "gchat_icon.png"
BUILD = ROOT / "build"
ICONS = BUILD / "icons"
TAURI_ICONS = ROOT / "src-tauri" / "icons"
NAVY = (11, 16, 32, 255)


def make_desktop_icon(src: Image.Image, size: int) -> Image.Image:
    """Solid navy square + white brand mark — visible on light and dark chrome."""
    bg = Image.new("RGBA", (size, size), NAVY)
    pad = max(1, int(size * 0.14))
    bird = src.resize((size - 2 * pad, size - 2 * pad), Image.Resampling.LANCZOS)
    bg.paste(bird, (pad, pad), bird)
    return bg


def main() -> None:
    img = Image.open(SRC).convert("RGBA")
    print(f"source {SRC} size={img.size} bytes={SRC.stat().st_size}")

    TAURI_ICONS.mkdir(parents=True, exist_ok=True)
    master = make_desktop_icon(img, 1024)
    master_path = TAURI_ICONS / "app-icon-source.png"
    master.save(master_path, format="PNG", optimize=True)
    print(f"wrote {master_path.relative_to(ROOT)} ({master_path.stat().st_size} bytes)")
    print(f"  corner={master.getpixel((0, 0))} center={master.getpixel((512, 512))}")

    ICONS.mkdir(parents=True, exist_ok=True)
    sizes = [16, 32, 48, 64, 128, 256, 512]
    ico_images = []
    for size in sizes:
        resized = make_desktop_icon(img, size)
        out = ICONS / f"{size}x{size}.png"
        resized.save(out, format="PNG", optimize=True)
        print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size} bytes)")
        if size in (16, 32, 48, 64, 128, 256):
            ico_images.append(resized)

    ico_path = BUILD / "icon.ico"
    ico_images[-1].save(
        ico_path,
        format="ICO",
        sizes=[(im.width, im.height) for im in ico_images],
    )
    print(f"wrote {ico_path.relative_to(ROOT)} ({ico_path.stat().st_size} bytes)")

    opaque = None
    sample = Image.open(ICONS / "256x256.png").convert("RGBA")
    for y in range(0, sample.height, 8):
        for x in range(0, sample.width, 8):
            pixel = sample.getpixel((x, y))
            if pixel[3] > 200 and sum(pixel[:3]) > 30:
                opaque = pixel
                break
        if opaque:
            break
    print(f"256 sample opaque pixel={opaque}")
    if not opaque:
        raise SystemExit("Regenerated icon is missing a visible brand mark")

    print(
        "Next: npx tauri icon src-tauri/icons/app-icon-source.png --output src-tauri/icons"
    )


if __name__ == "__main__":
    main()
