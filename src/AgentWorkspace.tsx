import { useEffect, useMemo, useRef, useState } from "react";
import { onFileDrop, openDialog as open } from "./lib/tauriCompat";
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
  designAgentTool,
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
  saveAgentTool,
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
} from "./types";
import MarkdownMessage from "./MarkdownMessage";
import { artifactsForMessage } from "./lib/messageArtifacts";
import shellAvatar from "./assets/zhai-shell-avatar.png";
import { isWebApiEnabled } from "./lib/webApi";

const supportedExtensions = [
  "docx",
  "xlsx",
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
  profile?: AiProfile;
  apiKey: string;
  openModels: () => void;
  designTarget?: AgentTool;
  startInDesignMode?: boolean;
  onSkillSaved?: (skill: AgentTool) => void;
};

type SkillDesignPhase = "brief" | "loading_skill" | "editing" | "testing" | "repairing" | "saving" | "ready";

export default function AgentWorkspace({ profile, apiKey, openModels, designTarget, startInDesignMode, onSkillSaved }: Props) {
  const webMode = isWebApiEnabled();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [detail, setDetail] = useState<AgentSessionDetail>();
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [liveRuns, setLiveRuns] = useState<AgentToolRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [urlInput, setUrlInput] = useState("");
  const [showUrl, setShowUrl] = useState(false);
  const [allowModelFileAccess, setAllowModelFileAccess] = useState(false);
  const [pythonStatus, setPythonStatus] = useState<PythonExecutionStatus>();
  const [turnModel, setTurnModel] = useState(profile?.defaultModel || "");
  const [showProcess, setShowProcess] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);
  const [savedSkillRuns, setSavedSkillRuns] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string>();
  const [agentPhase, setAgentPhase] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"files" | "skill">(
    startInDesignMode || designTarget ? "skill" : "files",
  );
  const [skillDraft, setSkillDraft] = useState<AgentTool | undefined>(designTarget);
  const [skillMessages, setSkillMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [skillAttachmentRoles, setSkillAttachmentRoles] = useState<Record<string, DesignAttachment["role"]>>({});
  const [skillDesignStatus, setSkillDesignStatus] = useState<string>();
  const [skillDesignElapsed, setSkillDesignElapsed] = useState(0);
  const skillDesignProgress = skillDesignStatus && busy
    ? `${skillDesignStatus} · ${skillDesignElapsed} 秒`
    : skillDesignStatus;
  const [skillDesignPhase, setSkillDesignPhase] = useState<SkillDesignPhase>("brief");
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

  useEffect(() => {
    if (!designTarget) return;
    skillDesignIdRef.current = undefined;
    setWorkspaceMode("skill");
    setSkillDesignPhase("brief");
    setSkillDraft(designTarget);
    setSkillMessages([
      {
        role: "assistant",
        content: designTarget.source === "builtin"
          ? `已载入内置能力“${designTarget.name}”作为只读基础。你描述修改后，我会另存为自建能力包，不会改变系统内置版本。`
          : `已载入自建能力包“${designTarget.name}”。你可以继续添加样本、正确成果或参考文件夹，然后直接告诉我要怎么修改。`,
      },
    ]);
  }, [designTarget?.id]);

  const refreshSessions = async (preferId?: string) => {
    const items = await listAgentSessions();
    sessionsRef.current = items;
    setSessions(items);
    const nextId = preferId || activeIdRef.current || items[0]?.id;
    activeIdRef.current = nextId;
    setActiveId(nextId);
    if (nextId) setDetail(await getAgentSession(nextId));
    else setDetail(undefined);
  };

  useEffect(() => {
    refreshSessions()
      .catch((reason) => setError(String(reason)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (typeof element.scrollTo === "function") {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }, [detail?.messages.length, liveRuns.length, streaming]);

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
          try {
            const session = await ensureSession();
            await addAgentAttachments(
              session.id,
              paths.map((path) => ({
                kind: "file" as const,
                path,
              })),
            );
            await refreshSessions(session.id);
          } catch (reason) {
            setError(String(reason));
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

  const ensureSession = async () => {
    const currentId = activeIdRef.current;
    if (currentId)
      return (
        sessionsRef.current.find((item) => item.id === currentId) ||
        (await getAgentSession(currentId)).session
      );
    if (sessionCreationRef.current) return sessionCreationRef.current;
    const currentProfile = profileRef.current;
    if (!currentProfile) throw new Error("请先连接一个模型服务");
    const creation = (async () => {
      const created = await createAgentSession({
        profileId: currentProfile.id,
        model: turnModelRef.current || currentProfile.defaultModel,
      });
      activeIdRef.current = created.id;
      sessionsRef.current = [created, ...sessionsRef.current.filter((item) => item.id !== created.id)];
      setSessions(sessionsRef.current);
      setActiveId(created.id);
      setDetail(await getAgentSession(created.id));
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
    if (busy || creatingNewRef.current) return;
    if (!profile) {
      openModels();
      return;
    }
    creatingNewRef.current = true;
    setError(undefined);
    try {
      const created = await createAgentSession({
        profileId: profile.id,
        model: turnModel || profile.defaultModel,
      });
      activeIdRef.current = created.id;
      await refreshSessions(created.id);
      setInput("");
      setStreaming("");
      setLiveRuns([]);
    } finally {
      creatingNewRef.current = false;
    }
  };

  const chooseSession = async (sessionId: string) => {
    if (busy) return;
    activeIdRef.current = sessionId;
    setActiveId(sessionId);
    setStreaming("");
    setLiveRuns([]);
    setError(undefined);
    setDetail(await getAgentSession(sessionId));
  };

  const addFiles = async () => {
    const selection = await open({
      directory: false,
      multiple: true,
      title: "添加文件到当前会话",
      filters: [{ name: "办公材料", extensions: supportedExtensions }],
    });
    const paths = Array.isArray(selection)
      ? selection
      : typeof selection === "string"
        ? [selection]
        : [];
    if (paths.length === 0) return;
    const session = await ensureSession();
    await addAgentAttachments(
      session.id,
      paths.map((path) => ({ kind: "file", path })),
    );
    await refreshSessions(session.id);
  };

  const addFolder = async () => {
    const selection = await open({
      directory: true,
      multiple: false,
      title: "添加文件夹到当前会话",
    });
    if (typeof selection !== "string") return;
    const session = await ensureSession();
    await addAgentAttachments(session.id, [
      { kind: "folder", path: selection },
    ]);
    await refreshSessions(session.id);
  };

  const addUrl = async () => {
    if (!/^https?:\/\//i.test(urlInput.trim())) {
      setError("请输入完整的 HTTP(S) 网址");
      return;
    }
    const session = await ensureSession();
    await addAgentAttachments(session.id, [
      { kind: "url", url: urlInput.trim() },
    ]);
    setUrlInput("");
    setShowUrl(false);
    setError(undefined);
    await refreshSessions(session.id);
  };

  const removeAttachment = async (item: AgentAttachment) => {
    if (!activeId || item.kind === "artifact") return;
    await removeAgentAttachment(activeId, item.id);
    await refreshSessions(activeId);
  };

  const removeMaterialGroup = async (group: MaterialGroup) => {
    if (!activeId) return;
    if (group.items.length === 1) {
      await removeAttachment(group.items[0]);
      return;
    }
    await removeAgentAttachments(activeId, group.items.map((item) => item.id));
    await refreshSessions(activeId);
  };

  const onAgentEvent = (event: AgentEvent) => {
    if (event.sessionId !== activeIdRef.current) return;
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
              attachments: [...current.attachments, event.artifact],
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

  const send = async () => {
    if (!input.trim() || busy) return;
    setNotice(undefined);
    setStopping(false);
    setAgentPhase(undefined);
    if (!profile) {
      openModels();
      return;
    }
    if (workspaceMode === "skill") {
      setBusy(true);
      setError(undefined);
      setSkillDesignElapsed(0);
      const userText = input.trim();
      setInput("");
      setSkillMessages((current) => [...current, { role: "user", content: userText }]);
      try {
        const designId = skillDesignIdRef.current || globalThis.crypto.randomUUID();
        skillDesignIdRef.current = designId;
        setSkillDesignStatus(skillDraft ? "正在载入现有能力包" : "正在创建能力包设计工作区");
        setSkillDesignPhase("loading_skill");
        const handleDesignEvent = (event: SkillDesignEvent) => {
          if (event.type === "started") {
            if (event.designId) skillDesignIdRef.current = event.designId;
            return;
          }
          if (event.type === "phase") {
            setSkillDesignPhase(event.phase);
            setSkillDesignStatus(event.message);
            if (Number.isFinite(event.elapsedSeconds)) setSkillDesignElapsed((value) => Math.max(value, event.elapsedSeconds));
            return;
          }
          if (event.type === "test_progress") {
            setSkillDesignPhase("testing");
            setSkillDesignStatus(`${event.message}（${event.current}/${event.total}）`);
            return;
          }
          if (event.type === "completed") setSkillDesignPhase("ready");
          if (event.type === "cancelled") {
            setSkillDesignPhase("brief");
            setSkillDesignStatus("能力包设计已停止");
          }
        };
        const generated = await designAgentTool({
          designId,
          sessionId: activeId,
          currentSkillId: skillDraft?.id,
          prompt: userText,
          profileId: profile.id,
          model: turnModel || profile.defaultModel,
          apiKey: apiKey || undefined,
          kind: skillDraft?.source === "builtin"
            ? "derived"
            : skillDraft?.kind === "workflow" || skillDraft?.kind === "derived"
              ? skillDraft.kind
              : "python",
          attachments: materials
            .filter((item) => item.localSnapshotPath)
            .map((item) => ({
              path: item.localSnapshotPath!,
              role: skillAttachmentRoles[item.id] || "sample_input",
            })),
        }, handleDesignEvent);
        const next: AgentTool = {
          ...generated,
          version: skillDraft?.version || generated.version || "0.1.0",
          status: "draft",
          available: false,
        };
        const saved = await saveAgentTool(next);
        setSkillDraft(saved);
        setSkillDesignPhase("ready");
        setSkillMessages((current) => [
          ...current,
          {
            role: "assistant",
            content: `已生成并保存能力包草稿“${saved.name}”。当前支持 ${saved.supportedExtensions.join("、") || "通用"}，状态为待测试。你可继续说“把异常日期列出来”之类的修改要求，或去能力包库用样本测试。`,
          },
        ]);
        onSkillSaved?.(saved);
        setSkillDesignStatus(undefined);
      } catch (reason) {
        setError(String(reason));
        setSkillDesignPhase("brief");
        setSkillDesignStatus(undefined);
      } finally {
        setBusy(false);
        setStopping(false);
      }
      return;
    }
    setBusy(true);
    setShowProcess(true);
    setError(undefined);
    setStreaming("");
    setLiveRuns([]);
    try {
      const session = await ensureSession();
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
        },
        onAgentEvent,
      );
      setDetail(result);
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
      setStopping(false);
      setAgentPhase(undefined);
    }
  };

  const saveRunAsSkill = async (run: AgentToolRun) => {
    if (savedSkillRuns.has(run.id)) return;
    try {
      const skill = await promoteAgentRunToSkill(run.id, run.toolId === "codex_harness" ? undefined : run.summary);
      setSavedSkillRuns((current) => new Set(current).add(run.id));
      setNotice(`已保存为能力包草稿“${skill.name}”，请用新样本测试后发布。`);
      onSkillSaved?.(skill);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const stop = async () => {
    setStopping(true);
    if (workspaceMode === "skill" && skillDesignIdRef.current) {
      try {
        await cancelSkillDesign(skillDesignIdRef.current);
      } catch (reason) {
        setStopping(false);
        setError(`无法停止能力设计：${String(reason)}`);
      }
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
    if (!window.confirm("删除这个会话及材料副本？已导出的成果文件默认保留。"))
      return;
    await deleteAgentSession(sessionId, false);
    const remaining = sessions.filter((item) => item.id !== sessionId);
    sessionsRef.current = remaining;
    setSessions(remaining);
    activeIdRef.current = remaining[0]?.id;
    setActiveId(activeIdRef.current);
    setDetail(
      remaining[0] ? await getAgentSession(remaining[0].id) : undefined,
    );
  };

  const renameSession = async (session: AgentSession) => {
    if (busy) return;
    const title = window.prompt("重命名会话", session.title)?.trim();
    if (!title || title === session.title) return;
    await renameAgentSession(session.id, title);
    await refreshSessions(session.id);
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
        name: first.sourceGroupName || "历史文件夹材料",
        items,
        summary: `${items.length} 个文件 · ${formatBytes(items.reduce((sum, item) => sum + (item.size || 0), 0))}${formatSummary ? ` · ${formatSummary}` : ""}`,
      };
    });
  }, [materials]);
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
  const reusableRunId = useMemo(
    () =>
      allRuns.find((run) => run.toolId === "codex_harness" && run.status === "completed" && run.detail?.includes("可保存工作流"))?.id ||
      [...allRuns]
        .reverse()
        .find(
          (run) =>
            run.toolId === "run_python" &&
            run.status === "completed" &&
            !run.detail?.includes("样本结构诊断"),
        )?.id,
    [allRuns],
  );

  return (
    <div className={`agent-workspace ${contextOpen ? "" : "context-collapsed"}`}>
      <aside className="session-column">
        <header>
          <div>
            <span>文件 Agent</span>
            <strong>工作会话</strong>
          </div>
          <button onClick={createNew} disabled={busy} aria-label="新建会话">
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
            <button disabled={busy} className={workspaceMode === "files" ? "is-active" : ""} onClick={() => setWorkspaceMode("files")}>{workspaceMode === "skill" && <ArrowLeft size={13} />}处理材料</button>
            <button disabled={busy} className={workspaceMode === "skill" ? "is-active" : ""} onClick={() => setWorkspaceMode("skill")}><Code size={14} />设计能力包</button>
          </div>
          <button className={profile && (apiKey.trim() || profile.keyStored) ? "model-ready" : ""} onClick={openModels}>
            <Cloud size={15} />
            {!profile
              ? "配置模型"
              : apiKey.trim() || profile.keyStored
                ? profile.lastTest?.success
                  ? "模型已就绪"
                  : "密钥已设置"
                : "需要 API Key"}
          </button>
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
          {workspaceMode === "skill" && (
            <section className="skill-design-progress" aria-label="能力包设计进度">
              <div>
                <span>能力包设计工作台</span>
                <strong>{skillDraft?.name || "从工作方法创建可复用能力"}</strong>
                <small>{skillDesignProgress || (skillDraft ? "继续描述要调整的规则，现有能力包会保留版本记录" : "添加样本并说明规则，草稿通过测试后才能发布")}</small>
              </div>
              <ol>
                {[
                  ["brief", "定义规则"],
                  ["editing", "生成实现"],
                  ["testing", "结构校验"],
                  ["ready", "保存草稿"],
                ].map(([phase, label], index) => {
                  const currentIndex = skillDesignPhase === "loading_skill"
                    ? 1
                    : skillDesignPhase === "repairing"
                      ? 2
                      : skillDesignPhase === "saving"
                        ? 3
                      : ["brief", "editing", "testing", "ready"].indexOf(skillDesignPhase);
                  return (
                    <li className={index < currentIndex ? "is-done" : index === currentIndex ? "is-current" : ""} key={phase}>
                      <i>{index < currentIndex ? <CheckCircle size={13} weight="fill" /> : index + 1}</i>
                      <span>{label}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
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
              <div><button onClick={addFiles}><File size={16} />添加样本</button><button onClick={addFolder}><FolderOpen size={16} />添加参考文件夹</button></div>
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
                  {run.id === reusableRunId && artifacts.length > 0 && (
                    <button className="promote-skill" disabled={savedSkillRuns.has(run.id)} onClick={() => saveRunAsSkill(run)}>
                      <FloppyDisk size={12} />{savedSkillRuns.has(run.id) ? "已保存" : "保存为能力包"}
                    </button>
                  )}
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
          {busy && !streaming && (
            <div className="thinking-line">
              <span />
              <span />
              <span />
              <small>{stopping ? "正在停止任务，等待后台退出…" : workspaceMode === "skill" ? skillDesignProgress || "正在设计能力包" : agentPhase || "正在准备本轮任务"}</small>
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
          {materialGroups.length > 0 && (
            <div className="composer-materials">
              {materialGroups.slice(-6).map((group) => (
                <span key={group.key} title={group.summary}>
                  {group.kind === "folder" ? <FolderOpen size={13} /> : iconForAttachment(group.items[0])}
                  <b>{group.name}</b>
                  {group.items.length > 1 && <i>{group.items.length}</i>}
                  <button onClick={() => removeMaterialGroup(group)}>
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
                {materials.slice(-6).map((item) => (
                  <label key={item.id} title={item.name}>
                    <b>{item.name}</b>
                    <select
                      value={skillAttachmentRoles[item.id] || "sample_input"}
                      onChange={(event) => setSkillAttachmentRoles((current) => ({
                        ...current,
                        [item.id]: event.target.value as DesignAttachment["role"],
                      }))}
                    >
                      <option value="sample_input">原始样本</option>
                      <option value="expected_output">正确成果</option>
                      <option value="template">模板</option>
                      <option value="reference">参考材料</option>
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="composer">
            <div className="attach-menu">
              <button onClick={addFiles} title="添加文件">
                <Paperclip size={17} />
              </button>
              <button onClick={addFolder} title="添加文件夹">
                <FolderOpen size={17} />
              </button>
              <button
                onClick={() => setShowUrl((value) => !value)}
                title="添加网址"
              >
                <Globe size={17} />
              </button>
            </div>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
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
            {busy ? (
              <button className="stop-send" onClick={stop} aria-label="停止任务">
                <Stop size={14} weight="fill" />
              </button>
            ) : (
              <button
                className="send-button"
                aria-label="发送消息"
                disabled={!input.trim()}
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
            {webMode ? (workspaceMode === "skill" ? "设计时会把样本交给模型，生成可测试的简单工作流草稿。" : allowModelFileAccess ? "会话保存在服务器；本轮允许所选模型读取附件正文。" : "会话和文件保存在服务器；任务说明、文件名与处理摘要会发送模型，附件正文不发送。") : workspaceMode === "skill"
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
            <small>{webMode ? "试用版运行已有文件处理能力；自定义脚本暂未开放。" : "成熟能力包优先；临时代码只在系统隔离器内运行。"}</small>
          </span>
        </div>
      </aside>
    </div>
  );
}
