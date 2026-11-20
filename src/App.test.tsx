import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { scanSource } from "./lib/backend";
import * as backend from "./lib/backend";

describe("zhai", () => {
  it("桌面重开后沿用上次选择的网关，新增配置保留已有服务", async () => {
    const official = {id:"test-official", provider:"deepseek" as const, displayName:"官方模型", baseUrl:"https://api.deepseek.com", defaultModel:"deepseek-v4-flash", keyStored:true};
    const cloud = {id:"zhai-tianyi", provider:"openai_compatible" as const, displayName:"天翼云", baseUrl:"https://ai.ctaigw.cn/v1", defaultModel:"deepseek-v4-flash-0731-new", keyStored:true};
    const listed = vi.spyOn(backend,"listAiProfiles").mockResolvedValue([official,cloud]);
    try {
      const first = render(<App />);
      fireEvent.click(screen.getByRole("button",{name:"模型服务"}));
      fireEvent.click(await screen.findByRole("button",{name:/天翼云/}));
      first.unmount();
      render(<App />);
      fireEvent.click(screen.getByRole("button",{name:"模型服务"}));
      expect(await screen.findByDisplayValue(cloud.baseUrl)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button",{name:"新增模型配置"}));
      expect(screen.getByPlaceholderText("粘贴后将保存到本机系统凭据库")).toBeInTheDocument();
      expect(screen.getByRole("button",{name:/天翼云/})).toBeInTheDocument();
    } finally {
      localStorage.removeItem("zhai.desktop.activeProfile");
      listed.mockRestore();
    }
  });
  it("无附件能力可填写测试参数、测试发布并运行", async () => {
    await backend.saveAgentTool({id:"generator-ui-check",name:"无附件参数验收",description:"从零生成测试",source:"designed",kind:"python",supportedExtensions:[],available:false,availabilityDetail:"待测试",status:"draft",testStatus:"untested",parameters:[{key:"title",label:"测试标题",type:"text",required:true},{key:"count",label:"测试数量",type:"number",required:true},{key:"mode",label:"测试模式",type:"choice",required:true,choices:["完整","简略"]}],steps:[]});
    const tested = vi.spyOn(backend, "testAndRepairSkill");
    const ran = vi.spyOn(backend, "runSkill").mockResolvedValue({summary:"生成成功",outputDirectory:"/tmp/check",artifacts:[]});
    render(<App />);
    fireEvent.click(screen.getByRole("button", {name:"能力包"}));
    fireEvent.click(await screen.findByRole("button", {name:"全部"}));
    fireEvent.click(await screen.findByRole("button", {name:/^无附件参数验收/}));
    fireEvent.click(await screen.findByRole("button", {name:"开始测试"}));
    expect(tested).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/测试标题/), {target:{value:"部门收集表"}});
    expect(screen.getByLabelText(/测试模式/)).toHaveValue("");
    fireEvent.change(screen.getByLabelText(/测试模式/), {target:{value:"完整"}});
    fireEvent.change(screen.getByLabelText(/测试数量/), {target:{value:"5"}});
    fireEvent.change(screen.getByLabelText(/测试数量/), {target:{value:""}});
    fireEvent.click(screen.getByRole("button", {name:"开始测试"}));
    expect(tested).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/测试数量/), {target:{value:"0"}});
    fireEvent.click(screen.getByRole("button", {name:"开始测试"}));
    await waitFor(() => expect(tested).toHaveBeenCalledWith(expect.objectContaining({skillId:"generator-ui-check", samplePaths:[], parameters:{title:"部门收集表",count:0,mode:"完整"}}), expect.any(Function)));
    await waitFor(() => expect(screen.getByRole("button", {name:"发布给 Agent"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button", {name:"发布给 Agent"}));
    const run = await screen.findByRole("button", {name:"开始运行"});
    expect(run).toBeEnabled();
    fireEvent.click(run);
    await waitFor(() => expect(ran).toHaveBeenCalledWith("generator-ui-check", [], {title:"部门收集表",count:0,mode:"完整"}, expect.any(Function)));
    tested.mockRestore(); ran.mockRestore();
    await backend.deleteSkill("generator-ui-check");
  });
  it("套红能力支持单独选择模板和独立版记参数", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "能力包" }));
    fireEvent.click(await screen.findByRole("button", { name: "全部" }));
    fireEvent.click(await screen.findByRole("button", { name: /公文套红与版记/ }));
    expect(await screen.findByRole("button", { name: "选择红头模板" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加文件夹" })).toBeInTheDocument();
    expect(screen.getByText("版记印发机关（可含办公室）")).toBeInTheDocument();
    expect(screen.getByText("印发日期")).toBeInTheDocument();
  });
  it("展示 zhai 品牌和主要工作入口", async () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "文件 Agent" })).toHaveClass("is-active");
    expect(screen.queryByRole("button", { name: "12345" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "能力包" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "模型服务" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "公文字体" })).not.toBeInTheDocument();
    expect(screen.getByText("文件处理工作台")).toBeInTheDocument();
    expect(screen.getByText("定制你的办公AI")).toBeInTheDocument();
    expect(screen.queryByText(/Codex Harness · codex-cli/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());
    expect(screen.queryByText("有材料就处理，没材料也能从零创建")).not.toBeInTheDocument();
  });

  it("文件 Agent 空白会话直接展示输入框", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());
    expect(screen.queryByText(/直接描述成果/)).not.toBeInTheDocument();
    expect(screen.queryByText("确认处理计划")).not.toBeInTheDocument();
    expect(screen.queryByText("生成处理计划")).not.toBeInTheDocument();
  });

  it("没有附件时仍可直接输入从零创建需求", async () => {
    render(<App />);
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "帮我生成一份 Word" } });
    expect((input as HTMLTextAreaElement).value).toContain("生成一份 Word");
    expect(screen.getByRole("checkbox", { name: "允许模型读取材料正文" })).not.toBeChecked();
  });

  it("文件 Agent 默认不向模型发送本地文件内容", async () => {
    render(<App />);
    const accessSwitch = await screen.findByRole("checkbox", {
      name: "允许模型读取材料正文",
    });
    expect(accessSwitch).not.toBeChecked();
    expect(screen.getByText("本地内容不上网")).toBeInTheDocument();
    fireEvent.click(accessSwitch);
    expect(accessSwitch).toBeChecked();
    expect(screen.getByText("允许模型读正文")).toBeInTheDocument();
    expect(await screen.findByText("浏览器预览不执行临时脚本。")).toBeInTheDocument();
  });

  it("能力包设计保留原有三栏对话布局并提供验收引导", async () => {
    const { container } = render(<App />);
    const design = await screen.findByRole("button", { name: /设计能力包/ });
    await waitFor(() => expect(design).toBeEnabled());
    fireEvent.click(design);
    expect(container.querySelector(".app-shell")).not.toHaveClass("design-focus");
    expect(container.querySelector(".agent-workspace")).not.toHaveClass("skill-design-workspace");
    expect(container.querySelector(".session-column")).toBeInTheDocument();
    expect(container.querySelector(".context-column")).toBeInTheDocument();
    expect(screen.queryByText("能力包设计工作台")).not.toBeInTheDocument();
    expect(screen.queryByText("结构校验")).not.toBeInTheDocument();
    expect(await screen.findByText("1. 添加样本")).toBeInTheDocument();
    expect(screen.getByText("2. 说清规则")).toBeInTheDocument();
    expect(screen.getByText("3. 测试发布")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "公文套版" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("批量处理 DOC 和 DOCX");
    fireEvent.click(screen.getByRole("button", { name: /处理材料/ }));
  });

  it("切换到能力包页面不会卸载正在工作的文件 Agent", async () => {
    const { container } = render(<App />);
    const design = await screen.findByRole("button", { name: /设计能力包/ });
    await waitFor(() => expect(design).toBeEnabled());
    fireEvent.click(design);
    expect(await screen.findByRole("button", { name: "新建设计会话" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "能力包" }));
    expect(container.querySelector(".persistent-agent-view")).toHaveAttribute("hidden");
    expect(await screen.findByText("选择能力包，直接处理材料")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "文件 Agent" }));
    expect(container.querySelector(".persistent-agent-view")).not.toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "新建设计会话" })).toBeInTheDocument();
  });

  it("能力包页只负责查找、管理和运行能力", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "能力包" }));
    expect(await screen.findByText("选择能力包，直接处理材料")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /在 Agent 中设计能力包/ })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "搜索能力包" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Word" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Excel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PDF" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "数据" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.queryByText("本地")).not.toBeInTheDocument();
    expect(screen.getByText("需联网")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /Markdown 生成公文版式/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /CSV 转|转 CSV/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /合并 Excel 数据/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /现有 Word 一键公文排版/ }));
    await screen.findByRole("button", { name: "关闭能力包详情" });
    expect(document.querySelector(".skill-detail")).toHaveClass("is-content-screen");
    expect(document.querySelector(".side-rail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭能力包详情" })).toHaveTextContent("返回能力包库");
    expect(await screen.findByText("添加材料")).toBeInTheDocument();
    expect(screen.getByText("可选设置")).toBeInTheDocument();
    expect(screen.getByText("不修改的项目自动采用能力包默认值")).toBeInTheDocument();
    expect(screen.getByText("保留原有加粗")).toBeInTheDocument();
    expect(screen.getByText("主送机关识别")).toBeInTheDocument();
    expect(screen.getByText("落款排版模式")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加文件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加文件夹" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始运行" })).toBeDisabled();
  });

  it("12345 核心能力位于能力包中", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "能力包" }));
    await screen.findByText("选择能力包，直接处理材料");
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.getByRole("button", { name: /12345 市民回复/ })).toBeInTheDocument();
  });

  it("模型密钥默认保存到本机系统凭据库", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "模型服务" }));
    expect(await screen.findByPlaceholderText("粘贴后将保存到本机系统凭据库")).toBeInTheDocument();
    expect(screen.getByText("授权一次，长期使用")).toBeInTheDocument();
    expect(screen.getByText(/重启后继续使用/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存配置" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /V4 Flash/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /V4 Pro/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "DeepSeek" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "其他兼容服务" })).toBeInTheDocument();
    for (const name of ["OpenAI", "Claude", "Gemini"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("旧接口配置保留参数与凭据，用户保存后才切换兼容接口", async () => {
    const legacy = { id: "legacy-service", provider: "anthropic" as const, displayName: "旧服务", baseUrl: "https://legacy.example/v1", defaultModel: "old-model", keyStored: true };
    const listed = vi.spyOn(backend, "listAiProfiles").mockResolvedValue([legacy]);
    const saved = vi.spyOn(backend, "saveAiProfile").mockResolvedValue({ ...legacy, provider: "openai_compatible" });
    try {
      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "模型服务" }));
      await screen.findByText(/此配置使用已移除的专用接口/);
      expect(await screen.findByDisplayValue(legacy.baseUrl)).toBeInTheDocument();
      expect(screen.getByDisplayValue(legacy.defaultModel)).toBeInTheDocument();
      expect(screen.getByPlaceholderText("已安全保存；如需更换，请粘贴新 Key")).toBeInTheDocument();
      expect(saved).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
      await waitFor(() => expect(saved).toHaveBeenCalledWith({ id: legacy.id, provider: "openai_compatible", displayName: legacy.displayName, baseUrl: legacy.baseUrl, defaultModel: legacy.defaultModel, apiKey: undefined }));
      await waitFor(() => expect(screen.queryByText(/此配置使用已移除的专用接口/)).not.toBeInTheDocument());
    } finally {
      listed.mockRestore();
      saved.mockRestore();
    }
  });

  it("单文件扫描结果始终只有所选文件", async () => {
    const result = await scanSource(
      { kind: "file", path: "/Users/demo/Documents/专项材料/单份通知.pdf" },
      { recursive: true, followSymlinks: false, extensions: ["pdf"], exclusions: [] },
    );
    expect(result.summary.totalFiles).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe("单份通知.pdf");
  });

  it("文件夹格式过滤不会把 Word 纳入 PDF 任务", async () => {
    const result = await scanSource(
      { kind: "folder", path: "/Users/demo/Documents/专项材料" },
      { recursive: true, followSymlinks: false, extensions: ["pdf"], exclusions: [] },
    );
    expect(result.files.map((item) => item.extension)).toEqual(["pdf"]);
    expect(result.summary.excludedByFormat.docx).toBe(1);
  });
});
