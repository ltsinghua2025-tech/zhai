# zhai Work Skill Contract

`skill.json` is the only machine-readable source of truth. Use camelCase keys.

```json
{
  "schemaVersion": 1,
  "id": "example_skill",
  "name": "示例技能",
  "description": "明确说明输入、动作和输出",
  "version": "0.1.0",
  "status": "draft",
  "implementation": "python",
  "inputExtensions": ["docx"],
  "outputExtensions": ["docx"],
  "parametersSchema": {"type": "object", "properties": {}},
  "permissions": ["read_inputs", "write_outputs"],
  "requiresNetwork": false,
  "dependencies": [],
  "acceptance": ["原件保持不变", "至少生成一个可打开的 DOCX"],
  "composition": null
}
```

Required fields are `schemaVersion`, `id`, `name`, `description`, `version`, `status`, `implementation`, `inputExtensions`, `outputExtensions`, `parametersSchema`, `permissions`, `requiresNetwork`, `dependencies`, and `acceptance`.

`parametersSchema.properties` generates the test/run form when the optional legacy `parameters` list is omitted. Supported fields are string, number/integer, boolean and string enums; use `title`, `default` and the schema's `required` list. Complex settings may use a JSON string parsed by the script. `testStatus`, `available` and `availabilityDetail` are application-managed metadata; omitting them defaults to untested/unavailable. Do not set `available: true` to bypass sample testing and publication.

Allowed `implementation` values are `python`, `workflow`, `derived`, and `adapter`.

Allowed statuses: `draft`, `testing`, `published`, `test_failed`, `unavailable`, `disabled`.

## Composition

```json
{
  "schemaVersion": 1,
  "versionPolicy": "latest_compatible",
  "stages": [
    {"kind": "skill", "skillId": "docx_to_gongwen", "input": "original", "parameters": {}},
    {"kind": "python", "script": "scripts/main.py", "input": "previous", "outputExtensions": ["docx"]}
  ]
}
```

For a derived skill, stage 1 identifies the parent mature skill. Subsequent stages normally use `previous`. Do not duplicate the parent's implementation in the child.

A derived package may contain only the parent stage when it is a saved parameter preset. For example, “公文排版并在标题后空一行” should configure `docx_to_gongwen` with `{"addTitleBlankLine": true}` and must not add a no-op Python stage.

## Python Runtime Contract

### Workflows in zhai 0.21

For a freely composed workflow use `implementation: "workflow"` and `composition.schemaVersion: 2`. The package-level schemaVersion remains 1. A workflow supports 1–32 stages, including published built-in/custom skills and independent Python scripts. Inputs may be `original`, `previous`, or `stage:1` (one-based, earlier steps only). A Python stage declares its own `script` path under `scripts/` and optional `parameters` object. Conditions, batch loops, field mapping and validation may be implemented inside a Python stage using `context.inputs`; every successful stage creates new output files. Only the last stage is delivered.

Stage parameters may reference workflow parameters with `{"$param":"parameterKey"}`; values retain their JSON types. Use `versionPolicy: "latest_compatible"` for newly designed workflows. Workflows saved from a successful task use `locked` and a generated `references/dependencies.json`; do not remove the lock to conceal a dependency mismatch. Sample tests execute the complete workflow, not just validate its JSON.

Reusable package scripts must not contain fixed paths to the original conversation. Use `context.inputs` and `context.output_dir`. Packaged scripts can read `context.resources_dir / "assets"` for templates and `context.resources_dir / "references"` for rules. Helpers in the package's scripts directory are importable. These resources are copied into a read-only runtime scope; write new files only under `context.output_dir`.

`scripts/main.py` must expose `run(context, params)`. `context.inputs` is a `list[pathlib.Path]`, not a list of dictionaries; e.g. `Document(context.inputs[0])`. `context.output_dir` is a `pathlib.Path` and the only writable directory. Return `{"summary": "...", "outputs": [str(path)]}` for new files saved under it. No global `result` variable is provided.

The packaged runtime includes python-docx, docxcompose, openpyxl, pypdf, pdfplumber, reportlab and lxml. For DOCX concatenation, prefer `docxcompose.composer.Composer` to copying body XML alone, which loses relationships and styles. Composer uses the first document's headers and footers: if that conflicts with the requested preservation, reject or clearly scope the operation. Never silently discard unsupported DOC files or complex content.

Do not use module-level `return`, shell interpolation, network calls for offline skills, or writes outside `context.output_dir`.

Returning a path from `context.inputs` or a previous stage is not an output. A Python stage must save a new file below `context.output_dir` and return that new path.

`tests/cases.json` is a JSON array. Each case may declare `name`, `inputs`, `parameters`, `expectedOutputs`, and `acceptance`. Fixture paths are relative to `tests/fixtures/`.
