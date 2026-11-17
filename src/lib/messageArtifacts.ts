import type { AgentAttachment, AgentMessage } from "../types";

export type ArtifactGroup = { key: string; name: string; items: AgentAttachment[] };

/** Attach delivered files to the final reply of the turn that produced them. */
export function artifactsForMessage(
  message: AgentMessage,
  messages: AgentMessage[],
  groups: ArtifactGroup[],
): ArtifactGroup[] {
  if (message.role !== "assistant") return [];
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return [];
  const nextUserIndex = messages.findIndex((item, position) => position > index && item.role === "user");
  const endIndex = nextUserIndex < 0 ? messages.length : nextUserIndex;
  if (messages.slice(index + 1, endIndex).some((item) => item.role === "assistant")) return [];
  const previousUser = messages.slice(0, index).reverse().find((item) => item.role === "user");
  if (!previousUser) return [];
  const start = Date.parse(previousUser.createdAt);
  const end = nextUserIndex < 0 ? Infinity : Date.parse(messages[nextUserIndex].createdAt);
  if (!Number.isFinite(start)) return [];
  return groups.filter((group) => group.items.some((item) => {
    const created = Date.parse(item.createdAt);
    return Number.isFinite(created) && created >= start && created < end;
  }));
}
