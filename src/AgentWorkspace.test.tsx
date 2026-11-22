import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentWorkspace from "./AgentWorkspace";
import type { AgentSessionDetail, AgentTool, AiProfile, DesignAndTestRequest, SendAgentMessageRequest, SkillDesignEvent, SkillDesignRunResult, SkillDesignState } from "./types";

const mocked = vi.hoisted(() => ({
  send: vi.fn(), cancel: vi.fn(), design: vi.fn(), repair: vi.fn(), cancelDesign: vi.fn(), saveTool: vi.fn(),
  open: vi.fn(), saveState: vi.fn(), getState: vi.fn(), promote: vi.fn(), seed: vi.fn(),
  sessions: new Map<string, AgentSessionDetail>(), states: new Map<string, SkillDesignState>(), skills: new Map<string, AgentTool>(),
}));
vi.mock("./lib/tauriCompat", async original => ({ ...await original<typeof import("./lib/tauriCompat")>(), openDialog: mocked.open }));
vi.mock("./lib/backend", async original => ({
  ...await original<typeof import("./lib/backend")>(),
  sendAgentMessage: mocked.send, cancelAgentTurn: mocked.cancel,
  designAndTestSkill: mocked.design, testAndRepairSkill: mocked.repair,
  cancelSkillDesign: mocked.cancelDesign, saveAgentTool: mocked.saveTool,
  getSkillDesignState: mocked.getState, saveSkillDesignState: mocked.saveState,
  promoteAgentRunToSkill: mocked.promote, getTaskSkillSeed: mocked.seed,
  getPythonExecutionStatus: async () => ({ available: true, detail: "测试执行环境可用" }),
  getSkill: async (id: string) => mocked.skills.get(id),
  listAgentSessions: async () => [...mocked.sessions.values()].map(detail => detail.session).reverse(),
  getAgentSession: async (id: string) => structuredClone(mocked.sessions.get(id)),
  createAgentSession: async (request: { title?: string; profileId: string; model: string }) => {
    const session = { ...request, id: `session-${mocked.sessions.size + 1}`, title: request.title || "新会话", status: "idle" as const, createdAt: "2026-11-18T10:00:00Z", updatedAt: "2026-11-18T10:00:00Z", workspacePath: "/tmp/test" };
    mocked.sessions.set(session.id, { session, messages: [], attachments: [], toolRuns: [] });
    return session;
  },
  renameAgentSession: async (id: string, title: string) => { mocked.sessions.get(id)!.session.title = title; },
  addAgentAttachments: async (id: string, inputs: Array<{ path: string }>) => {
    const detail = mocked.sessions.get(id)!;
    const added = inputs.map((input, index) => ({ id: `${id}-file-${detail.attachments.length + index}`, sessionId: id, kind: "file" as const, name: input.path.split("/").pop()!, localSnapshotPath: input.path, createdAt: "2026-11-18T10:00:00Z" }));
    detail.attachments.push(...added);
    return structuredClone(added);
  },
}));

const profile: AiProfile = { id: "deepseek", provider: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", keyStored: true };
const skill: AgentTool = { id: "table-skill", name: "表格转换", description: "转换样本表格", source: "designed", kind: "python", supportedExtensions: ["csv"], available: true, availabilityDetail: "可测试", parameters: [{ key: "column", label: "目标列", type: "text", required: true, defaultValue: "姓名" }], steps: [], testStatus: "untested", status: "draft" };
const workspace = (props: Partial<React.ComponentProps<typeof AgentWorkspace>> = {}) => <AgentWorkspace profile={profile} apiKey="" openModels={() => {}} {...props} />;
const composer = () => screen.getByRole("textbox", { name: "" });
async function send(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "发送消息" })); });
}
async function addSamples(...paths: string[]) {
  // A design target renders its test panel before its session finishes opening.
  await waitFor(() => expect(screen.getByRole("button", { name: "新建设计会话" })).toBeEnabled());
  mocked.open.mockResolvedValueOnce(paths);
  fireEvent.click(screen.getByTitle("添加文件"));
  await screen.findByRole("combobox", { name: paths[0].split("/").pop() });
}

function completedTask(currentHasArtifact = true) {
  const sessionId = "session-1";
  const detail: AgentSessionDetail = {
    session: { id: sessionId, title: "原始处理会话", profileId: profile.id, model: profile.defaultModel, status: "idle", createdAt: "2026-11-18T10:00:00Z", updatedAt: "2026-11-18T10:03:00Z", workspacePath: "/tmp/original" },
    messages: [
      { id: "old-user", sessionId, role: "user", content: "处理旧样本", turnId: "old-turn", createdAt: "2026-11-18T10:00:00Z" },
      { id: "old-reply", sessionId, role: "assistant", content: "旧轮次已完成", turnId: "old-turn", createdAt: "2026-11-18T10:01:00Z" },
      { id: "current-user", sessionId, role: "user", content: "按单位合并当前样本", turnId: "current-turn", createdAt: "2026-11-18T10:02:00Z" },
      { id: "current-reply", sessionId, role: "assistant", content: "当前轮次已完成", turnId: "current-turn", createdAt: "2026-11-18T10:03:00Z" },
    ],
    attachments: [
      { id: "old-input", sessionId, kind: "file", name: "旧样本.csv", localSnapshotPath: "/original/old.csv", createdAt: "2026-11-18T10:00:00Z" },
      { id: "old-output", sessionId, kind: "artifact", name: "旧成果.csv", localSnapshotPath: "/original/old-result.csv", createdAt: "2026-11-18T10:00:30Z" },
      { id: "current-input", sessionId, kind: "file", name: "当前样本.csv", localSnapshotPath: "/original/current.csv", createdAt: "2026-11-18T10:02:00Z" },
      ...(currentHasArtifact ? [{ id: "current-output", sessionId, kind: "artifact" as const, name: "当前成果.csv", localSnapshotPath: "/original/current-result.csv", createdAt: "2026-11-18T10:02:30Z" }] : []),
    ],
    toolRuns: [{ id: "current-run", sessionId, turnId: "current-turn", toolId: "codex_harness", status: "completed", summary: "按单位合并", detail: "可保存工作流", startedAt: "2026-11-18T10:02:10Z", completedAt: "2026-11-18T10:02:30Z" }],
  };
  mocked.sessions.set(sessionId, structuredClone(detail));
  mocked.seed.mockResolvedValue({ prompt: "原任务：按单位合并当前样本；已验证数量合计。", samplePaths: ["/original/current.csv"], requiresNetwork: false });
  return detail;
}

function currentReply() {
  return within(screen.getByText("当前轮次已完成").closest("article")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.open.mockReset(); mocked.promote.mockReset(); mocked.seed.mockReset();
  mocked.sessions.clear(); mocked.states.clear(); mocked.skills.clear();
  mocked.skills.set(skill.id, skill);
  mocked.cancel.mockResolvedValue(undefined); mocked.cancelDesign.mockResolvedValue(undefined);
  mocked.saveState.mockImplementation(async (id: string, state: SkillDesignState) => { mocked.states.set(id, structuredClone(state)); return structuredClone(state); });
  mocked.getState.mockImplementation(async (id: string) => structuredClone(mocked.states.get(id) || null));
});

describe("design session lifecycle", () => {
  it("defers an external design target change until the current run finishes without mixing sessions", async () => {
    let finish: (result: SkillDesignRunResult) => void = () => {};
    mocked.design.mockImplementation(() => new Promise<SkillDesignRunResult>(resolve => { finish = resolve; }));
    const nextSkill: AgentTool = { ...skill, id: "split-skill", name: "拆分表格", parameters: [{ key: "separator", label: "分隔符", type: "text", required: true, defaultValue: "逗号" }] };
    mocked.skills.set(nextSkill.id, nextSkill);
    const handled = vi.fn();
    const view = render(workspace({ designTarget: skill, onDesignTargetHandled: handled }));
    await screen.findByRole("region", { name: "能力包样本测试" });
    await addSamples("/samples/original.csv");
    await send("只修改当前转换能力");
    expect(mocked.design).toHaveBeenCalledTimes(1);
    await act(async () => { view.rerender(workspace({ designTarget: nextSkill, onDesignTargetHandled: handled })); });
    expect(mocked.sessions.size).toBe(1);
    expect(mocked.states.get("session-1")?.skillId).toBe(skill.id);
    expect(screen.getByRole("textbox", { name: "目标列必填" })).toHaveValue("姓名");
    expect(screen.queryByRole("textbox", { name: "分隔符必填" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止任务" })).toBeInTheDocument();
    expect(handled).toHaveBeenCalledTimes(1);

    await act(async () => { finish({ skill: { ...skill, name: "转换规则已优化" } }); });
    expect(await screen.findByRole("textbox", { name: "分隔符必填" })).toHaveValue("逗号");
    await waitFor(() => expect(handled).toHaveBeenCalledTimes(2));
    expect(mocked.sessions.size).toBe(2);
    expect(mocked.states.get("session-2")).toMatchObject({ skillId: nextSkill.id, parameters: { separator: "逗号" }, attachmentRoles: {} });
    expect(mocked.states.get("session-2")!.messages).toHaveLength(1);
    expect(mocked.states.get("session-1")!.messages).toEqual(expect.arrayContaining([
      { role: "user", content: "只修改当前转换能力" },
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("转换规则已优化") }),
    ]));
    expect(mocked.sessions.get("session-1")!.attachments).toHaveLength(1);
    expect(mocked.sessions.get("session-2")!.attachments).toHaveLength(0);
    expect(screen.queryByText("只修改当前转换能力")).not.toBeInTheDocument();
    expect(mocked.design).toHaveBeenCalledTimes(1);
  });

  it("preserves the draft while the file chooser is open and ignores a superseded selection", async () => {
    let resolveFirst!: (paths: string[]) => void;
    mocked.open.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    await act(async () => { render(workspace({ startInDesignMode: true })); });
    fireEvent.change(composer(), { target: { value: "把文件转换成文本" } });
    fireEvent.click(screen.getByTitle("添加文件"));
    expect(screen.queryByRole("button", { name: "停止任务" })).toBeNull();
    expect(screen.queryByText(/正在准备本轮任务/)).toBeNull();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled();
    await addSamples("/samples/second.csv");
    await act(async () => { resolveFirst(["/samples/stale.csv"]); });
    expect(composer()).toHaveValue("把文件转换成文本");
    expect(mocked.sessions.get("session-1")!.attachments.map(item => item.name)).toEqual(["second.csv"]);
  });

  it("shows file picker failures and allows another upload in the same design", async () => {
    await act(async () => { render(workspace({ startInDesignMode: true })); });
    mocked.open.mockRejectedValueOnce(new Error("文件选择器暂不可用"));
    fireEvent.click(screen.getByTitle("添加文件"));
    expect(await screen.findByText(/添加文件失败：.*文件选择器暂不可用/)).toBeInTheDocument();
    expect(screen.getByTitle("添加文件")).toBeEnabled();
    await addSamples("/samples/retry.csv");
    expect(screen.queryByText(/添加文件失败/)).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "retry.csv" })).toHaveValue("sample_input");
    expect(mocked.sessions.size).toBe(1);
    expect(mocked.sessions.get("session-1")!.attachments).toHaveLength(1);
    expect(mocked.open).toHaveBeenCalledTimes(2);
  });

  it("keeps the design identity across timeout but cancels the current run and waits for it to finish", async () => {
    let rejectDesign: (reason: Error) => void = () => {};
    mocked.design.mockImplementation((_request: DesignAndTestRequest, emit: (event: SkillDesignEvent) => void) => {
      emit({ type: "phase", phase: "editing", message: "正在编辑", elapsedSeconds: 7 });
      return new Promise((_resolve, reject) => { rejectDesign = reject; });
    });
    await act(async () => { render(workspace({ startInDesignMode: true })); });
    await send("设计合并能力");
    await waitFor(() => expect(mocked.design).toHaveBeenCalledTimes(1));
    const first = mocked.design.mock.calls[0][0] as DesignAndTestRequest;
    expect(screen.getAllByText("正在编辑 · 7 秒").length).toBeGreaterThan(0);
    await act(async () => { rejectDesign(new Error("设计超时，草稿已保留")); });
    await send("继续完成测试");
    await waitFor(() => expect(mocked.design).toHaveBeenCalledTimes(2));
    const second = mocked.design.mock.calls[1][0] as DesignAndTestRequest;
    expect(second.design.designId).toBe(first.design.designId);
    expect(second.runId).not.toBe(first.runId);
    expect(second.runId).not.toBe(second.design.designId);
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    await waitFor(() => expect(mocked.cancelDesign).toHaveBeenCalledWith(second.runId));
    expect(screen.getByRole("button", { name: "停止任务" })).toBeInTheDocument();
    fireEvent.change(composer(), { target: { value: "不应并发发送" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(mocked.design).toHaveBeenCalledTimes(2);
    await act(async () => { rejectDesign(new Error("技能设计已取消")); });
    expect(await screen.findByRole("button", { name: "发送消息" })).toBeInTheDocument();
  });

  it("creates isolated designs, restores roles and parameters when switching, and persists them across remount", async () => {
    const view = render(workspace({ designTarget: skill }));
    await screen.findByRole("region", { name: "能力包样本测试" });
    await addSamples("/samples/input.csv", "/samples/expected.csv");
    fireEvent.change(screen.getByRole("combobox", { name: "expected.csv" }), { target: { value: "expected_output" } });
    fireEvent.change(screen.getByRole("textbox", { name: "目标列必填" }), { target: { value: "单位" } });
    const originalId = [...mocked.sessions.keys()][0];
    await waitFor(() => expect(mocked.states.get(originalId)?.parameters).toEqual({ column: "单位" }));
    const originalDesignId = mocked.states.get(originalId)!.designId;
    fireEvent.click(screen.getByRole("button", { name: "新建设计会话" }));
    await waitFor(() => expect(mocked.sessions.size).toBe(2));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "目标列必填" })).not.toBeInTheDocument());
    expect(screen.queryByRole("combobox", { name: "expected.csv" })).not.toBeInTheDocument();
    const fresh = mocked.states.get("session-2")!;
    expect(fresh.designId).not.toBe(originalDesignId);
    expect(fresh).toMatchObject({ messages: [], attachmentRoles: {}, parameters: {} });
    expect(fresh.skillId).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: /设计 · 表格转换/ }));
    expect(await screen.findByRole("textbox", { name: "目标列必填" })).toHaveValue("单位");
    expect(screen.getByRole("combobox", { name: "expected.csv" })).toHaveValue("expected_output");
    expect(screen.getByText(/1 份原始样本/)).toBeInTheDocument();
    view.unmount();
    await act(async () => { render(workspace()); });
    await screen.findByRole("button", { name: /设计 · 表格转换/ });
    fireEvent.click(screen.getByRole("button", { name: /设计 · 表格转换/ }));
    expect(await screen.findByRole("textbox", { name: "目标列必填" })).toHaveValue("单位");
    expect(screen.getByRole("combobox", { name: "expected.csv" })).toHaveValue("expected_output");
    expect(mocked.states.get(originalId)!.designId).toBe(originalDesignId);
    expect(screen.queryByText("能力包设计工作台")).not.toBeInTheDocument();
    expect(screen.queryByText("结构校验")).not.toBeInTheDocument();
  });

  it("uses the active web draft when asked to try it and identifies a missing sample", async () => {
    vi.stubEnv("VITE_WEB_API", "1");
    try {
      render(workspace({ designTarget: skill }));
      await screen.findByRole("region", { name: "能力包样本测试" });
      await send("试试");
      expect(screen.getByText("试试")).toBeInTheDocument();
      expect(screen.getAllByText(/请添加至少一份原始样本/).length).toBeGreaterThan(1);
      expect(mocked.design).not.toHaveBeenCalled();
      expect(mocked.repair).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("tests current originals after design and preserves the passed result without saving again", async () => {
    const passedSkill: AgentTool = { ...skill, testStatus: "passed" };
    mocked.design.mockResolvedValue({ skill: passedSkill, testResult: { status: "passed", summary: "当前样本处理成功", parameters: { column: "单位" }, outputs: ["/results/result.csv"], outputDirectory: "/results", repairable: false } });
    const saved = vi.fn();
    render(workspace({ designTarget: skill, onSkillSaved: saved }));
    await screen.findByRole("region", { name: "能力包样本测试" });
    await addSamples("/samples/input.csv", "/samples/template.csv");
    fireEvent.change(screen.getByRole("combobox", { name: "template.csv" }), { target: { value: "template" } });
    fireEvent.change(screen.getByRole("textbox", { name: "目标列必填" }), { target: { value: "单位" } });
    await send("按模板优化转换");
    await screen.findByText("样本执行通过");
    expect(mocked.design).toHaveBeenCalledWith(expect.objectContaining({ autoTest: true, samplePaths: ["/samples/input.csv"], parameters: { column: "单位" }, design: expect.objectContaining({ attachments: [{ path: "/samples/input.csv", role: "sample_input" }, { path: "/samples/template.csv", role: "template" }] }) }), expect.any(Function));
    expect(mocked.saveTool).not.toHaveBeenCalled();
    expect(saved).toHaveBeenCalledWith(passedSkill);
    expect(screen.getByRole("button", { name: "发布能力包" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "添加测试样本" })).toBeInTheDocument();
  });

  it("repairs a failed test with the same samples and parameter values", async () => {
    mocked.repair.mockResolvedValueOnce({ skill: { ...skill, testStatus: "failed" }, testResult: { status: "failed", summary: "脚本缺少列检查", parameters: { column: "姓名" }, outputs: [], repairable: true } })
      .mockResolvedValueOnce({ skill: { ...skill, testStatus: "passed" }, testResult: { status: "passed", summary: "修复后执行成功", parameters: { column: "姓名" }, outputs: [], repairable: false } });
    render(workspace({ designTarget: skill }));
    await screen.findByRole("region", { name: "能力包样本测试" });
    await addSamples("/samples/input.csv");
    fireEvent.click(screen.getByRole("button", { name: "用当前样本测试" }));
    fireEvent.click(await screen.findByRole("button", { name: "自动修复并重测" }));
    await screen.findByText("样本执行通过");
    expect(mocked.repair.mock.calls[1][0]).toMatchObject({ skillId: skill.id, samplePaths: ["/samples/input.csv"], parameters: { column: "姓名" }, repair: { currentSkillId: skill.id, attachments: [{ path: "/samples/input.csv", role: "sample_input" }] } });
    expect(mocked.repair.mock.calls[1][0].runId).not.toBe(mocked.repair.mock.calls[0][0].runId);
  });

  it.each(["parameter", "sample role"])("requires a fresh passing test after changing a %s", async change => {
    mocked.repair.mockResolvedValue({ skill: { ...skill, testStatus: "passed" }, testResult: { status: "passed", summary: "当前输入测试通过", parameters: { column: "姓名" }, outputs: [], repairable: false } });
    render(workspace({ designTarget: skill }));
    await screen.findByRole("region", { name: "能力包样本测试" });
    await addSamples("/samples/input.csv", "/samples/second.csv");
    fireEvent.click(screen.getByRole("button", { name: "用当前样本测试" }));
    await screen.findByText("样本执行通过");
    expect(screen.getByRole("button", { name: "发布能力包" })).toBeEnabled();
    if (change === "parameter") {
      fireEvent.change(screen.getByRole("textbox", { name: "目标列必填" }), { target: { value: "单位" } });
    } else {
      fireEvent.change(screen.getByRole("combobox", { name: "second.csv" }), { target: { value: "reference" } });
      expect(screen.getByText(/1 份原始样本/)).toBeInTheDocument();
    }
    expect(screen.queryByText("样本执行通过")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发布能力包" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "用当前样本测试" })).toBeEnabled();
    await waitFor(() => expect(mocked.states.get("session-1")?.testResult).toBeUndefined());
  });
});

describe("successful task to capability draft", () => {
  it("creates a separate design with only the selected turn's samples and leaves the source session intact", async () => {
    const original = completedTask();
    mocked.promote.mockResolvedValue(skill);
    await act(async () => { render(workspace()); });
    fireEvent.click(currentReply().getByRole("button", { name: "生成能力包测试版" }));
    await screen.findByRole("region", { name: "能力包样本测试" });
    await waitFor(() => expect(mocked.states.get("session-2")?.sourceTask).toEqual({ sessionId: "session-1", turnId: "current-turn" }));
    expect(mocked.seed).toHaveBeenCalledWith("session-1", "current-turn");
    expect(mocked.promote).toHaveBeenCalledWith("current-run", undefined);
    expect(mocked.states.get("session-2")).toMatchObject({ skillId: skill.id, parameters: { column: "姓名" } });
    expect(mocked.sessions.get("session-2")!.attachments.map(item => item.localSnapshotPath)).toEqual(["/original/current.csv"]);
    expect(mocked.sessions.get("session-1")).toEqual(original);
    expect(mocked.states.has("session-1")).toBe(false);
    expect(screen.getByRole("button", { name: "发布能力包" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "查看原会话" }));
    await screen.findByText("当前轮次已完成");
    expect(currentReply().getByRole("button", { name: "生成能力包测试版" })).toBeEnabled();
    expect(mocked.sessions.get("session-1")).toEqual(original);
  });

  it("falls back to a new seeded conversation when extraction is rejected and can send it for design", async () => {
    const original = completedTask();
    mocked.promote.mockRejectedValue(new Error("原执行包含不能固定的子集引用"));
    mocked.design.mockResolvedValue({ skill });
    await act(async () => { render(workspace()); });
    fireEvent.click(currentReply().getByRole("button", { name: "生成能力包测试版" }));
    await screen.findByText(/原执行包含不能固定的子集引用/);
    expect(composer()).toHaveValue("把这次成功任务整理为可复用的能力包测试版，保留处理规则，把每次可能变化的内容做成参数。");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "发送消息" })); });
    await screen.findByRole("region", { name: "能力包样本测试" });
    expect(mocked.design).toHaveBeenCalledWith(expect.objectContaining({ samplePaths: ["/original/current.csv"], design: expect.objectContaining({ sessionId: "session-2", prompt: expect.stringContaining("原任务：按单位合并当前样本；已验证数量合计。") }) }), expect.any(Function));
    expect(mocked.states.get("session-2")?.sourceTask).toEqual({ sessionId: "session-1", turnId: "current-turn" });
    expect(mocked.sessions.get("session-1")).toEqual(original);
  });

  it("does not offer a draft for a turn without outputs just because the session has older artifacts", async () => {
    completedTask(false);
    await act(async () => { render(workspace()); });
    expect(currentReply().queryByRole("button", { name: "生成能力包测试版" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "生成能力包测试版" })).toHaveLength(1);
    const oldReply = within(screen.getByText("旧轮次已完成").closest("article")!);
    expect(oldReply.getByRole("button", { name: "生成能力包测试版" })).toBeInTheDocument();
    expect(mocked.promote).not.toHaveBeenCalled();
  });
});

describe("Agent execution lifecycle", () => {
  it("does not grant material access for chat and waits for cancellation to finish", async () => {
    let request: SendAgentMessageRequest | undefined;
    let finish: (value: AgentSessionDetail) => void = () => {};
    let emit: ((event: import("./types").AgentEvent) => void) | undefined;
    mocked.send.mockImplementation((value: SendAgentMessageRequest, onEvent: typeof emit) => {
      request = value; emit = onEvent;
      return new Promise<AgentSessionDetail>(resolve => { finish = resolve; });
    });
    render(workspace());
    await send("帮我想两个标题");
    await waitFor(() => expect(mocked.send).toHaveBeenCalledTimes(1));
    expect(request?.allowModelFileAccess).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    expect(mocked.cancel).not.toHaveBeenCalled();
    await act(async () => emit?.({ type: "phase", sessionId: request!.sessionId, turnId: "registered-turn", message: "后台已开始" }));
    await waitFor(() => expect(mocked.cancel).toHaveBeenCalledWith(request!.sessionId, "registered-turn"));
    expect(screen.getByRole("button", { name: "停止任务" })).toBeInTheDocument();
    fireEvent.change(composer(), { target: { value: "下一条消息" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(mocked.send).toHaveBeenCalledTimes(1);
    await act(async () => { finish(structuredClone(mocked.sessions.get(request!.sessionId)!)); });
    expect(await screen.findByRole("button", { name: "发送消息" })).toBeInTheDocument();
    expect(screen.queryByText(/正在停止任务/)).not.toBeInTheDocument();
  });
});
