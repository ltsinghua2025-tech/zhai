---
name: zhai-capability-designer
description: "Design, update, test, repair, and migrate zhai capability packages for government document processing. Use when creating a reusable capability package, deriving one from a built-in Word/Excel/PDF capability, changing an existing package, or diagnosing a package test failure."
---

# zhai Capability Package Designer

Work inside the writable capability package supplied by zhai. Treat built-in capabilities and user originals as read-only.

## Workflow

1. Inspect `skill.json`, `SKILL.md`, `scripts/`, `references/`, `assets/`, and `tests/` when present.
2. Read [skill-package-schema.md](references/skill-package-schema.md) before changing the execution contract.
3. Read [office-capabilities.md](references/office-capabilities.md) when choosing a parent skill, input format, or pipeline stage.
   For 公文排版、套红 or 版记, also read [official-document-format.md](references/official-document-format.md). Prefer the published `apply_redhead` capability for letterhead composition.
4. Preserve the existing package ID and parent relationship unless the user explicitly asks for a new package.
5. Prefer a derived composition when the request modifies an existing mature capability. Keep built-in parent capabilities unchanged. First inspect the parent's declared parameters: when the requested change is already supported, create a one-stage derived package that only configures the parent. Do not add a placeholder or pass-through Python stage.
6. Add `scripts/main.py` only when the requested transformation cannot be expressed by mature capability parameters. Use `python3`; expose `run(context, params)`, open the previous-stage files from `context.inputs`, write new files under `context.output_dir`, and return those new paths in `outputs`.
7. Add or update `tests/cases.json`. Copy only the fixtures zhai placed in `tests/fixtures/`; never read other paths.
8. Declare `requiresNetwork` truthfully: deterministic local transformations are offline; workflows that need a model or external service on every reuse are online. Include `network` in permissions and explain the service dependency in the description. The model used to design a package does not itself make that package online. The current custom-script executor denies network access: an online declaration is a preserved draft, not permission to bypass the sandbox or a claim it can run.
9. Run `python3 "$ZHAI_DESIGNER_SKILL/scripts/validate_package.py" .`. This is structural validation only. zhai saves the draft, then runs selected sample inputs with the packaged production sidecar. A shell Python interpreter may not have the sidecar's dependencies. Do not invent a test command or claim sample execution passed without the executor's result.
10. When zhai supplies a real sample failure, repair the existing package once using the error and the exact parameters; do not change its ID, discard features, weaken acceptance, or return fabricated artifacts. The application reruns the same sample and parameters. If business input is missing, report that explicitly rather than guessing or editing the implementation to accept invalid input.

## Sample and parameter contract

- Inspect the supplied `tests/fixtures` roles before implementing. `sample_input` files are the actual test inputs; templates, references and expected outputs are resources, not additional data rows. Confirm file formats and headers from the samples; never infer CSV support merely because a filename was attached to an Excel task.
- Keep the default parameter set executable where a safe default exists. User choices that cannot be inferred must remain required. A zero placeholder is not a valid substitute for a required matrix dimension.
- Declare cross-field positive-number requirements in `references/parameter-rules.json`, e.g. `{"atLeastOnePositive":[["rows","cols"]]}`. The application checks these before execution and asks for input without spending a model repair attempt. Only reference existing numeric parameter keys.
- For other business validation use `ValueError("需要补充参数：<specific missing choice>")`. Do not use this prefix for programming defects. Preserve the supplied parameters in repairs.
- Describe test assertions for content and order, not just file existence. Include a second example with different data when possible. A generated test description is not evidence the test ran.
- When continuing from a successful task, generalize paths, sample-specific values and runtime settings into `context.inputs` and parameters. Preserve the original task's output contract and distinguish reusable rules from facts only true of the original sample.

## Design Rules

- A reusable capability package must have a machine contract, instructions, implementation or composition, tests, and a version.
- Do not emit a one-off JSON plan in place of editing the package.
- Establish a working contract and minimal implementation first, then refine it against the supplied samples. On continuation, inspect and repair the existing implementation rather than rebuilding the package.
- Do not overwrite user originals. Every write must target the designated output directory.
- Do not install dependencies, open external applications, access the network, or access paths outside the design workspace.
- A derived capability may have at most three inheritance levels and must not form a cycle.
- Version 1 derived stages consume original or previous outputs. For more flexible workflows use composition schemaVersion 2: stages can consume original, previous or stage:N outputs, use independent scripts and bind workflow parameters. Only the final stage is a user-visible artifact.
- A Python stage must create a new artifact in its own `context.output_dir`. Returning an input or previous-stage path without writing a new file is invalid.
- Keep `SKILL.md` operational and concise. Put detailed rules and field dictionaries in `references/`.
- Keep the final response short: summarize changed files, validation result, and any remaining limitation.

## Package Outcomes

- `draft`: valid package not yet accepted by samples.
- `testing`: tests are currently running.
- `test_failed`: validation or sample acceptance failed.
- `published`: all required validations passed and the user published it.
- `unavailable`: declared runtime dependency is absent.
- `disabled`: intentionally disabled by the user.
