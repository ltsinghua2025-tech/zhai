import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import AgentWorkspace from "./AgentWorkspace";
import * as backend from "./lib/backend";
import type { AgentTool, AiProfile, SkillDesignState } from "./types";

const profile: AiProfile = {
  id: "test-design", provider: "openai_compatible", displayName: "本地测试",
  baseUrl: "https://example.invalid/v1", defaultModel: "example", keyStored: true,
};
const skill: AgentTool = {
  id: "greeting-test-existing", name: "登记汇总", description: "生成汇总表",
  source: "designed", kind: "python", parameters: [], steps: [], supportedExtensions: [],
  status: "draft", testStatus: "passed", available: true, availabilityDetail: "已测试",
};
const renderWorkspace = (fresh = true) => render(
  <AgentWorkspace profile={profile} apiKey="" openModels={() => {}} startInDesignMode={fresh} />,
);
const composer = () => screen.getByRole("textbox", { name: "" });
async function enterText(text: string) {
  await waitFor(() => expect(screen.getByRole("button", { name: "新建设计会话" })).toBeEnabled());
  fireEvent.change(composer(), { target: { value: text } });
  const button = screen.getByRole("button", { name: "发送消息" });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}
afterEach(() => vi.restoreAllMocks());

it("answers a greeting in a fresh design and restores both messages without generating a skill", async () => {
  const design = vi.spyOn(backend, "designAndTestSkill").mockResolvedValue({ skill });
  const view = renderWorkspace();
  fireEvent.click(await enterText("你好"));
  await screen.findByText("你好", { selector: "article.user p" });
  const session = (await backend.listAgentSessions())[0];
  await waitFor(async () => {
    const state = await backend.getSkillDesignState(session.id);
    expect(state?.messages).toEqual([
      { role: "user", content: "你好" }, { role: "assistant", content: expect.stringMatching(/材料|样本|能力包/) },
    ]);
    expect(state?.skillId).toBeUndefined();
    expect(design).not.toHaveBeenCalled();
  });
  view.unmount();
  renderWorkspace(false);
  expect(await screen.findByText("你好", { selector: "article.user p" })).toBeVisible();
  expect(screen.getByText(/材料|样本|能力包/, { selector: "article.assistant p" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "能力包样本测试" })).toBeNull();
});

it("keeps an existing draft, its parameters and its passing test when greeted", async () => {
  const design = vi.spyOn(backend, "designAndTestSkill").mockResolvedValue({ skill });
  const session = await backend.createAgentSession({ profileId: profile.id, model: profile.defaultModel });
  await backend.saveAgentTool(skill);
  const prior: SkillDesignState = {
    designId: "existing-design", skillId: skill.id, messages: [],
    attachmentRoles: {}, parameters: { column: "单位" },
    testResult: { status: "passed", summary: "原有样本已通过", parameters: { column: "单位" }, outputs: [], repairable: false },
  };
  await backend.saveSkillDesignState(session.id, prior);
  renderWorkspace(false);
  expect(await screen.findByText("原有样本已通过")).toBeVisible();
  fireEvent.click(await enterText("您好！"));
  await screen.findByText("您好！", { selector: "article.user p" });
  await waitFor(async () => {
    const state = await backend.getSkillDesignState(session.id);
    expect(state?.messages).toHaveLength(2);
    expect({ ...state, messages: [] }).toEqual(prior);
  });
  expect(screen.getByText("原有样本已通过")).toBeVisible();
  expect(screen.getByRole("button", { name: "发布能力包" })).toBeEnabled();
  expect(design).not.toHaveBeenCalled();
});

it("keeps the full substantive request after an opening greeting and submits it once", async () => {
  const design = vi.spyOn(backend, "designAndTestSkill").mockResolvedValue({ skill });
  renderWorkspace();
  const prompt = "你好，请把多份 Word 报表按单位汇总为 Excel。";
  fireEvent.click(await enterText(prompt));
  await waitFor(() => expect(design).toHaveBeenCalledTimes(1));
  expect(design.mock.calls[0][0].design.prompt).toBe(prompt);
  await screen.findByRole("region", { name: "能力包样本测试" });
});

it.each([{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }])(
  "does not submit Chinese composition Enter and submits the committed request on plain Enter ($keyCode)",
  async composition => {
    const design = vi.spyOn(backend, "designAndTestSkill").mockResolvedValue({ skill });
    renderWorkspace();
    const prompt = "设计公文排版能力";
    await enterText(prompt);
    await act(async () => { fireEvent.keyDown(composer(), { key: "Enter", ...composition }); });
    expect(composer()).toHaveValue(prompt);
    expect(design).not.toHaveBeenCalled();
    fireEvent.keyDown(composer(), { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(design).toHaveBeenCalledTimes(1));
    await screen.findByRole("region", { name: "能力包样本测试" });
  },
);
