import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, ChevronDown, Plus } from "lucide-react";
import type * as Types from "../../lib/backend/types";

interface WorkspaceDropdownProps {
  workspaces: Types.Workspace[];
  activeWorkspace: Types.Workspace | null;
  onSelectWorkspace: (workspace: Types.Workspace) => void;
  onAddWorkspace: () => void;
  disabled?: boolean;
}

function getWorkspaceLabel(workspace: Types.Workspace | null | undefined): string {
  if (!workspace) return "Workspace";
  const normalizedPath = workspace.cwd.replace(/\\/g, "/");
  const basename = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
  if (workspace.display_name === ".oneagent" || basename === ".oneagent") {
    return "Default";
  }
  return workspace.display_name;
}

export function WorkspaceDropdown({
  workspaces,
  activeWorkspace,
  onSelectWorkspace,
  onAddWorkspace,
  disabled = false,
}: WorkspaceDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Total items: workspaces + "Add new workspace"
  const totalItems = workspaces.length + 1;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    if (!isOpen) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setIsOpen(true);
        setFocusedIndex(0);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusedIndex((prev) => (prev === null ? 0 : Math.min(prev + 1, totalItems - 1)));
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusedIndex((prev) => (prev === null ? totalItems - 1 : Math.max(prev - 1, 0)));
        break;
      case "Enter":
        e.preventDefault();
        if (focusedIndex !== null) {
          if (focusedIndex < workspaces.length) {
            onSelectWorkspace(workspaces[focusedIndex]);
          } else {
            onAddWorkspace();
          }
          setIsOpen(false);
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        break;
      case "Tab":
        setIsOpen(false);
        break;
    }
  };

  // Reset focus when dropdown closes
  useEffect(() => {
    if (!isOpen) {
      setFocusedIndex(null);
    }
  }, [isOpen]);

  // Focus the trigger button when dropdown closes
  useEffect(() => {
    if (!isOpen && triggerRef.current) {
      triggerRef.current.focus();
    }
  }, [isOpen]);

  const handleSelectWorkspace = (workspace: Types.Workspace) => {
    onSelectWorkspace(workspace);
    setIsOpen(false);
  };

  const handleAddWorkspace = () => {
    onAddWorkspace();
    setIsOpen(false);
  };

  const workspaceLabel = getWorkspaceLabel(activeWorkspace);

  return (
    <div className="relative inline-flex items-center justify-center">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        className={`text-[40px] leading-none font-display font-medium text-center tracking-tight inline-flex items-center gap-0 focus:outline-none ${
          disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"
        }`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="text-pure-black">Build</span>
        <span className="text-stone truncate max-w-[200px] ml-2" title={activeWorkspace?.cwd || "Workspace"}>
          {workspaceLabel}
        </span>
        {!disabled && (
          <ChevronDown className="w-6 h-6 text-stone inline-block ml-1" />
        )}
      </button>

      <AnimatePresence>
        {isOpen && (
          <>
            {/* Overlay for click-outside dismissal */}
            <div
              className="fixed inset-0 z-[60]"
              onClick={() => setIsOpen(false)}
            />

            {/* Dropdown panel */}
            <motion.div
              ref={dropdownRef}
              initial={{ opacity: 0, scale: 0.95, y: -10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -10 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="absolute top-full mt-3 left-1/2 -translate-x-1/2 w-[280px] max-h-[250px] overflow-y-auto bg-pure-white border border-light-gray rounded-container z-[70] py-1.5 flex flex-col shadow-none"
              role="listbox"
              aria-activedescendant={focusedIndex !== null ? `workspace-item-${focusedIndex}` : undefined}
            >
              {/* Workspace header */}
              <div className="px-3 py-1">
                <span className="text-[10px] font-medium text-silver tracking-wider">Workspace</span>
              </div>

              {/* Workspace list */}
              {workspaces.length === 0 ? (
                <div className="px-3 py-2 text-[13px] text-silver text-center">
                  No workspaces available
                </div>
              ) : (
                workspaces.map((workspace, index) => {
                  const isActive = activeWorkspace?.id === workspace.id;
                  const isFocused = focusedIndex === index;
                  const label = getWorkspaceLabel(workspace);

                  return (
                    <button
                      key={workspace.id}
                      id={`workspace-item-${index}`}
                      type="button"
                      onClick={() => handleSelectWorkspace(workspace)}
                      onMouseEnter={() => setFocusedIndex(index)}
                      className={`w-full text-left px-3 py-2 text-[13px] transition-colors flex items-center justify-between gap-4 ${
                        isActive
                          ? "bg-light-gray/60 text-pure-black font-medium"
                          : isFocused
                            ? "bg-snow text-near-black"
                            : "text-near-black hover:bg-snow"
                      }`}
                      role="option"
                      aria-selected={isActive}
                    >
                      <span className="truncate" title={workspace.cwd}>
                        {label}
                      </span>
                      {isActive && (
                        <Check className="w-3.5 h-3.5 text-pure-black shrink-0" />
                      )}
                    </button>
                  );
                })
              )}

              {/* Separator */}
              {workspaces.length > 0 && (
                <div className="border-t border-light-gray my-1.5" />
              )}

              {/* Add new workspace option */}
              <button
                id={`workspace-item-${workspaces.length}`}
                type="button"
                onClick={handleAddWorkspace}
                onMouseEnter={() => setFocusedIndex(workspaces.length)}
                className={`w-full text-left px-3 py-2 text-[13px] transition-colors flex items-center gap-2 ${
                  focusedIndex === workspaces.length
                    ? "bg-snow text-stone"
                    : "text-stone hover:bg-snow"
                }`}
              >
                <Plus className="w-3.5 h-3.5 shrink-0" />
                <span>Add new workspace</span>
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}