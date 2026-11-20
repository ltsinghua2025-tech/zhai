#!/usr/bin/env python3
"""Build losslessly compressed main + optional OCR DEBs from local artifacts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time


def run(*args):
    # Focal dpkg-deb supports xz. XZ_OPT only affects an external xz process;
    # dpkg builds using liblzma may choose their own worker count.
    subprocess.run(args, check=True, env={**os.environ, "XZ_OPT": "-T2"})


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def payload(root):
    result = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if relative.parts[0] == "DEBIAN":
            continue
        if path.is_symlink():
            result[str(relative)] = {"link": os.readlink(path)}
        elif path.is_file():
            result[str(relative)] = {"sha256": digest(path), "bytes": path.stat().st_size,
                                     "mode": path.stat().st_mode & 0o777}
    return result


def field(control, name, value):
    # Debian fields may span indented continuation lines.
    expression = rf"^{re.escape(name)}:.*(?:\n[ \t].*)*\n?"
    control = re.sub(expression, "", control, flags=re.MULTILINE)
    return control.rstrip() + f"\n{name}: {value}\n"


def build(stage, output, work):
    expected = payload(stage)
    control_path = stage / "DEBIAN/control"
    installed_kib = sum((item.get("bytes", 0) + 1023) // 1024 for item in expected.values())
    control_path.write_text(field(control_path.read_text(), "Installed-Size", installed_kib))
    candidate = work / output.name
    started = time.monotonic()
    run("dpkg-deb", "--root-owner-group", "--uniform-compression", "-Zxz", "-z6", "--build", str(stage), str(candidate))
    verify = work / (output.stem + "-verify")
    run("dpkg-deb", "--extract", str(candidate), str(verify))
    if payload(verify) != expected:
        raise RuntimeError("压缩后的包文件、权限或哈希不一致，拒绝交付")
    shutil.copy2(candidate, output.with_suffix(".deb.new"))
    output.with_suffix(".deb.new").replace(output)
    return {"file": str(output), "bytes": output.stat().st_size, "sha256": digest(output),
            "installedKiB": installed_kib, "payloadVerified": True,
            "seconds": round(time.monotonic() - started, 3), "files": expected}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--main-deb", type=Path, required=True)
    parser.add_argument("--ocr-binary", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--revision", default="1", help="Debian package revision")
    args = parser.parse_args()
    if not shutil.which("dpkg-deb"):
        parser.error("请在 Linux 构建环境运行，需要 dpkg-deb")
    project = Path(__file__).resolve().parents[1]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    version = json.loads((project / "package.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        parser.error("版本格式无效")
    if not re.fullmatch(r"[1-9][0-9]*", args.revision):
        parser.error("Debian 修订号格式无效")
    package_version = f"{version}-{args.revision}"
    if not args.ocr_binary.is_file() or not os.access(args.ocr_binary, os.X_OK):
        parser.error("缺少已验证的 OCR 可执行组件")
    header = subprocess.check_output(["dpkg-deb", "--field", str(args.main_deb)], text=True)
    for line in ["Package: zhai", f"Version: {version}", "Architecture: arm64"]:
        if line not in header.splitlines():
            parser.error("主包名称、版本或架构不符")
    with tempfile.TemporaryDirectory(prefix="zhai-components-") as temporary:
        work = Path(temporary)
        main_stage = work / "main"
        run("dpkg-deb", "--raw-extract", str(args.main_deb), str(main_stage))
        if any("rapid-ocr" in name for name in payload(main_stage)):
            raise RuntimeError("主包仍包含 OCR，请先从 Tauri externalBin 移除")
        control_path = main_stage / "DEBIAN/control"
        control = control_path.read_text()
        dependency_fields = re.findall(
            r"^(?:Pre-Depends|Depends|Recommends):.*(?:\n[ \t].*)*", control, re.MULTILINE
        )
        if any(re.search(r"\bzhai-ocr\b", value) for value in dependency_fields):
            raise RuntimeError("OCR 不得成为自动安装依赖")
        control_path.write_text(field(field(control, "Suggests", "zhai-ocr"), "Version", package_version))
        ocr_stage = work / "ocr"
        executable = ocr_stage / "usr/lib/zhai/ocr/material-workshop-rapid-ocr"
        executable.parent.mkdir(parents=True)
        shutil.copy2(args.ocr_binary, executable)
        executable.chmod(0o755)
        notices = ocr_stage / "usr/share/doc/zhai-ocr/THIRD-PARTY-NOTICES.txt"
        notices.parent.mkdir(parents=True)
        shutil.copyfile(project / "src-tauri/binaries/OCR-THIRD-PARTY-NOTICES.txt", notices)
        (ocr_stage / "DEBIAN").mkdir()
        (ocr_stage / "DEBIAN/control").write_text(
            f"Package: zhai-ocr\nVersion: {package_version}\nArchitecture: arm64\n"
            "Maintainer: zhai\nSection: utils\nPriority: optional\n"
            f"Depends: zhai (= {package_version}), libc6 (>= 2.31), libgcc-s1, libstdc++6\n"
            "Description: Optional offline Chinese PDF OCR for zhai\n"
            " Includes fixed local RapidOCR models and an isolated CPU runtime.\n"
            " Install only when scanned PDF text recognition is needed.\n"
        )
        results = [build(main_stage, args.output_dir / f"zhai_{package_version}_arm64.deb", work),
                   build(ocr_stage, args.output_dir / f"zhai-ocr_{package_version}_arm64.deb", work)]
        (args.output_dir / "package-manifest.json").write_text(json.dumps({
            "version": package_version, "compression": "xz-6", "mainInputBytes": args.main_deb.stat().st_size,
            "mainInputSha256": digest(args.main_deb), "packages": results,
        }, ensure_ascii=False, indent=2) + "\n")
        for result in results:
            print(json.dumps({key: value for key, value in result.items() if key != "files"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
