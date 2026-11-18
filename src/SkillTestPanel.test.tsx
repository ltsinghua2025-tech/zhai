import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SkillTestPanel } from "./SkillTestPanel";
import type { AgentTool, SkillTestResult } from "./types";

const skill: AgentTool = { id: "test-table", name: "表格转换", description: "样本转换", source: "designed", supportedExtensions: ["csv", "xlsx"], available: true, availabilityDetail: "", parameters: [{ key: "column", label: "目标列", type: "text", required: true }], steps: [], status: "draft", testStatus: "untested" };
function props(overrides: Partial<React.ComponentProps<typeof SkillTestPanel>> = {}) {
  return { skill, paths: ["/sample/input.csv"], parameters: { column: "姓名" }, busy: false, onParameter: vi.fn(), onAdd: vi.fn(), onTest: vi.fn(), onRepair: vi.fn(), onOpen: vi.fn(), onPublish: vi.fn(), ...overrides };
}

describe("capability sample testing", () => {
  it("keeps the upload entry visible and explains incompatible formats before execution", () => {
    const callbacks = props({ paths: ["/sample/原始材料.docx"] });
    const view = render(<SkillTestPanel {...callbacks} />);
    expect(screen.getByRole("status")).toHaveTextContent("原始材料.docx");
    expect(screen.getByRole("status")).toHaveTextContent("csv、xlsx");
    expect(screen.getByRole("button", { name: "用当前样本测试" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "添加测试样本" }));
    expect(callbacks.onAdd).toHaveBeenCalledOnce();
    expect(callbacks.onTest).not.toHaveBeenCalled();
    view.rerender(<SkillTestPanel {...callbacks} paths={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("请添加至少一份原始样本");
    expect(screen.getByRole("button", { name: "添加测试样本" })).toBeEnabled();
  });

  it("requires business inputs, accepts uppercase extensions, and forwards edited values", () => {
    const callbacks = props({ paths: ["/sample/INPUT.CSV"], parameters: {} });
    const view = render(<SkillTestPanel {...callbacks} />);
    expect(screen.getByRole("status")).toHaveTextContent("请填写“目标列”");
    fireEvent.change(screen.getByRole("textbox", { name: "目标列必填" }), { target: { value: "单位" } });
    expect(callbacks.onParameter).toHaveBeenCalledWith("column", "单位");
    view.rerender(<SkillTestPanel {...callbacks} parameters={{ column: "单位" }} />);
    fireEvent.click(screen.getByRole("button", { name: "用当前样本测试" }));
    expect(callbacks.onTest).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "发布能力包" })).toBeDisabled();
  });

  it("offers automatic repair only for repairable failure and blocks duplicate work while busy", () => {
    const result: SkillTestResult = { status: "failed", summary: "执行时缺少字段", outputs: [], parameters: { column: "姓名" }, repairable: true };
    const callbacks = props({ result });
    const view = render(<SkillTestPanel {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "自动修复并重测" }));
    expect(callbacks.onRepair).toHaveBeenCalledOnce();
    view.rerender(<SkillTestPanel {...callbacks} busy />);
    expect(screen.getByRole("button", { name: "自动修复并重测" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新测试" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "目标列必填" })).toBeDisabled();
    view.rerender(<SkillTestPanel {...callbacks} result={{ ...result, status: "needs_input", repairable: false }} />);
    expect(screen.queryByRole("button", { name: "自动修复并重测" })).not.toBeInTheDocument();
  });

  it("opens retained successful outputs and distinguishes network-dependent capabilities", () => {
    const callbacks = props({ skill: { ...skill, testStatus: "passed", requiresNetwork: true }, result: { status: "passed", summary: "样本校验成功", outputs: ["/result/output.xlsx"], outputDirectory: "/result", parameters: { column: "姓名" }, repairable: false } });
    render(<SkillTestPanel {...callbacks} />);
    expect(screen.getByText(/需联网 · 1 份原始样本/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开测试成果" }));
    expect(callbacks.onOpen).toHaveBeenCalledWith("/result");
    expect(screen.getByRole("button", { name: "发布能力包" })).toBeEnabled();
    expect(screen.getByText(/当前样本通过不代表所有材料都适用/)).toBeInTheDocument();
  });
});
