import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { getWebSelectionFiles, openDialog as open, randomId, releaseWebSelection } from "./lib/tauriCompat";
import {
  ArrowCounterClockwise,
  ArrowLeft,
  Check,
  CheckCircle,
  ChatCircleDots,
  Cloud,
  Code,
  Copy,
  File,
  FolderOpen,
  FolderSimplePlus,
  HardDrive,
  Key,
  LockKey,
  Package,
  Paperclip,
  Play,
  Robot,
  ShieldCheck,
  Sparkle,
  SpinnerGap,
  TerminalWindow,
  Toolbox,
  Trash,
  UserCircle,
  WarningCircle,
  Wrench,
  X,
} from "@phosphor-icons/react";
import {
  designAgentTool,
  generateCitizenReply,
  getSkill,
  listAgentTools,
  listRecentSkills,
  listAiProfiles,
  disableSkill,
  deleteSkill,
  listDeletedSkills,
  permanentlyDeleteSkill,
  restoreSkill,
  publishSkill,
  runSkill,
  cancelSkillRun,
  deleteApiKey,
  revealInFinder,
  saveAgentTool,
  saveAiProfile,
  testAiConnection,
  testAndRepairSkill,
  cancelSkillDesign,
} from "./lib/backend";
import { isWebApiEnabled, webReleaseInfo } from "./lib/webApi";
import type {
  AgentTool,
  AiProfile,
  JobOutcome,
  ScanResult,
  TaskPlan,
  ToolParameter,
  CitizenReplyMode,
  CitizenReplyPlatform,
  CitizenReplyResult,
  DesignAttachment,
  SkillRunEvent,
  SkillRunResult,
  SkillTestResult,
} from "./types";
import "./App.css";
import AgentWorkspace from "./AgentWorkspace";
import { SkillParameterField } from "./SkillParameterField";
import { SkillTestPanel, missingSkillParameters, skillInputExtensions, skillInputProblem } from "./SkillTestPanel";
import zhaiAppIcon from "./assets/zhai-app-icon.png";

type View = "agent" | "skills" | "models";
type TaskMode = "agent" | "dispatch" | "offline";
type SourceMode = "file" | "folder";
type BusyState =
  | "idle"
  | "scanning"
  | "planning"
  | "running"
  | "designing"
  | "saving"
  | "testing";
type SkillKind = "workflow" | "python" | "adapter";
type ConversationTurn = { role: "user" | "assistant"; content: string };

type SkillLibraryInputs = {
  paths: string[];
  parameters: Record<string, unknown>;
  testResult?: SkillTestResult;
  needsRetest: boolean;
};

function defaultSkillLibraryInputs(skill: AgentTool): SkillLibraryInputs {
  return {
    paths: [],
    parameters: Object.fromEntries(skill.parameters.filter(parameter => parameter.defaultValue !== undefined).map(parameter => [parameter.key, parameter.defaultValue])),
    needsRetest: false,
  };
}

const formatChoices = [
  { id: "word", label: "Word/文稿", extensions: ["docx", "doc", "wps", "md", "txt"] },
  { id: "excel", label: "Excel", extensions: ["xlsx", "xls"] },
  { id: "pdf", label: "PDF", extensions: ["pdf"] },
] as const;

const modelPresets = {
  deepseek: {
    displayName: "DeepSeek",
    provider: "deepseek" as const,
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  },
  compatible: {
    displayName: "自定义兼容服务",
    provider: "openai_compatible" as const,
    baseUrl: "https://",
    model: "",
  },
};

function fileName(path: string) {
  if (path.startsWith("web-selection:")) {
    const files = getWebSelectionFiles(path);
    if (files.length) return files[0].webkitRelativePath?.split("/")[0] || files.map(file => file.name).join("、");
  }
  return path.split(/[\\/]/).pop() || path;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function getToolCategory(
  tool: AgentTool,
): "general" | "word" | "excel" | "pdf" {
  const extensions = new Set(skillInputExtensions(tool));
  const groups = [
    ["word", ["doc", "docx", "wps", "md", "txt"]],
    ["excel", ["xls", "xlsx", "xlsm"]],
    ["pdf", ["pdf"]],
  ] as const;
  const matched = groups.filter(([, values]) =>
    values.some((value) => extensions.has(value)),
  );
  return matched.length === 1 ? matched[0][0] : "general";
}

function App() {
  const webMode = isWebApiEnabled();
  const offlineOnly = import.meta.env.VITE_WINDOWS_OFFLINE === "1";
  const [webVersion, setWebVersion] = useState("");
  useEffect(() => {
    if (!webMode) return;
    let active = true;
    webReleaseInfo().then(({ version, revision }) => {
      if (active && version) setWebVersion([version, revision].filter(Boolean).join("-"));
    }).catch(() => {});
    return () => { active = false; };
  }, [webMode]);
  const [view, setView] = useState<View>(offlineOnly ? "skills" : "agent");
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<AiProfile>();
  const selectProfile = (next?: AiProfile) => {
    if (next?.id !== activeProfile?.id) setSessionApiKey("");
    setActiveProfile(next);
    if (!webMode && next) localStorage.setItem("zhai.desktop.activeProfile", next.id);
  };
  const [sessionApiKey, setSessionApiKey] = useState("");
  const [busy, setBusy] = useState<BusyState>("idle");
  const [error, setError] = useState<string>();
  const [designTarget, setDesignTarget] = useState<AgentTool>();
  const [skillLibraryInputs, setSkillLibraryInputs] = useState(() => new Map<string, SkillLibraryInputs>());
  const retainedSelections = useRef(new Set<string>());
  useEffect(() => {
    const next = new Set([...skillLibraryInputs.values()].flatMap(inputs => inputs.paths.filter(path => path.startsWith("web-selection:"))));
    for (const path of retainedSelections.current) if (!next.has(path)) releaseWebSelection(path);
    retainedSelections.current = next;
  }, [skillLibraryInputs]);
  useEffect(() => () => { retainedSelections.current.forEach(releaseWebSelection); }, []);

  const refreshTools = async () => {
    const items = await listAgentTools();
    setTools(offlineOnly ? items.filter(isRunnableOfflineTool) : items);
  };

  useEffect(() => {
    refreshTools().catch((reason) => setError(String(reason)));
    if (offlineOnly) return;
    listAiProfiles()
      .then((items) => {
        setProfiles(items);
        const lastId = webMode ? null : localStorage.getItem("zhai.desktop.activeProfile");
        setActiveProfile(current => current || items.find(item => item.id === lastId) || items[0]);
      })
      .catch((reason) => setError(String(reason)));
  }, []);

  return (
    <main className="app-shell">
      <aside className="side-rail">
        <div className="drag-strip" data-tauri-drag-region />
        <div className="brand">
          <div className="brand-mark">
            <img src={zhaiAppIcon} alt="" aria-hidden="true" />
          </div>
          <div>
            <strong>zhai</strong>
            <span>文件处理工作台</span>
          </div>
        </div>
        <nav aria-label="主导航">
          {!offlineOnly && <NavButton
            active={view === "agent"}
            icon={<Robot size={18} />}
            label="文件 Agent"
            onClick={() => setView("agent")}
          />}
          <NavButton
            active={view === "skills"}
            icon={<Package size={18} />}
            label={offlineOnly ? "离线工具" : "能力包"}
            onClick={() => setView("skills")}
          />
          {!offlineOnly && !activeProfile?.managed && <NavButton
            active={view === "models"}
            icon={<Cloud size={18} />}
            label="模型服务"
            onClick={() => setView("models")}
          />}
        </nav>
        <div className="rail-note">
          <Sparkle size={16} weight="fill" />
          <strong>{offlineOnly ? "Windows 离线工具版" : "定制你的办公AI"}</strong>
        </div>
      </aside>

      <section className="main-stage">
        <div className="titlebar" data-tauri-drag-region />
        {webMode && (
          <div className="web-mode-notice">
            <Cloud size={15} />
            <span>
              {[activeProfile?.managed ? "评委体验版" : "网页版", webVersion].filter(Boolean).join(" ")}
              {activeProfile?.managed
                ? " · 本浏览器单独保存会话和成果。材料在服务器处理，可上传 DOCX、XLSX 或带文字层的 PDF。"
                : " · 支持 DOCX 排版、文字修改、Excel 汇总和 PDF 文本提取。材料在服务器处理。"}
            </span>
          </div>
        )}
        {!offlineOnly && <div
          className={`persistent-agent-view ${view === "agent" ? "is-active" : ""}`}
          hidden={view !== "agent"}
        >
          <AgentWorkspace
            active={view === "agent"}
            profile={activeProfile}
            apiKey={webMode ? sessionApiKey : ""}
            openModels={() => setView("models")}
            designTarget={designTarget}
            onDesignTargetHandled={() => setDesignTarget(undefined)}
            startInDesignMode={Boolean(designTarget)}
            onSkillSaved={() => refreshTools().catch((reason) => setError(String(reason)))}
          />
        </div>}
        {view === "skills" && (
          <SkillsWorkspace
            tools={tools}
            offlineOnly={offlineOnly}
            profile={activeProfile}
            apiKey={webMode ? sessionApiKey : ""}
            busy={busy}
            error={error}
            openModels={() => setView("models")}
            setBusy={setBusy}
            setError={setError}
            refreshTools={refreshTools}
            skillLibraryInputs={skillLibraryInputs}
            setSkillLibraryInputs={setSkillLibraryInputs}
            onOpenAgent={(tool) => {
              setDesignTarget(tool);
              setView("agent");
            }}
          />
        )}
        {!offlineOnly && view === "models" && !activeProfile?.managed && (
          <ModelsWorkspace
            profiles={profiles}
            setProfiles={setProfiles}
            activeProfile={activeProfile}
            setActiveProfile={selectProfile}
            sessionApiKey={sessionApiKey}
            setSessionApiKey={setSessionApiKey}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            error={error}
          />
        )}
      </section>
    </main>
  );
}

function NavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`nav-button ${active ? "is-active" : ""}`}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

type TaskProps = {
  taskMode: TaskMode;
  setTaskMode: (mode: TaskMode) => void;
  sourceMode: SourceMode;
  setSourceMode: (mode: SourceMode) => void;
  filePath: string;
  folderPath: string;
  setFolderPath: (value: string) => void;
  folderFormats: string[];
  setFolderFormats: (value: string[]) => void;
  chooseFile: () => void;
  chooseFolder: () => void;
  instruction: string;
  setInstruction: (value: string) => void;
  taskName: string;
  setTaskName: (value: string) => void;
  conversation: ConversationTurn[];
  tools: AgentTool[];
  selectedToolId: string;
  setSelectedToolId: (value: string) => void;
  selectedTool?: AgentTool;
  parameters: Record<string, unknown>;
  setParameters: (value: Record<string, unknown>) => void;
  activeProfile?: AiProfile;
  openModels: () => void;
  scan?: ScanResult;
  plan?: TaskPlan;
  outcome?: JobOutcome;
  busy: BusyState;
  error?: string;
  buildPlan: () => void;
  executePlan: () => void;
  continueConversation: () => void;
};

function TaskWorkspace(props: TaskProps) {
  const isBusy = props.busy !== "idle";
  const [skillCategory, setSkillCategory] = useState<
    "all" | "general" | "word" | "excel" | "pdf"
  >("all");
  const runnableTools = props.tools.filter(
    (tool) =>
      tool.available &&
      (skillCategory === "all" || getToolCategory(tool) === skillCategory),
  );
  return (
    <div className="page task-page">
      <header className="page-header">
        <div>
          <p>新建任务</p>
          <h1>选择模型参与到哪一步</h1>
          <span>同一套能力包，按任务敏感度和复杂度选择不同协作边界。</span>
        </div>
      </header>

      <section className="mode-console" aria-label="处理模式">
        <div className="mode-switch mode-switch-wide">
          <button
            className={props.taskMode === "agent" ? "is-active" : ""}
            onClick={() => props.setTaskMode("agent")}
          >
            <Robot size={15} />
            联网 Agent
          </button>
          <button
            className={props.taskMode === "dispatch" ? "is-active" : ""}
            onClick={() => props.setTaskMode("dispatch")}
          >
            <Sparkle size={15} />
            智能调用
          </button>
          <button
            className={props.taskMode === "offline" ? "is-active" : ""}
            onClick={() => props.setTaskMode("offline")}
          >
            <HardDrive size={15} />
            直接运行
          </button>
        </div>
        {props.taskMode === "agent" && (
          <div className="mode-explainer">
            <span>
              <Cloud size={17} />
            </span>
            <div>
              <strong>模型参与分析、规划和多轮修改</strong>
              <small>
                适合错别字、语义审校和复杂新需求；生成计划时会发送你确认过的脱敏正文。
              </small>
            </div>
            <b>处理过程联网</b>
          </div>
        )}
        {props.taskMode === "dispatch" && (
          <div className="mode-explainer">
            <span>
              <LockKey size={17} />
            </span>
            <div>
              <strong>模型只理解命令并选择成熟能力包</strong>
              <small>
                只发送任务说明、文件名/格式和能力目录；计划锁定后，文件处理阶段不访问网络。
              </small>
            </div>
            <b>正文不上网</b>
          </div>
        )}
        {props.taskMode === "offline" && (
          <div className="mode-explainer">
            <span>
              <ShieldCheck size={17} />
            </span>
            <div>
              <strong>不使用模型，直接运行本机能力包</strong>
              <small>
                适合固定、重复、规则明确的工作；参数由你手动设置，全程不产生网络请求。
              </small>
            </div>
            <b>全程离线</b>
          </div>
        )}
      </section>

      {props.error && <InlineMessage tone="error">{props.error}</InlineMessage>}

      <section className="source-panel">
        <div className="section-kicker">
          <span>01</span>
          <strong>材料范围</strong>
          <small>只处理你明确选择的内容</small>
        </div>
        <div className="source-tabs">
          <button
            className={props.sourceMode === "file" ? "is-active" : ""}
            onClick={() => props.setSourceMode("file")}
          >
            <File size={16} />
            单个文件
          </button>
          <button
            className={props.sourceMode === "folder" ? "is-active" : ""}
            onClick={() => props.setSourceMode("folder")}
          >
            <FolderOpen size={16} />
            文件夹
          </button>
        </div>
        {props.sourceMode === "file" ? (
          <button className="source-picker" onClick={props.chooseFile}>
            <span className="source-icon">
              <File size={21} />
            </span>
            <span>
              <strong>
                {props.filePath ? fileName(props.filePath) : "选择一个文件"}
              </strong>
              <small>
                {props.filePath ||
                  "DOCX、XLSX、PDF、DOC、XLS、Markdown、TXT"}
              </small>
            </span>
            <b>{props.filePath ? "更换" : "选择"}</b>
          </button>
        ) : (
          <div className="folder-source">
            <div className="folder-input">
              <FolderOpen size={17} />
              <input
                value={props.folderPath}
                onChange={(event) => props.setFolderPath(event.target.value)}
                placeholder="填写文件夹路径，或使用右侧选择"
              />
              {props.folderPath && (
                <button
                  onClick={() => props.setFolderPath("")}
                  aria-label="清空路径"
                >
                  <X size={14} />
                </button>
              )}
              <button className="browse-button" onClick={props.chooseFolder}>
                选择
              </button>
            </div>
            <div className="format-row">
              <span>只纳入</span>
              {formatChoices.map((choice) => {
                const selected = props.folderFormats.includes(choice.id);
                return (
                  <button
                    key={choice.id}
                    className={selected ? "is-selected" : ""}
                    onClick={() =>
                      props.setFolderFormats(
                        selected
                          ? props.folderFormats.filter(
                              (item) => item !== choice.id,
                            )
                          : [...props.folderFormats, choice.id],
                      )
                    }
                  >
                    {selected && <Check size={11} weight="bold" />}
                    {choice.label}
                  </button>
                );
              })}
              <small>未选择的格式不会进入成果目录</small>
            </div>
          </div>
        )}
      </section>

      <section className="work-panel">
        <div className="section-kicker">
          <span>02</span>
          <strong>
            {props.taskMode === "agent"
              ? "和 Agent 说明"
              : props.taskMode === "dispatch"
                ? "说明要调用什么"
                : "选择能力包"}
          </strong>
          <small>
            {props.taskMode === "agent"
              ? "支持完成后继续追问修改"
              : props.taskMode === "dispatch"
                ? "模型不读取材料正文"
                : "无需联网，参数固定可复用"}
          </small>
        </div>
        {props.taskMode !== "offline" ? (
          <>
            <div
              className={`model-strip ${props.activeProfile ? "is-ready" : ""}`}
            >
              <span>
                {props.activeProfile ? (
                  <CheckCircle size={17} weight="fill" />
                ) : (
                  <Cloud size={17} />
                )}
              </span>
              <div>
                <strong>
                  {props.activeProfile
                    ? props.activeProfile.displayName
                    : "尚未连接模型"}
                </strong>
                <small>
                  {props.activeProfile
                    ? `${props.activeProfile.defaultModel} · API Key 由你提供`
                    : "DeepSeek 或兼容接口服务"}
                </small>
              </div>
              <button onClick={props.openModels}>
                {props.activeProfile ? "更换" : "配置"}
              </button>
            </div>
            {props.taskMode === "agent" && props.conversation.length > 0 && (
              <div className="conversation-list">
                {props.conversation.map((turn, index) => (
                  <div className={turn.role} key={`${turn.role}-${index}`}>
                    <span>
                      {turn.role === "user" ? (
                        <UserCircle size={15} />
                      ) : (
                        <Robot size={15} />
                      )}
                    </span>
                    <p>{turn.content}</p>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={props.instruction}
              onChange={(event) => props.setInstruction(event.target.value)}
              placeholder={
                props.taskMode === "agent"
                  ? props.conversation.length
                    ? "继续说明要修改的地方，例如：第二页标题不要改，只调整落款日期……"
                    : "例如：检查错别字和职务表述，保留原格式；完成后我还会继续提出修改……"
                  : "例如：把文件夹内所有 DOCX 的落款日期改为 2026 年 8 月 9 日；不要读取正文，只选择已有能力包……"
              }
            />
            {props.taskMode === "agent" ? (
              <div className="privacy-note privacy-note-strong">
                <ShieldCheck size={14} />
                <span>
                  点击“发送并处理”即表示同意本条任务发送脱敏正文；原路径和密钥不写入日志。
                </span>
              </div>
            ) : (
              <div className="privacy-note privacy-note-strong">
                <LockKey size={14} />
                <span>
                  规划时联网，但不会提取或发送文件正文；执行计划时不再联网。
                </span>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="skill-category-tabs">
              {(
                [
                  ["all", "全部"],
                  ["general", "综合"],
                  ["word", "Word"],
                  ["excel", "Excel"],
                  ["pdf", "PDF"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={skillCategory === id ? "is-active" : ""}
                  onClick={() => setSkillCategory(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="skill-select-grid">
              {runnableTools.map((tool) => (
                <button
                  key={tool.id}
                  className={
                    props.selectedToolId === tool.id ? "is-active" : ""
                  }
                  onClick={() => props.setSelectedToolId(tool.id)}
                >
                  <span className="skill-glyph">
                    {tool.source === "designed" ? (
                      <Wrench size={18} />
                    ) : (
                      <Toolbox size={18} />
                    )}
                  </span>
                  <span>
                    <strong>{tool.name}</strong>
                    <small>{tool.description}</small>
                  </span>
                  <b>{tool.source === "designed" ? "我的能力包" : "内置"}</b>
                </button>
              ))}
            </div>
            {props.selectedTool && (
              <ToolParameterFields
                parameters={props.selectedTool.parameters}
                values={props.parameters}
                setValues={props.setParameters}
              />
            )}
          </>
        )}
      </section>

      <div className="task-meta">
        <label>
          任务名称
          <input
            value={props.taskName}
            onChange={(event) => props.setTaskName(event.target.value)}
          />
        </label>
        <span>每次执行都生成独立版本，原件永不覆盖</span>
      </div>

      {props.scan && (
        <div className="scan-summary">
          <span>
            <strong>{props.scan.summary.totalFiles}</strong>纳入
          </span>
          <span>
            <strong>{formatBytes(props.scan.summary.totalSize)}</strong>总大小
          </span>
          <span>
            <strong>{props.scan.summary.excludedItems}</strong>排除
          </span>
          <small>
            {props.scan.summary.legacyFiles > 0
              ? `${props.scan.summary.legacyFiles} 个旧版文件需转换能力`
              : "范围已锁定"}
          </small>
        </div>
      )}

      {props.plan && props.taskMode !== "agent" && (
        <section className="plan-block">
          <div className="plan-heading">
            <div>
              <p>执行前确认</p>
              <h2>{props.plan.operations.length} 个步骤</h2>
            </div>
            <span>
              <ShieldCheck size={15} />
              只写入新版本
            </span>
          </div>
          <div className="plan-list">
            {props.plan.operations.map((operation, index) => (
              <div key={operation.id}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <span>
                  <strong>{operation.title}</strong>
                  <small>{operation.description}</small>
                </span>
                <em>{operation.fileCount} 个文件</em>
              </div>
            ))}
          </div>
          {props.plan.warnings.map((warning) => (
            <div className="plan-warning" key={warning}>
              <WarningCircle size={14} weight="fill" />
              {warning}
            </div>
          ))}
          <p className="output-path">{props.plan.outputDirectory}</p>
        </section>
      )}

      {props.outcome && (
        <section className="result-panel">
          <CheckCircle size={24} weight="fill" />
          <div>
            <strong>新版本已生成</strong>
            <small>
              完成 {props.outcome.completedFiles} 个，失败{" "}
              {props.outcome.failedFiles} 个
            </small>
          </div>
          <button
            onClick={() => revealInFinder(props.outcome!.outputDirectory)}
          >
            打开成果
          </button>
          {props.taskMode === "agent" && (
            <button
              className="text-button"
              onClick={props.continueConversation}
            >
              <ArrowCounterClockwise size={14} />
              继续修改
            </button>
          )}
        </section>
      )}

      <footer className="action-bar">
        <span>
          {props.taskMode === "offline"
            ? "全程离线，不使用模型，不发送材料。"
            : props.taskMode === "dispatch"
              ? "只在规划时联网；文件正文不上网，执行阶段断网。"
              : "每条消息都会让模型选择能力包，本地引擎直接生成新版本。"}
        </span>
        {props.taskMode === "agent" ? (
          <button
            className="primary-action"
            disabled={isBusy || !props.instruction.trim()}
            onClick={props.buildPlan}
          >
            {isBusy ? (
              <SpinnerGap className="spin" size={16} />
            ) : (
              <Robot size={16} />
            )}
            {props.busy === "scanning"
              ? "正在读取"
              : props.busy === "planning"
                ? "Agent 正在理解"
                : props.busy === "running"
                  ? "正在生成新版本"
                  : "发送并处理"}
          </button>
        ) : !props.plan ? (
          <button
            className="primary-action"
            disabled={isBusy}
            onClick={props.buildPlan}
          >
            {isBusy ? (
              <SpinnerGap className="spin" size={16} />
            ) : props.taskMode === "dispatch" ? (
              <Sparkle size={16} />
            ) : (
              <Play size={16} weight="fill" />
            )}
            {props.busy === "scanning"
              ? "正在扫描"
              : props.busy === "planning"
                ? "正在规划"
                : props.taskMode === "dispatch"
                  ? "生成离线计划"
                  : "检查并运行"}
          </button>
        ) : (
          <button
            className="primary-action"
            disabled={isBusy || Boolean(props.outcome)}
            onClick={props.executePlan}
          >
            {props.busy === "running" ? (
              <SpinnerGap className="spin" size={16} />
            ) : (
              <Play size={16} weight="fill" />
            )}
            {props.busy === "running"
              ? "正在生成新版本"
              : props.outcome
                ? "已完成"
                : props.taskMode === "dispatch"
                  ? "断网执行"
                  : "确认执行"}
          </button>
        )}
      </footer>
    </div>
  );
}

// Kept temporarily for opening historical 0.7 task records during migration.
void TaskWorkspace;

function isRunnableOfflineTool(tool: AgentTool) {
  return tool.source === "builtin" && tool.available && (tool.status ?? "published") === "published"
    && !tool.requiresNetwork && !tool.permissions?.includes("network");
}

function SkillsWorkspace({
  tools,
  offlineOnly,
  profile,
  apiKey,
  busy,
  error,
  openModels,
  setBusy,
  setError,
  refreshTools,
  skillLibraryInputs,
  setSkillLibraryInputs,
  onOpenAgent,
}: {
  tools: AgentTool[];
  offlineOnly: boolean;
  profile?: AiProfile;
  apiKey: string;
  busy: BusyState;
  error?: string;
  openModels: () => void;
  setBusy: (value: BusyState) => void;
  setError: (value?: string) => void;
  refreshTools: () => Promise<void>;
  skillLibraryInputs: Map<string, SkillLibraryInputs>;
  setSkillLibraryInputs: Dispatch<SetStateAction<Map<string, SkillLibraryInputs>>>;
  onOpenAgent: (tool?: AgentTool) => void;
}) {
  const [section] = useState<"library" | "builder">("library");
  const [libraryCategory, setLibraryCategory] = useState<
    "recent" | "custom" | "all" | "general" | "word" | "excel" | "pdf"
  >(offlineOnly ? "all" : "recent");
  const [kind, setKind] = useState<SkillKind>("workflow");
  const [prompt, setPrompt] = useState(
    "设计一个干部任免审批表助手：从 Excel 名册读取人员信息，批量填入 Word 审批表，检查缺失字段并保留指定字体名称。",
  );
  const [draft, setDraft] = useState<AgentTool>();
  const [notice, setNotice] = useState<string>();
  const [attachments, setAttachments] = useState<DesignAttachment[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<AgentTool>();
  const [deletedSkills, setDeletedSkills] = useState<AgentTool[]>([]);
  const [runEvent, setRunEvent] = useState<SkillRunEvent>();
  const [stoppingRun, setStoppingRun] = useState(false);
  const selectedInputs = selectedSkill ? skillLibraryInputs.get(selectedSkill.id) || defaultSkillLibraryInputs(selectedSkill) : undefined;
  const needsFiles = !!selectedSkill?.supportedExtensions.length;
  const runPaths = needsFiles ? selectedInputs?.paths || [] : [];
  const runParameters = selectedInputs?.parameters || {};
  const missingRunParameters = selectedSkill ? missingSkillParameters(selectedSkill, runParameters) : [];
  const [runResult, setRunResult] = useState<SkillRunResult>();
  const singleWebArtifact = isWebApiEnabled() && runResult?.artifacts.length === 1 ? runResult.artifacts[0] : undefined;
  const sampleResult = selectedInputs?.testResult;
  const testInputsChanged = selectedInputs?.needsRetest || false;
  const [testProgress, setTestProgress] = useState<string>();
  const selectionVersion = useRef(0);
  const testingId = useRef<string | undefined>(undefined);
  const [skillQuery, setSkillQuery] = useState("");
  const [recentSkillIds, setRecentSkillIds] = useState<string[]>([]);
  const designed = tools.filter((tool) => tool.source === "designed");
  const builtins = tools.filter((tool) => tool.source === "builtin");

  useEffect(() => {
    if (!offlineOnly) listDeletedSkills().then(setDeletedSkills).catch(() => setDeletedSkills([]));
    listRecentSkills().then(setRecentSkillIds).catch(() => setRecentSkillIds([]));
  }, [tools.length]);

  const closeSkill = () => {
    selectionVersion.current += 1;
    setSelectedSkill(undefined);
  };
  useEffect(() => () => { selectionVersion.current += 1; }, []);

  useEffect(() => {
    if (!selectedSkill || busy !== "idle") return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSkill();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedSkill, busy]);

  const createDraft = async () => {
    if (!profile) {
      setError("请先连接一个模型服务，再让 Agent 协助设计能力包");
      openModels();
      return;
    }
    setBusy("designing");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await designAgentTool({
        prompt,
        profileId: profile.id,
        model: profile.defaultModel,
        baseUrl: profile.baseUrl,
        apiKey: apiKey || undefined,
        kind,
        attachments,
      });
      setDraft(result);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("idle");
    }
  };

  const addDesignFiles = async () => {
    const selection = await open({
      directory: false,
      multiple: true,
      title: "选择样本、模板或预期成果",
    });
    const paths = Array.isArray(selection)
      ? selection
      : typeof selection === "string"
        ? [selection]
        : [];
    setAttachments((current) => [
      ...current,
      ...paths
        .filter((path) => !current.some((item) => item.path === path))
        .map((path) => ({ path, role: "sample_input" as const })),
    ]);
  };

  const addDesignFolder = async () => {
    const selection = await open({
      directory: true,
      multiple: false,
      title: "选择样本文件夹",
    });
    if (
      typeof selection === "string" &&
      !attachments.some((item) => item.path === selection)
    ) {
      setAttachments((current) => [
        ...current,
        { path: selection, role: "reference" },
      ]);
    }
  };

  const visibleTools = tools.filter(
    (tool) =>
      (libraryCategory === "all" ||
        (libraryCategory === "recent" && recentSkillIds.includes(tool.id)) ||
        (libraryCategory === "custom" && tool.source === "designed") ||
        getToolCategory(tool) === libraryCategory) &&
      `${tool.name} ${tool.description} ${tool.supportedExtensions.join(" ")}`
        .toLowerCase()
        .includes(skillQuery.trim().toLowerCase()),
  ).sort((a, b) => {
    if (libraryCategory !== "recent") return 0;
    return recentSkillIds.indexOf(a.id) - recentSkillIds.indexOf(b.id);
  });

  const createBlankExtension = () => {
    setKind("python");
    setDraft({
      id: `designed-${randomId()}`,
      name: "未命名扩展能力包",
      description: prompt || "用户创建的本地能力包",
      source: "designed",
      kind: "python",
      version: "0.1.0",
      author: "本机用户",
      permissions: ["read_selected_files", "write_task_output"],
      sourceCode:
        'def run(context):\n    # context[\'input_dir\'] 只包含用户明确选择的文件副本\n    # 结果只能写入 context[\'output_dir\']\n    return {"status": "draft", "outputs": []}\n',
      testStatus: "untested",
      status: "draft",
      supportedExtensions: ["docx"],
      available: false,
      availabilityDetail: "开发草稿；通过源码审阅和隔离样本测试后才能启用",
      parameters: [],
      steps: [],
    });
  };

  const saveDraft = async () => {
    if (!draft) return;
    setBusy("saving");
    setError(undefined);
    try {
      const saved = await saveAgentTool({
        ...draft,
        status: draft.status || "draft",
      });
      await refreshTools();
      setSelectedSkill(saved);
      setNotice(
        `“${saved.name}”已保存为草稿。请添加样本并测试，测试通过后再发布。`,
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("idle");
    }
  };

  const openSkill = async (tool: AgentTool) => {
    if (busy !== "idle") return;
    const version = ++selectionVersion.current;
    setError(undefined);
    setNotice(undefined);
    try {
      const skill = await getSkill(tool.id);
      if (version !== selectionVersion.current) return;
      if (offlineOnly && !isRunnableOfflineTool(skill)) {
        throw new Error("这项工具当前无法在本机离线运行。");
      }
      updateSkillInputs(skill, current => {
        const defaults = defaultSkillLibraryInputs(skill);
        if (skill.source === "builtin" || skill.status === "published") return defaults;
        const parameters = { ...defaults.parameters };
        for (const { key } of skill.parameters) {
          if (Object.prototype.hasOwnProperty.call(current.parameters, key)) parameters[key] = current.parameters[key];
        }
        const result = current.testResult?.status === "passed" && skill.testStatus !== "passed" ? undefined
          : current.testResult || (!current.needsRetest ? skill.testResult : undefined);
        return { ...current, parameters, testResult: result };
      });
      setSelectedSkill(skill);
      setRunEvent(undefined);
      setRunResult(undefined);
    } catch (reason) {
      if (version === selectionVersion.current) setError(String(reason));
    }
  };

  const updateSkillInputs = (skill: AgentTool, update: (value: SkillLibraryInputs) => SkillLibraryInputs) => {
    setSkillLibraryInputs(current => {
      const next = new Map(current);
      next.set(skill.id, update(current.get(skill.id) || defaultSkillLibraryInputs(skill)));
      return next;
    });
  };

  const changeSelectedInputs = (update: (value: SkillLibraryInputs) => SkillLibraryInputs) => {
    if (selectedSkill) updateSkillInputs(selectedSkill, current => ({
      ...update(current),
      testResult: undefined,
      needsRetest: true,
    }));
  };

  const addRunFiles = async () => {
    if (!selectedSkill || !needsFiles) return;
    const version = selectionVersion.current;
    try {
      const selection = await open({
        directory: false,
        multiple: true,
        title: `选择“${selectedSkill.name}”要处理的文件`,
        filters: [{ name: "支持的文件", extensions: skillInputExtensions(selectedSkill) }],
      });
      if (version !== selectionVersion.current || !selection) return;
      const paths = Array.isArray(selection) ? selection : [selection];
      updateSkillInputs(selectedSkill, current => {
        const combined = [...new Set([...current.paths, ...paths])];
        return combined.length === current.paths.length ? current : { ...current, paths: combined, testResult: undefined, needsRetest: true };
      });
      setError(undefined);
    } catch (reason) {
      if (version === selectionVersion.current) setError(`添加文件失败：${String(reason)}`);
    }
  };

  const addRedheadTemplate = async () => {
    const version = selectionVersion.current;
    const selection = await open({ directory: false, multiple: false, title: "选择 Word 红头模板", filters: [{name: "Word 模板", extensions: ["doc", "docx"]}] });
    if (version !== selectionVersion.current || typeof selection !== "string") return;
    changeSelectedInputs(current => ({ ...current, paths: [...new Set([...current.paths, selection])], parameters: { ...current.parameters, templateName: fileName(selection) } }));
  };

  const addRunFolder = async () => {
    const version = selectionVersion.current;
    const selection = await open({
      directory: true,
      multiple: false,
      title: "选择要处理的文件夹",
    });
    if (version === selectionVersion.current && typeof selection === "string") {
      changeSelectedInputs(current => ({ ...current, paths: [...new Set([...current.paths, selection])] }));
    }
  };

  const runSkillTest = async (repair = false) => {
    if (!selectedSkill || busy !== "idle") return;
    const problem = skillInputProblem(selectedSkill, runPaths, runParameters);
    if (problem) { setError(problem); return; }
    if (repair && !profile) { openModels(); return; }
    const runId = randomId();
    testingId.current = runId;
    changeSelectedInputs(current => current);
    setBusy("testing"); setError(undefined); setTestProgress("正在运行样本测试");
    try {
      const result = await testAndRepairSkill({ runId, skillId: selectedSkill.id, samplePaths: runPaths, parameters: runParameters,
        repair: repair && profile ? { designId: `repair-${selectedSkill.id}`, currentSkillId: selectedSkill.id, prompt: "根据真实测试错误修复当前能力包并重测，保留原有规则。", profileId: profile.id, model: profile.defaultModel, baseUrl: profile.baseUrl, apiKey: apiKey || undefined, kind: selectedSkill.kind === "python" ? "python" : "workflow", attachments: runPaths.map(path => ({ path, role: "sample_input" })) } : undefined,
      }, event => { if (event.type === "phase" || event.type === "test_progress") setTestProgress(event.message); });
      setSelectedSkill(result.skill);
      updateSkillInputs(result.skill, current => ({ ...current, paths: runPaths, testResult: result.testResult,
        needsRetest: result.testResult?.status !== "passed", parameters: result.testResult?.parameters || runParameters }));
      await refreshTools();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy("idle"); testingId.current = undefined; setTestProgress(undefined); }
  };

  const publishSelectedSkill = async () => {
    if (!selectedSkill || testInputsChanged) return;
    setBusy("saving");
    setError(undefined);
    try {
      const published = await publishSkill(selectedSkill.id);
      setSelectedSkill(published);
      await refreshTools();
      setNotice(`“${published.name}”已发布，文件 Agent 现在可以调用。`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("idle");
    }
  };

  const disableSelectedSkill = async () => {
    if (!selectedSkill) return;
    setBusy("saving");
    setError(undefined);
    try {
      const disabled = await disableSkill(selectedSkill.id);
      setSelectedSkill(disabled);
      await refreshTools();
      setNotice(`“${disabled.name}”已停用。`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("idle");
    }
  };

  const runSelectedSkill = async () => {
    if (!selectedSkill) return;
    if (runPaths.length === 0 && selectedSkill.supportedExtensions.length > 0) {
      setError("请先添加要处理的文件或文件夹");
      return;
    }
    const missing = missingSkillParameters(selectedSkill, runParameters);
    if (missing.length > 0) {
      setError(`请填写${missing.map(parameter => `“${parameter.label}”`).join("、")}。`);
      return;
    }
    setBusy("running"); setError(undefined); setNotice(undefined); setRunEvent(undefined); setRunResult(undefined); setStoppingRun(false);
    try {
      const result = await runSkill(selectedSkill.id, runPaths, runParameters, setRunEvent);
      setRunResult(result);
      setNotice(result.summary);
    } catch (reason) {
      setRunEvent(undefined);
      if (isWebApiEnabled() && /已停止|已取消/.test(String(reason))) setNotice("运行已停止。");
      else setError(String(reason));
    } finally { setBusy("idle"); setStoppingRun(false); }
  };

  const stopRun = async (runId: string) => {
    setStoppingRun(true);
    try { await cancelSkillRun(runId); }
    catch (reason) { setStoppingRun(false); setError(String(reason)); }
  };

  const removeSkill = async (tool: AgentTool) => {
    if (tool.source !== "designed") return;
    if (!window.confirm(`将“${tool.name}”移入回收站？`)) return;
    setBusy("saving");
    try {
      await deleteSkill(tool.id);
      if (selectedSkill?.id === tool.id) closeSkill();
      setSkillLibraryInputs(current => {
        const next = new Map(current);
        next.delete(tool.id);
        return next;
      });
      await refreshTools();
      setDeletedSkills(await listDeletedSkills());
      setNotice("能力包已移入回收站，可随时恢复。");
    } catch (reason) { setError(String(reason)); } finally { setBusy("idle"); }
  };

  const restoreDeletedSkill = async (tool: AgentTool) => {
    await restoreSkill(tool.id);
    await refreshTools();
    setDeletedSkills(await listDeletedSkills());
    setNotice(`已恢复“${tool.name}”。`);
  };

  const purgeDeletedSkill = async (tool: AgentTool) => {
    if (!window.confirm(`永久删除“${tool.name}”？删除后无法恢复。`)) return;
    setBusy("saving");
    try {
      await permanentlyDeleteSkill(tool.id);
      setDeletedSkills(await listDeletedSkills());
      setNotice(`已永久删除“${tool.name}”。`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("idle");
    }
  };

  return (
    <div className="page skills-page">
      <header className="page-header">
        <div>
          <p>{offlineOnly ? "离线工具" : "能力包"}</p>
          <h1>{offlineOnly ? "选择工具，处理本机文件" : "选择能力包，直接处理材料"}</h1>
          <span>{offlineOnly ? "选择工具后添加文件或文件夹。成果会另存，原件保留。" : "这里用于查看、管理和运行能力包；新的能力包统一在文件 Agent 的“设计能力包”中创建。"}</span>
        </div>
      </header>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
      {section === "library" ? (
        <>
          {!offlineOnly && <div className="library-intro">
            <div>
              <strong>{builtins.length}</strong>
              <span>基础工具</span>
            </div>
            <div>
              <strong>{designed.filter((item) => item.status === "published").length}</strong>
              <span>成熟能力包</span>
            </div>
            <div>
              <strong>{designed.filter((item) => item.status !== "published").length}</strong>
              <span>草稿能力包</span>
            </div>
            <div>
              <strong>会话内</strong>
              <span>临时脚本</span>
            </div>
            <p>
              临时脚本只保留在文件 Agent 会话中；保存、测试并发布后成为成熟能力包。普通能力包由本机执行，只有明确标注“需联网”的能力才访问网络。
            </p>
          </div>}
          {deletedSkills.length > 0 && (
            <details className="skill-trash">
              <summary>回收站 <span>{deletedSkills.length}</span></summary>
              {deletedSkills.map((tool) => (
                <div key={tool.id}>
                  <span><strong>{tool.name}</strong><small>{tool.description}</small></span>
                  <menu>
                    <button onClick={() => restoreDeletedSkill(tool)}><ArrowCounterClockwise size={14} />恢复</button>
                    <button className="purge" onClick={() => purgeDeletedSkill(tool)}><Trash size={14} />永久删除</button>
                  </menu>
                </div>
              ))}
            </details>
          )}
          <div className="library-heading">
            <strong>{offlineOnly ? "可用工具" : "能力包库"}</strong>
            {!offlineOnly && <span>常用显示最近成功运行的 3 个能力包；自建能力包可继续优化或删除。</span>}
          </div>
          <label className="skill-search">
            <Wrench size={14} />
            <input
              value={skillQuery}
              onChange={(event) => setSkillQuery(event.target.value)}
              placeholder="搜索能力包名称、用途或文件格式"
              aria-label="搜索能力包"
            />
            {skillQuery && (
              <button aria-label="清空能力包搜索" onClick={() => setSkillQuery("")}>
                <X size={13} />
              </button>
            )}
          </label>
          <div className="skill-category-tabs">
            {(
              [
                ["recent", "常用"],
                ["custom", "自建"],
                ["all", "全部"],
                ["general", "综合"],
                ["word", "Word"],
                ["excel", "Excel"],
                ["pdf", "PDF"],
              ] as const
            ).filter(([id]) => !offlineOnly || id !== "custom").map(([id, label]) => (
              <button
                key={id}
                className={libraryCategory === id ? "is-active" : ""}
                onClick={() => setLibraryCategory(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="skill-library compact">
            {visibleTools.length ? (
              visibleTools.map((tool) => (
                <SkillRow
                  key={tool.id}
                  tool={tool}
                  onClick={() => openSkill(tool)}
                  onDelete={tool.source === "designed" ? () => removeSkill(tool) : undefined}
                />
              ))
            ) : (
              <div className="skill-list-empty">
                {libraryCategory === "recent" ? "运行能力包后，最近使用的 3 个会显示在这里" : "没有找到符合条件的能力包"}
              </div>
            )}
          </div>
          {selectedSkill && (
            <section className="skill-detail is-content-screen">
              <header>
                <div>
                  <span>
                    {selectedSkill.source === "designed"
                      ? "我的能力包"
                      : "内置能力"}{" "}
                    · {selectedSkill.version || "1.0.0"}
                  </span>
                  <h2>{selectedSkill.name}</h2>
                  <p>{selectedSkill.description}</p>
                  {selectedSkill.requiresNetwork && selectedSkill.source === "designed" && (
                    <p>当前版本尚不支持执行需联网的自建能力包，切换到文件 Agent 也不能执行。可继续保存和编辑草稿。</p>
                  )}
                  <div className="skill-capability-tags">
                    {selectedSkill.requiresNetwork || selectedSkill.permissions?.includes("network") ? (
                      <b className="network"><Cloud size={12} />需联网</b>
                    ) : null}
                    {selectedSkill.supportedExtensions.map((item) => <b key={item}>{item.toUpperCase()}</b>)}
                  </div>
                </div>
                <button
                  aria-label="关闭能力包详情"
                  onClick={closeSkill}
                  disabled={busy !== "idle"}
                >
                  <ArrowLeft size={15} />
                  返回能力包库
                </button>
              </header>
              <div className="skill-detail-feedback" aria-live="polite">
                {error && <InlineMessage tone="error">{error}</InlineMessage>}
                {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
                {testProgress && <p>{testProgress} <button onClick={() => testingId.current && cancelSkillDesign(testingId.current).catch(reason => setError(String(reason)))}>停止测试</button></p>}
              </div>
              <div className="skill-detail-grid">
                <div>
                  <small>状态</small>
                  <strong>{skillStatusLabel(selectedSkill)}</strong>
                </div>
                <div>
                  <small>样本测试</small>
                  <strong>
                    {selectedSkill.testStatus === "passed"
                      ? "已通过"
                      : selectedSkill.testStatus === "failed"
                        ? "未通过"
                        : "尚未测试"}
                  </strong>
                </div>
                <div>
                  <small>实现方式</small>
                  <strong>{selectedSkill.kind === "derived" ? "派生流水线" : selectedSkill.kind === "python" ? "脚本能力" : selectedSkill.kind === "workflow" ? "组合流程" : selectedSkill.kind === "adapter" ? "软件适配器" : "基础工具"}</strong>
                </div>
                <div>
                  <small>接受材料</small>
                  <strong>
                    {selectedSkill.supportedExtensions.join("、") || "无需原始材料"}
                  </strong>
                </div>
              </div>
              {selectedSkill.sourceCode && (
                <pre>{selectedSkill.sourceCode}</pre>
              )}
              {selectedSkill.composition && (
                <div className="skill-composition">
                  <strong>执行流水线</strong>
                  {selectedSkill.composition.stages.map((stage, index) => (
                    <span key={`${stage.kind}-${index}`}>
                      <i>{index + 1}</i>
                      {stage.kind === "skill" ? stage.skillId : "新增 Python 处理"}
                      <small>{index === selectedSkill.composition!.stages.length - 1 ? "最终成果" : "中间结果不展示"}</small>
                    </span>
                  ))}
                </div>
              )}
              <p className="skill-detail-note">
                {selectedSkill.availabilityDetail}
              </p>
              {selectedSkill.source === "designed" && selectedSkill.status !== "published" && (
                <SkillTestPanel skill={selectedSkill} paths={runPaths} parameters={runParameters} result={sampleResult} busy={busy !== "idle"}
                  onParameter={(key, value) => changeSelectedInputs(current => ({ ...current, parameters: { ...current.parameters, [key]: value } }))}
                  onAdd={() => void addRunFiles()} onTest={() => void runSkillTest()}
                  onRemove={path => changeSelectedInputs(current => ({ ...current, paths: current.paths.filter(item => item !== path) }))}
                  onRepair={() => void runSkillTest(true)} onOpen={path => void revealInFinder(path).catch(reason => setError(String(reason)))} />
              )}
              {selectedSkill.available &&
                (selectedSkill.status ?? "published") === "published" && (
                selectedSkill.id === "citizen_reply" ? (
                  <CitizenReplyWorkspace
                    profile={profile}
                    apiKey={apiKey}
                    openModels={openModels}
                    embedded
                  />
                ) : (selectedSkill.requiresNetwork || selectedSkill.permissions?.includes("network")) ? (
                  <section className="skill-online-guide">
                    <Cloud size={19} />
                    <div>
                      <strong>这个能力包需要联网</strong>
                      <span>请在文件 Agent 中添加材料并调用。发送前请确认当前模型服务可用。</span>
                    </div>
                    <button className="primary-action" onClick={() => onOpenAgent()}>去文件 Agent 使用</button>
                  </section>
                ) : (
                  <section className="skill-runner">
                    {needsFiles && <>
                    <header>
                      <div><span>01</span><strong>添加材料</strong></div>
                      <small>只会纳入 {selectedSkill.supportedExtensions.map((item) => item.toUpperCase()).join("、") || "该能力包支持的"} 文件</small>
                    </header>
                    <div className="skill-run-source-actions">
                      {selectedSkill.id === "apply_redhead" && <button onClick={addRedheadTemplate}><Paperclip size={15} />选择红头模板</button>}
                      <button onClick={addRunFiles}><File size={15} />添加文件</button>
                      <button onClick={addRunFolder}><FolderOpen size={15} />添加文件夹</button>
                      {runPaths.length > 0 && <span>已添加 {runPaths.length} 个来源</span>}
                    </div>
                    {runPaths.length > 0 ? (
                      <div className="skill-run-paths">
                        {runPaths.map((path) => (
                          <div key={path}>
                            <File size={14} />
                            <span title={fileName(path)}>{fileName(path)}{!isWebApiEnabled() && <small>{path}</small>}</span>
                            <button disabled={busy !== "idle"} aria-label={`移除 ${fileName(path)}`} onClick={() => changeSelectedInputs(current => ({ ...current, paths: current.paths.filter(item => item !== path) }))}><X size={13} /></button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="skill-run-empty">尚未添加材料，原件不会被覆盖</div>
                    )}
                    </>}
                    {selectedSkill.parameters.length > 0 && (
                      <div className="skill-parameters">
                        <header>
                          <span>{needsFiles ? "02" : "01"}</span>
                          <strong>{selectedSkill.parameters.some(parameter => parameter.required) ? "运行参数" : "可选设置"}</strong>
                          <small>不修改的项目自动采用能力包默认值</small>
                        </header>
                        <div className="skill-parameter-grid">
                          {selectedSkill.parameters.map((parameter) => (
                            <SkillParameterField
                              key={parameter.key}
                              parameter={parameter}
                              value={runParameters[parameter.key]}
                              invalid={missingRunParameters.includes(parameter)}
                              onChange={(value) => changeSelectedInputs(current => ({ ...current, parameters: { ...current.parameters, [parameter.key]: value } }))}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    <footer>
                      <span>成果将生成新版本，并集中放入本次能力包运行目录。</span>
                      <button className="primary-action" onClick={runSelectedSkill} disabled={busy !== "idle" || (runPaths.length === 0 && needsFiles)}>
                        {busy === "running" ? <SpinnerGap className="spin" size={15} /> : <Play size={15} />}
                        {busy === "running" ? "正在处理" : "开始运行"}
                      </button>
                    </footer>
                  </section>
                )
              )}
              {runEvent && (
                <div className={`skill-run-progress ${runEvent.type}`}>
                  {runEvent.type === "progress" && <progress max={Math.max(runEvent.total, 1)} value={runEvent.current} />}
                  <span>{runEvent.type === "progress" ? runEvent.message : runEvent.type === "started" ? "已开始处理" : runEvent.type === "completed" ? "处理完成" : runEvent.type === "cancelled" ? "已取消" : runEvent.type === "failed" ? runEvent.message : ""}</span>
                  {busy === "running" && "runId" in runEvent && <button disabled={stoppingRun} onClick={() => void stopRun(runEvent.runId)}><X size={13} />{stoppingRun ? "正在停止" : "停止"}</button>}
                </div>
              )}
              {runResult && (
                <section className="skill-run-result">
                  <CheckCircle size={18} weight="fill" />
                  <div><strong>处理完成</strong><span>{runResult.summary}</span>
                    {singleWebArtifact ? <small>{singleWebArtifact.name}</small> : !isWebApiEnabled() && <small>{runResult.outputDirectory}</small>}
                  </div>
                  <button onClick={() => revealInFinder(singleWebArtifact?.localSnapshotPath || runResult.outputDirectory)}>
                    {isWebApiEnabled() ? singleWebArtifact ? "下载成果" : "下载全部成果" : "打开成果文件夹"}
                  </button>
                </section>
              )}
              {!offlineOnly && <footer>
                {selectedSkill.source === "designed" ? (
                  <>
                    {selectedSkill.status === "published" ? (
                      <button
                        className="secondary-action"
                        onClick={disableSelectedSkill}
                        disabled={busy !== "idle"}
                      >
                        停用
                      </button>
                    ) : null}
                    <button
                      className="primary-action"
                      onClick={publishSelectedSkill}
                      disabled={
                        busy !== "idle" ||
                        selectedSkill.testStatus !== "passed" ||
                        testInputsChanged ||
                        selectedSkill.status === "published"
                      }
                    >
                      <Package size={15} />
                      发布给 Agent
                    </button>
                    <button className="danger-action" onClick={() => removeSkill(selectedSkill)} disabled={busy !== "idle"}>
                      删除
                    </button>
                    <button className="secondary-action" onClick={() => onOpenAgent(selectedSkill)} disabled={busy !== "idle"}>
                      继续优化
                    </button>
                  </>
                ) : (
                  <>
                    <span>内置能力只读；微调会创建一个独立的派生能力包，不改变原能力。</span>
                    <button className="secondary-action" onClick={() => onOpenAgent(selectedSkill)}>
                      基于此能力调整
                    </button>
                  </>
                )}
              </footer>}
            </section>
          )}
        </>
      ) : (
        <>
          <div className="skill-kind-grid">
            <button
              className={kind === "workflow" ? "is-active" : ""}
              onClick={() => {
                setKind("workflow");
                setDraft(undefined);
              }}
            >
              <Toolbox size={21} />
              <strong>流程能力包</strong>
              <span>组合已验证能力；普通能力包可直接在本机运行</span>
            </button>
            <button
              className={kind === "python" ? "is-active" : ""}
              onClick={() => {
                setKind("python");
                setDraft(undefined);
              }}
            >
              <Code size={21} />
              <strong>Python 扩展</strong>
              <span>开发新处理逻辑，先审阅和样本测试</span>
            </button>
            <button
              className={kind === "adapter" ? "is-active" : ""}
              onClick={() => {
                setKind("adapter");
                setDraft(undefined);
              }}
            >
              <TerminalWindow size={21} />
              <strong>软件适配器</strong>
              <span>接入 WPS、Office 或单位内部系统</span>
            </button>
          </div>
          <section className="builder-panel">
            <label>描述你的工作做法</label>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="写清输入材料、处理规则、输出结果和不能改变的内容。"
            />
            <div className="attachment-actions">
              <span>设计参考</span>
              <button onClick={addDesignFiles}>
                <Paperclip size={14} />
                添加文件
              </button>
              <button onClick={addDesignFolder}>
                <FolderSimplePlus size={14} />
                添加文件夹
              </button>
            </div>
            {attachments.length > 0 && (
              <div className="design-attachments">
                {attachments.map((item) => (
                  <div key={item.path}>
                    <span>
                      <File size={14} />
                      <b>{fileName(item.path)}</b>
                      <small>{item.path}</small>
                    </span>
                    <select
                      value={item.role}
                      onChange={(event) =>
                        setAttachments((current) =>
                          current.map((entry) =>
                            entry.path === item.path
                              ? {
                                  ...entry,
                                  role: event.target
                                    .value as DesignAttachment["role"],
                                }
                              : entry,
                          ),
                        )
                      }
                    >
                      <option value="sample_input">样本输入</option>
                      <option value="template">模板</option>
                      <option value="expected_output">预期成果</option>
                      <option value="reference">参考材料</option>
                    </select>
                    <button
                      aria-label="移除附件"
                      onClick={() =>
                        setAttachments((current) =>
                          current.filter((entry) => entry.path !== item.path),
                        )
                      }
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="builder-actions">
              <span>
                <ShieldCheck size={14} />
                模型只生成设计草稿，不会直接运行代码
              </span>
              <button
                className="secondary-action"
                onClick={createBlankExtension}
              >
                从空白代码开始
              </button>
              <button
                className="primary-action"
                disabled={busy !== "idle" || !prompt.trim()}
                onClick={createDraft}
              >
                {busy === "designing" ? (
                  <SpinnerGap className="spin" size={16} />
                ) : (
                  <Sparkle size={16} />
                )}
                让模型协助设计
              </button>
            </div>
          </section>
          <div className="permission-model">
            <strong>每个能力包单独声明权限</strong>
            <div>
              <span>
                <CheckCircle size={15} />
                读取用户本次选择的文件副本
              </span>
              <span>
                <CheckCircle size={15} />
                写入独立任务成果目录
              </span>
              <span className="blocked">
                <X size={15} />
                默认禁止网络、Shell 和任意路径访问
              </span>
            </div>
          </div>
          {draft ? (
            <section className="draft-skill">
              <header>
                <div>
                  <span>
                    能力包草稿 ·{" "}
                    {draft.kind === "workflow"
                      ? "流程"
                      : draft.kind === "adapter"
                        ? "适配器"
                        : "Python"}
                  </span>
                  <h2>{draft.name}</h2>
                  <p>{draft.description}</p>
                </div>
                <b className={draft.available ? "ready" : "draft"}>
                  {draft.available ? "可运行" : "待测试"}
                </b>
              </header>
              {draft.steps.length > 0 && (
                <div className="draft-steps">
                  {draft.steps.map((step, index) => (
                    <div key={`${step.toolId}-${index}`}>
                      <span>{index + 1}</span>
                      <strong>{step.toolId}</strong>
                      <code>{JSON.stringify(step.parameters)}</code>
                    </div>
                  ))}
                </div>
              )}
              {draft.sourceCode && (
                <div className="code-review">
                  <div>
                    <strong>源码 / 清单审阅</strong>
                    <span>保存不会自动启用</span>
                  </div>
                  <textarea
                    value={draft.sourceCode}
                    onChange={(event) =>
                      setDraft({ ...draft, sourceCode: event.target.value })
                    }
                    spellCheck={false}
                  />
                </div>
              )}
              <footer>
                <span>{draft.availabilityDetail}</span>
                <button
                  className="primary-action"
                  onClick={saveDraft}
                  disabled={busy !== "idle"}
                >
                  {busy === "saving" ? (
                    <SpinnerGap className="spin" size={16} />
                  ) : (
                    <Package size={16} />
                  )}
                  保存能力包
                </button>
              </footer>
            </section>
          ) : (
            <div className="builder-empty">
              <Wrench size={27} />
              <strong>能力包草稿会在这里展开</strong>
              <span>你能看到步骤、权限、源码和测试状态。</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}


function skillStatusLabel(tool: AgentTool) {
  const status = tool.status || (tool.available ? "published" : "unavailable");
  return (
    {
      draft: "草稿",
      testing: "测试中",
      published: "已发布",
      test_failed: "测试失败",
      unavailable: "能力不可用",
      disabled: "已停用",
    } as const
  )[status];
}

function SkillRow({
  tool,
  onClick,
  onDelete,
}: {
  tool: AgentTool;
  onClick?: () => void;
  onDelete?: () => void;
}) {
  const content = (
    <>
      <span className="skill-glyph">
        {tool.kind === "python" ? (
          <Code size={17} />
        ) : tool.kind === "adapter" ? (
          <TerminalWindow size={17} />
        ) : (
          <Wrench size={17} />
        )}
      </span>
      <div>
        <strong>{tool.name}</strong>
        <small>{tool.description}</small>
      </div>
      <span className="format-tags">
        {tool.supportedExtensions.slice(0, 4).map((item) => (
          <b key={item}>{item.toUpperCase()}</b>
        ))}
      </span>
      {!(tool.requiresNetwork || tool.permissions?.includes("network")) && <span className="skill-network-tag">可离线</span>}
      {(tool.requiresNetwork || tool.permissions?.includes("network")) && (
        <span className="skill-network-tag network">
          <Cloud size={12} />
          需联网
        </span>
      )}
      <em
        className={
          tool.status === "published" || tool.available ? "ready" : "draft"
        }
      >
        {skillStatusLabel(tool)}
      </em>
    </>
  );
  return onDelete ? (
    <div className="skill-row-wrap">
      <button className="skill-row" onClick={onClick}>
        {content}
      </button>
      <button
        className="skill-row-delete"
        aria-label={`删除能力包 ${tool.name}`}
        title="移入回收站"
        onClick={onDelete}
      >
        <Trash size={15} />
      </button>
    </div>
  ) : onClick ? (
    <button className="skill-row" onClick={onClick}>{content}</button>
  ) : (
    <div className="skill-row">{content}</div>
  );
}

function CitizenReplyWorkspace({
  profile,
  apiKey,
  openModels,
  embedded = false,
}: {
  profile?: AiProfile;
  apiKey: string;
  openModels: () => void;
  embedded?: boolean;
}) {
  const [mode, setMode] = useState<CitizenReplyMode>("reply");
  const [platform, setPlatform] = useState<CitizenReplyPlatform>("general");
  const [form, setForm] = useState({
    department: "",
    citizenRequest: "",
    caseLocation: "",
    verification: "",
    handling: "",
    caseResult: "",
    nextStep: "",
    instructions: "",
  });
  const [result, setResult] = useState<CitizenReplyResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const setField = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const generate = async () => {
    if (!profile) {
      setError("请先配置并选择一个模型服务");
      return;
    }
    if (!form.citizenRequest.trim()) {
      setError("请至少填写市民诉求");
      return;
    }
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(
        await generateCitizenReply({
          profileId: profile.id,
          model: profile.defaultModel,
          apiKey: apiKey || undefined,
          mode,
          platform,
          ...form,
        }),
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const copyAnswer = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.answer);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className={`${embedded ? "citizen-embedded" : "page"} citizen-page`}>
      {!embedded && <header className="page-header">
        <div>
          <p>市民回复助手</p>
          <h1>先核实事实，再起草回复</h1>
          <span>支持起草 12345、人民网、粤省心答复及满意度复核材料。</span>
        </div>
        <button
          className={`model-pill ${profile ? "is-ready" : ""}`}
          onClick={openModels}
        >
          <Cloud size={15} />
          <span>
            {profile
              ? `${profile.displayName} · ${profile.defaultModel}`
              : "配置模型"}
          </span>
        </button>
      </header>}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      <div className="citizen-layout">
        <section className="citizen-form">
          <div className="citizen-switches">
            <div>
              <span>任务类型</span>
              {(
                [
                  ["reply", "普通答复"],
                  ["special", "特殊平台"],
                  ["appeal", "满意度申诉"],
                  ["review", "审核改写"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={mode === id ? "is-active" : ""}
                  onClick={() => setMode(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div>
              <span>发布平台</span>
              {(
                [
                  ["general", "12345"],
                  ["people", "人民网"],
                  ["provincial", "粤省心/省热线"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={platform === id ? "is-active" : ""}
                  onClick={() => setPlatform(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="citizen-fields">
            <label>
              <span>承办单位</span>
              <input
                value={form.department}
                onChange={(event) => setField("department", event.target.value)}
                placeholder="例如：香洲区某单位"
              />
            </label>
            <label>
              <span>事发地点</span>
              <input
                value={form.caseLocation}
                onChange={(event) =>
                  setField("caseLocation", event.target.value)
                }
                placeholder="只填工作所需范围，避免详细住址"
              />
            </label>
            <label className="wide required">
              <span>市民诉求</span>
              <textarea
                value={form.citizenRequest}
                onChange={(event) =>
                  setField("citizenRequest", event.target.value)
                }
                placeholder="原样粘贴诉求；发送前会在本机脱敏手机号、身份证号和邮箱。"
              />
            </label>
            <label className="wide">
              <span>核查情况</span>
              <textarea
                value={form.verification}
                onChange={(event) =>
                  setField("verification", event.target.value)
                }
                placeholder="填写已核实的时间、方式和所见事实；不确定的留空。"
              />
            </label>
            <label className="wide">
              <span>处理情况</span>
              <textarea
                value={form.handling}
                onChange={(event) => setField("handling", event.target.value)}
                placeholder="已采取的具体措施、沟通和整改情况。"
              />
            </label>
            <label>
              <span>办理结果</span>
              <textarea
                value={form.caseResult}
                onChange={(event) => setField("caseResult", event.target.value)}
                placeholder="已完成、阶段性结果或暂无法解决的原因。"
              />
            </label>
            <label>
              <span>后续安排</span>
              <textarea
                value={form.nextStep}
                onChange={(event) => setField("nextStep", event.target.value)}
                placeholder="复查、联系路径、时间节点或可行的下一步。"
              />
            </label>
            <label className="wide">
              <span>额外要求</span>
              <input
                value={form.instructions}
                onChange={(event) =>
                  setField("instructions", event.target.value)
                }
                placeholder="例如：语气更简洁；重点说明复查安排"
              />
            </label>
          </div>
          <div className="citizen-submit">
            <span>
              <ShieldCheck size={14} />
              工单不写入任务历史；结果必须人工审核后发布。
            </span>
            <button
              className="primary-action"
              disabled={busy}
              onClick={generate}
            >
              {busy ? (
                <SpinnerGap className="spin" size={16} />
              ) : (
                <ChatCircleDots size={16} />
              )}
              {busy ? "正在匹配规则并起草" : "生成答复草稿"}
            </button>
          </div>
        </section>
        <section className={`citizen-result ${result ? "has-result" : ""}`}>
          {!result ? (
            <div className="citizen-empty">
              <ChatCircleDots size={30} />
              <strong>草稿会在这里生成</strong>
              <span>信息不全时会保留“待补充”，不把推测写成事实。</span>
            </div>
          ) : (
            <>
              <header>
                <div>
                  <span>答复草稿</span>
                  <small>{result.returnedModel || profile?.defaultModel}</small>
                </div>
                <button onClick={copyAnswer}>
                  <Copy size={14} />
                  {copied ? "已复制" : "复制"}
                </button>
              </header>
              <article>{result.answer}</article>
              {result.findings.length > 0 && (
                <div className="citizen-findings">
                  <strong>发布前检查</strong>
                  {result.findings.map((item) => (
                    <div
                      className={item.level}
                      key={`${item.code}-${item.message}`}
                    >
                      <WarningCircle size={14} weight="fill" />
                      <span>{item.message}</span>
                    </div>
                  ))}
                </div>
              )}
              {result.references.length > 0 && (
                <div className="citizen-references">
                  <strong>匹配的本地参考</strong>
                  {result.references.map((item) => (
                    <span key={`${item.source}-${item.title}`}>
                      {item.title}
                      <small>{item.source}</small>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function ModelsWorkspace({
  profiles,
  setProfiles,
  activeProfile,
  setActiveProfile,
  sessionApiKey,
  setSessionApiKey,
  busy,
  setBusy,
  setError,
  error,
}: {
  profiles: AiProfile[];
  setProfiles: (value: AiProfile[]) => void;
  activeProfile?: AiProfile;
  setActiveProfile: (value?: AiProfile) => void;
  sessionApiKey: string;
  setSessionApiKey: (value: string) => void;
  busy: BusyState;
  setBusy: (value: BusyState) => void;
  setError: (value?: string) => void;
  error?: string;
}) {
  const webMode = isWebApiEnabled();
  const [loaded, setLoaded] = useState(false);
  const [preset, setPreset] = useState<keyof typeof modelPresets>("deepseek");
  const [displayName, setDisplayName] = useState(
    modelPresets.deepseek.displayName,
  );
  const [baseUrl, setBaseUrl] = useState(modelPresets.deepseek.baseUrl);
  const [model, setModel] = useState(modelPresets.deepseek.model);
  const [testResult, setTestResult] = useState<string>();
  const [addingProfile, setAddingProfile] = useState(false);
  const editingProfile = addingProfile ? undefined : activeProfile;

  useEffect(() => {
    if (loaded) return;
    setLoaded(true);
    listAiProfiles()
      .then(setProfiles)
      .catch((reason) => setError(String(reason)));
  }, [loaded]);

  const choosePreset = (value: keyof typeof modelPresets) => {
    const next = modelPresets[value];
    setPreset(value);
    setDisplayName(next.displayName);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setTestResult(undefined);
  };

  const presetForProvider = (provider: AiProfile["provider"]): keyof typeof modelPresets =>
    provider === "deepseek" ? "deepseek" : "compatible";
  const legacyProfile = activeProfile && activeProfile.provider !== "deepseek"
    && activeProfile.provider !== "openai_compatible";

  useEffect(() => {
    if (!activeProfile) return;
    setPreset(presetForProvider(activeProfile.provider));
    setDisplayName(activeProfile.displayName);
    setBaseUrl(activeProfile.baseUrl);
    setModel(activeProfile.defaultModel);
  }, [activeProfile?.id]);

  const saveProfile = async (shouldTest: boolean) => {
    if (!displayName.trim() || !baseUrl.trim() || !model.trim()) {
      setError("请填写服务名称、HTTPS 地址和模型名");
      return;
    }
    const hasNewEndpoint = !webMode && !!editingProfile && baseUrl.trim().replace(/\/+$/, "") !== editingProfile.baseUrl;
    if (!sessionApiKey.trim() && (!editingProfile?.keyStored || hasNewEndpoint)) {
      setError(
        webMode
          ? "请粘贴本次使用的 API Key"
          : "请粘贴 API Key；保存一次后会长期保存在本机系统凭据库",
      );
      return;
    }
    setBusy(shouldTest ? "testing" : "saving");
    setError(undefined);
    setTestResult(undefined);
    try {
      const id = (!hasNewEndpoint && editingProfile?.id) || `model-${randomId()}`;
      const providedKey = sessionApiKey.trim();
      const saved = await saveAiProfile({
        id,
        provider: modelPresets[preset].provider,
        displayName,
        baseUrl,
        defaultModel: model,
        apiKey: providedKey || undefined,
      });
      const hydrated = saved;
      setProfiles([
        ...profiles.filter((item) => item.id !== hydrated.id),
        hydrated,
      ]);
      setActiveProfile(hydrated);
      setAddingProfile(false);
      if (shouldTest) {
        const result = await testAiConnection(
          hydrated.id,
          model,
          webMode ? providedKey || undefined : undefined,
          baseUrl,
        );
        if (!result.success) throw new Error(result.message);
        setTestResult(
          `连接成功 · ${result.returnedModel || model} · ${result.latencyMs ?? 0} ms`,
        );
      } else {
        setTestResult(
          webMode ? "配置已用于当前网页会话" : "配置与 API Key 已保存，可在重启后继续使用",
        );
      }
      if (providedKey && !webMode) setSessionApiKey("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("idle");
    }
  };

  const removeStoredKey = async () => {
    if (!activeProfile) return;
    setBusy("saving");
    setError(undefined);
    setTestResult(undefined);
    try {
      await deleteApiKey(activeProfile.id);
      const next = { ...activeProfile, keyStored: false };
      setProfiles(
        profiles.map((item) => (item.id === next.id ? next : item)),
      );
      setActiveProfile(next);
      setSessionApiKey("");
      setTestResult("已删除本机系统凭据库中保存的 API Key");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("idle");
    }
  };

  return (
    <div className="page models-page">
      <header className="page-header">
        <div>
          <p>模型服务</p>
          <h1>{webMode ? "单位算力已配置，打开即可使用" : "模型由你选择，也由你提供密钥"}</h1>
          <span>
            {webMode
              ? "默认使用单位提供的 DeepSeek。无需填写密钥；需要其他服务时，可在下方填写自己的接口和密钥。"
              : "API Key 由本机系统凭据库加密保存；授权一次，重启后仍可继续使用。"}
          </span>
        </div>
        {activeProfile && (
          <div className="active-model">
            <span />
            <div>
              <strong>{activeProfile.displayName}</strong>
              <small>{activeProfile.defaultModel}</small>
            </div>
          </div>
        )}
      </header>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {testResult && <InlineMessage tone="success">{testResult}</InlineMessage>}
      {legacyProfile && (
        <InlineMessage tone="error">
          此配置使用已移除的专用接口，暂不能运行。原参数和密钥仍保留；请核对兼容接口地址和模型名，点击保存后才会切换为兼容接口。
        </InlineMessage>
      )}
      <section className="model-form">
        <div className="preset-row">
          {!webMode && activeProfile && !addingProfile && <button onClick={() => {
            setAddingProfile(true);
            setSessionApiKey("");
            setError(undefined);
            choosePreset("compatible");
          }}>新增模型配置</button>}
          <button
            className={preset === "deepseek" ? "is-active" : ""}
            onClick={() => choosePreset("deepseek")}
          >
            DeepSeek
          </button>
          <button
            className={preset === "compatible" ? "is-active" : ""}
            onClick={() => choosePreset("compatible")}
          >
            其他兼容服务
          </button>
        </div>
        <div className="form-grid">
          <label>
            <span>显示名称</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label>
            <span>模型名称</span>
            {preset === "deepseek" ? (
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                {model && !["deepseek-v4-flash", "deepseek-v4-pro"].includes(model) && (
                  <option value={model}>{model} · 已保存模型</option>
                )}
                <option value="deepseek-v4-flash">DeepSeek V4 Flash · 更快更省</option>
                <option value="deepseek-v4-pro">DeepSeek V4 Pro · 复杂任务</option>
              </select>
            ) : (
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="服务商提供的 model ID"
              />
            )}
            {preset === "deepseek" && <small className="field-help">处理大批量固定任务选 Flash；复杂脚本、自修复和能力包设计选 Pro。</small>}
          </label>
          <label className="wide">
            <span>API Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://.../v1"
            />
          </label>
          <label className="wide">
            <span>API Key</span>
            <div className="secret-input">
              <Key size={16} />
              <input
                type="password"
                autoComplete="off"
                value={sessionApiKey}
                onChange={(event) => setSessionApiKey(event.target.value)}
                placeholder={
                  webMode
                    ? "默认算力无需填写；切换接口时填写自己的密钥"
                    : editingProfile?.keyStored
                      ? "已安全保存；如需更换，请粘贴新 Key"
                      : "粘贴后将保存到本机系统凭据库"
                }
              />
              {sessionApiKey && (
                <button
                  onClick={() => setSessionApiKey("")}
                  aria-label="清除密钥"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </label>
        </div>
        <div className="persist-option">
          <ShieldCheck size={18} />
          <span>
            <strong>{webMode ? "默认算力长期生效" : "授权一次，长期使用"}</strong>
            <small>
              {webMode
                ? "单位密钥保存在服务器，刷新后仍可使用。你另行填写的密钥仅用于当前页面，刷新后恢复单位默认算力。"
                : "API Key 保存在本机系统凭据库，重启后继续使用；只有你主动删除时才清除。"}
            </small>
          </span>
          {!webMode && editingProfile?.keyStored && (
            <button
              className="credential-delete"
              disabled={busy !== "idle"}
              onClick={removeStoredKey}
            >
              <Trash size={14} />
              删除已保存的 API Key
            </button>
          )}
        </div>
        <footer>
          <span>
            <LockKey size={14} />
            API Key 不写入数据库、任务报告或日志
          </span>
          <button
            className="secondary-action"
            disabled={busy !== "idle"}
            onClick={() => saveProfile(false)}
          >
            {webMode ? "用于当前会话" : "保存配置"}
          </button>
          <button
            className="primary-action"
            disabled={busy !== "idle"}
            onClick={() => saveProfile(true)}
          >
            {busy === "testing" ? (
              <SpinnerGap className="spin" size={16} />
            ) : (
              <Cloud size={16} />
            )}
            保存并测试
          </button>
        </footer>
      </section>
      {profiles.length > 0 && (
        <section className="saved-profiles">
          <div className="library-heading">
            <strong>已保存的服务参数</strong>
            <span>{webMode ? "这里只保存地址和模型名。" : "密钥保存在系统凭据库，列表仅显示授权状态。"}</span>
          </div>
          {profiles.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setAddingProfile(false);
                setSessionApiKey("");
                setTestResult(undefined);
                setPreset(presetForProvider(item.provider));
                setActiveProfile(item);
                setDisplayName(item.displayName);
                setBaseUrl(item.baseUrl);
                setModel(item.defaultModel);
              }}
            >
              <span
                className={activeProfile?.id === item.id ? "selected" : ""}
              />
              <div>
                <strong>{item.displayName}</strong>
                <small>{item.baseUrl}</small>
              </div>
              <b>
                {item.defaultModel}
                {!webMode && <em>{item.keyStored ? "API 已授权" : "需要 API Key"}</em>}
              </b>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function ToolParameterFields({
  parameters,
  values,
  setValues,
}: {
  parameters: ToolParameter[];
  values: Record<string, unknown>;
  setValues: (value: Record<string, unknown>) => void;
}) {
  if (parameters.length === 0) return null;
  return (
    <div className="parameter-grid">
      {parameters.map((parameter) => (
        <label key={parameter.key}>
          <span>{parameter.label}</span>
          {parameter.type === "boolean" ? (
            <input
              type="checkbox"
              checked={Boolean(values[parameter.key])}
              onChange={(event) =>
                setValues({ ...values, [parameter.key]: event.target.checked })
              }
            />
          ) : parameter.type === "choice" ? (
            <select
              value={String(
                values[parameter.key] ?? parameter.defaultValue ?? "",
              )}
              onChange={(event) =>
                setValues({ ...values, [parameter.key]: event.target.value })
              }
            >
              {(parameter.choices ?? []).map((choice) => (
                <option value={choice} key={choice}>
                  {choice}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={String(values[parameter.key] ?? "")}
              placeholder={parameter.placeholder}
              onChange={(event) =>
                setValues({ ...values, [parameter.key]: event.target.value })
              }
            />
          )}
        </label>
      ))}
    </div>
  );
}

function InlineMessage({
  tone,
  children,
}: {
  tone: "error" | "success";
  children: ReactNode;
}) {
  return (
    <div className={`inline-message ${tone}`}>
      {tone === "error" ? (
        <WarningCircle size={17} weight="fill" />
      ) : (
        <CheckCircle size={17} weight="fill" />
      )}
      <span>{children}</span>
    </div>
  );
}

export default App;
