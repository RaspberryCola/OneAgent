import React, { useState, useEffect, useRef, useCallback } from 'react';
import type * as Types from '../../lib/backend/types';
import type { ActivityBlockData, GroupedSegment } from '../../lib/utils/activityBlock';
import { computeBlockDurationMs } from '../../lib/utils/activityBlock';
import type { TimelineItem } from '../../lib/utils/timeline';
import { ThoughtDisplay } from './ThoughtDisplay';
import { ToolCallDisplay } from './ToolCallDisplay';
import { StatusMessage } from '../timeline/StatusMessage';
import { ErrorMessage } from '../timeline/ErrorMessage';
import { DISPLAY_LIMITS, TIMING } from '../../lib/constants';

interface ActivityBlockProps {
  block: ActivityBlockData;
  isTurnActive: boolean;
  terminals: Types.TerminalRecord[];
  permissionDecisions: Types.PermissionDecision[];
  getLatestPermissionDecision: (
    toolCallId: string,
    decisions: Types.PermissionDecision[],
  ) => Types.PermissionDecision | null;
}

/**
 * Render a single item inside the activity block.
 * Reuses existing ThoughtDisplay and ToolCallDisplay components.
 */
function renderBlockItem(
  item: TimelineItem,
  terminals: Types.TerminalRecord[],
  permissionDecisions: Types.PermissionDecision[],
  getLatestPermissionDecision: (
    toolCallId: string,
    decisions: Types.PermissionDecision[],
  ) => Types.PermissionDecision | null,
): React.ReactNode {
  if (item.type === 'message') {
    const msg = item.data;
    if (msg.kind === 'thinking') {
      return (
        <ThoughtDisplay
          key={msg.id}
          content={msg.content_json?.text || ''}
          status={msg.content_json?.status || 'done'}
          duration_ms={msg.content_json?.duration_ms}
        />
      );
    }
    if (msg.kind === 'status') {
      return (
        <StatusMessage
          key={msg.id}
          content={msg.content_json?.message || msg.content_json?.text || ''}
        />
      );
    }
    if (msg.kind === 'error') {
      return (
        <ErrorMessage
          key={msg.id}
          content={msg.content_json?.message || msg.content_json?.text || ''}
        />
      );
    }
    return null;
  }

  if (item.type === 'tool_call') {
    const toolTerminals = terminals.filter(
      (t) =>
        Array.isArray(item.data.terminal_ids_json) &&
        item.data.terminal_ids_json.includes(t.terminal_id),
    );
    return (
      <ToolCallDisplay
        key={item.key}
        toolCall={item.data}
        terminals={toolTerminals}
        permissionDecision={getLatestPermissionDecision(
          item.data.tool_call_id,
          permissionDecisions,
        )}
      />
    );
  }

  return null;
}

export function ActivityBlock({
  block,
  isTurnActive,
  terminals,
  permissionDecisions,
  getLatestPermissionDecision,
}: ActivityBlockProps) {
  // Start expanded if block is active, collapsed otherwise
  const [isExpanded, setIsExpanded] = useState(block.isActive);

  // Elapsed time for display
  const [elapsedMs, setElapsedMs] = useState(() => computeBlockDurationMs(block));

  // Ref for inner scroll container
  const innerScrollRef = useRef<HTMLDivElement>(null);

  // Auto expand/collapse based on isActive
  useEffect(() => {
    if (block.isActive) {
      setIsExpanded(true);
    } else {
      // Delay collapse for visual transition
      const timer = setTimeout(() => setIsExpanded(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [block.isActive]);

  // Timer for real-time elapsed display
  useEffect(() => {
    if (!block.isActive) {
      setElapsedMs(computeBlockDurationMs(block));
      return;
    }
    const interval = setInterval(() => {
      setElapsedMs(computeBlockDurationMs(block));
    }, TIMING.THOUGHT_UPDATE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [block.isActive, block.startedAt, block.endedAt]);

  // Auto-scroll to bottom when active and expanded
  useEffect(() => {
    if (isExpanded && block.isActive && innerScrollRef.current) {
      innerScrollRef.current.scrollTop = innerScrollRef.current.scrollHeight;
    }
  }, [isExpanded, block.isActive, block.items.length]);

  const durationSec = (elapsedMs / 1000).toFixed(1);

  // Build summary text
  const summaryParts: string[] = [];
  if (block.isActive) {
    summaryParts.push(`Processing ${durationSec}s`);
  } else {
    summaryParts.push(`Completed ${durationSec}s`);
  }
  if (block.toolCallCount > 0) {
    summaryParts.push(`${block.toolCallCount} tool${block.toolCallCount > 1 ? 's' : ''}`);
  }
  if (block.thinkingCount > 0) {
    summaryParts.push(`${block.thinkingCount} thought${block.thinkingCount > 1 ? 's' : ''}`);
  }
  const summaryText = summaryParts.join(' · ');

  // Chevron icon
  const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
    <svg
      className={`w-3 h-3 shrink-0 text-silver transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
      viewBox="0 0 12 12"
      fill="none"
    >
      <path
        d="M4.5 2.5L8 6L4.5 9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );

  return (
    <div className="w-full my-1">
      {/* Collapsed header / expand trigger */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 w-full py-1.5 px-0 cursor-pointer bg-transparent border-none group"
        type="button"
      >
        <ChevronIcon expanded={isExpanded} />

        {/* Status dot */}
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
            block.isActive ? 'bg-blue-400 animate-pulse' : 'bg-emerald-400'
          }`}
        />

        {/* Summary text */}
        <span className="text-[12px] font-mono text-silver group-hover:text-stone transition-colors truncate">
          {summaryText}
        </span>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div
          ref={innerScrollRef}
          className="pl-3 border-l border-light-gray/40 ml-1.5 space-y-0.5"
          style={{
            maxHeight: `${DISPLAY_LIMITS.ACTIVITY_BLOCK_MAX_HEIGHT}px`,
            overflowY: 'auto',
          }}
        >
          {block.items.map((item) =>
            renderBlockItem(
              item,
              terminals,
              permissionDecisions,
              getLatestPermissionDecision,
            ),
          )}
        </div>
      )}
    </div>
  );
}
