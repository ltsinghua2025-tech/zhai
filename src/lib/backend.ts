import { invokeCompat as invoke, invokeWithEvents, listenCompat, randomId } from "./tauriCompat";
import builtinOutputContracts from "../../resources/builtin-output-contracts.json";
import {
  isWebApiEnabled,
  webCancelSession,
  webCancelSkillRun,
  webCreateSession,
  webDeleteSession,
  webGetSession,
  webListProfiles,
  webListSessions,
  webRemoveAttachment,
  webRenameSession,
  webRequest,
  webSaveProfile,
  webSendMessage,
  webTestConnection,
  webDownloadUrl,
  webGenerateCitizenReply,
  uploadWebSelection,
  type UploadProgress,
  webDesignSkill,
  webDeleteSkill,
  webDisableSkill,
  webGetSkill,
  webListDeletedSkills,
  webListRecentSkills,
  webListSkills,
  webPermanentlyDeleteSkill,
  webPublishSkill,
  webRestoreSkill,
  webRunSkill,
  webSaveSkill,
  webTestSkill,
} from "./webApi";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentTool,
  AiConnectionResult,
  AiProfile,
  SupportedAiProvider,
  PythonExecutionStatus,
  DesignToolRequest,
  EngineCapabilities,
  HistoryEntry,
  JobEvent,
  JobOutcome,
  ScanOptions,
  ScanResult,
  SourceInput,
  TaskPlan,
  ToolPlanRequest,
  WpsCapabilities,
  LibreOfficeCapabilities,
  CitizenReplyRequest,
  CitizenReplyResult,
  AgentAttachment,
  AgentAttachmentInput,
  AgentEvent,
  AgentSession,
  AgentSessionDetail,
  SendAgentMessageRequest,
  SkillRunResult,
  SkillRunEvent,
  OfficeFontStatus,
  CodexRuntimeStatus,
  SkillDesignEvent,
  SkillDesignState,
  SkillDesignRunResult,
  DesignAndTestRequest,
  TestAndRepairRequest,
  TaskSkillSeed,
} from "../types";

export { hasTauriRuntime as isTauri } from "./tauriCompat";
import { hasTauriRuntime } from "./tauriCompat";
const isTauri = hasTauriRuntime;

const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const mockFiles = [
  {
    id: "file-1",
    path: "/Users/demo/Documents/专项材料/工作方案.docx",
    name: "工作方案.docx",
    extension: "docx",
    category: "文档",
    size: 248_320,
    modifiedAt: new Date().toISOString(),
    relativePath: "01-方案/工作方案.docx",
    readable: true,
    processingStatus: "processable" as const,
  },
  {
    id: "file-2",
    path: "/Users/demo/Documents/专项材料/报名情况表.xlsx",
    name: "报名情况表.xlsx",
    extension: "xlsx",
    category: "表格",
    size: 91_240,
    modifiedAt: new Date().toISOString(),
    relativePath: "02-数据/报名情况表.xlsx",
    readable: true,
    processingStatus: "processable" as const,
  },
  {
    id: "file-3",
    path: "/Users/demo/Documents/专项材料/通知扫描件.pdf",
    name: "通知扫描件.pdf",
    extension: "pdf",
    category: "PDF",
    size: 1_984_120,
    modifiedAt: new Date().toISOString(),
    relativePath: "03-附件/通知扫描件.pdf",
    readable: true,
    processingStatus: "processable" as const,
  },
  {
    id: "file-4",
    path: "/Users/demo/Documents/专项材料/联系人.csv",
    name: "联系人.csv",
    extension: "csv",
    category: "表格",
    size: 12_880,
    modifiedAt: new Date().toISOString(),
    relativePath: "03-附件/联系人.csv",
    readable: true,
    processingStatus: "processable" as const,
  },
];

let mockListener: ((event: JobEvent) => void) | undefined;
let mockPlan: TaskPlan | undefined;
let mockLastScan: ScanResult | undefined;
let mockDesignedTools: AgentTool[] = [];
let mockAgentSessions: AgentSessionDetail[] = [];

export async function createAgentSession(input: {
  title?: string;
  profileId: string;
  model: string;
}, signal?: AbortSignal): Promise<AgentSession> {
  if (isTauri()) return invoke("create_agent_session", { request: input });
  if (isWebApiEnabled()) return webCreateSession(input, signal);
  const now = new Date().toISOString();
  const session: AgentSession = {
    id: randomId(),
    title: input.title?.trim() || "新会话",
    profileId: input.profileId,
    model: input.model,
    status: "idle",
    createdAt: now,
    updatedAt: now,
    workspacePath: "/Users/demo/Documents/材料工作台/会话/示例会话",
  };
  mockAgentSessions.unshift({ session, messages: [], attachments: [], toolRuns: [] });
  return session;
}

export async function listAgentSessions(signal?: AbortSignal): Promise<AgentSession[]> {
  if (isTauri()) return invoke("list_agent_sessions");
  if (isWebApiEnabled()) return webListSessions(signal);
  return mockAgentSessions.map((item) => item.session);
}

export async function detectCodexRuntime(): Promise<CodexRuntimeStatus> {
  if (isTauri()) return invoke("detect_codex_runtime");
  if (isWebApiEnabled()) return { available: false, detail: "网页端不运行本机 Codex Harness；文件处理由服务器引擎完成" };
  return { available: false, detail: "浏览器预览不运行 Codex Harness" };
}

export async function getAgentSession(sessionId: string, signal?: AbortSignal): Promise<AgentSessionDetail> {
  if (isTauri()) return invoke("get_agent_session", { sessionId });
  if (isWebApiEnabled()) return webGetSession(sessionId, signal);
  const found = mockAgentSessions.find((item) => item.session.id === sessionId);
  if (!found) throw new Error("会话不存在");
  return structuredClone(found);
}

export async function renameAgentSession(sessionId: string, title: string): Promise<AgentSession> {
  if (isTauri()) return invoke("rename_agent_session", { sessionId, title });
  if (isWebApiEnabled()) return webRenameSession(sessionId, title);
  const found = mockAgentSessions.find((item) => item.session.id === sessionId);
  if (!found) throw new Error("会话不存在");
  found.session = { ...found.session, title, updatedAt: new Date().toISOString() };
  return found.session;
}

export async function deleteAgentSession(sessionId: string, deleteArtifacts = false): Promise<void> {
  if (isTauri()) return invoke("delete_agent_session", { sessionId, deleteArtifacts });
  if (isWebApiEnabled()) return webDeleteSession(sessionId, deleteArtifacts);
  mockAgentSessions = mockAgentSessions.filter((item) => item.session.id !== sessionId);
}

export async function removeAgentAttachments(sessionId: string, attachmentIds: string[]): Promise<void> {
  if (attachmentIds.length === 0) return;
  if (isTauri()) return invoke("remove_agent_attachments", { sessionId, attachmentIds });
  if (isWebApiEnabled()) {
    await Promise.all(attachmentIds.map((attachmentId) => webRemoveAttachment(sessionId, attachmentId)));
    return;
  }
  const found = mockAgentSessions.find((item) => item.session.id === sessionId);
  if (!found) throw new Error("会话不存在");
  found.attachments = found.attachments.filter((item) => !attachmentIds.includes(item.id));
}

export async function addAgentAttachments(
  sessionId: string,
  items: AgentAttachmentInput[],
  deduplicateSamples = false,
  progress?: UploadProgress,
): Promise<AgentAttachment[]> {
  if (isTauri()) return invoke("add_agent_attachments", { request: { sessionId, items, deduplicateSamples } });
  if (isWebApiEnabled()) {
    const uploaded = await Promise.all(items.map((item) => uploadWebSelection(sessionId, item, progress)));
    return uploaded.flat();
  }
  const found = mockAgentSessions.find((item) => item.session.id === sessionId);
  if (!found) throw new Error("会话不存在");
  const existingPaths = new Set(found.attachments.map(item => item.localSnapshotPath));
  const attachments = items.filter(item => {
    if (!deduplicateSamples || item.kind === "url") return true;
    if (existingPaths.has(item.path)) return false;
    existingPaths.add(item.path);
    return true;
  }).map((item): AgentAttachment => {
    const value = item.kind === "url" ? item.url : item.path;
    return {
      id: randomId(),
      sessionId,
      kind: item.kind,
      name: value.split(/[\\/]/).pop() || value,
      localSnapshotPath: item.kind === "url" ? undefined : value,
      sourceUrl: item.kind === "url" ? value : undefined,
      size: 128_640,
      createdAt: new Date().toISOString(),
    };
  });
  found.attachments.push(...attachments);
  return attachments;
}

export async function removeAgentAttachment(sessionId: string, attachmentId: string): Promise<void> {
  if (isTauri()) return invoke("remove_agent_attachment", { sessionId, attachmentId });
  if (isWebApiEnabled()) return webRemoveAttachment(sessionId, attachmentId);
  const found = mockAgentSessions.find((item) => item.session.id === sessionId);
  if (found) found.attachments = found.attachments.filter((item) => item.id !== attachmentId);
}

export async function sendAgentMessage(
  input: SendAgentMessageRequest,
  onEvent: (event: AgentEvent) => void,
): Promise<AgentSessionDetail> {
  if (isTauri()) {
    return invokeWithEvents("send_agent_message", { request: input }, onEvent);
  }
  if (isWebApiEnabled()) return webSendMessage(input, onEvent);
  const found = mockAgentSessions.find((item) => item.session.id === input.sessionId);
  if (!found) throw new Error("会话不存在");
  const turnId = randomId();
  const now = new Date().toISOString();
  found.messages.push({ id: randomId(), sessionId: input.sessionId, role: "user", content: input.content, createdAt: now, turnId, attachmentIds: input.attachmentIds });
  found.session.status = "running";
  const runId = randomId();
  onEvent({ type: "tool_started", sessionId: input.sessionId, turnId, runId, toolId: "inspect_document", summary: "读取并分析附件" });
  await wait(400);
  onEvent({ type: "tool_progress", sessionId: input.sessionId, turnId, runId, progress: 100, detail: "已读取材料结构" });
  const content = found.attachments.length
    ? "我已读取当前材料，并完成这一轮处理。成果会作为下一轮对话的默认材料；你可以继续说明要修改的地方。"
    : "可以直接聊天或讨论思路。需要处理材料时添加文件，也可以描述想创建的文档。";
  for (const text of content.match(/.{1,18}/gu) ?? [content]) {
    onEvent({ type: "assistant_delta", sessionId: input.sessionId, turnId, text });
    await wait(35);
  }
  const messageId = randomId();
  found.messages.push({ id: messageId, sessionId: input.sessionId, role: "assistant", content, createdAt: new Date().toISOString(), turnId });
  found.session.status = "idle";
  found.session.updatedAt = new Date().toISOString();
  onEvent({ type: "turn_completed", sessionId: input.sessionId, turnId, messageId });
  return structuredClone(found);
}

export async function cancelAgentTurn(sessionId: string, turnId?: string): Promise<void> {
  if (isTauri()) return invoke("cancel_agent_turn", { sessionId, turnId });
  if (isWebApiEnabled()) return webCancelSession(sessionId);
  const found = mockAgentSessions.find((item) => item.session.id === sessionId);
  if (found) found.session.status = "idle";
}

export async function scanSource(source: SourceInput, options: ScanOptions): Promise<ScanResult> {
  if (isTauri()) {
    return invoke("scan_source", { source, options });
  }
  await wait(900);
  const allowed = new Set(options.extensions.map((extension) => extension.toLowerCase()));
  const fileFromPath = (path: string, index = 0) => {
    const name = path.split("/").pop() || `材料-${index + 1}`;
    const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const template = mockFiles.find((file) => file.extension === extension) ?? mockFiles[0];
    return {
      ...template,
      id: `selected-${index}-${extension || "file"}`,
      path,
      name,
      extension,
      category:
        extension === "pdf"
          ? "PDF"
          : ["docx", "doc", "wps", "md", "txt"].includes(extension)
            ? "文档"
            : "表格",
      relativePath: name,
      processingStatus:
        extension === "xls" || extension === "wps"
          ? ("legacy_skipped" as const)
          : ("processable" as const),
    };
  };
  const discovered =
    source.kind === "file"
      ? [fileFromPath(source.path)]
      : source.kind === "files"
        ? source.paths.map(fileFromPath)
        : mockFiles;
  const files = discovered.filter((file) => allowed.has(file.extension));
  const excludedByFormat = discovered
    .filter((file) => !allowed.has(file.extension))
    .reduce<Record<string, number>>((counts, file) => {
      counts[file.extension] = (counts[file.extension] ?? 0) + 1;
      return counts;
    }, {});
  const byFormat = files.reduce<Record<string, number>>((counts, file) => {
    counts[file.extension] = (counts[file.extension] ?? 0) + 1;
    return counts;
  }, {});
  const sourceLabel =
    source.kind === "files"
      ? `已选择 ${source.paths.length} 个文件`
      : source.path;
  const result = {
    manifestId: randomId(),
    sourceLabel,
    files,
    summary: {
      totalFiles: files.length,
      discoveredFiles: discovered.length,
      totalSize: files.reduce((sum, item) => sum + item.size, 0),
      subdirectories: source.kind === "folder" || source.kind === "path" ? 3 : 0,
      unreadableFiles: 0,
      legacyFiles: files.filter((file) => file.processingStatus === "legacy_skipped").length,
      processableFiles: files.filter((file) => file.processingStatus === "processable").length,
      excludedItems: Object.values(excludedByFormat).reduce((sum, count) => sum + count, 0),
      excludedByFormat,
      byFormat,
    },
    warnings: [],
  };
  mockLastScan = result;
  return result;
}

export async function createPlan(input: {
  manifestId: string;
  taskName: string;
  description: string;
  templateId?: string;
  useAi: boolean;
  useOcr: boolean;
}): Promise<TaskPlan> {
  if (isTauri()) return invoke("create_plan", { request: input });
  await wait(700);
  mockPlan = {
    id: randomId(),
    manifestId: input.manifestId,
    taskName: input.taskName || "材料规范与一致性检查",
    description: input.description,
    operations: [
      {
        id: "review-1",
        kind: "normalize_docx_styles",
        title: "规范文档样式",
        description: "统一标题层级、正文段落和常见格式偏差",
        fileCount: 1,
        parameters: {},
        requiresReview: true,
        available: true,
      },
      {
        id: "review-2",
        kind: "cross_file_consistency_check",
        title: "跨文件一致性检查",
        description: "核对机构名称、日期与关键字段，生成差异报告",
        fileCount: 4,
        parameters: {},
        requiresReview: true,
        available: true,
      },
      {
        id: "review-3",
        kind: "redact_content",
        title: "生成脱敏副本",
        description: "离线识别中国证件、电话、邮箱、银行卡、信用代码及上下文字段，原件保持不变",
        fileCount: 4,
        parameters: {},
        requiresReview: true,
        available: true,
      },
    ],
    affectedFiles: 4,
    estimatedOutputs: 4,
    outputDirectory: `/Users/demo/Documents/材料工作台/任务/20260802-103000-${input.taskName || "材料规范与一致性检查"}`,
    cloudPayload: undefined,
    aiReviewItems: [],
    aiGenerated: !input.useAi,
    warnings: input.useAi ? ["云端 AI 只会在您确认完整脱敏片段后调用"] : [],
    requiresWps: false,
    requiresOcr: input.useOcr,
    requiresAi: input.useAi,
  };
  return mockPlan;
}

export async function startJob(input: {
  planId: string;
  acceptedReviewIds: string[];
  cloudPayloadConfirmed: boolean;
}): Promise<JobOutcome> {
  if (isTauri()) return invoke("start_job", { request: input });
  const jobId = randomId();
  mockListener?.({ type: "started", jobId });
  for (let index = 0; index < mockFiles.length; index += 1) {
    await wait(350);
    mockListener?.({
      type: "file_progress",
      fileId: mockFiles[index].id,
      progress: 100,
      message: "处理并校验完成",
    });
    mockListener?.({
      type: "file_progress",
      fileId: "__batch__",
      progress: Math.round(((index + 1) / mockFiles.length) * 100),
      message: `已完成 ${index + 1}/${mockFiles.length}`,
    });
  }
  const reportPath = "/Users/demo/Documents/材料工作台/任务/示例任务/report/处理报告.html";
  mockListener?.({ type: "completed", reportPath });
  return {
    jobId,
    status: "completed",
    outputDirectory: "/Users/demo/Documents/材料工作台/任务/示例任务",
    reportPath,
    completedFiles: 4,
    failedFiles: 0,
    failures: [],
    skippedFiles: 0,
    skips: [],
    outputs: mockFiles.map((file) => ({ fileId: file.id, path: `/Users/demo/Documents/材料工作台/任务/示例任务/output/${file.name}` })),
  };
}

export async function cancelJob(jobId: string) {
  if (isTauri()) return invoke("cancel_job", { jobId });
  mockListener?.({ type: "cancelled", jobId });
}

export async function listenToJobEvents(
  callback: (event: JobEvent) => void,
): Promise<UnlistenFn> {
  if (isTauri()) {
    return listenCompat<JobEvent>("job-event", callback);
  }
  mockListener = callback;
  return () => {
    mockListener = undefined;
  };
}

export async function listHistory(): Promise<HistoryEntry[]> {
  if (isTauri()) return invoke("list_history");
  return [
    {
      id: "history-1",
      taskName: "季度材料格式规范",
      status: "completed",
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      completedAt: new Date(Date.now() - 86_100_000).toISOString(),
      totalFiles: 28,
      failedFiles: 0,
      outputDirectory: "/Users/demo/Documents/材料工作台/任务/季度材料格式规范",
    },
    {
      id: "history-2",
      taskName: "报名表字段核对",
      status: "partial",
      createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      completedAt: new Date(Date.now() - 3 * 86_400_000 + 240_000).toISOString(),
      totalFiles: 16,
      failedFiles: 2,
      outputDirectory: "/Users/demo/Documents/材料工作台/任务/报名表字段核对",
    },
  ];
}

export async function cleanupHistory(days = 30): Promise<number> {
  if (isTauri()) return invoke("cleanup_history", { days });
  return 2;
}

export async function detectWps(): Promise<WpsCapabilities> {
  if (isTauri()) return invoke("detect_wps_capabilities");
  const pending = {
    available: false,
    status: "unverified",
    detail: "已检测到 WPS，等待官方接口隔离样本验证",
  };
  return {
    installed: true,
    applicationPath: "/Applications/wpsoffice.app",
    bundleId: "com.kingsoft.wpsoffice.mac",
    version: "12.1.26026",
    docToDocx: pending,
    xlsToXlsx: pending,
    xlsxRecalculate: pending,
    docxToPdf: pending,
    xlsxToPdf: pending,
  };
}

export async function detectLibreOffice(): Promise<LibreOfficeCapabilities> {
  if (isTauri()) return invoke("detect_libreoffice_capabilities");
  const ready = {
    available: true,
    status: "ready",
    detail: "LibreOffice 已检测；转换结果仍会执行中文、页数和格式校验",
  };
  return {
    installed: true,
    executablePath: "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    version: "LibreOffice 26.2.5.2",
    bundled: false,
    docToDocx: ready,
    xlsToXlsx: ready,
    xlsxRecalculate: ready,
    docxToPdf: ready,
    xlsxToPdf: ready,
  };
}

export async function detectEngine(): Promise<EngineCapabilities> {
  if (isTauri()) return invoke("detect_engine_capabilities");
  if (isWebApiEnabled()) return webRequest<EngineCapabilities>("/capabilities");
  return {
    pythonSidecar: { available: true, status: "ready", detail: "材料处理 sidecar 可用" },
    visionOcr: {
      available: false,
      status: "unverified",
      detail: "Vision OCR 组件等待本机构建",
    },
    paddleOcr: {
      available: false,
      status: "optional_not_installed",
      detail: "离线 OCR 组件等待本机探测",
    },
  };
}

export async function hasApiKey(provider: string): Promise<boolean> {
  if (isTauri()) return invoke("has_api_key", { provider });
  return false;
}

export async function saveApiKey(provider: string, apiKey: string): Promise<void> {
  if (isTauri()) return invoke("save_api_key", { provider, apiKey });
}

export async function deleteApiKey(provider: string): Promise<void> {
  if (isTauri()) return invoke("delete_api_key", { provider });
}

export async function revealInFinder(path: string): Promise<void> {
  if (isTauri()) return invoke("reveal_in_finder", { path });
  if (isWebApiEnabled()) {
    window.open(webDownloadUrl(path), "_blank", "noopener,noreferrer");
  }
}

export async function openAgentArtifact(sessionId: string, artifact: AgentAttachment): Promise<void> {
  if (artifact.kind !== "artifact" || !artifact.localSnapshotPath) throw new Error("这不是可打开的成果文件");
  if (isTauri()) return invoke("open_agent_artifact", { sessionId, artifactId: artifact.id });
  if (isWebApiEnabled()) {
    window.open(webDownloadUrl(artifact.localSnapshotPath), "_blank", "noopener,noreferrer");
  }
}

export async function listAiProfiles(): Promise<AiProfile[]> {
  if (isTauri()) return invoke("list_ai_profiles");
  if (isWebApiEnabled()) return webListProfiles();
  return [{
    id: "deepseek",
    provider: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    keyStored: true,
    lastTest: {
      success: true,
      returnedModel: "deepseek-v4-flash",
      latencyMs: 684,
      testedAt: new Date().toISOString(),
      message: "连接成功；未发送任何材料内容",
    },
  }];
}

export async function getPythonExecutionStatus(): Promise<PythonExecutionStatus> {
  if (isTauri()) return invoke("get_python_execution_status");
  return {
    available: false,
    detail: isWebApiEnabled()
      ? "当前网页端支持现有文件工具，尚未提供隔离临时脚本执行。"
      : "浏览器预览不执行临时脚本。",
  };
}

export async function listOfficeFonts(): Promise<OfficeFontStatus[]> {
  if (isTauri()) return invoke("list_office_fonts");
  return [
    { id: "fangsong-gb2312", name: "仿宋_GB2312", installed: true, licenseNote: "需由使用单位持有合法授权" },
    { id: "simsun", name: "宋体", installed: false, licenseNote: "需由使用单位持有合法授权" },
    { id: "fzxiaobiaosong", name: "方正小标宋简体", installed: true, licenseNote: "方正商业字体，需持有合法授权" },
    { id: "kaiti-gb2312", name: "楷体_GB2312", installed: true, licenseNote: "需由使用单位持有合法授权" },
  ];
}

export async function installOfficeFonts(paths: string[]): Promise<OfficeFontStatus[]> {
  if (isTauri()) return invoke("install_office_fonts", { paths });
  return listOfficeFonts();
}

export async function saveAiProfile(input: {
  id: string;
  provider: SupportedAiProvider;
  displayName: string;
  baseUrl: string;
  defaultModel: string;
  apiKey?: string;
}): Promise<AiProfile> {
  if (isTauri()) return invoke("save_ai_profile", { request: input });
  if (isWebApiEnabled()) return webSaveProfile(input);
  return {
    ...input,
    keyStored: Boolean(input.apiKey),
  };
}

export async function testAiConnection(
  profileId: string,
  model?: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<AiConnectionResult> {
  if (isTauri()) return invoke("test_ai_connection", { profileId, model, apiKey });
  if (isWebApiEnabled()) return webTestConnection({ profileId, model, baseUrl, apiKey });
  await wait(650);
  return {
    success: true,
    returnedModel: model || "deepseek-v4-flash",
    latencyMs: 684,
    testedAt: new Date().toISOString(),
    message: "连接成功；未发送任何材料内容",
  };
}

export async function prepareAiPayload(
  planId: string,
  selectedFileIds: string[],
): Promise<TaskPlan> {
  if (isTauri()) {
    return invoke("prepare_ai_payload", {
      request: { planId, selectedFileIds },
    });
  }
  if (!mockPlan || mockPlan.id !== planId) throw new Error("处理计划已失效");
  const redactedText = `任务说明：${mockPlan.description}
{"fileId":"file-1","source":"01-方案/工作方案.docx","locator":{"kind":"docx_paragraph","index":2}}
本方案实施日期为2026年8月15日，联系人：[手机号已脱敏]。

{"fileId":"file-2","source":"02-数据/报名情况表.xlsx","locator":{"kind":"xlsx_cell","sheet":"报名","cell":"D6"}}
实施日期：2026年8月16日`;
  mockPlan = {
    ...mockPlan,
    cloudPayload: {
      id: "mock-ai-payload",
      manifestId: mockPlan.manifestId,
      selectedFileIds,
      chunks: [{
        id: "mock-chunk",
        sourceFileIds: selectedFileIds,
        redactedText,
        characterCount: redactedText.length,
      }],
      characterCount: redactedText.length,
      payloadHash: "mock-payload-hash",
    },
    aiGenerated: false,
    aiReviewItems: [],
  };
  await wait(450);
  return mockPlan;
}

export async function generateAiPlan(input: {
  planId: string;
  profileId: string;
  model: string;
  confirmedPayloadHash: string;
}): Promise<TaskPlan> {
  if (isTauri()) return invoke("generate_ai_plan", { request: input });
  if (!mockPlan || mockPlan.id !== input.planId) throw new Error("处理计划已失效");
  await wait(900);
  mockPlan = {
    ...mockPlan,
    aiGenerated: true,
    aiProfileId: input.profileId,
    aiModel: input.model,
    aiReviewItems: [{
      id: "ai-review-1",
      fileId: "file-2",
      locator: { kind: "xlsx_cell", sheet: "报名", cell: "D6" },
      before: "2026年8月16日",
      after: "2026年8月15日",
      reason: "与工作方案中的统一实施日期保持一致",
      confidence: 0.93,
    }],
    operations: [
      ...mockPlan.operations,
      {
        id: "ai-operation",
        kind: "review_content",
        title: "DeepSeek 材料审校",
        description: "发现 1 处跨文件日期不一致，已生成可审阅建议。",
        fileCount: selectedFileIdsOrDefault(mockPlan),
        parameters: { source: "ai", model: input.model },
        requiresReview: false,
        available: true,
      },
    ],
  };
  return mockPlan;
}

function selectedFileIdsOrDefault(plan: TaskPlan) {
  return plan.cloudPayload?.selectedFileIds.length ?? plan.affectedFiles;
}

const mockBuiltinTools: AgentTool[] = [
  {
    id: "citizen_reply",
    name: "12345 市民回复",
    description: "根据已核实工单材料起草、审核热线回复或满意度申诉文本。",
    source: "builtin",
    permissions: ["read_selected_files", "write_task_output", "network"],
    supportedExtensions: ["docx", "pdf", "md", "txt"],
    available: true,
    availabilityDetail: "需要当前模型服务；也可以在 12345 独立页面使用",
    parameters: [],
    steps: [{ toolId: "citizen_reply", parameters: {} }],
  },
  {
    id: "apply_redhead",
    name: "公文套红与版记",
    description: "上传 Word 红头模板或填写单位名称，按公文标准套红并生成末页版记，支持文件夹批处理。",
    source: "builtin",
    supportedExtensions: ["doc", "docx"],
    available: true,
    availabilityDetail: "离线套红；模板与正文一起添加",
    parameters: [
      {key: "templateName", label: "红头模板文件名（可选）", type: "text", required: false},
      {key: "unitName", label: "红头单位名称", type: "text", required: false, placeholder: "未填写使用中共珠海市xxx"},
      {key: "documentNumber", label: "发文字号（可选）", type: "text", required: false},
      {key: "imprintUnit", label: "版记印发机关（可含办公室）", type: "text", required: false},
      {key: "officeName", label: "版记办公室后缀（可选）", type: "text", required: false},
      {key: "printDate", label: "印发日期", type: "text", required: false, placeholder: "未填用202x年x月x日印发"},
    ],
    steps: [{toolId: "apply_redhead", parameters: {}}],
  },
  {
    id: "docx_to_gongwen",
    name: "现有 Word 一键公文排版",
    description: "离线识别可选主送、正文、附件和落款；不确定结构保留并提示，原件不覆盖。",
    source: "builtin",
    supportedExtensions: ["doc", "docx"],
    available: true,
    availabilityDetail: "内置 DOCX 引擎可用；缺少字体只报告",
    parameters: [
      { key: "preserveBold", label: "保留原有加粗", type: "boolean", required: false, defaultValue: true },
      { key: "formatTables", label: "规范表格字体（保留字号与布局）", type: "boolean", required: false, defaultValue: false },
      { key: "recipientMode", label: "主送机关识别", type: "choice", required: false, defaultValue: "auto", choices: ["auto", "none"] },
      { key: "signatureMode", label: "落款排版模式", type: "choice", required: false, defaultValue: "preserve", choices: ["preserve", "unsigned"] },
      { key: "applyPageNumbers", label: "生成奇偶页码", type: "boolean", required: false, defaultValue: true },
      { key: "addTitleBlankLine", label: "标题后增加一行空白", type: "boolean", required: false, defaultValue: true },
      { key: "lineSpacingPt", label: "固定行距（磅）", type: "number", required: false, defaultValue: 28 },
      { key: "titleFont", label: "标题字体", type: "text", required: false, defaultValue: "方正小标宋简体" },
      { key: "bodyFont", label: "正文字体", type: "text", required: false, defaultValue: "仿宋_GB2312" },
      { key: "firstHeadingFont", label: "一级标题字体", type: "text", required: false, defaultValue: "黑体" },
      { key: "secondHeadingFont", label: "二级标题字体", type: "text", required: false, defaultValue: "楷体_GB2312" },
    ],
    steps: [{ toolId: "docx_to_gongwen", parameters: {} }],
  },
  {
    id: "word_to_pdf",
    name: "Word 转 PDF",
    description: "优先通过 WPS 官方桥接导出；不可用时明确回退 LibreOffice。",
    source: "builtin",
    supportedExtensions: ["docx"],
    available: false,
    availabilityDetail: "WPS 已安装，但 DOCX→PDF 官方桥接尚未通过验证",
    parameters: [{ key: "adapterPreference", label: "转换器", type: "choice", required: true, defaultValue: "auto", choices: ["auto", "wps", "libreoffice"] }],
    steps: [{ toolId: "word_to_pdf", parameters: {} }],
  },
  {
    id: "excel_to_pdf",
    name: "Excel 转 PDF",
    description: "优先通过 WPS 官方桥接重算并导出；不可用时明确回退 LibreOffice。",
    source: "builtin",
    supportedExtensions: ["xlsx"],
    available: false,
    availabilityDetail: "WPS 已安装，但 XLSX→PDF 官方桥接尚未通过验证",
    parameters: [{ key: "adapterPreference", label: "转换器", type: "choice", required: true, defaultValue: "auto", choices: ["auto", "wps", "libreoffice"] }],
    steps: [{ toolId: "excel_to_pdf", parameters: {} }],
  },
  {
    id: "doc_to_docx",
    name: "DOC 转 DOCX",
    description: "优先通过 WPS 官方桥接转换旧版 DOC；不可用时明确回退 LibreOffice。",
    source: "builtin",
    supportedExtensions: ["doc"],
    available: false,
    availabilityDetail: "WPS 官方桥接尚未通过验证",
    parameters: [{ key: "adapterPreference", label: "转换器", type: "choice", required: true, defaultValue: "auto", choices: ["auto", "wps", "libreoffice"] }],
    steps: [{ toolId: "doc_to_docx", parameters: {} }],
  },
  {
    id: "xls_to_xlsx",
    name: "XLS 转 XLSX",
    description: "优先通过 WPS 官方桥接转换旧版 XLS；不可用时明确回退 LibreOffice。",
    source: "builtin",
    supportedExtensions: ["xls"],
    available: false,
    availabilityDetail: "WPS 官方桥接尚未通过验证",
    parameters: [{ key: "adapterPreference", label: "转换器", type: "choice", required: true, defaultValue: "auto", choices: ["auto", "wps", "libreoffice"] }],
    steps: [{ toolId: "xls_to_xlsx", parameters: {} }],
  },
  {
    id: "normalize_whitespace",
    name: "清理空格与空行",
    description: "合并重复空格，清理空白段落；保留英文单词间空格。",
    source: "builtin",
    supportedExtensions: ["docx", "xlsx"],
    available: true,
    availabilityDetail: "内置引擎可用",
    parameters: [
      { key: "collapseSpaces", label: "合并重复空格", type: "boolean", required: false, defaultValue: true },
      { key: "removeEmptyParagraphs", label: "删除空白段落", type: "boolean", required: false, defaultValue: true },
    ],
    steps: [{ toolId: "normalize_whitespace", parameters: {} }],
  },
  {
    id: "remove_line_breaks",
    name: "删除换行符",
    description: "删除段落或单元格内的手动换行。",
    source: "builtin",
    supportedExtensions: ["docx", "xlsx"],
    available: true,
    availabilityDetail: "内置处理引擎可用",
    parameters: [{ key: "joinParagraphs", label: "合并相邻段落", type: "boolean", required: false, defaultValue: false }],
    steps: [{ toolId: "remove_line_breaks", parameters: {} }],
  },
  {
    id: "replace_text",
    name: "精确替换文字",
    description: "在 DOCX 和 XLSX 中执行可审阅的精确替换。",
    source: "builtin",
    supportedExtensions: ["docx", "xlsx"],
    available: true,
    availabilityDetail: "内置引擎可用",
    parameters: [
      { key: "before", label: "原文字", type: "text", required: true, placeholder: "需要替换的内容" },
      { key: "after", label: "替换为", type: "text", required: true, placeholder: "新的内容" },
    ],
    steps: [{ toolId: "replace_text", parameters: {} }],
  },
  {
    id: "update_dates",
    name: "统一日期",
    description: "将明确指定的旧日期替换为新日期。",
    source: "builtin",
    supportedExtensions: ["docx", "xlsx"],
    available: true,
    availabilityDetail: "内置处理引擎可用",
    parameters: [
      { key: "before", label: "原日期", type: "text", required: true, placeholder: "2026年8月8日" },
      { key: "after", label: "新日期", type: "text", required: true, placeholder: "2026年8月15日" },
    ],
    steps: [{ toolId: "update_dates", parameters: {} }],
  },
  {
    id: "normalize_docx_styles",
    name: "规范 Word 样式",
    description: "统一标题和正文的基础样式。",
    source: "builtin",
    supportedExtensions: ["docx"],
    available: true,
    availabilityDetail: "内置处理引擎可用",
    parameters: [],
    steps: [{ toolId: "normalize_docx_styles", parameters: {} }],
  },
  {
    id: "clean_metadata",
    name: "清理文件元数据",
    description: "移除作者、公司、主题和关键词。",
    source: "builtin",
    supportedExtensions: ["docx", "xlsx", "pdf"],
    available: true,
    availabilityDetail: "内置离线引擎可用",
    parameters: [],
    steps: [{ toolId: "clean_metadata", parameters: {} }],
  },
  {
    id: "set_xlsx_cell",
    name: "修改 Excel 单元格",
    description: "在指定工作表和单元格写入值。",
    source: "builtin",
    supportedExtensions: ["xlsx"],
    available: true,
    availabilityDetail: "内置离线引擎可用",
    parameters: [
      { key: "sheet", label: "工作表", type: "text", required: true, placeholder: "Sheet1" },
      { key: "cell", label: "单元格", type: "text", required: true, placeholder: "B6" },
      { key: "value", label: "新值", type: "text", required: true, placeholder: "要写入的内容" },
    ],
    steps: [{ toolId: "set_xlsx_cell", parameters: {} }],
  },
  {
    id: "delete_blank_rows",
    name: "删除 Excel 空白行",
    description: "删除整行均为空的行。",
    source: "builtin",
    supportedExtensions: ["xlsx"],
    available: true,
    availabilityDetail: "内置离线引擎可用",
    parameters: [],
    steps: [{ toolId: "delete_blank_rows", parameters: {} }],
  },
  {
    id: "merge_xlsx",
    name: "合并 Excel 数据",
    description: "把各单位报送的多个 Excel 明细表按表头对齐，逐行汇总到一个新的 XLSX。",
    source: "builtin",
    supportedExtensions: ["xlsx"],
    available: true,
    availabilityDetail: "内置离线引擎可用",
    parameters: [
      { key: "sheet", label: "工作表（可留空）", type: "text", required: false },
      { key: "headerRow", label: "表头所在行", type: "number", required: false, defaultValue: 1 },
      { key: "includeSource", label: "增加来源文件列", type: "boolean", required: false, defaultValue: true },
    ],
    steps: [{ toolId: "merge_xlsx", parameters: {} }],
  },
  {
    id: "xlsx_recalculate",
    name: "Excel 重算保存",
    description: "调用 WPS 重新计算公式并保存。",
    source: "builtin",
    supportedExtensions: ["xlsx"],
    available: false,
    availabilityDetail: "WPS 官方桥接尚未通过验证",
    parameters: [],
    steps: [{ toolId: "xlsx_recalculate", parameters: {} }],
  },
  {
    id: "merge_pdf",
    name: "合并 PDF",
    description: "按文件名顺序合并多个 PDF。",
    source: "builtin",
    supportedExtensions: ["pdf"],
    available: true,
    availabilityDetail: "内置 PDF 引擎可用",
    parameters: [],
    steps: [{ toolId: "merge_pdf", parameters: {} }],
  },
  {
    id: "split_pdf",
    name: "提取 PDF 页码",
    description: "按页码范围生成新的 PDF。",
    source: "builtin",
    supportedExtensions: ["pdf"],
    available: true,
    availabilityDetail: "内置 PDF 引擎可用",
    parameters: [{ key: "pages", label: "页码范围", type: "text", required: true, placeholder: "1-3,5" }],
    steps: [{ toolId: "split_pdf", parameters: {} }],
  },
  {
    id: "rotate_pdf",
    name: "旋转 PDF 页面",
    description: "旋转全部 PDF 页面。",
    source: "builtin",
    supportedExtensions: ["pdf"],
    available: true,
    availabilityDetail: "内置 PDF 引擎可用",
    parameters: [{ key: "degrees", label: "旋转角度", type: "choice", required: true, defaultValue: "90", choices: ["90", "180", "270"] }],
    steps: [{ toolId: "rotate_pdf", parameters: {} }],
  },
  {
    id: "watermark_pdf",
    name: "添加 PDF 水印",
    description: "在每页中央叠加文字水印。",
    source: "builtin",
    supportedExtensions: ["pdf"],
    available: true,
    availabilityDetail: "内置 PDF 引擎可用",
    parameters: [{ key: "text", label: "水印文字", type: "text", required: true, placeholder: "内部材料" }],
    steps: [{ toolId: "watermark_pdf", parameters: {} }],
  },
  {
    id: "extract_pdf_text",
    name: "提取 PDF 文本",
    description: "按页导出文本层为 TXT。",
    source: "builtin",
    supportedExtensions: ["pdf"],
    available: true,
    availabilityDetail: "内置 PDF 引擎可用",
    parameters: [],
    steps: [{ toolId: "extract_pdf_text", parameters: {} }],
  },
  {
    id: "ocr_pdf",
    name: "OCR 识别 PDF",
    description: "按页导出已有文字，无文字页使用离线 OCR（Mac 内置 Vision／麒麟可选扫描识字组件），交付一份 TXT；结果须复核。",
    source: "builtin",
    supportedExtensions: ["pdf"],
    available: true,
    availabilityDetail: "本机离线 OCR 可用（演示状态）",
    parameters: [],
    steps: [{ toolId: "ocr_pdf", parameters: {} }],
  },
  {
    id: "redact_content",
    name: "敏感信息脱敏",
    description: "识别中国证件、电话、邮箱、银行卡、信用代码及带上下文的姓名、单位和地址，生成脱敏副本。",
    source: "builtin",
    supportedExtensions: ["docx", "xlsx"],
    available: true,
    availabilityDetail: "内置规则引擎可用",
    parameters: [],
    steps: [{ toolId: "redact_content", parameters: {} }],
  },
];

export async function listAgentTools(): Promise<AgentTool[]> {
  if (isTauri()) return invoke("list_agent_tools");
  if (isWebApiEnabled()) return webListSkills();
  return [...mockBuiltinTools.map((tool) => ({
    ...tool,
    outputExtensions: (builtinOutputContracts as Record<string, string[]>)[tool.id] ?? [],
  })), ...mockDesignedTools];
}

export async function listRecentSkills(): Promise<string[]> {
  if (isTauri()) return invoke("list_recent_skills");
  if (isWebApiEnabled()) return webListRecentSkills();
  return [];
}

export async function createToolPlan(input: ToolPlanRequest): Promise<TaskPlan> {
  if (isTauri()) return invoke("create_tool_plan", { request: input });
  if (!mockLastScan || mockLastScan.manifestId !== input.manifestId) {
    throw new Error("扫描结果已失效，请重新选择材料");
  }
  await wait(input.mode === "manual" ? 300 : 850);
  const instruction = input.instruction.toLowerCase();
  const toolId = input.mode === "manual"
    ? input.toolId
    : instruction.includes("pdf") && (instruction.includes("转") || instruction.includes("导出"))
      ? (mockLastScan.files.some((file) => file.extension === "docx") ? "word_to_pdf" : "excel_to_pdf")
      : instruction.includes("换行")
        ? "remove_line_breaks"
        : instruction.includes("空格") || instruction.includes("空行")
        ? "normalize_whitespace"
        : instruction.includes("日期")
          ? "update_dates"
        : instruction.includes("合并") && instruction.includes("pdf")
          ? "merge_pdf"
          : instruction.includes("脱敏")
            ? "redact_content"
            : "replace_text";
  const selectedTool = [...mockBuiltinTools, ...mockDesignedTools].find((tool) => tool.id === toolId);
  if (!selectedTool) throw new Error("没有找到可执行工具");
  if (!selectedTool.available) throw new Error(`“${selectedTool.name}”当前不可用：${selectedTool.availabilityDetail}`);
  const steps = selectedTool.source === "designed" ? selectedTool.steps : [{ toolId: selectedTool.id, parameters: input.parameters }];
  const applicable = mockLastScan.files.filter(
    (file) =>
      file.processingStatus === "processable"
      && selectedTool.supportedExtensions.includes(file.extension),
  );
  if (applicable.length === 0) {
    throw new Error(`当前材料中没有“${selectedTool.name}”支持的文件格式`);
  }
  const operationKind = (stepId: string) =>
    stepId === "merge_pdf" ? "merge_or_split"
      : stepId === "word_to_pdf" || stepId === "excel_to_pdf" ? "convert_to_pdf"
        : stepId;
  const operations = steps.map((step, index) => ({
    id: `tool-operation-${index}`,
    kind: operationKind(step.toolId) as TaskPlan["operations"][number]["kind"],
    title: mockBuiltinTools.find((tool) => tool.id === step.toolId)?.name || selectedTool.name,
    description: mockBuiltinTools.find((tool) => tool.id === step.toolId)?.description || selectedTool.description,
    fileCount: applicable.filter((file) =>
      mockBuiltinTools
        .find((tool) => tool.id === step.toolId)
        ?.supportedExtensions.includes(file.extension),
    ).length,
    parameters: { ...step.parameters, ...input.parameters },
    requiresReview: step.toolId === "replace_text" || step.toolId === "normalize_whitespace",
    available: true,
  }));
  mockPlan = {
    id: randomId(),
    manifestId: input.manifestId,
    taskName: input.taskName,
    description: input.instruction,
    operations,
    affectedFiles: applicable.length,
    outputDirectory: `/Users/demo/Documents/材料工作台/任务/${input.taskName}`,
    estimatedOutputs: applicable.length,
    aiReviewItems: [],
    aiGenerated: input.mode !== "manual",
    aiProfileId: input.profileId,
    aiModel: input.model,
    warnings: [],
    requiresWps: false,
    requiresOcr: false,
    requiresAi: false,
  };
  return mockPlan;
}

export async function designAgentTool(
  input: DesignToolRequest,
  onEvent?: (event: SkillDesignEvent) => void,
): Promise<AgentTool> {
  if (isTauri())
    return invokeWithEvents(
      "design_agent_tool",
      { request: input },
      (event: SkillDesignEvent) => onEvent?.(event),
    );
  if (isWebApiEnabled()) {
    onEvent?.({ type: "started", designId: input.designId || randomId() });
    const result = await webDesignSkill(input);
    onEvent?.({ type: "completed", skillId: result.id });
    return result;
  }
  await wait(900);
  return {
    id: `designed-${randomId()}`,
    name: "公文清稿流程",
    description: input.prompt,
    source: "designed",
    kind: input.kind ?? "workflow",
    version: "0.1.0",
    author: "本机用户",
    permissions: ["read_selected_files", "write_task_output"],
    testStatus: "untested",
    status: "draft",
    supportedExtensions: ["docx"],
    available: false,
    availabilityDetail:
      input.kind === "workflow" || !input.kind
        ? "流程草稿已生成；需要完整样本测试通过后发布"
        : "扩展代码已生成；通过样本测试前不会进入可执行工具箱",
    parameters: [],
    sourceCode: input.kind === "python"
      ? "def run(context):\n    # 仅能读取 context['input_dir'] 并写入 context['output_dir']\n    return {\"summary\": \"draft\", \"outputs\": []}\n"
      : undefined,
    steps: input.kind === "workflow" || !input.kind ? [
      { toolId: "normalize_whitespace", parameters: { collapseSpaces: true, removeEmptyParagraphs: true } },
      { toolId: "redact_content", parameters: {} },
    ] : [],
  };
}

export async function cancelSkillDesign(designId: string): Promise<void> {
  if (isTauri()) return invoke("cancel_skill_design", { designId });
  if (isWebApiEnabled()) await webCancelSkillRun(designId);
}

const mockDesignStates = new Map<string, SkillDesignState>();

export async function getTaskSkillSeed(sessionId: string, turnId: string): Promise<TaskSkillSeed> {
  if (isTauri()) return invoke("get_task_skill_seed", { sessionId, turnId });
  if (isWebApiEnabled()) throw new Error("当前 Web 服务尚不支持从任务提取测试版，请从设计能力包入口创建。");
  const detail = await getAgentSession(sessionId);
  return { prompt: detail.messages.filter(m => m.turnId === turnId).map(m => m.content).join("\n"), samplePaths: detail.attachments.filter(a => a.kind !== "artifact").map(a => a.localSnapshotPath!).filter(Boolean), requiresNetwork: false };
}

export async function getSkillDesignState(sessionId: string): Promise<SkillDesignState | null> {
  if (isTauri()) return invoke("get_skill_design_state", { sessionId });
  if (isWebApiEnabled()) return webRequest(`/sessions/${encodeURIComponent(sessionId)}/design`);
  return structuredClone(mockDesignStates.get(sessionId) ?? null);
}

export async function saveSkillDesignState(sessionId: string, designState: SkillDesignState): Promise<SkillDesignState> {
  if (isTauri()) return invoke("save_skill_design_state", { sessionId, designState });
  if (isWebApiEnabled()) return webRequest(`/sessions/${encodeURIComponent(sessionId)}/design`, { method: "PUT", body: JSON.stringify(designState) });
  mockDesignStates.set(sessionId, structuredClone(designState));
  return structuredClone(designState);
}

export async function designAndTestSkill(request: DesignAndTestRequest, onEvent?: (event: SkillDesignEvent) => void): Promise<SkillDesignRunResult> {
  if (isTauri()) return invokeWithEvents("design_and_test_skill", { request }, (event: SkillDesignEvent) => onEvent?.(event));
  const web = isWebApiEnabled();
  const generated = web ? await webDesignSkill({ ...request.design, designRunId: request.runId }) : await designAgentTool(request.design, onEvent);
  const skill = web ? await webSaveSkill(generated, request.runId) : await saveAgentTool(generated);
  if (!request.autoTest || (!request.samplePaths.length && skill.supportedExtensions.length)) return { skill };
  return testAndRepairSkill({ runId: request.runId, skillId: skill.id, samplePaths: request.samplePaths, parameters: request.parameters }, onEvent);
}

export async function testAndRepairSkill(request: TestAndRepairRequest, onEvent?: (event: SkillDesignEvent) => void): Promise<SkillDesignRunResult> {
  if (isTauri()) return invokeWithEvents("test_and_repair_skill", { request }, (event: SkillDesignEvent) => onEvent?.(event));
  if (isWebApiEnabled() && request.repair) throw new Error("当前 Web 服务尚不支持自动修复，请先在设计对话中修改后重测。");
  onEvent?.({ type: "started", designId: request.runId });
  onEvent?.({ type: "phase", phase: "testing", message: "正在运行样本测试", elapsedSeconds: 0 });
  if (isWebApiEnabled()) {
    const skill = await webTestSkill(request.skillId, request.samplePaths, request.parameters, request.runId);
    return { skill, testResult: skill.testResult };
  }
  const skill = await testSkill(request.skillId, request.samplePaths, request.parameters);
  return { skill, testResult: { status: skill.testStatus === "passed" ? "passed" : "failed", summary: skill.availabilityDetail, outputs: [], parameters: request.parameters, repairable: true } };
}

export async function generateCitizenReply(input: CitizenReplyRequest): Promise<CitizenReplyResult> {
  if (isTauri()) return invoke("generate_citizen_reply", { request: input });
  if (isWebApiEnabled()) return webGenerateCitizenReply(input);
  await wait(900);
  const opening = input.platform === "people" ? "网友您好！\n\n" : "";
  return {
    answer: `${opening}经核查，${input.verification || "[待补充：承办单位需补充核查时间和方式]"}。\n\n${input.handling || "我单位已[待补充：承办单位需补充处理措施]"}。\n\n后续${input.nextStep || "[待补充：承办单位需补充跟进安排]"}。`,
    findings: [{ level: "warning", code: "placeholders", message: "仍有待补充内容，发布前必须核实。" }],
    references: [{ source: "wording-rules.md", title: "政务工单答复用语规则" }],
    returnedModel: input.model,
  };
}

export async function saveAgentTool(tool: AgentTool): Promise<AgentTool> {
  if (isTauri()) return invoke("save_agent_tool", { tool });
  if (isWebApiEnabled()) return webSaveSkill(tool);
  mockDesignedTools = [...mockDesignedTools.filter((item) => item.id !== tool.id), tool];
  return tool;
}

export async function promoteAgentRunToSkill(
  runId: string,
  name?: string,
): Promise<AgentTool> {
  if (isTauri()) return invoke("promote_agent_run_to_skill", { runId, name });
  const tool: AgentTool = {
    id: `designed-${randomId()}`,
    name: name?.trim() || "会话中验证通过的临时工具",
    description: "由文件 Agent 已成功执行并通过成果验收的临时工具沉淀而成。",
    source: "designed",
    kind: "python",
    version: "0.1.0",
    author: "本机用户",
    permissions: ["read_selected_files", "write_task_output"],
    sourceCode: "def run(context, params=None):\n    return {'summary': '示例技能', 'outputs': []}\n",
    testStatus: "untested",
    status: "draft",
    supportedExtensions: ["docx", "xlsx"],
    available: false,
    availabilityDetail: "已保存为草稿，请更换样本测试后发布",
    parameters: [],
    steps: [],
  };
  mockDesignedTools = [...mockDesignedTools, tool];
  return tool;
}

export async function getSkill(skillId: string): Promise<AgentTool> {
  if (isTauri()) return invoke("get_skill", { skillId });
  if (isWebApiEnabled()) return webGetSkill(skillId);
  const tool = [...mockBuiltinTools, ...mockDesignedTools].find((item) => item.id === skillId);
  if (!tool) throw new Error("技能不存在");
  return structuredClone(tool);
}

export async function testSkill(skillId: string, samplePaths: string[], parameters: Record<string, unknown> = {}): Promise<AgentTool> {
  if (isTauri()) return invoke("test_skill", { request: { skillId, samplePaths, parameters } });
  if (isWebApiEnabled()) return webTestSkill(skillId, samplePaths, parameters);
  const tool = await getSkill(skillId);
  const tested = { ...tool, testStatus: "passed" as const, status: "draft" as const, availabilityDetail: `样本测试通过（${samplePaths.length} 个输入）` };
  mockDesignedTools = [...mockDesignedTools.filter((item) => item.id !== skillId), tested];
  return tested;
}

export async function publishSkill(skillId: string): Promise<AgentTool> {
  if (isTauri()) return invoke("publish_skill", { skillId });
  if (isWebApiEnabled()) return webPublishSkill(skillId);
  const tool = await getSkill(skillId);
  if (tool.testStatus !== "passed") throw new Error("请先通过样本测试");
  const published = { ...tool, status: "published" as const, available: true, availabilityDetail: "已发布，可由 Agent 调用或手动运行" };
  mockDesignedTools = [...mockDesignedTools.filter((item) => item.id !== skillId), published];
  return published;
}

export async function disableSkill(skillId: string): Promise<AgentTool> {
  if (isTauri()) return invoke("disable_skill", { skillId });
  if (isWebApiEnabled()) return webDisableSkill(skillId);
  const tool = await getSkill(skillId);
  const disabled = { ...tool, status: "disabled" as const, available: false, availabilityDetail: "已停用" };
  mockDesignedTools = [...mockDesignedTools.filter((item) => item.id !== skillId), disabled];
  return disabled;
}

export async function deleteSkill(skillId: string): Promise<void> {
  if (isTauri()) return invoke("delete_skill", { skillId });
  if (isWebApiEnabled()) return webDeleteSkill(skillId);
  const exists = mockDesignedTools.some((item) => item.id === skillId);
  if (!exists) throw new Error("只能删除自己创建的技能");
  mockDesignedTools = mockDesignedTools.filter((item) => item.id !== skillId);
}

export async function listDeletedSkills(): Promise<AgentTool[]> {
  if (isTauri()) return invoke("list_deleted_skills");
  if (isWebApiEnabled()) return webListDeletedSkills();
  return [];
}

export async function restoreSkill(skillId: string): Promise<AgentTool> {
  if (isTauri()) return invoke("restore_skill", { skillId });
  if (isWebApiEnabled()) return webRestoreSkill(skillId);
  throw new Error("模拟环境没有可恢复的技能");
}

export async function permanentlyDeleteSkill(skillId: string): Promise<void> {
  if (isTauri()) return invoke("permanently_delete_skill", { skillId });
  if (isWebApiEnabled()) return webPermanentlyDeleteSkill(skillId);
}

export async function runSkill(
  skillId: string,
  paths: string[],
  parameters: Record<string, unknown> = {},
  onEvent?: (event: SkillRunEvent) => void,
): Promise<SkillRunResult> {
  const runId = randomId();
  if (isTauri()) {
    return invokeWithEvents(
      "run_skill",
      { request: { runId, skillId, paths, parameters } },
      (event: SkillRunEvent) => onEvent?.(event),
    );
  }
  if (isWebApiEnabled()) return webRunSkill({ runId, skillId, paths, parameters }, onEvent);
  const tool = await getSkill(skillId);
  if (!tool.available) throw new Error("技能尚未发布或当前不可用");
  onEvent?.({ type: "started", runId, total: paths.length });
  onEvent?.({ type: "progress", runId, stage: "executing", current: 0, total: 1, message: `正在运行“${tool.name}”` });
  await wait(500);
  const outputDirectory = "/Users/demo/Documents/材料工作台/技能运行/示例";
  onEvent?.({ type: "completed", runId, outputDirectory });
  return { summary: `“${tool.name}”已处理 ${paths.length} 个输入`, outputDirectory, artifacts: [] };
}

export async function cancelSkillRun(runId: string): Promise<void | "completed" | "stopping"> {
  if (isTauri()) return invoke<void>("cancel_skill_run", { runId });
  if (isWebApiEnabled()) return webCancelSkillRun(runId);
}
