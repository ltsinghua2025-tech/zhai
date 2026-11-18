#!/usr/bin/env python3
"""Deterministic validator for a zhai work-skill package."""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

STATUSES = {"draft", "testing", "published", "test_failed", "unavailable", "disabled"}
IMPLEMENTATIONS = {"python", "workflow", "derived", "adapter"}
PERMISSIONS = {"read_inputs", "write_outputs", "network", "external_office", "ocr"}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"missing {path.name}")
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON in {path}: {exc}")


def validate_python(path: Path) -> None:
    if not path.is_file():
        fail(f"missing Python implementation: {path}")
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as exc:
        fail(f"Python syntax error: {exc}")
    functions = {node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    if "run" not in functions:
        fail(f"{path} must expose run(context, params)")


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    contract = load_json(root / "skill.json")
    if not isinstance(contract, dict):
        fail("skill.json must contain an object")
    required = {
        "schemaVersion", "id", "name", "description", "version", "status",
        "implementation", "inputExtensions", "outputExtensions", "parametersSchema",
        "permissions", "requiresNetwork", "dependencies", "acceptance",
    }
    missing = sorted(required.difference(contract))
    if missing:
        fail("missing fields: " + ", ".join(missing))
    if contract["schemaVersion"] != 1:
        fail("schemaVersion must be 1")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,63}", str(contract["id"])):
        fail("id must be 2-64 lowercase ASCII letters, numbers, underscores, or hyphens")
    if contract["status"] not in STATUSES or contract["implementation"] not in IMPLEMENTATIONS:
        fail("unsupported status or implementation")
    if not isinstance(contract["requiresNetwork"], bool):
        fail("requiresNetwork must be boolean")
    permissions = contract["permissions"]
    if not isinstance(permissions, list) or any(p not in PERMISSIONS for p in permissions):
        fail("permissions contains an unsupported value")
    if contract["requiresNetwork"] != ("network" in permissions):
        fail("requiresNetwork and network permission must agree")
    schema = contract["parametersSchema"]
    if not isinstance(schema, dict) or schema.get("type", "object") != "object" or not isinstance(schema.get("properties", {}), dict):
        fail("parametersSchema must describe an object with properties")
    parameters = contract.get("parameters", [])
    if not isinstance(parameters, list):
        fail("parameters must be an array when supplied")
    for parameter in parameters:
        if not isinstance(parameter, dict) or not {"key", "label", "type", "required"}.issubset(parameter):
            fail("each parameters entry requires key, label, type and required")
        if parameter["type"] not in {"text", "number", "boolean", "choice"} or not isinstance(parameter["required"], bool):
            fail("invalid parameter type or required flag")
    if not parameters:
        for key, value in schema.get("properties", {}).items():
            if not isinstance(value, dict) or value.get("type", "string") not in {"string", "number", "integer", "boolean"}:
                fail(f"parameter {key}: use a primitive field or a JSON string parsed by the script")
            if "enum" in value and (not isinstance(value["enum"], list) or any(not isinstance(v, str) for v in value["enum"])):
                fail(f"parameter {key}: enum options must be strings")
    for key in ("inputExtensions", "outputExtensions", "dependencies", "acceptance"):
        if not isinstance(contract[key], list):
            fail(f"{key} must be an array")
    if not (root / "SKILL.md").is_file():
        fail("missing SKILL.md")
    implementation = contract["implementation"]
    if implementation == "python":
        validate_python(root / "scripts" / "main.py")
    if implementation in {"workflow", "derived"}:
        composition = contract.get("composition")
        if not isinstance(composition, dict) or composition.get("schemaVersion") not in {1, 2}:
            fail("workflow/derived skill requires composition schemaVersion 1 or 2")
        version = composition["schemaVersion"]
        if implementation == "derived" and version != 1:
            fail("derived packages use schemaVersion 1; use workflow for schemaVersion 2")
        stages = composition.get("stages")
        limit = 32 if version == 2 else (4 if implementation == "derived" else 8)
        if not isinstance(stages, list) or not stages or len(stages) > limit:
            fail(f"composition must have 1-{limit} stages")
        if implementation == "derived" and stages[0].get("kind") != "skill":
            fail("derived skill must begin with a parent skill stage")
        for index, stage in enumerate(stages):
            if not isinstance(stage, dict) or stage.get("kind") not in {"skill", "python"}:
                fail(f"invalid composition stage {index + 1}")
            if stage["kind"] == "skill" and not stage.get("skillId"):
                fail(f"stage {index + 1} is missing skillId")
            selector = stage.get("input", "")
            if selector not in {"original", "previous"}:
                match = re.fullmatch(r"stage:([1-9][0-9]*)", str(selector))
                if version != 2 or not match or int(match[1]) > index:
                    fail(f"stage {index + 1} must reference an earlier output")
            if stage["kind"] == "python":
                script = (root / str(stage.get("script", ""))).resolve()
                try:
                    script.relative_to(root / "scripts")
                except ValueError:
                    fail(f"stage {index + 1} script escapes package")
                validate_python(script)
                source = script.read_text(encoding="utf-8")
                if "output_dir" not in source:
                    fail(
                        f"stage {index + 1} must write a new artifact to context.output_dir; "
                        "returning a previous-stage path is invalid"
                    )
    cases_path = root / "tests" / "cases.json"
    if cases_path.exists() and not isinstance(load_json(cases_path), list):
        fail("tests/cases.json must contain an array")
    rules_path = root / "references" / "parameter-rules.json"
    if rules_path.exists():
        rules = load_json(rules_path)
        if not isinstance(rules, dict) or set(rules) - {"atLeastOnePositive"}:
            fail("unsupported parameter rule")
        numeric_keys = {key for key, value in schema.get("properties", {}).items()
                        if isinstance(value, dict) and value.get("type") in {"number", "integer"}}
        numeric_keys.update(p["key"] for p in parameters if p["type"] == "number")
        groups = rules.get("atLeastOnePositive", [])
        if not isinstance(groups, list):
            fail("atLeastOnePositive must be an array of field groups")
        for group in groups:
            if not isinstance(group, list) or not group or any(not isinstance(key, str) or key not in numeric_keys for key in group):
                fail("positive parameter groups must reference declared numeric fields")
    print(json.dumps({"valid": True, "skillId": contract["id"], "status": contract["status"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
