import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentWorkspace from "./AgentWorkspace";
import App from "./App";
import { SkillTestPanel } from "./SkillTestPanel";
import * as backend from "./lib/backend";
import type { AgentTool, AiProfile } from "./types";

const picker = vi.hoisted(() => vi.fn());

vi.mock("./lib/tauriCompat", async original => ({
  ...await original<typeof import("./lib/tauriCompat")>(),
  openDialog: picker,
}));

const draft: AgentTool = {
  id: "sample-intake-review",
  name: "样本导入验收草稿",
  description: "使用虚构表格验证添加样本",
  source: "designed",
  kind: "python",
  supportedExtensions: ["xlsx"],
  parameters: [],
  steps: [],
  available: false,
  availabilityDetail: "等待测试",
  status: "draft",
  testStatus: "untested",
};

const draftIds = new Set<string>();
const profile: AiProfile = {
  id: "sample-intake-review-profile",
  provider: "openai_compatible",
  displayName: "样本导入验收",
  baseUrl: "https://example.invalid/v1",
  defaultModel: "synthetic-review",
  keyStored: true,
};

async function seedDraft(tool = draft) {
  await backend.saveAgentTool(tool);
  draftIds.add(tool.id);
}

async function openLibrary() {
  await act(async () => { render(<App />); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "能力包" })); });
  const all = await screen.findByRole("button", { name: "全部" });
  fireEvent.click(all);
}

async function openDraft(name = draft.name) {
  const card = await screen.findByRole("button", { name: new RegExp(`^${name}`) });
  await act(async () => { fireEvent.click(card); });
  await screen.findByRole("region", { name: "能力包样本测试" });
}

afterEach(async () => {
  picker.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all([...draftIds].map(id => backend.deleteSkill(id)));
  draftIds.clear();
});

describe("sample intake regression", () => {
  it("tests a matching sample when an older capability uses a dotted uppercase extension", () => {
    const run = vi.fn();
    render(<SkillTestPanel skill={{ ...draft, supportedExtensions: [".XLSX"] }} paths={["C:\\Samples\\合成样本.XLSX"]}
      parameters={{}} busy={false} onParameter={vi.fn()} onAdd={vi.fn()} onTest={run} onOpen={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "用当前样本测试" }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs a no-input capability with a required zero parameter and no picker", () => {
    const generate = {
      ...draft,
      supportedExtensions: [],
      parameters: [{ key: "count", label: "补录数量", type: "number" as const, required: true }],
    };
    const run = vi.fn();
    const panel = { skill: generate, paths: [], busy: false, onParameter: vi.fn(), onAdd: vi.fn(), onTest: run, onOpen: vi.fn() };
    const view = render(<SkillTestPanel {...panel} parameters={{}} />);
    const test = () => screen.getByRole("button", { name: "开始测试" });
    expect(screen.queryByRole("button", { name: "添加测试样本" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("请填写“补录数量”");
    expect(test()).toBeDisabled();

    view.rerender(<SkillTestPanel {...panel} parameters={{ count: 0 }} />);
    fireEvent.click(test());
    expect(run).toHaveBeenCalledOnce();
  });

  it("shows one sample picker in the ability detail", async () => {
    await seedDraft();
    await openLibrary();
    await openDraft();

    expect(screen.getAllByRole("button", { name: "添加测试样本" })).toHaveLength(1);
  });

  it("keeps the original role when selecting the same sample again in one design session", async () => {
    await act(async () => {
      render(<AgentWorkspace profile={profile} apiKey="" openModels={() => {}} startInDesignMode />);
    });
    const filename = "重复选择验收.xlsx";
    const sample = `/tmp/zhai-sample-review/${filename}`;
    const add = () => screen.getByTitle("添加文件");
    await waitFor(() => expect(add()).toBeEnabled());

    picker.mockResolvedValueOnce([sample]);
    fireEvent.click(add());
    const role = await screen.findByRole("combobox", { name: filename });
    fireEvent.change(role, { target: { value: "expected_output" } });
    expect(role).toHaveValue("expected_output");

    picker.mockResolvedValueOnce([sample]);
    await act(async () => { fireEvent.click(add()); });
    expect(screen.getAllByRole("combobox", { name: filename })).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: filename })).toHaveValue("expected_output");
  });

  it("starts a design with distinct valid IDs when the webview lacks randomUUID", async () => {
    vi.stubGlobal("crypto", {});
    const sendDesign = vi.spyOn(backend, "designAndTestSkill").mockResolvedValue({ skill: draft });
    await act(async () => {
      render(<AgentWorkspace profile={profile} apiKey="" openModels={() => {}} startInDesignMode />);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "新建设计会话" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "" }), { target: { value: "汇总表格并保留姓名" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "发送消息" })); });

    expect(sendDesign).toHaveBeenCalledOnce();
    const { design, runId } = sendDesign.mock.calls[0][0];
    expect(design.designId).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    expect(runId).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    expect(runId).not.toBe(design.designId);
  });

  it("keeps a Word test when its picker is cancelled and identifies a legacy DOC from general intake", async () => {
    const word = { ...draft, name: "Word 样本验收草稿", supportedExtensions: ["docx"] };
    await seedDraft(word);
    await act(async () => {
      render(<AgentWorkspace profile={profile} apiKey="" openModels={() => {}} designTarget={word} />);
    });
    const addTestSample = () => screen.getByRole("button", { name: "添加测试样本" });
    await waitFor(() => expect(addTestSample()).toBeEnabled());

    picker.mockResolvedValueOnce(["/tmp/zhai-sample-review/现代公文.docx"]);
    fireEvent.click(addTestSample());
    await screen.findByRole("combobox", { name: "现代公文.docx" });
    expect(picker.mock.calls[0][0].filters[0].extensions).toEqual(["docx"]);
    fireEvent.click(screen.getByRole("button", { name: "用当前样本测试" }));
    expect(await screen.findByText("样本执行通过")).toBeVisible();

    picker.mockResolvedValueOnce(null);
    await act(async () => { fireEvent.click(addTestSample()); });
    expect(screen.getByText("样本执行通过")).toBeVisible();

    picker.mockResolvedValueOnce(["/tmp/zhai-sample-review/旧版公文.DOC"]);
    fireEvent.click(screen.getByTitle("添加文件"));
    expect(await screen.findByText(/样本格式不匹配.*旧版公文\.DOC.*docx/)).toBeVisible();
    expect(screen.getByRole("button", { name: "用当前样本测试" })).toBeDisabled();
  });

  it("keeps a passing result on cancelling the picker or selecting the same file", async () => {
    await seedDraft();
    await openLibrary();
    await openDraft();
    const sample = "/tmp/zhai-sample-review/合成样本.xlsx";
    const add = () => screen.getAllByRole("button", { name: "添加测试样本" })[0];

    picker.mockResolvedValueOnce([sample]);
    fireEvent.click(add());
    await screen.findByText("合成样本.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "用当前样本测试" }));
    expect(await screen.findByText("样本执行通过")).toBeVisible();

    picker.mockResolvedValueOnce(null);
    await act(async () => { fireEvent.click(add()); });
    expect(screen.getByText("样本执行通过")).toBeVisible();

    picker.mockResolvedValueOnce([sample]);
    await act(async () => { fireEvent.click(add()); });
    expect(screen.getByText("样本执行通过")).toBeVisible();
    expect(screen.getAllByText("合成样本.xlsx")).toHaveLength(1);
  });

  it("keeps a pending selection in the detail where it was started", async () => {
    const other = { ...draft, id: "sample-intake-other", name: "另一个样本验收草稿" };
    await seedDraft();
    await seedDraft(other);
    await openLibrary();
    await openDraft();
    let choose: (path: string[]) => void = () => {};
    picker.mockImplementationOnce(() => new Promise<string[]>(resolve => { choose = resolve; }));
    fireEvent.click(screen.getAllByRole("button", { name: "添加测试样本" })[0]);
    await waitFor(() => expect(picker).toHaveBeenCalledOnce());

    const close = screen.getByRole("button", { name: "关闭能力包详情" });
    if (close.hasAttribute("disabled")) {
      await act(async () => { choose(["/tmp/zhai-sample-review/原能力样本.xlsx"]); });
      await screen.findByText("原能力样本.xlsx");
      fireEvent.click(close);
      await openDraft(other.name);
    } else {
      fireEvent.click(close);
      await openDraft(other.name);
      await act(async () => { choose(["/tmp/zhai-sample-review/原能力样本.xlsx"]); });
    }

    expect(screen.queryByText("原能力样本.xlsx")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "用当前样本测试" })).toBeDisabled();
  });

  it("restores each draft's own paths, parameter values and test result after switching details", async () => {
    const first: AgentTool = {
      ...draft,
      parameters: [{ key: "label", label: "汇总标题", type: "text", required: true, defaultValue: "原始默认" }],
    };
    const other: AgentTool = {
      ...first,
      id: "sample-intake-other",
      name: "另一个样本验收草稿",
      parameters: [{ ...first.parameters[0], defaultValue: "第二个默认" }],
    };
    await seedDraft(first);
    await seedDraft(other);
    await openLibrary();
    await openDraft();
    picker.mockResolvedValueOnce(["/tmp/zhai-sample-review/能力甲样本.xlsx"]);
    fireEvent.click(screen.getByRole("button", { name: "添加测试样本" }));
    await screen.findByText("能力甲样本.xlsx");
    fireEvent.change(screen.getByRole("textbox", { name: /汇总标题/ }), { target: { value: "能力甲标题" } });
    fireEvent.click(screen.getByRole("button", { name: "用当前样本测试" }));
    expect(await screen.findByText("样本执行通过")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "关闭能力包详情" }));
    await openDraft(other.name);
    expect(screen.getByRole("textbox", { name: /汇总标题/ })).toHaveValue("第二个默认");
    expect(screen.queryByText("能力甲样本.xlsx")).not.toBeInTheDocument();
    expect(screen.queryByText("样本执行通过")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /汇总标题/ }), { target: { value: "能力乙标题" } });

    fireEvent.click(screen.getByRole("button", { name: "关闭能力包详情" }));
    await openDraft();
    expect(screen.getByRole("textbox", { name: /汇总标题/ })).toHaveValue("能力甲标题");
    expect(screen.getByText("能力甲样本.xlsx")).toBeVisible();
    expect(screen.getByText("样本执行通过")).toBeVisible();
  });
});
