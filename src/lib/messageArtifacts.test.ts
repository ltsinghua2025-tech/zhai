import { describe, expect, it } from "vitest";
import { artifactsForMessage } from "./messageArtifacts";
import type { AgentAttachment, AgentMessage } from "../types";

const messages: AgentMessage[] = [
  { id: "u1", sessionId: "s", role: "user", content: "排版", createdAt: "2026-09-26T10:00:00Z", turnId: "t1" },
  { id: "a1", sessionId: "s", role: "assistant", content: "处理中", createdAt: "2026-09-26T10:00:05Z", turnId: "t1" },
  { id: "a2", sessionId: "s", role: "assistant", content: "完成", createdAt: "2026-09-26T10:00:20Z", turnId: "t1" },
  { id: "u2", sessionId: "s", role: "user", content: "再处理", createdAt: "2026-09-26T10:01:00Z", turnId: "t2" },
  { id: "a3", sessionId: "s", role: "assistant", content: "完成", createdAt: "2026-09-26T10:01:20Z", turnId: "t2" },
];

function group(id: string, createdAt: string) {
  const item: AgentAttachment = { id, sessionId: "s", kind: "artifact", name: `${id}.docx`, createdAt, localSnapshotPath: `/tmp/${id}.docx` };
  return { key: id, name: item.name, items: [item] };
}

describe("conversation artifact links", () => {
  it("shows a turn's file only beneath its final reply", () => {
    const groups = [group("first", "2026-09-26T10:00:10Z"), group("second", "2026-09-26T10:01:10Z")];
    expect(artifactsForMessage(messages[1], messages, groups)).toEqual([]);
    expect(artifactsForMessage(messages[2], messages, groups).map((item) => item.key)).toEqual(["first"]);
    expect(artifactsForMessage(messages[4], messages, groups).map((item) => item.key)).toEqual(["second"]);
  });
});
