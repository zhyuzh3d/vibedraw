#!/usr/bin/env python3
"""Publish the archived VibeDraw brand artwork as the application icon.

`docs/assets/vibedraw-icon-source.png` is the artwork exactly as designed: the
brand magenta field with the white italic V sitting off-centre to the right.
That placement is the design, so this tool is a faithful transcode and nothing
else - it never re-centres, rescales or recomposes the mark. It exists so the
APK icon, the website icon and the happ package icon are all rendered from one
committed source instead of drifting as three separate exports.

Output is lossless WebP at the artwork's own resolution.

Usage:
  python3 tools/make-icon.py --out app/assets/icon.webp
  python3 tools/make-icon.py --out app/assets/icon.webp --copy ../hermitweb/public/assets/site/vibedraw.webp
"""

from __future__ import annotations

import argparse
import pathlib
import shutil

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "assets" / "vibedraw-icon-source.png"


def build() -> Image.Image:
    art = Image.open(SOURCE)
    return art.convert("RGBA") if "A" in art.getbands() else art.convert("RGB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="output WebP path")
    parser.add_argument("--copy", action="append", default=[], help="extra path to receive the same icon")
    parser.add_argument("--preview", help="optional PNG preview path")
    args = parser.parse_args()

    icon = build()
    output = pathlib.Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    icon.save(output, format="WEBP", lossless=True, method=6)
    print(f"created {output} ({icon.size[0]}x{icon.size[1]}, {output.stat().st_size} bytes)")
    for destination in args.copy:
        path = pathlib.Path(destination)
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(output, path)
        print(f"copied to {path}")
    if args.preview:
        icon.save(args.preview, format="PNG")


if __name__ == "__main__":
    main()
