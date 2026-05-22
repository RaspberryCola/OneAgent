import { Bot, Trash2, X, MessageCircle } from "lucide-react";
import type * as Types from "../../lib/backend/types";

type SidebarItemProps = {
  title: string;
  agentCommand?: string;
  status?: Types.Conversation["status"];
  imSource?: string;
  unread?: boolean;
  active?: boolean;
  onClick?: () => void;
  deletePending?: boolean;
  onDelete?: () => void;
  onCancelDelete?: () => void;
  renderAgentLogo?: (agentCommand: string, className: string) => React.ReactNode;
};

export function SidebarItem({
  title,
  agentCommand,
  status,
  imSource,
  unread = false,
  active = false,
  onClick,
  deletePending = false,
  onDelete,
  onCancelDelete,
  renderAgentLogo,
}: SidebarItemProps) {
  const isRunning = status === "running";
  const isCancelling = status === "cancelling";
  const showCompletedDot = unread && !active && !isRunning && !isCancelling;

  return (
    <div
      className={`group w-full rounded-container flex items-center gap-1 min-w-0 border border-transparent transition-colors ${active ? "bg-light-gray" : "hover:bg-light-gray/50"}`}
    >
      <button
        type="button"
        onClick={onClick}
        className="md:min-h-0 min-h-[44px] flex-1 text-left px-3 py-2 flex items-center gap-2.5 min-w-0 rounded-container"
      >
        <div className={`relative w-4 h-4 flex items-center justify-center shrink-0 ${active ? "opacity-100" : "opacity-40"}`}>
          {agentCommand && renderAgentLogo ? renderAgentLogo(agentCommand, "w-3.5 h-3.5") : <Bot className="w-3.5 h-3.5" />}
          {(isRunning || isCancelling) && (
            <div
              className={`absolute left-0 top-1/2 -translate-y-1/2 -translate-x-[calc(100%+3px)] w-1.5 h-1.5 rounded-full ${isRunning ? "bg-blue-500" : "bg-amber-500"} animate-pulse`}
            />
          )}
          {showCompletedDot && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-[calc(100%+3px)] w-1.5 h-1.5 rounded-full bg-emerald-500" />
          )}
        </div>
        <span className={`text-small truncate flex-1 ${active ? "text-pure-black font-medium" : "text-near-black"}`}>{title}</span>
        {imSource && (
          <span className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 text-[9px] font-medium leading-none" title={`via ${imSource}`}>
            <MessageCircle className="w-2.5 h-2.5" />
            {imSource === 'weixin' ? 'WX' : imSource === 'lark' ? 'Lark' : imSource.slice(0, 4).toUpperCase()}
          </span>
        )}
      </button>
      {onDelete && (
        deletePending ? (
          <div className="flex items-center gap-1 pr-1.5 shrink-0">
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDelete();
              }}
              className="md:min-h-0 min-h-[44px] px-2.5 py-1.5 rounded-container bg-pure-black text-pure-white text-[11px] font-medium hover:opacity-90 transition-opacity flex items-center justify-center"
              title="Confirm delete conversation"
              aria-label={`Confirm delete conversation ${title}`}
            >
              Delete
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCancelDelete?.();
              }}
              className="md:min-h-0 min-h-[44px] p-2 rounded-container text-stone hover:text-pure-black hover:bg-light-gray transition-colors flex items-center justify-center"
              title="Cancel delete"
              aria-label={`Cancel delete conversation ${title}`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDelete();
            }}
            className="md:min-h-0 min-h-[44px] opacity-0 group-hover:opacity-100 p-2 rounded-container text-stone hover:text-pure-black hover:bg-light-gray transition-all shrink-0 cursor-pointer mr-1 flex items-center justify-center"
            title="Delete conversation"
            aria-label={`Delete conversation ${title}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )
      )}
    </div>
  );
}
