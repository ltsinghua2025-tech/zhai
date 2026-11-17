import { Component, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfmCompat from "./lib/remarkGfmCompat";

type Props = {
  children: string;
};

function safeImageSource(src: string | undefined) {
  if (!src) return undefined;
  try {
    const url = new URL(src);
    if (url.protocol === "https:" || url.protocol === "asset:") return src;
    // Tauri on Windows and Linux serves asset-protocol files through this
    // origin instead of the asset: scheme.
    if (url.origin === "http://asset.localhost") return src;
  } catch {
    // Relative paths have no stable base in a chat message. In particular,
    // never let them resolve to an arbitrary path in the WebView.
  }
  return undefined;
}

function MarkdownImage({ alt, src }: { alt?: string; src?: string }) {
  const [failed, setFailed] = useState(false);
  const safeSrc = safeImageSource(src);
  if (!safeSrc || failed) {
    return <span className="markdown-image-placeholder">[图片：{alt || "未命名"}无法加载]</span>;
  }
  return (
    <img
      className="markdown-image"
      src={safeSrc}
      alt={alt || "Markdown 图片"}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export class MessageRenderBoundary extends Component<
  { text: string; children: ReactNode }, { error?: string }
> {
  state: { error?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.error) {
      return <div className="message-markdown">
        <p role="status">这条回复的格式显示失败，已切换为纯文本。</p>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{this.props.text}</div>
        <details><summary>显示错误详情</summary><pre>{this.state.error}</pre></details>
      </div>;
    }
    return this.props.children;
  }
}

export default function MarkdownMessage({ children }: Props) {
  const safeMarkdown = children
    .replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed)\b[^>]*\/?>/gi, "");
  return (
    <MessageRenderBoundary text={safeMarkdown}>
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfmCompat]}
        skipHtml
        urlTransform={(url, key) =>
          key === "src" ? safeImageSource(url) || "" : defaultUrlTransform(url)
        }
        components={{
          a: ({ children: label, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {label}
            </a>
          ),
          img: ({ alt, src }) => <MarkdownImage alt={alt} src={src} />,
        }}
      >
        {safeMarkdown}
      </ReactMarkdown>
    </div>
    </MessageRenderBoundary>
  );
}
