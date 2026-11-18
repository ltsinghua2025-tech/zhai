import type { ToolParameter } from "./types";

export function SkillParameterField({
  parameter,
  value,
  invalid,
  onChange,
}: {
  parameter: ToolParameter;
  value: unknown;
  invalid?: boolean;
  onChange: (value: unknown) => void;
}) {
  const choiceLabel = (choice: string) =>
    ({
      general: "12345热线",
      people: "人民网留言",
      provincial: "粤省心/省热线",
      reply: "起草回复",
      special: "专项答复",
      appeal: "满意度申诉",
      review: "审核改写",
      auto: parameter.key === "recipientMode" ? "自动（保守识别）" : "自动",
      none: "无主送（不添加）",
      preserve: "保留原落款布局",
      unsigned: "无章单一机关（补足间隔）",
      "utf-8-sig": "UTF-8（兼容 Excel）",
      "utf-8": "UTF-8",
      gb18030: "GB18030",
    } as Record<string, string>)[choice] || choice;

  if (parameter.type === "boolean" && !parameter.required) {
    return (
      <label className="skill-boolean-field">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span><strong>{parameter.label}</strong><small>可选</small></span>
      </label>
    );
  }
  return (
    <label className="skill-parameter-field">
      <span>{parameter.label}{parameter.required && <b>必填</b>}</span>
      {parameter.type === "boolean" ? (
        <select required aria-invalid={invalid} value={String(value ?? "")} onChange={event => onChange(event.target.value === "" ? null : event.target.value === "true")}>
          <option value="">请选择</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      ) : parameter.type === "choice" ? (
        <select required={parameter.required} aria-invalid={invalid} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择</option>
          {(parameter.choices || []).map((choice) => <option key={choice} value={choice}>{choiceLabel(choice)}</option>)}
        </select>
      ) : (
        <input
          type={parameter.type === "number" ? "number" : "text"}
          required={parameter.required}
          aria-invalid={invalid}
          value={String(value ?? "")}
          placeholder={parameter.placeholder}
          onChange={(event) => onChange(parameter.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)}
        />
      )}
    </label>
  );
}
