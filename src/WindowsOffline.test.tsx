import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import * as backend from "./lib/backend";
import * as platform from "./lib/tauriCompat";
import type { AgentTool } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("Windows 离线版从本机工具库选文件运行，全程无需 Agent 或模型档案", async () => {
  vi.stubEnv("VITE_WINDOWS_OFFLINE", "1");
  const tool: AgentTool = {
    id: "merge_excel", name: "合并 Excel 数据", description: "汇总表格", source: "builtin",
    supportedExtensions: ["xlsx"], available: true, availabilityDetail: "可用", parameters: [], steps: [],
  };
  vi.spyOn(backend, "listAgentTools").mockResolvedValue([
    tool, { ...tool, id: "network", name: "联网工具", requiresNetwork: true },
    { ...tool, id: "permissions", name: "需要网络权限", permissions: ["network"] },
    { ...tool, id: "missing", name: "组件缺失", available: false },
    { ...tool, id: "draft", name: "未发布", status: "draft" },
    { ...tool, id: "custom", name: "自建脚本", source: "designed" },
  ]);
  vi.spyOn(backend, "getSkill").mockResolvedValue(tool);
  const profiles = vi.spyOn(backend, "listAiProfiles");
  const sessions = vi.spyOn(backend, "listAgentSessions");
  const file = "C:\\材料\\部门汇总.xlsx";
  vi.spyOn(platform, "openDialog").mockResolvedValue([file]);
  const run = vi.spyOn(backend, "runSkill").mockResolvedValue({
    summary: "已生成汇总表", artifacts: [], outputDirectory: "C:\\结果",
  });

  render(<App />);
  const row = await screen.findByRole("button", { name: /合并 Excel 数据/ });
  expect(screen.getByRole("button", { name: "全部" })).toHaveClass("is-active");
  expect(screen.queryByRole("button", { name: /模型服务|文件 Agent|联网工具|需要网络权限|组件缺失|未发布|自建/ })).toBeNull();
  fireEvent.click(row);
  fireEvent.click(await screen.findByRole("button", { name: "添加文件" }));
  expect(await screen.findByText(file)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /设计|基于此能力调整|模型/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await waitFor(() => expect(run).toHaveBeenCalledWith(tool.id, [file], {}, expect.any(Function)));
  expect(await screen.findByRole("button", { name: "打开成果文件夹" })).toBeInTheDocument();
  expect(profiles).not.toHaveBeenCalled();
  expect(sessions).not.toHaveBeenCalled();
});
