import type { TimelineItem } from './timeline';

// ---- Grouped Segment Types ----

export type GroupedSegment =
  | { type: 'item'; item: TimelineItem }
  | { type: 'activity_block'; block: ActivityBlockData };

export interface ActivityBlockData {
  id: string;
  items: TimelineItem[];
  isActive: boolean;
  toolCallCount: number;
  thinkingCount: number;
  startedAt: string | null;
  endedAt: string | null;
}

// ---- Helper Functions ----

/**
 * Determine if a TimelineItem should be grouped into an activity block.
 * Activity items: thinking messages, tool_calls, status, error.
 * Non-activity items: text (user/agent), plan, terminal, diff, resource.
 * Permission items are always independent (never grouped, never break blocks).
 */
export function isActivityItem(item: TimelineItem): boolean {
  if (item.type === 'tool_call') return true;
  if (item.type === 'permission') return false;
  if (item.type === 'message') {
    const kind = item.data.kind;
    if (kind === 'thinking') return true;
    if (kind === 'status') return true;
    if (kind === 'error') return true;
    // text, plan, terminal, diff, resource → break blocks
    return false;
  }
  return false;
}

/**
 * Check if a permission item (always rendered independently).
 */
export function isPermissionItem(item: TimelineItem): boolean {
  return item.type === 'permission';
}

/**
 * Determine if an activity item is currently "in progress".
 */
export function isItemActive(item: TimelineItem): boolean {
  if (item.type === 'tool_call') {
    const status = item.data.status.toLowerCase();
    return status === 'running' || status === 'declared' || status === 'in_progress';
  }
  if (item.type === 'message' && item.data.kind === 'thinking') {
    return item.data.content_json?.status === 'thinking';
  }
  return false;
}

/**
 * Get the start timestamp of an item.
 */
function getItemTimestamp(item: TimelineItem): string | null {
  if (item.type === 'message') return item.data.created_at;
  if (item.type === 'tool_call') return item.data.started_at;
  if (item.type === 'permission') return item.data.created_at;
  return null;
}

/**
 * Get the end timestamp of an item (if applicable).
 */
function getItemEndTimestamp(item: TimelineItem): string | null {
  if (item.type === 'tool_call') return item.data.ended_at || null;
  return null;
}

/**
 * Compute the duration of an activity block in milliseconds.
 * If the block is active, computes from start to now.
 * If completed, computes from start to end.
 */
export function computeBlockDurationMs(block: ActivityBlockData): number {
  if (!block.startedAt) return 0;
  const startMs = Date.parse(block.startedAt);
  if (isNaN(startMs)) return 0;

  if (block.isActive) {
    return Date.now() - startMs;
  }
  if (block.endedAt) {
    const endMs = Date.parse(block.endedAt);
    if (isNaN(endMs)) return 0;
    return Math.max(0, endMs - startMs);
  }
  return 0;
}

// ---- Core Grouping Algorithm ----

/**
 * Group a flat list of TimelineItems into segments.
 * Consecutive activity items (thinking, tool_call, status, error) are grouped
 * into ActivityBlockData. Non-activity items remain as standalone segments.
 * Permission items are always standalone and do NOT break activity blocks.
 */
export function groupTimelineSegments(
  items: TimelineItem[],
  isTurnActive: boolean,
): GroupedSegment[] {
  const segments: GroupedSegment[] = [];
  let currentBlockItems: TimelineItem[] = [];

  function flushBlock(isLastBlock: boolean): void {
    if (currentBlockItems.length === 0) return;

    const hasActive = currentBlockItems.some(isItemActive);
    const toolCalls = currentBlockItems.filter((i) => i.type === 'tool_call');
    const thoughts = currentBlockItems.filter(
      (i) => i.type === 'message' && i.data.kind === 'thinking',
    );

    // Compute time range
    const timestamps = currentBlockItems
      .map(getItemTimestamp)
      .filter((t): t is string => t !== null);
    const startedAt = timestamps.length > 0 ? timestamps[0] : null;

    // End time: latest ended_at; null if any item is active
    const endTimestamps = currentBlockItems
      .map(getItemEndTimestamp)
      .filter((t): t is string => t !== null);
    const endedAt = hasActive
      ? null
      : endTimestamps.length > 0
        ? endTimestamps[endTimestamps.length - 1]
        : startedAt;

    // isActive: any item active, OR (last block AND turn still running)
    const isActive = hasActive || (isLastBlock && isTurnActive);

    segments.push({
      type: 'activity_block',
      block: {
        id: `activity-block-${currentBlockItems[0].key}`,
        items: [...currentBlockItems],
        isActive,
        toolCallCount: toolCalls.length,
        thinkingCount: thoughts.length,
        startedAt,
        endedAt,
      },
    });

    currentBlockItems = [];
  }

  for (const item of items) {
    // Permission items are always standalone but do NOT break activity blocks
    if (isPermissionItem(item)) {
      segments.push({ type: 'item', item });
      continue;
    }

    if (isActivityItem(item)) {
      currentBlockItems.push(item);
    } else {
      // Non-activity item breaks the current block
      flushBlock(false);
      segments.push({ type: 'item', item });
    }
  }

  // Flush remaining activity items (this is the last block)
  flushBlock(true);

  return segments;
}
