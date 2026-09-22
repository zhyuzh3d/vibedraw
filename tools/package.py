#!/usr/bin/env python3
"""Build or verify the deterministic VibeDraw happ release archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import zipfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNTIME_ROOTS = ("index.html", "hermit.json", "guid.md", "app", "styles")
FIXED_TIMESTAMP = (2026, 9, 17, 0, 0, 0)


def runtime_files() -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    for relative in RUNTIME_ROOTS:
        target = ROOT / relative
        if target.is_file():
            files.append(target)
        elif target.is_dir():
            files.extend(path for path in target.rglob("*") if path.is_file())
        else:
            raise SystemExit(f"missing runtime path: {relative}")
    return sorted(files, key=lambda path: path.relative_to(ROOT).as_posix())


def release_info() -> tuple[str, pathlib.Path]:
    manifest = json.loads((ROOT / "hermit.json").read_text(encoding="utf-8"))
    relative = f"release/vibedraw-v{manifest['version']['name']}.zip"
    return relative, ROOT / relative


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build(output: pathlib.Path) -> str:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in runtime_files():
            relative = path.relative_to(ROOT).as_posix()
            info = zipfile.ZipInfo(relative, FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    if output.exists():
        if sha256(temporary) != sha256(output):
            temporary.unlink()
            raise SystemExit("versioned archive already exists with different content; bump the version before packaging")
        temporary.unlink()
    else:
        temporary.replace(output)
    return sha256(output)


def write_install_manifest(package_path: str, digest: str) -> None:
    content = {"schema": 1, "package": package_path, "sha256": digest}
    (ROOT / "hermit-install.json").write_text(
        json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def verify(package_path: str, output: pathlib.Path) -> None:
    if not output.is_file():
        raise SystemExit(f"release archive missing: {output}")
    install = json.loads((ROOT / "hermit-install.json").read_text(encoding="utf-8"))
    digest = sha256(output)
    if install != {"schema": 1, "package": package_path, "sha256": digest}:
        raise SystemExit("hermit-install.json does not match the release archive")
    expected_files = {path.relative_to(ROOT).as_posix() for path in runtime_files()}
    with zipfile.ZipFile(output) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != expected_files:
            raise SystemExit("release archive does not match the runtime allowlist")
        for path in runtime_files():
            relative = path.relative_to(ROOT).as_posix()
            if archive.read(relative) != path.read_bytes():
                raise SystemExit(f"release content mismatch: {relative}")
    print(f"verified {output.relative_to(ROOT)} sha256={digest}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    package_path, output = release_info()
    if not args.check:
        digest = build(output)
        write_install_manifest(package_path, digest)
        print(f"created {output.relative_to(ROOT)} sha256={digest}")
    verify(package_path, output)


if __name__ == "__main__":
    main()
