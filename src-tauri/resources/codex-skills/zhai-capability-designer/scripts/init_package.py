#!/usr/bin/env python3
"""Create a minimal zhai work-skill package without overwriting existing files."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit("usage: init_package.py <directory> <skill-id> [name]")
    root = Path(sys.argv[1]).resolve()
    skill_id = sys.argv[2]
    name = sys.argv[3] if len(sys.argv) > 3 else skill_id
    (root / "scripts").mkdir(parents=True, exist_ok=True)
    (root / "tests" / "fixtures").mkdir(parents=True, exist_ok=True)
    contract = {
        "schemaVersion": 1, "id": skill_id, "name": name,
        "description": "待完善的能力包", "version": "0.1.0", "status": "draft",
        "implementation": "python", "inputExtensions": [], "outputExtensions": [],
        "parametersSchema": {"type": "object", "properties": {}},
        "permissions": ["read_inputs", "write_outputs"], "requiresNetwork": False,
        "dependencies": [], "acceptance": ["原件保持不变"], "composition": None,
    }
    files = {
        root / "skill.json": json.dumps(contract, ensure_ascii=False, indent=2) + "\n",
        root / "SKILL.md": f"# {name}\n\n说明该能力包的触发条件、输入、参数和输出。\n",
        root / "scripts" / "main.py": "def run(context, params):\n    return {\"summary\": \"尚未实现\", \"outputs\": []}\n",
        root / "tests" / "cases.json": "[]\n",
    }
    for path, content in files.items():
        if not path.exists():
            path.write_text(content, encoding="utf-8")


if __name__ == "__main__":
    main()
