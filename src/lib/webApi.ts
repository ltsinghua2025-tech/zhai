import type { AgentAttachment, AgentAttachmentInput, AgentEvent, AgentSession, AgentSessionDetail, AgentTool, AiConnectionResult, AiProfile, CitizenReplyRequest, CitizenReplyResult, DesignAttachment, SkillRunEvent, SkillRunResult } from "../types";
import { getWebSelectionFiles, isWebRuntime, randomId } from "./tauriCompat";

const API_BASE = (import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");

export function isWebApiEnabled() {
  return isWebRuntime() && import.meta.env.VITE_WEB_API === "1";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const signal = init?.signal;
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = window.setTimeout(cancel, init?.method === "POST" ? 240_000 : 30_000);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init, signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string } & T;
    if (controller.signal.aborted) throw new Error("请求已中断");
    if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
    return payload;
  } catch (reason) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? "已取消上传" : "服务器响应超时，请刷新后查看任务状态");
    throw reason;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export function webRequest<T>(path: string, init?: RequestInit) {
  return request<T>(path, init);
}

export type UploadProgress = { signal: AbortSignal; onFile: (name: string) => void };

function uploadFile<T>(file: File, fields: Record<string, string>, signal?: AbortSignal) {
  const query = new URLSearchParams({ filename: file.name, relativePath: file.webkitRelativePath || file.name, ...fields });
  return request<T>(`/uploads?${query}`, {
    method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" }, signal,
  });
}

export async function uploadWebSelection(sessionId: string, input: AgentAttachmentInput, progress?: UploadProgress): Promise<AgentAttachment[]> {
  if (input.kind === "url") {
    return request<AgentAttachment[]>(`/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: "POST",
      body: JSON.stringify({ kind: "url", url: input.url }),
    });
  }

  const files = getWebSelectionFiles(input.path);
  if (!files.length) throw new Error("没有读取到浏览器选择的文件，请重新选择");
  const attachments: AgentAttachment[] = [];
  const groupId = input.kind === "folder" ? randomId() : undefined;
  for (const file of files) {
    if (progress?.signal.aborted) throw new Error("已取消上传");
    progress?.onFile(file.name);
    const result = await uploadFile<AgentAttachment>(file, {
      sessionId, kind: input.kind, ...(groupId ? { groupId, groupName: file.webkitRelativePath?.split("/")[0] || "上传文件夹" } : {}),
    }, progress?.signal);
    attachments.push(result);
  }
  return attachments;
}

export function webCreateSession(input: { title?: string; profileId: string; model: string }, signal?: AbortSignal) {
  return request<AgentSession>("/sessions", { method: "POST", body: JSON.stringify(input), signal });
}

export function webListSessions(signal?: AbortSignal) {
  return request<AgentSession[]>("/sessions", { signal });
}

export function webDesignFromTurn(sessionId: string, turnId: string) {
  return request<{ sessionId: string }>(`/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/design`, {
    method: "POST", body: "{}",
  });
}

export function webGetSession(sessionId: string, signal?: AbortSignal) {
  return request<AgentSessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`, { signal });
}

export function webRenameSession(sessionId: string, title: string) {
  return request<AgentSession>(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export function webDeleteSession(sessionId: string, deleteArtifacts = false) {
  return request<void>(`/sessions/${encodeURIComponent(sessionId)}?deleteArtifacts=${deleteArtifacts ? "1" : "0"}`, { method: "DELETE" });
}

export function webRemoveAttachment(sessionId: string, attachmentId: string) {
  return request<void>(`/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
}

export async function webSendMessage(input: {
  sessionId: string;
  content: string;
  profileId: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  allowModelFileAccess: boolean;
  attachmentIds?: string[];
}, onEvent: (event: AgentEvent) => void) {
  const response = await request<{ turnId: string }>(`/sessions/${encodeURIComponent(input.sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  onEvent({ type: "phase", sessionId: input.sessionId, turnId: response.turnId, message: "任务已开始" });
  let offset = 0;
  for (;;) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    const state = await request<{ status: string; error?: string; events: AgentEvent[]; offset: number; detail?: AgentSessionDetail }>(`/turns/${encodeURIComponent(response.turnId)}?offset=${offset}`);
    state.events.forEach(onEvent);
    offset = state.offset;
    if (state.status === "running" || state.status === "stopping") continue;
    if (state.status !== "completed") throw new Error(state.error || "任务未完成");
    if (!state.detail) throw new Error("任务结果缺失，请刷新会话");
    return state.detail;
  }
}

export function webListProfiles() {
  return request<AiProfile[]>("/profiles");
}

export function webSaveProfile(input: {
  id: string;
  provider: "deepseek" | "openai_compatible";
  displayName: string;
  baseUrl: string;
  defaultModel: string;
  apiKey?: string;
}) {
  return request<AiProfile>("/profiles", { method: "POST", body: JSON.stringify(input) });
}

export function webTestConnection(input: { profileId: string; model?: string; baseUrl?: string; apiKey?: string }) {
  return request<AiConnectionResult>("/profiles/test", { method: "POST", body: JSON.stringify(input) });
}

export function webGenerateCitizenReply(input: CitizenReplyRequest) {
  return request<CitizenReplyResult>("/citizen-reply", { method: "POST", body: JSON.stringify(input) });
}

export function webListTools() {
  return request<AgentTool[]>("/tools");
}

const uploadedFiles = new WeakMap<File, { uploadId: string; expires: number }>();

async function uploadSkillInputs(paths: string[], signal?: AbortSignal) {
  const result: Array<{ uploadId: string } | { attachmentId: string }> = [];
  for (const path of paths) {
    if (path.startsWith("web-attachment:")) {
      result.push({ attachmentId: path.slice("web-attachment:".length) });
      continue;
    }
    const files = getWebSelectionFiles(path);
    if (!files.length) throw new Error("没有读取到所选文件，请重新选择");
    for (const file of files) {
      if (signal?.aborted) throw new Error("已取消上传");
      const cached = uploadedFiles.get(file);
      if (cached && cached.expires > Date.now()) {
        result.push({ uploadId: cached.uploadId });
        continue;
      }
      const { uploadId } = await uploadFile<{ uploadId: string }>(file, { kind: file.webkitRelativePath ? "folder" : "file" }, signal);
      if (!uploadId) throw new Error("未收到文件标识，请重新选择文件");
      uploadedFiles.set(file, { uploadId, expires: Date.now() + 23 * 60 * 60 * 1000 });
      result.push({ uploadId });
    }
  }
  if (paths.length && !result.length) throw new Error("没有读取到浏览器选择的样本文件，请重新选择");
  return result;
}

export function webListSkills() {
  return request<AgentTool[]>("/skills");
}

export function webListRecentSkills() {
  return request<string[]>("/skills/recent");
}

export function webListDeletedSkills() {
  return request<AgentTool[]>("/skills/deleted");
}

export function webGetSkill(skillId: string) {
  return request<AgentTool>(`/skills/${encodeURIComponent(skillId)}`);
}

export function webDesignSkill(input: {
  designRunId?: string;
  prompt: string;
  sessionId?: string;
  profileId: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  kind?: "workflow" | "python" | "adapter" | "derived";
  attachments?: Array<DesignAttachment & { contentBase64?: string; filename?: string }>;
}) {
  return request<AgentTool>("/skills/design", { method: "POST", body: JSON.stringify(input) });
}

export function webSaveSkill(tool: AgentTool, designRunId?: string) {
  return request<AgentTool>("/skills", { method: "POST", body: JSON.stringify({ tool, designRunId }) });
}

export async function webTestSkill(skillId: string, paths: string[], parameters: Record<string, unknown> = {}, designRunId: string = randomId()) {
  const files = await prepareSkillInputs(designRunId, paths);
  return request<AgentTool>(`/skills/${encodeURIComponent(skillId)}/test`, {
    method: "POST", body: JSON.stringify({ files, parameters, designRunId }),
  });
}

export function webPublishSkill(skillId: string) {
  return request<AgentTool>(`/skills/${encodeURIComponent(skillId)}/publish`, { method: "POST", body: JSON.stringify({}) });
}

export function webDisableSkill(skillId: string) {
  return request<AgentTool>(`/skills/${encodeURIComponent(skillId)}/disable`, { method: "POST", body: JSON.stringify({}) });
}

export function webDeleteSkill(skillId: string) {
  return request<void>(`/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" });
}

export function webRestoreSkill(skillId: string) {
  return request<AgentTool>(`/skills/${encodeURIComponent(skillId)}/restore`, { method: "POST", body: JSON.stringify({}) });
}

export function webPermanentlyDeleteSkill(skillId: string) {
  return request<void>(`/skills/${encodeURIComponent(skillId)}/permanent`, { method: "DELETE" });
}

const preparingSkillRuns = new Map<string, AbortController>();

async function prepareSkillInputs(runId: string, paths: string[]) {
  const controller = new AbortController();
  preparingSkillRuns.set(runId, controller);
  try {
    const files = await uploadSkillInputs(paths, controller.signal);
    if (controller.signal.aborted) throw new Error("已停止运行");
    return files;
  } finally { preparingSkillRuns.delete(runId); }
}

export async function webCancelSkillRun(runId: string) {
  const preparing = preparingSkillRuns.get(runId);
  if (preparing) {
    preparing.abort();
    return "stopping" as const;
  }
  const result = await request<{ status: "completed" | "stopping" }>(`/design-runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" });
  return result.status;
}

export async function webRunSkill(
  input: { runId: string; skillId: string; paths: string[]; parameters: Record<string, unknown> },
  onEvent?: (event: SkillRunEvent) => void,
): Promise<SkillRunResult> {
  const { runId, skillId, paths, parameters } = input;
  onEvent?.({ type: "progress", runId, stage: "preparing", current: 0, total: paths.length, message: "正在准备运行材料" });
  const files = await prepareSkillInputs(runId, paths);
  onEvent?.({ type: "started", runId, total: files.length });
  const result = await request<SkillRunResult>("/skills/run", { method: "POST", body: JSON.stringify({ skillId, runId, parameters, files }) });
  onEvent?.({ type: "completed", runId, outputDirectory: result.outputDirectory });
  return result;
}

export function webCancelSession(sessionId: string) {
  return request<void>(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST", body: JSON.stringify({}) });
}

export function webDownloadUrl(path: string) {
  return `${API_BASE}/artifacts/download?path=${encodeURIComponent(path)}`;
}
