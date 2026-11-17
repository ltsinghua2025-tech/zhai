import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AgentWorkspace from "./AgentWorkspace";

const opened = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./lib/backend", async (original) => {
  const actual = await original<typeof import("./lib/backend")>();
  const session = {
    id: "artifact-session", title: "测试会话", profileId: "deepseek", model: "deepseek-v4-flash",
    status: "idle" as const, createdAt: "2026-09-26T10:00:00Z", updatedAt: "2026-09-26T10:00:20Z", workspacePath: "/tmp/session",
  };
  const artifact = {
    id: "final-docx", sessionId: session.id, kind: "artifact" as const, name: "排版成果.docx",
    localSnapshotPath: "/tmp/session/排版成果.docx", createdAt: "2026-09-26T10:00:10Z",
  };
  return {
    ...actual,
    listAgentSessions: async () => [session],
    getAgentSession: async () => ({
      session,
      messages: [
        { id: "u", sessionId: session.id, role: "user", content: "帮我排版", createdAt: "2026-09-26T10:00:00Z", turnId: "turn" },
        { id: "a", sessionId: session.id, role: "assistant", content: "已完成", createdAt: "2026-09-26T10:00:20Z", turnId: "turn" },
      ],
      attachments: [artifact], toolRuns: [],
    }),
    openAgentArtifact: opened,
  };
});

describe("conversation file opening", () => {
  it("opens the persisted final artifact from the assistant reply", async () => {
    render(<AgentWorkspace profile={{ id: "deepseek", provider: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", keyStored: true }} apiKey="" openModels={() => {}} />);
    const link = await screen.findByRole("button", { name: "排版成果.docx" });
    fireEvent.click(link);
    await waitFor(() => expect(opened).toHaveBeenCalledWith("artifact-session", expect.objectContaining({ id: "final-docx" })));
  });
});
