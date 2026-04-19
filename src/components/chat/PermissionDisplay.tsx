import React, { useState, useMemo } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import type { PendingPermissionRequest, ToolCallProjection, PermissionDecision, ResolvePermissionInput } from '../../lib/backend/types';
import * as API from '../../lib/backend/commands';

interface PermissionDisplayProps {
  request: PendingPermissionRequest;
  toolCall: ToolCallProjection | null;
  requestMeta: {
    toolKind?: string;
    title?: string;
    paths?: string[];
    rawInput?: any;
  } | null;
  decision: PermissionDecision | null;
}

export function PermissionDisplay({ request, toolCall, requestMeta, decision }: PermissionDisplayProps) {
  const [isSubmitting, setIsSubmitting] = useState<string | null>(null);
  const options = Array.isArray(request.options_json) ? request.options_json : [];
  const isResolved = request.status !== "pending";

  const decisionLabel = (value: string | null | undefined) => {
    switch (value) {
      case "allow_once": return "Allowed once";
      case "allow_always": return "Always allowed";
      case "reject_once": return "Rejected once";
      case "reject_always": return "Always rejected";
      case "cancelled": return "Cancelled";
      default: return "Resolved";
    }
  };

  const toolSummary = useMemo(() => {
    const input = requestMeta?.rawInput ?? toolCall?.raw_input_json;
    if (!input) return "";
    if (typeof input === "string") return input;
    if (input.command) return `${input.command}${Array.isArray(input.args) ? ` ${input.args.join(" ")}` : ""}`;
    if (input.path) return String(input.path);
    return "";
  }, [requestMeta?.rawInput, toolCall?.raw_input_json]);

  const toolTitle = requestMeta?.title || toolCall?.title || "Tool action";

  const optionMeta = (option: any) => {
    const kind = String(option?.kind || "");
    const baseLabel = String(option?.name || option?.label || option?.title || kind || "Confirm");
    
    switch (kind) {
      case "allow_once": return { label: "Allow Once", decision: "allow_once", primary: false };
      case "allow_always": return { label: "Always Allow", decision: "allow_always", primary: true };
      case "reject_once": return { label: "Reject Once", decision: "reject_once", primary: false };
      case "reject_always": return { label: "Always Reject", decision: "reject_always", primary: false };
      case "cancelled": return { label: "Cancel", decision: "cancelled", primary: false };
      default: return { label: baseLabel, decision: kind, primary: false };
    }
  };

  const handleResolve = async (option: any) => {
    const meta = optionMeta(option);
    if (isResolved || isSubmitting || !meta.decision) return;
    setIsSubmitting(meta.decision);
    try {
      await API.resolvePermissionRequest({
        conversation_id: request.conversation_id,
        tool_call_id: request.tool_call_id,
        fingerprint: request.fingerprint,
        decision: meta.decision as ResolvePermissionInput['decision'],
      });
    } catch (error) {
      console.error("Failed to resolve permission", error);
    } finally {
      setIsSubmitting(null);
    }
  };

  if (isResolved) {
    return (
      <div className="flex w-full justify-start mt-0.5 mb-1">
        <div className="w-full max-w-[95%] md:max-w-[85%] rounded-container border border-light-gray bg-snow px-3 py-2 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 text-stone" />
          <span className="text-[12px] font-mono text-pure-black truncate">
            {toolTitle} <span className="text-stone">· {decisionLabel(decision?.decision)}</span>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full justify-start mt-0.5 mb-1">
      <div className="w-full max-w-[95%] md:max-w-[85%] border border-light-gray rounded-container bg-pure-white px-3 py-2">
        <div className="flex flex-col gap-2">
          {/* 第一行：权限信息 */}
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-3.5 h-3.5 text-pure-black shrink-0" />
            <div className="text-[12px] font-mono whitespace-nowrap text-pure-black shrink-0">
              Needs permission:
            </div>
            <div className="text-[12px] font-mono text-stone truncate">
              {toolTitle} {toolSummary ? `· ${toolSummary}` : ""}
            </div>
          </div>

          {/* 第二行：操作按钮 */}
          {options.length > 0 && (
            <div className="flex gap-2 overflow-x-auto no-scrollbar">
              {options.map((option: any, index: number) => {
                const meta = optionMeta(option);
                const isActive = isSubmitting === meta.decision;
                return (
                  <button
                    key={index}
                    onClick={() => void handleResolve(option)}
                    disabled={isResolved || !!isSubmitting}
                    className={`inline-flex items-center justify-center rounded-pill px-3 py-1 text-[11px] font-medium transition-none cursor-pointer shrink-0 ${
                      meta.primary
                        ? "bg-pure-black text-pure-white border border-pure-black hover:opacity-90"
                        : "bg-pure-white text-pure-black border border-light-gray hover:bg-snow"
                    } ${isResolved || !!isSubmitting ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    {isActive ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : null}
                    {meta.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
