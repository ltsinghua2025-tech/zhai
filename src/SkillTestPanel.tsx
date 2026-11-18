import { File, FolderOpen, Play, Wrench, X } from "@phosphor-icons/react";
import { SkillParameterField } from "./SkillParameterField";
import type { AgentTool, SkillTestResult } from "./types";
import { getWebSelectionFiles } from "./lib/tauriCompat";

export function skillInputExtensions(skill: AgentTool): string[] {
  return skill.supportedExtensions.map(extension => extension.replace(/^\.+/, "").toLowerCase());
}

function sampleNames(path: string, labels?: Record<string, string>): string[] {
  if (labels?.[path]) return [labels[path]];
  const webFiles = getWebSelectionFiles(path);
  return webFiles.length ? webFiles.map(file => file.name) : [path.split(/[\\/]/).pop() || path];
}

export function missingSkillParameters(skill: AgentTool, values: Record<string, unknown>) {
  return skill.parameters.filter(parameter => {
    const value = Object.prototype.hasOwnProperty.call(values, parameter.key) ? values[parameter.key] : parameter.defaultValue;
    return parameter.required && (value == null || (typeof value === "string" && value.trim() === ""));
  });
}

export function skillInputProblem(skill: AgentTool, paths: string[], values: Record<string, unknown>, sampleLabels?: Record<string, string>): string | undefined {
  const extensions = skillInputExtensions(skill);
  const names = paths.flatMap(path => sampleNames(path, sampleLabels));
  const problems: string[] = [];
  if (extensions.length && !names.length) problems.push("请添加至少一份原始样本，再开始测试。");
  if (!extensions.length && names.length) problems.push("这份能力包无需原始样本，请移除样本后重新测试。");
  if (names.length > 100) problems.push("一次最多测试 100 份样本，请移除多余样本。");
  const invalid = extensions.length ? names.filter(name => {
    const dot = name.lastIndexOf(".");
    return dot < 1 || !extensions.includes(name.slice(dot + 1).toLowerCase());
  }) : [];
  if (invalid.length) problems.push(`这些样本格式不匹配：${invalid.join("、")}。当前能力支持 ${extensions.join("、")}，请更换样本。`);
  const missing = missingSkillParameters(skill, values);
  if (missing.length) problems.push(`请填写${missing.map(parameter => `“${parameter.label}”`).join("、")}。`);
  return problems.length ? problems.join(" ") : undefined;
}

export function SkillTestPanel({ skill, paths, sampleLabels, parameters, result, busy, onParameter, onAdd, onRemove, onTest, onRepair, onOpen, onPublish }: {
  skill: AgentTool; paths: string[]; parameters: Record<string, unknown>; result?: SkillTestResult; busy: boolean;
  sampleLabels?: Record<string, string>;
  onParameter: (key: string, value: unknown) => void; onAdd: () => void; onTest: () => void;
  onRemove?: (path: string) => void;
  onRepair?: () => void; onOpen: (path: string) => void; onPublish?: () => void;
}) {
  const problem = skillInputProblem(skill, paths, parameters, sampleLabels);
  const missing = missingSkillParameters(skill, parameters);
  const requiresFiles = skill.supportedExtensions.length > 0;
  const count = paths.flatMap(path => sampleNames(path, sampleLabels)).length;
  const network = skill.requiresNetwork || skill.permissions?.includes("network");
  return <section className="design-test-panel" aria-label="能力包样本测试">
    <header><strong>样本测试</strong><span>{network ? "需联网" : "可离线运行"} · {requiresFiles ? `${count} 份原始样本` : "无需原始样本"}</span></header>
    <p>{network ? "运行依赖模型或外部服务；仅在相应联网执行环境可用时测试。" : "本地执行，原件保持不变。设计和自动修复需要调用模型。"}</p>
    {requiresFiles && <button type="button" disabled={busy} onClick={onAdd}><File size={15} />添加测试样本</button>}
    {!!paths.length && <ul className="test-samples">{paths.map(path => {
      const name = sampleNames(path, sampleLabels).join("、");
      return <li key={path}><span>{name}</span>{onRemove && <button disabled={busy} aria-label={`移除样本 ${name}`} onClick={() => onRemove(path)}><X size={13} /></button>}</li>;
    })}</ul>}
    {skill.parameters.length > 0 && <details className="test-parameters" open={skill.parameters.some(parameter => parameter.required) || undefined}>
      <summary>测试参数 · {skill.parameters.length} 项</summary>
      <fieldset disabled={busy} className="skill-parameter-grid">{skill.parameters.map(parameter => <SkillParameterField key={parameter.key} parameter={parameter} value={Object.prototype.hasOwnProperty.call(parameters, parameter.key) ? parameters[parameter.key] : parameter.defaultValue} invalid={missing.includes(parameter)} onChange={value => onParameter(parameter.key, value)} />)}</fieldset>
    </details>}
    {problem && <p className="test-input-problem" role="status">{problem}</p>}
    {result && <div className={`test-result ${result.status}`} role="status">
      <strong>{({ passed: "样本执行通过", failed: "测试未通过", needs_input: "需要补充信息", cancelled: "测试已停止" })[result.status]}</strong>
      <p>{result.summary}</p>
      {result.status === "passed" && result.outputDirectory && <button onClick={() => onOpen(result.outputDirectory!)}><FolderOpen size={15} />打开测试成果</button>}
      {result.status === "passed" && requiresFiles && <small>当前样本通过不代表所有材料都适用，建议换一份样本验证后发布。</small>}
    </div>}
    <div className="design-test-actions">
      <button className="primary-action" disabled={busy || !!problem} onClick={onTest}><Play size={15} />{result ? "重新测试" : requiresFiles ? "用当前样本测试" : "开始测试"}</button>
      {result?.repairable && onRepair && <button disabled={busy || !!problem} onClick={onRepair}><Wrench size={15} />自动修复并重测</button>}
      {onPublish && <button disabled={busy || !!problem || result?.status !== "passed" || skill.testStatus !== "passed" || skill.status === "published"} onClick={onPublish}>{skill.status === "published" ? "已发布" : "发布能力包"}</button>}
    </div>
  </section>;
}
