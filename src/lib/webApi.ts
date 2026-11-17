import type { AgentAttachment, AgentAttachmentInput, AgentEvent, AgentSession, AgentSessionDetail, AgentTool, AiConnectionResult, AiProfile, CitizenReplyRequest, CitizenReplyResult, DesignAttachment, SkillRunEvent, SkillRunResult } from "../types";
import { getWebSelectionFiles, isWebRuntime, randomId } from "./tauriCompat";

const API_BASE = (import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");

export function isWebApiEnabled() {
  return isWebRuntime() && import.meta.env.VITE_WEB_API === "1";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

export function webRequest<T>(path: string, init?: RequestInit) {
  return request<T>(path, init);
}

export async function uploadWebSelection(sessionId: string, input: AgentAttachmentInput): Promise<AgentAttachment[]> {
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
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    const encoded = btoa(binary);
    const result = await request<AgentAttachment>(`/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: "POST",
      body: JSON.stringify({
        kind: input.kind,
        filename: file.name,
        relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        mimeType: file.type || undefined,
        size: file.size,
        groupId,
        contentBase64: encoded,
      }),
    });
    attachments.push(result);
  }
  return attachments;
}

export function webCreateSession(input: { title?: string; profileId: string; model: string }) {
  return request<AgentSession>("/sessions", { method: "POST", body: JSON.stringify(input) });
}

export function webListSessions() {
  return request<AgentSession[]>("/sessions");
}

export function webGetSession(sessionId: string) {
  return request<AgentSessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`);
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
}, onEvent: (event: AgentEvent) => void) {
  const response = await request<{ turnId: string }>(`/sessions/${encodeURIComponent(input.sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  let offset = 0;
  for (;;) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    const state = await request<{ status: string; error?: string; events: AgentEvent[]; offset: number; detail?: AgentSessionDetail }>(`/turns/${encodeURIComponent(response.turnId)}?offset=${offset}`);
    state.events.forEach(onEvent);
    offset = state.offset;
    if (state.status === "running") continue;
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

type WebFilePayload = {
  filename: string;
  relativePath: string;
  mimeType?: string;
  size: number;
  contentBase64: string;
};

async function encodeWebSelection(paths: string[]) {
  const result: WebFilePayload[] = [];
  for (const path of paths) {
    const files = getWebSelectionFiles(path);
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      result.push({
        filename: file.name,
        relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        mimeType: file.type || undefined,
        size: file.size,
        contentBase64: btoa(binary),
      });
    }
  }
  if (!result.length) throw new Error("没有读取到浏览器选择的样本文件，请重新选择");
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

export function webSaveSkill(tool: AgentTool) {
  return request<AgentTool>("/skills", { method: "POST", body: JSON.stringify({ tool }) });
}

export function webTestSkill(skillId: string, paths: string[], parameters: Record<string, unknown> = {}) {
  return encodeWebSelection(paths).then((files) =>
    request<AgentTool>(`/skills/${encodeURIComponent(skillId)}/test`, {
      method: "POST",
      body: JSON.stringify({ files, parameters }),
    }),
  );
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

export async function webRunSkill(
  input: { skillId: string; paths: string[]; parameters: Record<string, unknown> },
  onEvent?: (event: SkillRunEvent) => void,
): Promise<SkillRunResult> {
  const runId = randomId();
  const files = await encodeWebSelection(input.paths);
  onEvent?.({ type: "started", runId, total: files.length });
  const result = await request<SkillRunResult>("/skills/run", {
    method: "POST",
    body: JSON.stringify({ ...input, runId, files }),
  });
  onEvent?.({ type: "completed", runId, outputDirectory: result.outputDirectory });
  return result;
}

export function webCancelSession(sessionId: string) {
  return request<void>(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST", body: JSON.stringify({}) });
}

export function webDownloadUrl(path: string) {
  return `${API_BASE}/artifacts/download?path=${encodeURIComponent(path)}`;
}
