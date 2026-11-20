import type { AgentAttachment, AgentMessage } from "../types";

export function webTurnMaterials(materials: AgentAttachment[], messages: AgentMessage[], explicit?: string[]) {
  const turns = messages.filter(message => message.role === "user" && !message.id.startsWith("pending-"));
  const last = turns[turns.length - 1];
  const available = new Set(materials.map(item => item.id));
  const fresh = materials.filter(item => !last || Date.parse(item.createdAt) > Date.parse(last.createdAt)).map(item => item.id);
  const ids = (explicit ?? (fresh.length ? fresh : last?.attachmentIds || [])).filter(id => available.has(id));
  return { ids, fresh };
}
