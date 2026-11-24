import { useMemo, useRef } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Typography } from "@douyinfe/semi-ui";
import { extractHeadings, highlightTokens } from "./reportFormat";

const plugins = [remarkGfm];

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  const code = String(children ?? "").replace(/\n$/, "");
  if (!lang) return <code className={className}>{children}</code>;
  const tokens = highlightTokens(code, lang);
  return (
    <code className={`gy-code gy-code-${lang}`}>
      {tokens.map((token, i) => (
        <span key={i} className={`gy-tok-${token.type}`}>{token.text}</span>
      ))}
    </code>
  );
}

/** 专业报告视图：目录 + Markdown 富文本（标题锚点、表格、代码着色）。 */
export function ReportMarkdown({ text }: { text: string }) {
  const headings = useMemo(() => extractHeadings(text), [text]);
  const counter = useRef(0);
  counter.current = 0;

  const heading = (level: number) => {
    const Tag = `h${level}` as keyof JSX.IntrinsicElements;
    return ({ children }: { children?: React.ReactNode }) => {
      const id = level <= 4 ? `gy-report-h-${counter.current++}` : undefined;
      return <Tag id={id} className="gy-report-heading">{children}</Tag>;
    };
  };

  const components: Components = {
    h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4),
    table: ({ children }) => <div className="gy-markdown-table"><table>{children}</table></div>,
    code: CodeBlock as Components["code"],
    img: ({ alt, src }) => <span>{alt || src || "图片"}</span>,
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
  };

  if (!text.trim()) {
    return <Typography.Text type="tertiary">暂无报告内容。</Typography.Text>;
  }

  return (
    <div className="gy-report">
      {headings.length > 0 && (
        <nav className="gy-report-toc" aria-label="报告目录">
          <Typography.Text strong size="small" style={{ display: "block", marginBottom: 8 }}>目录</Typography.Text>
          <ul>
            {headings.map((h) => (
              <li key={h.id} className={`gy-report-toc-l${h.level}`}>
                <a href={`#${h.id}`} onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}>{h.text}</a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <div className="gy-report-body gy-markdown">
        <Markdown remarkPlugins={plugins} components={components}>{text}</Markdown>
      </div>
    </div>
  );
}