#!/usr/bin/env python3
"""Build or verify the deterministic VibeDraw ComfyUI plugin archive.

The archive unpacks straight into ComfyUI's `custom_nodes/` directory, so the
`vibedraw_comfy/` folder is the top-level entry rather than a nested one. Like
the happ archive this is byte-for-byte reproducible: fixed timestamps, sorted
entries, no compression surprises.

Usage:
  python3 tools/package-plugin.py           # build release/vibedraw-comfyui-plugin-v2.0.0.zip
  python3 tools/package-plugin.py --check   # rebuild in memory and compare digests
"""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "comfyui-plugin"
VERSION = "2.0.1"
ARCHIVE = ROOT / "release" / f"vibedraw-comfyui-plugin-v{VERSION}.zip"
FIXED_TIMESTAMP = (2026, 9, 17, 0, 0, 0)
ENTRIES = ("vibedraw_comfy", "README.md")


def plugin_files() -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    for relative in ENTRIES:
        target = SOURCE / relative
        if target.is_file():
            files.append(target)
        elif target.is_dir():
            # Bytecode caches are build leftovers from whatever machine last imported
            # the plugin; they must never travel in the published archive.
            files.extend(
                path
                for path in target.rglob("*")
                if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
            )
        else:
            raise SystemExit(f"missing plugin path: {relative}")
    return sorted(files, key=lambda path: path.relative_to(SOURCE).as_posix())


def plugin_directories() -> list[str]:
    """Explicit folder entries keep the archive friendly to simple unzip tools."""
    names = {
        path.relative_to(SOURCE).parent.as_posix() + "/"
        for path in plugin_files()
        if path.relative_to(SOURCE).parent.parts
    }
    return sorted(names)


def write_archive(archive: pathlib.Path) -> None:
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for name in plugin_directories():
            info = zipfile.ZipInfo(name, FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = (0o40755 << 16) | 0x10
            bundle.writestr(info, b"")
        for path in plugin_files():
            info = zipfile.ZipInfo(path.relative_to(SOURCE).as_posix(), FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            bundle.writestr(info, path.read_bytes())


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify the committed archive")
    args = parser.parse_args()

    if args.check:
        if not ARCHIVE.exists():
            raise SystemExit(f"missing archive: {ARCHIVE.relative_to(ROOT)}")
        import tempfile

        with tempfile.TemporaryDirectory() as temporary:
            rebuilt = pathlib.Path(temporary) / ARCHIVE.name
            write_archive(rebuilt)
            if sha256(rebuilt) != sha256(ARCHIVE):
                raise SystemExit("the committed plugin archive does not match its sources")
        print(f"plugin archive ok {ARCHIVE.relative_to(ROOT)} sha256={sha256(ARCHIVE)}")
        return

    ARCHIVE.parent.mkdir(parents=True, exist_ok=True)
    write_archive(ARCHIVE)
    print(f"created {ARCHIVE.relative_to(ROOT)} ({ARCHIVE.stat().st_size} bytes) sha256={sha256(ARCHIVE)}")


if __name__ == "__main__":
    main()
