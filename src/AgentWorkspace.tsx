import { useEffect, useMemo, useRef, useState } from "react";
import { onFileDrop, openDialog as open, randomId, releaseWebSelection } from "./lib/tauriCompat";
import {
  ArrowLeft,
  ArrowUp,
  CheckCircle,
  Cloud,
  Code,
  File,
  FloppyDisk,
  FolderOpen,
  Globe,
  Link,
  Paperclip,
  Plus,
  Robot,
  ShieldCheck,
  SidebarSimple,
  SpinnerGap,
  Stop,
  Trash,
  Wrench,
  X,
} from "@phosphor-icons/react";
import {
  addAgentAttachments,
  cancelAgentTurn,
  cancelSkillDesign,
  createAgentSession,
  designAndTestSkill,
  testAndRepairSkill,
  getSkillDesignState,
  getTaskSkillSeed,
  saveSkillDesignState,
  getSkill,
  publishSkill,
  deleteAgentSession,
  getAgentSession,
  getPythonExecutionStatus,
  isTauri,
  listAgentSessions,
  openAgentArtifact,
  removeAgentAttachment,
  removeAgentAttachments,
  renameAgentSession,
  promoteAgentRunToSkill,
  revealInFinder,
  sendAgentMessage,
} from "./lib/backend";
import type {
  AgentAttachment,
  AgentEvent,
  AgentSession,
  AgentSessionDetail,
  AgentToolRun,
  AiProfile,
  AgentTool,
  DesignAttachment,
  SkillDesignEvent,
  PythonExecutionStatus,
  SkillDesignState,
  SkillTestResult,
  DesignToolRequest,
} from "./types";
import MarkdownMessage from "./MarkdownMessage";
import { SkillTestPanel, skillInputExtensions, skillInputProblem } from "./SkillTestPanel";
import { artifactsForMessage } from "./lib/messageArtifacts";
import { webTurnMaterials } from "./lib/turnMaterials";
import shellAvatar from "./assets/zhai-shell-avatar.png";
import { isWebApiEnabled, webDesignFromTurn } from "./lib/webApi";

const supportedExtensions = [
  "docx",
  "xlsx",
  "xlsm",
  "pptx",
  "pdf",
  "csv",
  "doc",
  "wps",
  "xls",
  "md",
  "txt",
  "png",
  "jpg",
  "jpeg",
];

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function iconForAttachment(item: AgentAttachment) {
  if (item.kind === "url") return <Globe size={16} />;
  if (item.kind === "folder") return <FolderOpen size={16} />;
  return <File size={16} />;
}

function toolLabel(toolId: string) {
  const labels: Record<string, string> = {
    inspect_document: "文件检查",
    officecli_inspect: "OfficeCLI 检查",
    read_attachment: "内容读取",
    read_word_structure: "Word 结构读取",
    edit_word: "Word 内容填写",
    profile_attachments: "材料画像",
    run_python: "临时工具",
    docx_to_gongwen: "公文排版",
    normalize_docx_styles: "Word 样式规范化",
    redact_content: "敏感信息脱敏",
    normalize_whitespace: "文字清理",
    remove_line_breaks: "清除手动换行",
    replace_text: "批量文字替换",
    delete_blank_rows: "清理 Excel 空行",
    set_xlsx_cell: "填写 Excel 单元格",
    merge_xlsx: "合并 Excel 数据",
    extract_docx_text: "读取 Word 正文",
    merge_docx: "批量合并 Word",
    split_docx: "按一级标题拆分 Word",
    center_docx_page_numbers: "Word 页脚居中页码",
    split_xlsx: "按工作表拆分 Excel",
    extract_xlsx_text: "读取 Excel 工作表",
    extract_pdf_text: "提取 PDF 文本",
    list_skills: "查找已发布技能",
    run_skill: "运行已发布技能",
    generate_gongwen: "生成公文",
    citizen_reply: "市民回复",
    web_fetch: "网页读取",
    web_search: "网页搜索",
    word_to_pdf: "Word 转 PDF",
    excel_to_pdf: "Excel 转 PDF",
  };
  return labels[toolId] || "专业能力";
}

function compactToolDetail(run: AgentToolRun) {
  const detail = run.detail?.trim();
  if (!detail) return "";
  if (detail.includes("诊断输出：") || detail.startsWith("diag 诊断输出"))
    return "样本结构已交给模型继续分析。";
  if (detail.toLowerCase().includes("return' outside function"))
    return "脚本格式有误，Agent 正在自动修复。";
  if (detail.includes("没有生成可验收的成果文件"))
    return "本次未生成可交付文件，Agent 将继续处理。";
  const firstLine = detail.split("\n")[0].replace(/\s+/g, " ");
  return firstLine.length > 150 ? `${firstLine.slice(0, 150)}…` : firstLine;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function isDiagnosticArtifact(item: AgentAttachment) {
  const name = item.name.toLowerCase();
  return (
    name.endsWith(".inspection.json") ||
    name.endsWith(".log") ||
    name === ".ds_store" ||
    name.includes("日志") ||
    name.includes("检查报告") ||
    name.includes("诊断报告") ||
    /^extracted(?:_v\d+)*\.(?:csv|json|txt)$/.test(name)
  );
}

type MaterialGroup = {
  key: string;
  kind: AgentAttachment["kind"];
  name: string;
  items: AgentAttachment[];
  summary: string;
};

type Props = {
  active?: boolean;
  profile?: AiProfile;
  apiKey: string;
  openModels: () => void;
  designTarget?: AgentTool;
  startInDesignMode?: boolean;
  onSkillSaved?: (skill: AgentTool) => void;
  onDesignTargetHandled?: () => void;
};

export default function AgentWorkspace({ active = true, profile, apiKey, openModels, designTarget, startInDesignMode, onSkillSaved, onDesignTargetHandled }: Props) {
  const webMode = isWebApiEnabled();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [detail, setDetail] = useState<AgentSessionDetail>();
  const [fileSelection, setFileSelection] = useState<{sessionId: string; ids: string[]}>();
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [liveRuns, setLiveRuns] = useState<AgentToolRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [importStatus, setImportStatus] = useState<string>();
  const pickerSequence = useRef(0);
  const uploadRef = useRef<AbortController | null>(null);
  const [runningTurn, setRunningTurn] = useState(false);
  const [turnAccepted, setTurnAccepted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [urlInput, setUrlInput] = useState("");
  const [showUrl, setShowUrl] = useState(false);
  const [allowModelFileAccess, setAllowModelFileAccess] = useState(false);
  const [pythonStatus, setPythonStatus] = useState<PythonExecutionStatus>();
  const [turnModel, setTurnModel] = useState(profile?.defaultModel || "");
  const [showProcess, setShowProcess] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);
  const [notice, setNotice] = useState<string>();
  const [agentPhase, setAgentPhase] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"files" | "skill">(
    startInDesignMode || designTarget ? "skill" : "files",
  );
  const [skillDraft, setSkillDraft] = useState<AgentTool | undefined>(designTarget);
  const needsSamples = !skillDraft || skillDraft.supportedExtensions.length > 0;
  const designModeRef = useRef(false);
  designModeRef.current = workspaceMode === "skill";
  const [skillMessages, setSkillMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [skillAttachmentRoles, setSkillAttachmentRoles] = useState<Record<string, DesignAttachment["role"]>>({});
  const [skillDesignStatus, setSkillDesignStatus] = useState<string>();
  const [skillDesignElapsed, setSkillDesignElapsed] = useState(0);
  const skillDesignProgress = skillDesignStatus && busy
    ? `${skillDesignStatus} · ${skillDesignElapsed} 秒`
    : skillDesignStatus;
  const [designParameters, setDesignParameters] = useState<Record<string, unknown>>({});
  const [testResult, setTestResult] = useState<SkillTestResult>();
  const [designSessionId, setDesignSessionId] = useState<string>();
  const [sourceTask, setSourceTask] = useState<SkillDesignState["sourceTask"]>();
  const [sourceContext, setSourceContext] = useState<string>();
  const designRunIdRef = useRef<string | undefined>(undefined);
  const cancelledDesignRun = useRef<string | undefined>(undefined);
  const registeredDesignRun = useRef<string | undefined>(undefined);
  const designSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const booted = useRef(false);
  const consumedTarget = useRef<string | undefined>(undefined);
  const chatTurn = useRef<{ sessionId?: string; turnId?: string; stopRequested: boolean } | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const dropEnabledRef = useRef(false);
  dropEnabledRef.current = active && !loading;
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | undefined>(undefined);
  const sessionsRef = useRef<AgentSession[]>([]);
  const profileRef = useRef<AiProfile | undefined>(undefined);
  const turnModelRef = useRef("");
  const sessionCreationRef = useRef<Promise<AgentSession> | null>(null);
  const creatingNewRef = useRef(false);
  const skillDesignIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    getPythonExecutionStatus()
      .then((status) => { if (!disposed) setPythonStatus(status); })
      .catch(() => {
        if (!disposed) setPythonStatus({ available: false, detail: "临时工具执行环境未通过检查；仍可使用现有文件工具。" });
      });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!busy || workspaceMode !== "skill") return;
    const timer = window.setInterval(() => setSkillDesignElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy, workspaceMode]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    turnModelRef.current = turnModel;
  }, [turnModel]);

  useEffect(() => {
    setTurnModel(profile?.defaultModel || "");
  }, [profile?.id, profile?.defaultModel]);

  const refreshSessions = async (preferId?: string, signal?: AbortSignal) => {
    const items = await listAgentSessions(signal);
    sessionsRef.current = items;
    setSessions(items);
    const nextId = preferId || activeIdRef.current || items[0]?.id;
    activeIdRef.current = nextId;
    setActiveId(nextId);
    if (nextId) setDetail(await getAgentSession(nextId, signal));
    else setDetail(undefined);
  };

  const resetDesign = () => {
    setDesignSessionId(undefined);
    skillDesignIdRef.current = undefined;
    setSkillDraft(undefined);
    setSkillMessages([]);
    setSkillAttachmentRoles({});
    setDesignParameters({});
    setSourceTask(undefined);
    setSourceContext(undefined);
    setTestResult(undefined);
    setSkillDesignStatus(undefined);
    setSkillDesignElapsed(0);
    setNotice(undefined);
    setError(undefined);
    setInput("");
    setShowUrl(false);
    setUrlInput("");
  };
  const restoreDesign = async (sessionId: string) => {
    setDesignSessionId(undefined);
    const stored = await getSkillDesignState(sessionId);
    const skill = stored?.skillId ? await getSkill(stored.skillId).catch(() => undefined) : undefined;
    const seed = stored?.sourceTask ? await getTaskSkillSeed(stored.sourceTask.sessionId, stored.sourceTask.turnId).catch(() => undefined) : undefined;
    if (activeIdRef.current !== sessionId) return;
    resetDesign();
    setWorkspaceMode(stored ? "skill" : "files");
    if (stored) {
      skillDesignIdRef.current = stored.designId;
      setSkillDraft(skill);
      setSkillMessages(stored.messages);
      setSkillAttachmentRoles(stored.attachmentRoles);
      setDesignParameters(stored.parameters);
      setTestResult(stored.testResult);
      setSourceTask(stored.sourceTask);
      setSourceContext(seed?.prompt);
      setDesignSessionId(sessionId);
      if (stored.skillId && !skill) setError("这份设计的能力包已移除，设计记录和样本仍保留。");
    }
  };
  const designSnapshot = (): SkillDesignState => ({
    designId: skillDesignIdRef.current || randomId(), skillId: skillDraft?.id,
    messages: skillMessages, attachmentRoles: skillAttachmentRoles, parameters: designParameters, testResult, sourceTask,
  });
  const queueDesignSave = (sessionId: string, snapshot: SkillDesignState) => {
    const pending = designSaveQueue.current.catch(() => undefined).then(() => saveSkillDesignState(sessionId, snapshot));
    designSaveQueue.current = pending;
    return pending;
  };
  const flushDesign = async () => {
    if (designSessionId && designSessionId === activeIdRef.current) await queueDesignSave(designSessionId, designSnapshot());
    else await designSaveQueue.current;
  };
  useEffect(() => {
    if (!designSessionId || designSessionId !== activeId || loading || busy) return;
    queueDesignSave(designSessionId, designSnapshot()).catch(reason => {
      if (activeIdRef.current === designSessionId) setError(`设计记录保存失败：${String(reason)}`);
    });
  }, [designSessionId, activeId, skillDraft, skillMessages, skillAttachmentRoles, designParameters, testResult, sourceTask, loading, busy]);
  const createFreshSession = async (mode: "files" | "skill", target?: AgentTool) => {
    const selectedProfile = profileRef.current || profile;
    if (!selectedProfile) { openModels(); return; }
    await flushDesign();
    const created = await createAgentSession({ profileId: selectedProfile.id, model: turnModelRef.current || selectedProfile.defaultModel, title: mode === "skill" ? target ? `设计 · ${target.name}` : "新能力设计" : undefined });
    activeIdRef.current = created.id;
    resetDesign();
    setWorkspaceMode(mode);
    setStreaming("");
    setLiveRuns([]);
    await refreshSessions(created.id);
    if (mode === "skill") {
      const snapshot: SkillDesignState = { designId: randomId(), skillId: target?.id, messages: target ? [{ role: "assistant", content: `已载入“${target.name}”。${target.supportedExtensions.length ? "添加样本后可测试" : "可填写参数后直接测试"}，也可以说明要调整的规则。${target.source === "builtin" ? "内置能力将另存为派生能力。" : ""}` }] : [], attachmentRoles: {}, parameters: Object.fromEntries((target?.parameters || []).filter(p => p.defaultValue !== undefined).map(p => [p.key, p.defaultValue])) };
      skillDesignIdRef.current = snapshot.designId;
      setSkillDraft(target);
      setSkillMessages(snapshot.messages);
      setDesignParameters(snapshot.parameters);
      await queueDesignSave(created.id, snapshot);
      setDesignSessionId(created.id);
    }
    return created;
  };
  useEffect(() => {
    if (!profile || booted.current) return;
    booted.current = true;
    const initialize = async () => {
      if (startInDesignMode || designTarget) {
        consumedTarget.current = designTarget?.id;
        await createFreshSession("skill", designTarget);
        onDesignTargetHandled?.();
      } else {
        await refreshSessions();
        if (activeIdRef.current) await restoreDesign(activeIdRef.current);
      }
    };
    initialize().catch(reason => setError(String(reason))).finally(() => setLoading(false));
  }, [profile?.id]);
  useEffect(() => {
    if (!designTarget) { consumedTarget.current = undefined; return; }
    if (loading || busy || consumedTarget.current === designTarget.id) return;
    consumedTarget.current = designTarget.id;
    setBusy(true);
    createFreshSession("skill", designTarget).then(() => onDesignTargetHandled?.()).catch(reason => setError(String(reason))).finally(() => setBusy(false));
  }, [designTarget?.id, loading, busy]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (typeof element.scrollTo === "function") {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }, [detail?.messages.length, skillMessages.length, liveRuns.length, streaming]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = workspaceMode === "skill" ? 0 : element.scrollHeight;
  }, [workspaceMode]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    onFileDrop(async (paths) => {
          if (!paths.length || !dropEnabledRef.current || busyRef.current || creatingNewRef.current) return;
          busyRef.current = true;
          setBusy(true);
          setError(undefined);
          setNotice(undefined);
          try {
            const session = await ensureSession();
            const added = await addAgentAttachments(
              session.id,
              paths.map((path) => ({
                kind: "file" as const,
                path,
              })),
              designModeRef.current,
            );
            if (!designModeRef.current && added.length) {
              setFileSelection(current => current?.sessionId === session.id
                ? { sessionId: session.id, ids: [...new Set([...current.ids, ...added.map(item => item.id)])] }
                : current);
            }
            await refreshSessions(session.id);
            reportMaterialImport(added);
          } catch (reason) {
            setError(String(reason));
          } finally {
            busyRef.current = false;
            setBusy(false);
          }
        }).then((unlisten) => {
          if (disposed) unlisten();
          else cleanup = unlisten;
        });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  const ensureSession = async (signal?: AbortSignal) => {
    const currentId = activeIdRef.current;
    if (currentId)
      return (
        sessionsRef.current.find((item) => item.id === currentId) ||
        (await getAgentSession(currentId, signal)).session
      );
    if (sessionCreationRef.current) return sessionCreationRef.current;
    const currentProfile = profileRef.current;
    if (!currentProfile) throw new Error("请先连接一个模型服务");
    const creation = (async () => {
      const created = await createAgentSession({
        profileId: currentProfile.id,
        model: turnModelRef.current || currentProfile.defaultModel,
      }, signal);
      activeIdRef.current = created.id;
      sessionsRef.current = [created, ...sessionsRef.current.filter((item) => item.id !== created.id)];
      setSessions(sessionsRef.current);
      setActiveId(created.id);
      setDetail(await getAgentSession(created.id, signal));
      return created;
    })();
    sessionCreationRef.current = creation;
    try {
      return await creation;
    } finally {
      if (sessionCreationRef.current === creation) sessionCreationRef.current = null;
    }
  };

  const createNew = async () => {
    if (busy || loading || creatingNewRef.current) return;
    creatingNewRef.current = true;
    setBusy(true);
    try { await createFreshSession(workspaceMode); }
    catch (reason) { setError(String(reason)); }
    finally { creatingNewRef.current = false; setBusy(false); }
  };
  const chooseSession = async (sessionId: string) => {
    if (busy || loading) return;
    setBusy(true);
    try {
      await flushDesign();
      setDesignSessionId(undefined);
      activeIdRef.current = sessionId;
      setActiveId(sessionId);
      setStreaming("");
      setLiveRuns([]);
      setDetail(await getAgentSession(sessionId));
      await restoreDesign(sessionId);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const changeMode = async (mode: "skill" | "files") => {
    if (busy || loading || mode === workspaceMode) return;
    setBusy(true);
    try { await createFreshSession(mode); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  function reportMaterialImport(added: AgentAttachment[]) {
    if (added.length > 0) {
      setTestResult(undefined);
      setNotice(`已添加 ${added.length} 份材料。`);
    } else {
      setNotice(undefined);
      const skipped = designModeRef.current ? "扫描文件夹时会跳过隐藏项目和符号链接。" : "";
      setError(`本次没有添加新材料。请选择包含受支持文件的来源，并检查材料是否已添加。${skipped}`);
    }
  }

  const chooseMaterials = async (folder: boolean, specialRole = false) => {
    if (busyRef.current || loading) return;
    const selectionId = ++pickerSequence.current;
    const sessionBefore = activeIdRef.current;
    const designing = designModeRef.current;
    let paths: string[] = [];
    let uploading = false;
    let sessionId: string | undefined;
    const controller = new AbortController();
    let timer: number | undefined;
    let timedOut = false;
    const onFile = (name: string) => {
      setImportStatus(webMode ? `正在上传 ${name}` : `正在添加 ${name}`);
      if (!webMode) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
    };
    try {
      const selection = await open({
        directory: folder, multiple: !folder,
        title: folder ? "添加文件夹到当前会话" : specialRole ? "添加原始测试样本" : "添加文件到当前会话",
        filters: folder ? undefined : [{ name: "办公材料", extensions: specialRole && skillDraft ? skillInputExtensions(skillDraft) : supportedExtensions }],
      });
      paths = typeof selection === "string" ? [selection] : selection || [];
      if (!paths.length || selectionId !== pickerSequence.current || sessionBefore !== activeIdRef.current ||
          designing !== designModeRef.current || busyRef.current) return;
      uploading = true;
      busyRef.current = true; setBusy(true); setError(undefined); setNotice(undefined);
      if (webMode) uploadRef.current = controller;
      setImportStatus(folder ? "正在添加文件夹" : "正在添加文件");
      const session = await ensureSession(controller.signal);
      sessionId = session.id;
      if (controller.signal.aborted) throw new Error("已取消上传");
      const items = paths.map(path => folder ? { kind: "folder" as const, path } : { kind: "file" as const, path });
      const added = webMode
        ? await addAgentAttachments(session.id, items, designing, { signal: controller.signal, onFile })
        : await addAgentAttachments(session.id, items, designing);
      if (!designing && added.length) {
        setFileSelection(current => {
          const base = current?.sessionId === session.id ? current.ids : turnMaterials.fresh;
          return { sessionId: session.id, ids: [...new Set([...base, ...added.map(item => item.id)])] };
        });
      }
      if (folder && specialRole && added.length) {
        setSkillAttachmentRoles(current => ({ ...current, ...Object.fromEntries(added.map(item => [item.id, "reference" as const])) }));
      }
      await refreshSessions(session.id, controller.signal);
      reportMaterialImport(added);
    } catch (reason) {
      if (timedOut) setError("上传超时，请检查网络后重试。");
      else if (controller.signal.aborted) setNotice("已取消上传。");
      else setError(`添加${folder ? "文件夹" : "文件"}失败：${String(reason)}`);
      if (webMode && sessionId) {
        const targetSession = sessionId;
        void getAgentSession(targetSession).then(current => {
          if (activeIdRef.current === targetSession && pickerSequence.current === selectionId && !busyRef.current) setDetail(current);
        }).catch(() => {});
      }
    } finally {
      window.clearTimeout(timer);
      if (webMode) paths.forEach(releaseWebSelection);
      if (uploading) {
        uploadRef.current = null; setImportStatus(undefined);
        busyRef.current = false; setBusy(false);
      }
    }
  };

  const addFiles = (asTestSample = false) => chooseMaterials(false, asTestSample);
  const addFolder = (asReference = false) => chooseMaterials(true, asReference);

  const addUrl = async () => {
    if (busyRef.current || loading) return;
    if (!/^https?:\/\//i.test(urlInput.trim())) {
      setError("请输入完整的 HTTP(S) 网址");
      return;
    }
    busyRef.current = true; setBusy(true);
    try {
    const session = await ensureSession();
    const added = await addAgentAttachments(session.id, [
      { kind: "url", url: urlInput.trim() },
    ]);
    if (!designModeRef.current && added.length) {
      setFileSelection(current => ({ sessionId: session.id, ids: [...new Set([
        ...(current?.sessionId === session.id ? current.ids : turnMaterials.fresh), ...added.map(item => item.id),
      ])] }));
    }
    setUrlInput("");
    setShowUrl(false);
    setError(undefined);
    await refreshSessions(session.id);
    setTestResult(undefined);
    } catch (reason) { setError(`添加网址失败：${String(reason)}`); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const removeAttachment = async (item: AgentAttachment) => {
    if (!activeId || item.kind === "artifact") return;
    await removeAgentAttachment(activeId, item.id);
    await refreshSessions(activeId);
  };

  const removeMaterialGroup = async (group: MaterialGroup) => {
    if (!activeId || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
    if (group.items.length === 1) {
      await removeAttachment(group.items[0]);
      return;
    }
    await removeAgentAttachments(activeId, group.items.map((item) => item.id));
    await refreshSessions(activeId);
    } catch (reason) { setError(`移除材料失败：${String(reason)}`); }
    finally { setTestResult(undefined); busyRef.current = false; setBusy(false); }
  };

  const onAgentEvent = (event: AgentEvent) => {
    if (event.sessionId !== activeIdRef.current) return;
    setFileSelection(undefined);
    const turn = chatTurn.current;
    if (!webMode && turn?.sessionId === event.sessionId && !turn.turnId) {
      turn.turnId = event.turnId;
      if (turn.stopRequested) void stopChatTurn(turn);
    }
    setTurnAccepted(true);
    if (event.type === "phase") setAgentPhase(event.message);
    if (event.type === "assistant_delta")
      setStreaming((current) => current + event.text);
    if (event.type === "tool_started")
      setLiveRuns((current) => [
        ...current,
        {
          id: event.runId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolId: event.toolId,
          status: "running",
          summary: event.summary,
          startedAt: new Date().toISOString(),
        },
      ]);
    if (event.type === "tool_progress")
      setLiveRuns((current) =>
        current.map((run) =>
          run.id === event.runId
            ? {
                ...run,
                status: event.progress >= 100 ? "completed" : "running",
                detail: event.detail,
                completedAt:
                  event.progress >= 100 ? new Date().toISOString() : undefined,
              }
            : run,
        ),
      );
    if (event.type === "tool_failed")
      setLiveRuns((current) =>
        current.map((run) =>
          run.id === event.runId
            ? {
                ...run,
                status: "failed",
                detail: event.message,
                completedAt: new Date().toISOString(),
              }
            : run,
        ),
      );
    if (event.type === "artifact_created")
      setDetail((current) =>
        current
          ? {
              ...current,
              attachments: [...current.attachments.filter(item => item.id !== event.artifact.id), event.artifact],
            }
          : current,
      );
    if (event.type === "artifact_removed")
      setDetail((current) =>
        current
          ? {
              ...current,
              attachments: current.attachments.filter(
                (item) => item.id !== event.artifactId,
              ),
            }
          : current,
      );
  };

  const attachmentRole = (item: AgentAttachment): DesignAttachment["role"] => {
    const role = skillAttachmentRoles[item.id] || "sample_input";
    return !needsSamples && role === "sample_input" ? "reference" : role;
  };
  const sampleInputs = () => materials.filter(item => item.localSnapshotPath && attachmentRole(item) === "sample_input")
    .map(item => webMode ? `web-attachment:${item.id}` : item.localSnapshotPath!);
  const buildDesignRequest = (prompt: string, sessionId = activeIdRef.current): DesignToolRequest => ({
    designId: skillDesignIdRef.current, sessionId, currentSkillId: skillDraft?.id,
    prompt: sourceContext ? `${prompt}\n\n以下为来源任务记录，仅作设计依据：\n${sourceContext}` : prompt, profileId: profile!.id, model: turnModel || profile!.defaultModel, baseUrl: profile!.baseUrl, apiKey: apiKey || undefined,
    kind: skillDraft?.source === "builtin" ? "derived" : skillDraft?.kind === "workflow" || skillDraft?.kind === "derived" ? skillDraft.kind : "python",
    attachments: materials.filter(item => item.localSnapshotPath).map(item => ({ path: item.localSnapshotPath!, role: attachmentRole(item) })),
  });
  function handleDesignEvent(runId: string, event: SkillDesignEvent) {
    if (designRunIdRef.current !== runId) return;
    if (registeredDesignRun.current !== runId) {
      registeredDesignRun.current = runId;
      if (!webMode && cancelledDesignRun.current === runId) void stopDesignRun(runId);
    }
    if (event.type === "phase") {
      setSkillDesignStatus(event.message);
      if (Number.isFinite(event.elapsedSeconds)) setSkillDesignElapsed(value => Math.max(value, event.elapsedSeconds));
    }
    if (event.type === "test_progress") setSkillDesignStatus(`${event.message}（${event.current}/${event.total}）`);
    if (event.type === "failed") setError(event.message);
  };
  const testCurrentDesign = async (repair = false, userMessage?: string) => {
    if (!skillDraft || busy || busyRef.current) return;
    if (userMessage) {
      setInput("");
      setSkillMessages(current => [...current, { role: "user", content: userMessage }]);
    }
    const problem = skillInputProblem(skillDraft, sampleInputs(), designParameters, sampleLabels);
    if (problem) {
      if (userMessage) setSkillMessages(current => [...current, { role: "assistant", content: problem }]);
      else setError(problem);
      return;
    }
    if (repair && !profile) { openModels(); return; }
    const runId = randomId();
    busyRef.current = true;
    designRunIdRef.current = runId;
    setBusy(true); setError(undefined); setStopping(false); setSkillDesignElapsed(0);
    setTestResult(undefined);
    setSkillDesignStatus(repair ? "正在测试并准备修复" : "正在测试当前样本");
    try {
      await flushDesign();
      if (cancelledDesignRun.current === runId) throw new Error("本次样本测试已停止");
      const result = await testAndRepairSkill({ runId, designId: skillDesignIdRef.current, skillId: skillDraft.id, samplePaths: sampleInputs(), parameters: designParameters,
        repair: repair ? buildDesignRequest("请根据正式样本测试的实际错误修复现有能力，保留原有规则；修复后用同一组样本和参数重测。") : undefined,
      }, event => handleDesignEvent(runId, event));
      if (cancelledDesignRun.current === runId) throw new Error("本次样本测试已停止");
      setSkillDraft(result.skill); setTestResult(result.testResult);
      if (userMessage && result.testResult) {
        const content = result.testResult.summary;
        setSkillMessages(current => [...current, { role: "assistant", content }]);
      }
      if (result.testResult) setDesignParameters(result.testResult.parameters);
      onSkillSaved?.(result.skill);
    } catch (reason) { setError(String(reason)); }
    finally { busyRef.current = false; setBusy(false); setStopping(false); setSkillDesignStatus(undefined); designRunIdRef.current = undefined; }
  };
  const publishCurrentDesign = async () => {
    if (!skillDraft || busy || testResult?.status !== "passed") return;
    setBusy(true);
    try { const published = await publishSkill(skillDraft.id); setSkillDraft(published); onSkillSaved?.(published); setNotice(`“${published.name}”已发布。`); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  const send = async () => {
    if (!input.trim() || busyRef.current || loading) return;
    ++pickerSequence.current;
    setNotice(undefined);
    setStopping(false);
    setAgentPhase(undefined);
    if (!profile) {
      openModels();
      return;
    }
    if (workspaceMode === "skill") {
      if (webMode && skillDraft && /^(?:请|帮我)?(?:试试|试一下|测试一下|测试|重测|重新测试|跑一下|试跑)(?:当前样本|这个样本)?[。！!？?]*$/.test(input.trim())) {
        await testCurrentDesign(true, input.trim());
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(undefined);
      const userText = input.trim();
      const runId = randomId();
      designRunIdRef.current = runId;
      const messages: SkillDesignState["messages"] = [...skillMessages, { role: "user", content: userText }];
      try {
        const session = await ensureSession();
        if (cancelledDesignRun.current === runId) return;
        const designId = skillDesignIdRef.current || randomId();
        skillDesignIdRef.current = designId;
        setInput("");
        if (/^(?:你好(?:呀|啊|吗)?|您好|嗨|哈[啰喽罗囉]|在吗|hello|hi)[\s!！?？。.,，～~]*$/iu.test(userText)) {
          const content = skillDraft
            ? `你好！我们可以继续修改“${skillDraft.name}”。你想调整哪条规则，或${needsSamples ? "试一下新的样本" : "修改参数后再测试"}？`
            : "你好！你想让能力包帮你处理什么材料？可以先描述输入文件和想得到的结果，也可以点“添加样本”给我一个例子。";
          const conversation: SkillDesignState["messages"] = [...messages, { role: "assistant", content }];
          setSkillMessages(conversation);
          await queueDesignSave(session.id, { ...designSnapshot(), designId, messages: conversation });
          setDesignSessionId(session.id);
          return;
        }
        setSkillMessages(messages);
        setSkillDesignElapsed(0);
        setTestResult(undefined);
        setSkillDesignStatus("正在准备能力包设计");
        await queueDesignSave(session.id, { ...designSnapshot(), designId, messages, testResult: undefined });
        setDesignSessionId(session.id);
        if (cancelledDesignRun.current === runId) throw new Error("本次能力包设计已停止");
        const result = await designAndTestSkill({
          design: buildDesignRequest(userText, session.id), runId,
          samplePaths: sampleInputs(), parameters: designParameters, autoTest: true,
        }, event => handleDesignEvent(runId, event));
        if (cancelledDesignRun.current === runId) throw new Error("本次能力包设计已停止");
        setSkillDraft(result.skill);
        setTestResult(result.testResult);
        setDesignParameters(result.testResult?.parameters || Object.fromEntries(result.skill.parameters.filter(p => p.defaultValue !== undefined).map(p => [p.key, p.defaultValue])));
        const summary = result.testResult?.summary || `已保存“${result.skill.name}”测试版。${result.skill.supportedExtensions.length ? "添加原始样本和必填参数后即可测试。" : "参数就绪后即可开始测试。"}`;
        const completed: SkillDesignState["messages"] = [...messages, { role: "assistant", content: summary }];
        setSkillMessages(completed);
        await queueDesignSave(session.id, { designId, skillId: result.skill.id, messages: completed, attachmentRoles: skillAttachmentRoles, parameters: result.testResult?.parameters || Object.fromEntries(result.skill.parameters.filter(p => p.defaultValue !== undefined).map(p => [p.key, p.defaultValue])), testResult: result.testResult, sourceTask });
        await renameAgentSession(session.id, `设计 · ${result.skill.name}`);
        await refreshSessions(session.id);
        onSkillSaved?.(result.skill);
      } catch (reason) {
        setError(String(reason));
        setSkillMessages([...messages, { role: "assistant", content: `本轮未完成：${String(reason)}。已保留设计记录，可继续修改。` }]);
      } finally {
        busyRef.current = false;
        setBusy(false);
        setStopping(false);
        setSkillDesignStatus(undefined);
        designRunIdRef.current = undefined;
      }
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const turn: NonNullable<typeof chatTurn.current> = { stopRequested: false };
    chatTurn.current = turn;
    setRunningTurn(true);
    setTurnAccepted(false);
    setShowProcess(true);
    setError(undefined);
    setStreaming("");
    setLiveRuns([]);
    try {
      const session = await ensureSession();
      if (turn.stopRequested) return;
      turn.sessionId = session.id;
      const userText = input.trim();
      setInput("");
      setDetail((current) =>
        current
          ? {
              ...current,
              messages: [
                ...current.messages,
                {
                  id: `pending-${Date.now()}`,
                  sessionId: session.id,
                  role: "user",
                  content: userText,
                  createdAt: new Date().toISOString(),
                  attachmentIds: turnMaterials.ids,
                },
              ],
            }
          : current,
      );
      const result = await sendAgentMessage(
        {
          sessionId: session.id,
          content: userText,
          profileId: profile.id,
          model: turnModel || profile.defaultModel,
          baseUrl: profile.baseUrl,
          apiKey: apiKey || undefined,
          allowModelFileAccess,
          attachmentIds: turnMaterials.ids,
        },
        onAgentEvent,
      );
      setDetail(result);
      setFileSelection(undefined);
      setStreaming("");
      setLiveRuns([]);
      await refreshSessions(session.id);
      setShowProcess(false);
    } catch (reason) {
      setError(String(reason));
      if (activeId)
        setDetail(await getAgentSession(activeId).catch(() => detail));
    } finally {
      setBusy(false);
      busyRef.current = false;
      chatTurn.current = null;
      setRunningTurn(false);
      setTurnAccepted(false);
      setStopping(false);
      setAgentPhase(undefined);
    }
  };

  const saveTaskAsSkill = async (turnId: string) => {
    if (busyRef.current || !activeId) return;
    const originalSession = activeId;
    busyRef.current = true; setBusy(true); setError(undefined);
    try {
      if (webMode) {
        const created = await webDesignFromTurn(originalSession, turnId);
        await refreshSessions(created.sessionId);
        await restoreDesign(created.sessionId);
        return;
      }
      const seed = await getTaskSkillSeed(originalSession, turnId);
      const candidates = detail?.toolRuns.filter(run => run.turnId === turnId && run.status === "completed") || [];
      const run = candidates.find(run => run.toolId === "codex_harness") || [...candidates].reverse().find(run => run.toolId === "run_python" && !run.detail?.includes("样本结构诊断"));
      let skill: AgentTool | undefined;
      let reason = "本轮需要将处理依据整理为可复用规则。";
      if (run) {
        try { skill = await promoteAgentRunToSkill(run.id, run.toolId === "codex_harness" ? undefined : run.summary); }
        catch (failure) { reason = String(failure); }
      }
      const created = await createFreshSession("skill", skill);
      if (!created) return;
      if (seed.samplePaths.length) {
        await addAgentAttachments(created.id, seed.samplePaths.map(path => ({ kind: "file", path })), true);
        await refreshSessions(created.id);
      }
      const source = { sessionId: originalSession, turnId };
      const messages: SkillDesignState["messages"] = [{ role: "assistant", content: skill
        ? `已从这次成功任务生成“${skill.name}”测试版，并保留执行参数。先用原样本复现，再换样本验证后发布。`
        : `已建立独立设计会话，带入原任务需求和成功执行记录。${reason} 请补充需要固定的规则，然后发送以生成测试版。${seed.requiresNetwork ? ` ${seed.networkReason}。` : ""}` }];
      const parameters = Object.fromEntries((skill?.parameters || []).filter(p => p.defaultValue !== undefined).map(p => [p.key, p.defaultValue]));
      setSourceTask(source); setSourceContext(seed.prompt); setSkillMessages(messages);
      if (!skill) setInput("把这次成功任务整理为可复用的能力包测试版，保留处理规则，把每次可能变化的内容做成参数。");
      await queueDesignSave(created.id, { designId: skillDesignIdRef.current!, skillId: skill?.id, messages, attachmentRoles: {}, parameters, sourceTask: source });
      if (skill) onSkillSaved?.(skill);
      if (!seed.samplePaths.length) setNotice("原任务没有保存可复用的输入引用，请重新添加测试样本。");
    } catch (reason) {
      setError(String(reason));
    } finally { busyRef.current = false; setBusy(false); }
  };

  async function stopChatTurn(turn: NonNullable<typeof chatTurn.current>) {
    if (!turn.sessionId || !turn.turnId) return;
    try { await cancelAgentTurn(turn.sessionId, turn.turnId); }
    catch (reason) {
      if (chatTurn.current === turn) {
        turn.stopRequested = false;
        setStopping(false);
        setError(`无法停止任务：${String(reason)}`);
      }
    }
  }

  async function stopDesignRun(runId: string) {
    try { await cancelSkillDesign(runId); }
    catch (reason) {
      if (designRunIdRef.current !== runId) return;
      cancelledDesignRun.current = undefined;
      setStopping(false);
      setError(`无法停止能力设计：${String(reason)}`);
    }
  }

  const stop = async () => {
    setStopping(true);
    if (workspaceMode === "skill" && designRunIdRef.current) {
      const runId = designRunIdRef.current;
      cancelledDesignRun.current = runId;
      if (webMode || registeredDesignRun.current === runId) await stopDesignRun(runId);
      return;
    }
    const turn = chatTurn.current;
    if (!webMode && turn) {
      turn.stopRequested = true;
      await stopChatTurn(turn);
      return;
    }
    if (!activeId) return;
    try {
      await cancelAgentTurn(activeId);
    } catch (reason) {
      setStopping(false);
      setError(`无法停止任务：${String(reason)}`);
    }
  };

  const deleteSession = async (sessionId: string) => {
    if (busy || loading) return;
    if (!window.confirm("删除这个会话及材料副本？已导出的成果文件默认保留。"))
      return;
    setBusy(true);
    try {
    await flushDesign();
    await deleteAgentSession(sessionId, false);
    const remaining = sessions.filter((item) => item.id !== sessionId);
    sessionsRef.current = remaining;
    setSessions(remaining);
    if (sessionId !== activeIdRef.current) return;
    resetDesign();
    activeIdRef.current = remaining[0]?.id;
    setActiveId(activeIdRef.current);
    setDetail(
      remaining[0] ? await getAgentSession(remaining[0].id) : undefined,
    );
    if (remaining[0]) await restoreDesign(remaining[0].id);
    } catch (reason) { setError(`删除会话失败：${String(reason)}`); }
    finally { setBusy(false); }
  };

  const renameSession = async (session: AgentSession) => {
    if (busy) return;
    const title = window.prompt("重命名会话", session.title)?.trim();
    if (!title || title === session.title) return;
    try { await renameAgentSession(session.id, title); await refreshSessions(activeId); }
    catch (reason) { setError(String(reason)); }
  };

  const allArtifacts = useMemo(
    () =>
      detail?.attachments.filter(
        (item) => item.kind === "artifact",
      ) ?? [],
    [detail?.attachments],
  );
  const artifacts = useMemo(
    () => allArtifacts.filter((item) => !isDiagnosticArtifact(item)),
    [allArtifacts],
  );
  const diagnosticArtifacts = useMemo(
    () => allArtifacts.filter(isDiagnosticArtifact),
    [allArtifacts],
  );
  const artifactGroups = useMemo(() => {
    const groups = new Map<string, AgentAttachment[]>();
    for (const item of artifacts) {
      const key = item.sourceGroupId
        ? `group:${item.sourceGroupId}`
        : `artifact:${item.id}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()].map(([key, items]): MaterialGroup => {
      const first = items[0];
      return {
        key,
        kind: items.length > 1 ? "folder" : "artifact",
        name:
          items.length > 1
            ? first.sourceGroupName || "批量成果"
            : first.name,
        items,
        summary:
          items.length > 1
            ? `${items.length} 个文件 · ${formatBytes(items.reduce((sum, item) => sum + (item.size || 0), 0))}`
            : displayTime(first.createdAt),
      };
    });
  }, [artifacts]);
  const openArtifact = async (item: AgentAttachment) => {
    if (!activeId) return;
    try {
      await openAgentArtifact(activeId, item);
    } catch (reason) {
      setError(String(reason));
    }
  };
  const materials = useMemo(
    () => detail?.attachments.filter((item) => item.kind !== "artifact") ?? [],
    [detail?.attachments],
  );
  const explicitIds = fileSelection?.sessionId === activeId ? fileSelection?.ids : undefined;
  const turnMaterials = webTurnMaterials(materials, detail?.messages || [], explicitIds);
  const turnMaterialSelection = workspaceMode === "files";
  const selectMaterials = (ids: string[]) => {
    if (activeId) setFileSelection({ sessionId: activeId, ids });
  };
  const materialChoice = (item: AgentAttachment) => <label key={item.id}>
    <input type="checkbox" disabled={busy} aria-label={`本轮使用 ${item.relativePath || item.name}`}
      checked={turnMaterials.ids.includes(item.id)}
      onChange={event => selectMaterials(event.target.checked ? [...turnMaterials.ids, item.id] : turnMaterials.ids.filter(id => id !== item.id))} />
    {item.relativePath || item.name}
  </label>;
  const sampleLabels = useMemo(() => Object.fromEntries(materials.flatMap(item => item.localSnapshotPath
    ? [[webMode ? `web-attachment:${item.id}` : item.localSnapshotPath, item.name]] : [])), [materials, webMode]);
  const materialGroups = useMemo(() => {
    const groups = new Map<string, AgentAttachment[]>();
    for (const item of materials) {
      const key = item.kind === "folder"
        ? `folder:${item.sourceGroupId || "legacy"}`
        : `${item.kind}:${item.id}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()].map(([key, items]): MaterialGroup => {
      const first = items[0];
      if (first.kind !== "folder") {
        return {
          key,
          kind: first.kind,
          name: first.name,
          items,
          summary: first.kind === "url"
            ? first.sourceUrl || "公开网址"
            : formatBytes(first.size || 0),
        };
      }
      const formats = new Map<string, number>();
      for (const item of items) {
        const extension = item.name.split(".").pop()?.toUpperCase() || "文件";
        formats.set(extension, (formats.get(extension) || 0) + 1);
      }
      const formatSummary = [...formats.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 4)
        .map(([extension, count]) => `${extension} ${count}`)
        .join(" · ");
      return {
        key,
        kind: "folder",
        name: first.relativePath?.includes("/") && webMode ? first.relativePath.split("/")[0] : first.sourceGroupName || "历史文件夹材料",
        items,
        summary: `${items.length} 个文件 · ${formatBytes(items.reduce((sum, item) => sum + (item.size || 0), 0))}${formatSummary ? ` · ${formatSummary}` : ""}`,
      };
    });
  }, [materials, webMode]);
  const sentMaterials = useMemo(() => {
    const byMessage = new Map<string, MaterialGroup[]>();
    const sent = new Set<string>();
    const userMessages = detail?.messages.filter(message => message.role === "user" && !message.id.startsWith("pending-")) ?? [];
    for (const group of materialGroups) {
      if (workspaceMode !== "files") continue;
      const created = Date.parse(group.items[0].createdAt);
      const legacyOwner = userMessages.find(message => Date.parse(message.createdAt) >= created);
      for (const message of userMessages) {
        const used = message.attachmentIds
          ? group.items.filter(item => message.attachmentIds!.includes(item.id))
          : message === legacyOwner ? group.items : [];
        if (!used.length) continue;
        byMessage.set(message.id, [...(byMessage.get(message.id) ?? []), { ...group, items: used }]);
        sent.add(group.key);
      }
    }
    return { byMessage, sent };
  }, [detail?.messages, materialGroups, workspaceMode]);
  const composerGroups = turnMaterialSelection
    ? materialGroups.map(group => ({ ...group, items: group.items.filter(item => (explicitIds || turnMaterials.fresh).includes(item.id)) }))
        .filter(group => group.items.length)
    : materialGroups.filter(group => !sentMaterials.sent.has(group.key));
  const latestPersistedTurnId = useMemo(
    () =>
      [...(detail?.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user" && message.turnId)?.turnId,
    [detail?.messages],
  );
  const allRuns = useMemo(() => {
    const activeTurnId = liveRuns[liveRuns.length - 1]?.turnId || latestPersistedTurnId;
    const runs = [
      ...(detail?.toolRuns.filter((run) => run.turnId === activeTurnId) ?? []),
      ...liveRuns.filter((run) => run.turnId === activeTurnId),
    ];
    return [...new Map(runs.map((run) => [run.id, run])).values()];
  }, [detail?.toolRuns, latestPersistedTurnId, liveRuns]);

  return (
    <div className={`agent-workspace ${contextOpen ? "" : "context-collapsed"}`}>
      <aside className="session-column">
        <header>
          <div>
            <span>文件 Agent</span>
            <strong>工作会话</strong>
          </div>
          <button onClick={createNew} disabled={busy || loading} aria-label={workspaceMode === "skill" ? "新建设计会话" : "新建会话"}>
            <Plus size={17} />
          </button>
        </header>
        <div className="session-list">
          {loading && (
            <div className="session-skeleton">
              <i />
              <i />
              <i />
            </div>
          )}
          {!loading && sessions.length === 0 && (
            <div className="session-empty">
              <Robot size={23} />
              <span>还没有会话</span>
              <button onClick={createNew}>新建一个</button>
            </div>
          )}
          {sessions.map((session) => (
            <button
              className={activeId === session.id ? "is-active" : ""}
              key={session.id}
              onClick={() => chooseSession(session.id)}
              onDoubleClick={() => renameSession(session)}
              title="双击重命名"
            >
              <span className={`session-state ${session.status}`} />
              <span>
                <strong>{session.title}</strong>
                <small>{displayTime(session.updatedAt)}</small>
              </span>
              <i
                onClick={(event) => {
                  event.stopPropagation();
                  deleteSession(session.id);
                }}
              >
                <Trash size={13} />
              </i>
            </button>
          ))}
        </div>
      </aside>

      <section className="conversation-column">
        <header className="conversation-header">
          <div>
            <span>{workspaceMode === "skill" ? skillDraft?.name || "新能力包" : detail?.session.title || "新会话"}</span>
            <small>
              {workspaceMode === "skill"
                ? skillDraft
                  ? `继续优化 · ${skillDraft.version || "0.1.0"}`
                  : "专属能力包设计 Agent"
                : profile
                ? `${profile.displayName} · ${turnModel || profile.defaultModel}`
                : "尚未连接模型"}
            </small>
          </div>
          {profile?.provider === "deepseek" && (
            <label className="turn-model-select" title="本轮使用的模型">
              <select value={turnModel} disabled={busy} onChange={(event) => setTurnModel(event.target.value)}>
                <option value="deepseek-v4-flash">V4 Flash</option>
                <option value="deepseek-v4-pro">V4 Pro</option>
              </select>
            </label>
          )}
          <div className="agent-work-mode">
            <button disabled={busy || loading} className={workspaceMode === "files" ? "is-active" : ""} onClick={() => void changeMode("files")}>{workspaceMode === "skill" && <ArrowLeft size={13} />}处理材料</button>
            <button disabled={busy || loading} className={workspaceMode === "skill" ? "is-active" : ""} onClick={() => void changeMode("skill")}><Code size={14} />设计能力包</button>
          </div>
          {!profile?.managed && <button className={profile && (apiKey.trim() || profile.keyStored) ? "model-ready" : ""} onClick={openModels}>
            <Cloud size={15} />
            {!profile
              ? "配置模型"
              : apiKey.trim() || profile.keyStored
                ? profile.lastTest?.success
                  ? "模型已就绪"
                  : "密钥已设置"
                : "需要 API Key"}
          </button>}
          {workspaceMode === "files" && (
            <button className="context-toggle" onClick={() => setContextOpen((value) => !value)} title={contextOpen ? "收起材料栏" : "展开材料栏"}>
              <SidebarSimple size={15} />
            </button>
          )}
        </header>
        {error && (
          <div className="agent-error">
            <span>{error}</span>
            <button onClick={() => setError(undefined)}>
              <X size={13} />
            </button>
          </div>
        )}
        {notice && (
          <div className="agent-notice">
            <span>{notice}</span>
            <button onClick={() => setNotice(undefined)}><X size={13} /></button>
          </div>
        )}
        <div className="message-stream" ref={scrollRef}>
          {workspaceMode === "skill" && skillMessages.length === 0 && !busy && (
            <div className="agent-welcome skill-welcome">
              <span className="welcome-mark"><Code size={25} /></span>
              <p>把你的工作方法教给 Agent</p>
              <h1>不需要先写代码。按“样本—规则—验收”说明一次，Agent 会生成可测试的能力包草稿。</h1>
              <ol className="skill-guide-steps">
                <li><span><File size={15} /></span><b>1. 添加样本</b><small>至少一份原始材料；最好再加正确成果或模板</small></li>
                <li><span><Code size={15} /></span><b>2. 说清规则</b><small>输入是什么、如何处理、输出什么、哪些内容不能改</small></li>
                <li><span><CheckCircle size={15} /></span><b>3. 测试发布</b><small>先在副本上验收；通过后才进入能力包库</small></li>
              </ol>
              <div><button onClick={() => void addFiles()}><File size={16} />添加样本</button><button onClick={() => void addFolder(true)}><FolderOpen size={16} />添加参考文件夹</button></div>
              <div className="skill-starters">
                <button onClick={() => setInput("设计一个批量信息提取能力包：从每份材料中提取姓名、单位、现职务和任职时间，汇总成一个 Excel。遇到缺失字段要留空并生成错误清单，原文件不修改。")}>信息提取汇总</button>
                <button onClick={() => setInput("设计一个公文格式能力包：以我提供的正确成果为版式标准，批量处理 DOC 和 DOCX，保留正文、表格和图片，生成新的 DOCX，并报告缺失字体和无法处理的文件。")}>公文套版</button>
                <button onClick={() => setInput("设计一个文字清理能力包：清理多余空格和手动换行，但保留英文单词间空格、表格结构、页眉页脚和原有图片；处理 DOC 时输出新的 DOCX。")}>文字清理</button>
              </div>
            </div>
          )}
          {workspaceMode === "files" && detail?.messages
            .filter((message) => message.role !== "tool")
            .map((message) => (
              <article
                className={`chat-message ${message.role}`}
                key={message.id}
              >
                <span className={message.role === "assistant" ? "agent-avatar-wrap" : undefined}>
                  {message.role === "user" ? "你" : <img className="agent-avatar" src={shellAvatar} alt="zhai 小贝壳" />}
                </span>
                <div>
                  {message.role === "assistant" ? <MarkdownMessage>{message.content}</MarkdownMessage> : <p>{message.content}</p>}
                  {sentMaterials.byMessage.get(message.id)?.map(group => <small key={group.key}><Paperclip size={12} /> {group.name}</small>)}
                  {message.role === "assistant" && artifactsForMessage(message, detail.messages, artifactGroups).map((group) => (
                    <div className="message-artifacts" key={group.key}>
                      {group.items.length > 1 && <strong>{group.name} · {group.items.length} 个文件</strong>}
                      {group.items.map((item) => (
                        <button key={item.id} type="button" onClick={() => openArtifact(item)} title={`打开 ${item.name}`}>
                          <File size={15} /> <span>{item.name}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {message.role === "assistant" && message.turnId && (webMode ? message.canDesignSkill : artifactsForMessage(message, detail.messages, artifactGroups).length > 0) && (
                    <button className="task-to-skill" disabled={busy || loading} onClick={() => void saveTaskAsSkill(message.turnId!)}>
                      <FloppyDisk size={15} />生成能力包测试版
                    </button>
                  )}
                  <small>{displayTime(message.createdAt)}</small>
                </div>
              </article>
            ))}
          {workspaceMode === "skill" && skillMessages.map((message, index) => (
            <article className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
              <span>{message.role === "user" ? "你" : <Code size={15} />}</span>
              <div>{message.role === "assistant" ? <MarkdownMessage>{message.content}</MarkdownMessage> : <p>{message.content}</p>}</div>
            </article>
          ))}
          {workspaceMode === "skill" && sourceTask && <p className="design-source-note">来自已交付任务 · <button disabled={busy} onClick={() => void chooseSession(sourceTask.sessionId)}>查看原会话</button> · 设计记录与原会话独立保存</p>}
          {workspaceMode === "skill" && skillDraft && skillDraft.source === "designed" && (
            <SkillTestPanel skill={skillDraft} paths={sampleInputs()} sampleLabels={sampleLabels} parameters={designParameters} result={testResult} busy={busy}
              onParameter={(key, value) => { setDesignParameters(current => ({ ...current, [key]: value })); setTestResult(undefined); }}
              onAdd={() => void addFiles(true)} onTest={() => void testCurrentDesign()} onRepair={() => void testCurrentDesign(true)}
              onOpen={path => void revealInFinder(path).catch(reason => setError(String(reason)))} onPublish={() => void publishCurrentDesign()} />
          )}
          {workspaceMode === "files" && allRuns.length > 0 && (
            <details className="tool-activity" open={showProcess} onToggle={(event) => setShowProcess(event.currentTarget.open)}>
              <summary>本轮过程 · {allRuns.length} 步 <span>{showProcess ? "收起" : "展开"}</span></summary>
              {allRuns.slice(-8).map((run) => (
                <div className={run.status} key={run.id}>
                  {run.status === "running" ? (
                    <SpinnerGap className="spin" size={14} />
                  ) : run.status === "completed" ? (
                    <CheckCircle size={14} weight="fill" />
                  ) : (
                    <X size={14} />
                  )}
                  <p>
                    <strong>{run.summary}</strong>
                    {run.detail && <small>{compactToolDetail(run)}</small>}
                  </p>
                  <span className="tool-kind" title={`内部工具：${run.toolId}`}>
                    {toolLabel(run.toolId)}
                  </span>
                </div>
              ))}
            </details>
          )}
          {streaming && (
            <article className="chat-message assistant is-streaming">
              <span className="agent-avatar-wrap">
                <img className="agent-avatar" src={shellAvatar} alt="zhai 小贝壳" />
              </span>
              <div>
                <MarkdownMessage>{streaming}</MarkdownMessage>
                <i />
              </div>
            </article>
          )}
          {busy && !streaming && (importStatus || runningTurn || skillDesignStatus) && (
            <div className="thinking-line">
              <span />
              <span />
              <span />
              <small>{importStatus || (stopping ? "正在停止任务，等待后台退出…" : skillDesignProgress || agentPhase || "正在准备本轮任务")}</small>
            </div>
          )}
        </div>
        <footer className="composer-wrap">
          {showUrl && (
            <div className="url-adder">
              <Link size={15} />
              <input
                autoFocus
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && addUrl()}
                placeholder="https://..."
              />
              <button onClick={addUrl}>添加</button>
              <button onClick={() => setShowUrl(false)}>
                <X size={13} />
              </button>
            </div>
          )}
          {composerGroups.length > 0 && (
            <div className="composer-materials">
              {composerGroups.map((group) => (
                <span key={group.key} title={group.summary}>
                  {group.kind === "folder" ? <FolderOpen size={13} /> : iconForAttachment(group.items[0])}
                  <b>{group.name}</b>
                  {group.items.length > 1 && <i>{group.items.length}</i>}
                  <button disabled={busy} aria-label={turnMaterialSelection ? `本轮移除 ${group.name}` : undefined} onClick={() => turnMaterialSelection
                    ? selectMaterials(turnMaterials.ids.filter(id => !group.items.some(item => item.id === id)))
                    : removeMaterialGroup(group)}>
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {workspaceMode === "skill" && materials.length > 0 && (
            <div className="skill-material-roles">
              <span>告诉 Agent 每份材料的用途</span>
              <div>
                {materialGroups.map(group => {
                  const roles = group.items.map(item => (
                  <label key={item.id} title={item.name}>
                    <b>{item.name}</b>
                    <select disabled={busy}
                      value={attachmentRole(item)}
                      onChange={(event) => { setTestResult(undefined); setSkillAttachmentRoles((current) => ({
                        ...current,
                        [item.id]: event.target.value as DesignAttachment["role"],
                      })); }}
                    >
                      {needsSamples && <option value="sample_input">原始样本</option>}
                      <option value="expected_output">正确成果</option>
                      <option value="template">模板</option>
                      <option value="reference">参考材料</option>
                    </select>
                  </label>
                  ));
                  return group.kind === "folder"
                    ? <details key={group.key}><summary>{group.name} · {group.items.length} 个文件</summary>{roles}</details>
                    : roles;
                })}
              </div>
            </div>
          )}
          {turnMaterialSelection && !!materials.length && <details className="turn-file-selection">
            <summary>本轮材料（{turnMaterials.ids.length}）</summary>
            <div>
              <button type="button" disabled={busy} onClick={() => selectMaterials(materials.map(item => item.id))}>本轮全选</button>
              {materialGroups.map(group => group.kind === "folder"
                ? <details key={group.key}><summary>{group.name} · {group.items.length} 份</summary>{group.items.map(materialChoice)}</details>
                : group.items.map(materialChoice))}
            </div>
          </details>}
          <div className="composer">
            <div className="attach-menu">
              <button disabled={busy} onClick={() => void addFiles()} title="添加文件">
                <Paperclip size={17} />{workspaceMode === "skill" && <span>{needsSamples ? "添加样本" : "添加参考材料"}</span>}
              </button>
              <button disabled={busy} onClick={() => void addFolder()} title="添加文件夹">
                <FolderOpen size={17} />
              </button>
              {!profile?.managed && <button
                onClick={() => setShowUrl((value) => !value)}
                title="添加网址"
              >
                <Globe size={17} />
              </button>}
            </div>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder={
                workspaceMode === "skill"
                  ? skillDraft
                    ? `继续优化“${skillDraft.name}”，例如：增加批量处理和错误清单`
                    : "说明想设计的能力包，以及样本之间的规律"
                  : materials.length
                  ? "继续说明要处理什么，Enter 发送，Shift+Enter 换行"
                  : webMode ? "直接聊天，或先上传需要处理的文件" : "可以直接聊天、讨论思路，也可以创建或处理文件"
              }
            />
            {importStatus && webMode ? (
              <button className="stop-send" onClick={() => uploadRef.current?.abort()} aria-label="取消上传" title="取消上传"><X size={14} /></button>
            ) : busy && (runningTurn || designRunIdRef.current) ? (
              <button className="stop-send" disabled={stopping || (runningTurn && webMode && !turnAccepted)} onClick={stop} aria-label="停止任务">
                <Stop size={14} weight="fill" />
              </button>
            ) : (
              <button
                className="send-button"
                aria-label="发送消息"
                disabled={!input.trim() || loading || busy}
                onClick={send}
              >
                <ArrowUp size={16} weight="bold" />
              </button>
            )}
          </div>
          {workspaceMode === "files" && <div className={`agent-access-mode ${allowModelFileAccess ? "is-open" : "is-private"}`}>
            <span>
              {allowModelFileAccess ? <Code size={13} /> : <ShieldCheck size={13} />}
              <b>{webMode ? (allowModelFileAccess ? "允许模型读正文" : "正文不交给模型") : allowModelFileAccess ? "允许模型读正文" : "本地内容不上网"}</b>
              <small>
                {webMode ? "材料在服务器处理；开启后，模型可读取附件正文" : allowModelFileAccess
                  ? pythonStatus?.available
                    ? "模型可读取材料、编辑 Word 并编写临时工具"
                    : pythonStatus?.detail || "正在检查临时工具环境；模型可先使用现有文件工具"
                  : materials.length === 0
                    ? "可以连续聊天，也可以从零创建文件"
                    : "模型只选成熟能力包，本地引擎处理文件"}
              </small>
            </span>
            <label>
              <input
                type="checkbox"
                checked={allowModelFileAccess}
                disabled={busy}
                aria-label="允许模型读取材料正文"
                onChange={(event) => setAllowModelFileAccess(event.target.checked)}
              />
              <i />
            </label>
          </div>}
          <small className="send-consent">
            {webMode ? (workspaceMode === "skill" ? "可以先描述需求。添加样本后，设计时会将所选样本内容发给模型，测试使用原件副本。" : allowModelFileAccess ? "会话保存在服务器；本轮允许所选模型读取附件正文。" : "会话和文件保存在服务器；任务说明、文件名与处理摘要会发送模型，附件正文不发送。") : workspaceMode === "skill"
              ? "设计模式会将你添加的样本和参考材料交给所选模型，生成的能力包先保存为本地草稿。"
              : allowModelFileAccess
              ? "发送即允许所选模型读取本会话附件；原件只读，成果生成新版本。"
              : materials.length === 0
                ? "聊天记录保存在本机；发送的消息交给模型回复，也可按你的要求创建文件。"
                : "仅发送任务说明和匿名格式统计；文件名、路径、正文及本地处理结果不发送模型。"}
          </small>
        </footer>
      </section>

      <aside className="context-column">
        <section>
          <header>
            <span>当前材料</span>
            <b>{materialGroups.length}</b>
          </header>
          {materialGroups.length === 0 ? (
            <p className="context-empty">文件、文件夹和网址会出现在这里。</p>
          ) : (
            <div className="context-list">
              {materialGroups.map((group) => (
                <div key={group.key} title={group.items.length > 1 ? group.items.slice(0, 20).map((item) => item.relativePath || item.name).join("\n") : undefined}>
                  {group.kind === "folder" ? <FolderOpen size={16} /> : iconForAttachment(group.items[0])}
                  <span>
                    <strong>{group.name}</strong>
                    <small>{group.summary}</small>
                  </span>
                  {(turnMaterialSelection || sentMaterials.sent.has(group.key)) && <button disabled={busy} aria-label={`移除材料 ${group.name}`} onClick={() => removeMaterialGroup(group)}><X size={13} /></button>}
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="artifact-section">
          <header>
            <span>成果版本</span>
            <b>{artifactGroups.length}</b>
          </header>
          {artifactGroups.length === 0 ? (
            <p className="context-empty">
              Agent 生成的新文件会按版本保存在这里。
            </p>
          ) : (
            <div className="context-list artifacts">
              {artifactGroups.map((group) => (
                <button
                  key={group.key}
                  onClick={() => {
                    const path = group.items[0]?.localSnapshotPath;
                    if (!path) return;
                    const target = group.items.length > 1
                      ? path.replace(/\/[^/]+$/, "")
                      : path;
                    revealInFinder(target);
                  }}
                >
                  {group.items.length > 1 ? <FolderOpen size={16} /> : iconForAttachment(group.items[0])}
                  <span>
                    <strong>{group.name}</strong>
                    <small>{group.summary}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
          {diagnosticArtifacts.length > 0 && (
            <details className="diagnostic-artifacts">
              <summary>运行诊断文件 · {diagnosticArtifacts.length}</summary>
              <p>日志和中间提取文件默认隐藏，不计入交付成果。</p>
            </details>
          )}
        </section>
        <div className="context-policy">
          <Wrench size={15} />
          <span>
            <strong>
              {allRuns.filter((item) => item.status === "completed").length}{" "}
              次能力调用
            </strong>
            <small>{webMode ? pythonStatus?.detail || "正在检查文件工具环境。" : "成熟能力包优先；临时代码只在系统隔离器内运行。"}</small>
          </span>
        </div>
      </aside>
    </div>
  );
}
