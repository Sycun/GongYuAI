import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];
const components: Components = {
  table: ({ children }) => <div className="gy-markdown-table"><table>{children}</table></div>,
  // Messages may contain external image URLs. Show their descriptions without fetching them.
  img: ({ alt, src }) => <span>{alt || src || "图片"}</span>,
};

export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return <div className="gy-markdown"><Markdown remarkPlugins={plugins} components={components}>{text}</Markdown></div>;
});
