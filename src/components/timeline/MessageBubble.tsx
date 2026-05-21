import { useMemo, useState } from "react";
import { code } from "@streamdown/code";
import { Check, Code, Copy } from "lucide-react";
import { Streamdown } from "streamdown";
import type * as Types from "../../lib/backend/types";
import { stripThinkingTags } from "../../lib/utils";

const markdownComponents = {
  p: ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
  inlineCode: ({ children }: any) => (
    <code className="bg-snow border border-light-gray px-1.5 py-0.5 rounded-interactive font-mono text-[0.9em] text-pure-black">
      {children}
    </code>
  ),
  ul: ({ children }: any) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li className="text-[14px] leading-relaxed">{children}</li>,
  h1: ({ children }: any) => <h1 className="text-xl font-display font-medium mb-2">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-lg font-display font-medium mb-1.5 mt-3">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-md font-display font-medium mb-1 mt-3">{children}</h3>,
  a: ({ children, href }: any) => (
    <a href={href} className="underline underline-offset-2 hover:text-stone transition-colors">
      {children}
    </a>
  ),
  table: ({ children }: any) => (
    <div className="w-full overflow-x-auto my-2">
      <table className="w-full border-collapse min-w-0">{children}</table>
    </div>
  ),
  thead: ({ children }: any) => <thead className="bg-snow">{children}</thead>,
  tbody: ({ children }: any) => <tbody>{children}</tbody>,
  tr: ({ children }: any) => <tr className="border-b border-light-gray last:border-b-0">{children}</tr>,
  th: ({ children }: any) => (
    <th className="px-3 py-2 text-left text-[13px] font-medium text-near-black border-b border-light-gray">
      {children}
    </th>
  ),
  td: ({ children }: any) => <td className="px-3 py-2 text-[13px] text-pure-black">{children}</td>,
};

type MessageBubbleProps = {
  role: "user" | "agent" | "assistant" | "tool" | "system";
  content: string;
  attachments: Types.AttachmentInput[];
  kind?: string;
  contentJson?: any;
  messageId?: string;
  isLastAgentMessage?: boolean;
};

export function MessageBubble({
  role,
  content,
  attachments,
  kind,
  contentJson,
  messageId,
  isLastAgentMessage,
}: MessageBubbleProps) {
  const isUser = role === "user";
  const isDiff = kind === "diff";
  const [copied, setCopied] = useState(false);

  const displayContent = useMemo(() => {
    if (isUser || isDiff || !content) return content;
    return stripThinkingTags(content).trim();
  }, [content, isDiff, isUser]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const showCopyButton = isUser || isLastAgentMessage;

  if (!displayContent && !isUser && !isDiff && attachments.length === 0) return null;

  return (
    <div className={`group flex w-full ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`flex flex-col gap-1 min-w-0 w-full ${isUser ? "max-w-[95%] md:max-w-[85%] items-end" : "items-start"} mt-0.5`}>
        <div className={`text-chat leading-relaxed break-words min-w-0 w-fit max-w-full ${isUser ? "bg-light-gray px-4 py-2 rounded-container" : "text-pure-black py-2 pl-0 pr-4"}`}>
          {isUser ? (
            <div className="whitespace-pre-wrap">{displayContent}</div>
          ) : isDiff ? (
            <div className="space-y-4 w-full">
              {Array.isArray(contentJson?.diffs) && contentJson.diffs.map((diff: any, idx: number) => (
                <div key={idx} className="border border-light-gray rounded-container overflow-hidden bg-pure-white w-full max-w-full min-w-0">
                  <div className="bg-snow px-3 py-1.5 border-b border-light-gray flex items-center gap-2">
                    <Code className="w-3.5 h-3.5 text-stone" />
                    <span className="text-[11px] font-mono font-medium text-near-black truncate">{diff.path}</span>
                  </div>
                  <pre className="p-3 text-[12px] font-mono overflow-x-auto whitespace-pre">
                    {String(diff.patch ?? "").split("\n").map((line: string, i: number) => {
                      const isAdded = line.startsWith("+");
                      const isRemoved = line.startsWith("-");
                      return (
                        <div key={i} className={`${isAdded ? "bg-snow text-near-black font-medium" : isRemoved ? "bg-light-gray/30 text-stone" : ""}`}>
                          {line}
                        </div>
                      );
                    })}
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            <Streamdown components={markdownComponents} plugins={{ code }} lineNumbers={false}>
              {displayContent || ""}
            </Streamdown>
          )}
          {attachments.length > 0 && (
            <div className="mt-3 space-y-2">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="rounded-interactive border border-light-gray bg-pure-white/80 px-3 py-2 text-[12px] text-stone">
                  <div className="font-medium text-pure-black truncate">{attachment.name}</div>
                  <div className="flex gap-2 flex-wrap">
                    <span>{attachment.kind}</span>
                    <span>{attachment.delivery_preference}</span>
                    {attachment.mime_type && <span>{attachment.mime_type}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {showCopyButton && (
          <button
            type="button"
            onClick={handleCopy}
            className="opacity-0 group-hover:opacity-100 p-1 rounded-full text-stone hover:text-pure-black hover:bg-light-gray transition-all cursor-pointer"
            title="Copy message"
            aria-label={`Copy message ${messageId || ""}`}
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}
