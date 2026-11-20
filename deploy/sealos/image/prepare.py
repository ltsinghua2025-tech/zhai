#!/usr/bin/env python3
"""Prepare a public Docker context from current sources and verified offline wheels."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

here = Path(__file__).resolve().parent
app = here.parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--frontend", type=Path, required=True)
parser.add_argument("--offline-zip", type=Path, required=True)
parser.add_argument("--context", type=Path, required=True)
args = parser.parse_args()
args.context.mkdir(parents=True, exist_ok=False)
runtime = args.context / "zhai"
version = json.loads((app / "package.json").read_text())["version"]
if not (args.frontend / "index.html").is_file():
    raise SystemExit("缺少已构建的 Web 前端")
if not (args.frontend / ".vite/license.md").is_file():
    raise SystemExit("缺少前端第三方许可证，请启用 Vite build.license 后重新构建")
shutil.copytree(args.frontend, runtime / "dist")
for folder, files in {
    "server": ("app.py", "runtime_config.py", "data_admin.py"),
    "engine": ("material_workshop_engine.py", "redaction_engine.py", "gongwen_layout.py",
               "redhead.py", "word_structure.py", "requirements.txt"),
    "resources": ("builtin-output-contracts.json",),
}.items():
    (runtime / folder).mkdir()
    for name in files:
        shutil.copy2(app / folder / name, runtime / folder / name)
for name in ("entrypoint.sh", "verify-package.py"):
    shutil.copy2(here.parent / name, runtime / name)
shutil.copy2(app / "LICENSE", runtime / "LICENSE")
with zipfile.ZipFile(args.offline_zip) as archive:
    manifest = json.loads(archive.read("zhai/manifest.json"))
    if archive.read("zhai/engine/requirements.txt") != (runtime / "engine/requirements.txt").read_bytes():
        raise SystemExit("离线包依赖与当前源码不一致")
    dest = args.context / "wheels"
    dest.mkdir()
    wheels = [name for name in manifest if Path(name).parent == Path("wheels/aarch64") and name.endswith(".whl")]
    if not wheels:
        raise SystemExit("缺少 aarch64 wheels")
    for name in wheels:
        data = archive.read("zhai/" + name)
        if hashlib.sha256(data).hexdigest() != manifest[name]:
            raise SystemExit(f"wheel SHA256 不匹配 {name}")
        (dest / Path(name).name).write_bytes(data)
(runtime / "release.json").write_text(json.dumps({
    "schemaVersion": 1, "product": "zhai-sealos-web", "version": version,
    "python": "3.12", "architectures": ["aarch64"], "codexCli": False,
    "ocr": False, "customPython": False,
}) + "\n")
hashes = {p.relative_to(runtime).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
          for p in sorted(runtime.rglob("*")) if p.is_file()}
(runtime / "manifest.json").write_text(json.dumps(hashes, ensure_ascii=False, indent=2) + "\n")
for name in ("Dockerfile", "entrypoint.sh"):
    shutil.copy2(here / name, args.context / name)
