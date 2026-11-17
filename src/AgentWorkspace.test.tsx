import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AgentWorkspace from "./AgentWorkspace";
import { getAgentSession } from "./lib/backend";
import type { AgentSessionDetail, SendAgentMessageRequest, DesignToolRequest, SkillDesignEvent } from "./types";

const mocked = vi.hoisted(() => ({ send: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined), design: vi.fn(), cancelDesign: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./lib/backend", async (original) => ({
  ...await original<typeof import("./lib/backend")>(),
  sendAgentMessage: mocked.send,
  cancelAgentTurn: mocked.cancel,
  designAgentTool: mocked.design,
  cancelSkillDesign: mocked.cancelDesign,
}));

describe("Agent execution lifecycle", () => {
  it("resumes a timed out design and stays busy until cancellation actually finishes", async () => {
    let rejectDesign: ((reason: Error) => void) | undefined;
    mocked.design.mockImplementation((_request: DesignToolRequest, emit: (event: SkillDesignEvent) => void) => {
      emit({ type: "started", designId: "preserved-design" });
      emit({ type: "phase", phase: "editing", message: "正在编辑", elapsedSeconds: 7 });
      return new Promise((_resolve, reject) => { rejectDesign = reject; });
    });
    render(<AgentWorkspace startInDesignMode profile={{ id: "deepseek", provider: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", keyStored: true }} apiKey="" openModels={() => {}} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "设计合并能力" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(mocked.design).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText("正在编辑 · 7 秒").length).toBeGreaterThan(0);
    await act(async () => { rejectDesign!(new Error("设计超时，草稿已保留")); });
    fireEvent.change(input, { target: { value: "继续完成测试" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(mocked.design).toHaveBeenCalledTimes(2));
    expect(mocked.design.mock.calls[1][0].designId).toBe("preserved-design");
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    await waitFor(() => expect(mocked.cancelDesign).toHaveBeenCalledWith("preserved-design"));
    expect(screen.getByRole("button", { name: "停止任务" })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocked.design).toHaveBeenCalledTimes(2);
    await act(async () => { rejectDesign!(new Error("技能设计已取消")); });
    expect(await screen.findByRole("button", { name: "发送消息" })).toBeInTheDocument();
  });

  it("does not grant material access for chat and waits for cancellation to finish", async () => {
    let request: SendAgentMessageRequest | undefined;
    let finish: ((value: AgentSessionDetail) => void) | undefined;
    mocked.send.mockImplementation((value: SendAgentMessageRequest) => {
      request = value;
      return new Promise<AgentSessionDetail>((resolve) => { finish = resolve; });
    });
    render(<AgentWorkspace profile={{ id: "deepseek", provider: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", keyStored: true }} apiKey="" openModels={() => {}} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "帮我想两个标题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(mocked.send).toHaveBeenCalledTimes(1));
    expect(request?.allowModelFileAccess).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    await waitFor(() => expect(mocked.cancel).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "停止任务" })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "下一条消息" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocked.send).toHaveBeenCalledTimes(1);
    const detail = await getAgentSession(request!.sessionId);
    await act(async () => { finish!(detail); });
    expect(await screen.findByRole("button", { name: "发送消息" })).toBeInTheDocument();
    expect(screen.queryByText(/正在停止任务/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设计能力包" }));
    expect(screen.queryByText(/正在停止任务/)).not.toBeInTheDocument();
  });
});
