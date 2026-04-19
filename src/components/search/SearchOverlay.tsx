import { useEffect, useRef } from "react";
import { ChevronRight, Loader2, Search, X } from "lucide-react";
import { motion } from "framer-motion";
import type * as Types from "../../lib/backend/types";

type SearchOverlayProps = {
  query: string;
  setQuery: (q: string) => void;
  results: Types.Conversation[];
  isSearching: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  agentProfiles: Types.AgentProfile[];
  renderAgentLogo: (agent: Types.AgentProfile | string, className: string) => React.ReactNode;
};

export function SearchOverlay({
  query,
  setQuery,
  results,
  isSearching,
  onClose,
  onSelect,
  agentProfiles,
  renderAgentLogo,
}: SearchOverlayProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4 bg-pure-white/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: -20, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: -20, opacity: 0, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        className="w-full max-w-2xl bg-pure-white rounded-container border border-light-gray flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-light-gray flex items-center gap-3">
          <Search className="w-5 h-5 text-stone" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations..."
            className="flex-1 bg-transparent text-bodyLarge focus:outline-none placeholder:text-silver"
          />
          {isSearching && <Loader2 className="w-4 h-4 animate-spin text-stone" />}
          <button
            onClick={onClose}
            className="p-1 rounded-pill hover:bg-snow text-stone transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2 no-scrollbar">
          {query.trim() === "" ? (
            <div className="py-12 text-center text-stone text-caption">
              Type to search your conversations
            </div>
          ) : results.length === 0 && !isSearching ? (
            <div className="py-12 text-center text-stone text-caption">
              No conversations found for "{query}"
            </div>
          ) : (
            <div className="space-y-1">
              {results.map((result) => {
                const agent = agentProfiles.find((p) => p.id === result.agent_profile_id);
                return (
                  <button
                    key={result.id}
                    onClick={() => onSelect(result.id)}
                    className="w-full group text-left px-3 py-2.5 rounded-container hover:bg-snow transition-all flex items-center gap-4"
                  >
                    <div className="w-10 h-10 rounded-container border border-light-gray bg-pure-white flex items-center justify-center shrink-0">
                      {renderAgentLogo(agent ?? result.agent_profile_id, "w-6 h-6 object-contain")}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-[15px] text-pure-black truncate">
                          {result.title || "Untitled Chat"}
                        </span>
                        {result.origin === "worker_task" && (
                          <span className="px-2 py-0.5 rounded-pill bg-light-gray/60 text-[9px] font-medium uppercase tracking-tight text-near-black">
                            Task
                          </span>
                        )}
                      </div>
                      <div className="text-[12px] text-stone mt-0.5 flex items-center gap-2">
                        <span className="truncate max-w-[120px]">{agent?.name || "Agent"}</span>
                        <span className="text-silver opacity-50">•</span>
                        <span>
                          {new Date(result.updated_at).toLocaleString([], {
                            year: "numeric",
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          })}
                        </span>
                      </div>
                    </div>

                    <ChevronRight className="w-4 h-4 text-silver opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-3 bg-snow border-t border-light-gray flex items-center justify-between text-[11px] text-silver">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1">
              <span className="px-1.5 py-0.5 bg-pure-white border border-light-gray rounded-md text-stone">ESC</span>
              to close
            </span>
            <span className="flex items-center gap-1">
              <span className="px-1.5 py-0.5 bg-pure-white border border-light-gray rounded-md text-stone">ENTER</span>
              to select
            </span>
          </div>
          <div>{results.length} results</div>
        </div>
      </motion.div>
    </motion.div>
  );
}
