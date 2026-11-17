import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MarkdownMessage, { MessageRenderBoundary } from "./MarkdownMessage";

describe("MarkdownMessage", () => {
  it("单条回复渲染失败时保留文本和其他界面", () => {
    function BrokenReply(): never { throw new Error("测试：不支持的表达式"); }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<><button>新会话</button><MessageRenderBoundary text="公文已处理，成果.docx"><BrokenReply /></MessageRenderBoundary></>);
      expect(screen.getByText("公文已处理，成果.docx")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "新会话" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("已切换为纯文本");
    } finally { consoleError.mockRestore(); }
  });
  it("渲染加粗和列表而不暴露 Markdown 星号", () => {
    render(<MarkdownMessage>{"**页面**\n\n- A4\n- 28 磅行距"}</MarkdownMessage>);
    expect(screen.getByText("页面").tagName).toBe("STRONG");
    expect(screen.getByText("A4").closest("li")).toBeInTheDocument();
    expect(screen.queryByText("**页面**")).not.toBeInTheDocument();
  });

  it("不执行模型输出中的原始 HTML", () => {
    const { container } = render(
      <MarkdownMessage>{"<script>window.bad = true</script>正常文本"}</MarkdownMessage>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("正常文本")).toBeInTheDocument();
  });

  it("渲染 HTTPS 和应用资产图片", () => {
    render(<MarkdownMessage>{"![流程图](https://example.com/flow.png)\n\n![本地附件](asset://localhost/guide.png)"}</MarkdownMessage>);
    expect(screen.getByRole("img", { name: "流程图" })).toHaveAttribute("src", "https://example.com/flow.png");
    expect(screen.getByRole("img", { name: "本地附件" })).toHaveAttribute("src", "asset://localhost/guide.png");
  });

  it("拒绝未经授权的本机、相对和脚本图片路径", () => {
    render(<MarkdownMessage>{"![本机](file:///Users/example/private.png)\n\n![相对路径](images/guide.png)\n\n![脚本](javascript:alert(1))"}</MarkdownMessage>);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("[图片：本机无法加载]")).toBeInTheDocument();
    expect(screen.getByText("[图片：相对路径无法加载]")).toBeInTheDocument();
    expect(screen.getByText("[图片：脚本无法加载]")).toBeInTheDocument();
  });

  it("图片请求失败时回退为可读提示", () => {
    render(<MarkdownMessage>{"![流程图](https://example.com/missing.png)"}</MarkdownMessage>);
    fireEvent.error(screen.getByRole("img", { name: "流程图" }));
    expect(screen.getByText("[图片：流程图无法加载]")).toBeInTheDocument();
  });
});
