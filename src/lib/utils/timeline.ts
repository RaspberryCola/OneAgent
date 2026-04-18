import type * as Types from '../backend/types';

export type TimelineItem =
  | { type: 'message'; key: string; data: Types.MessageProjection }
  | { type: 'tool_call'; key: string; data: Types.ToolCallProjection }
  | { type: 'permission'; key: string; data: Types.PendingPermissionRequest };

export function compareIsoTimestamp(a?: string | null, b?: string | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  const aMillis = Date.parse(a);
  const bMillis = Date.parse(b);
  if (aMillis !== bMillis) return aMillis - bMillis;

  const aFraction = (a.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? '').padEnd(9, '0').slice(0, 9);
  const bFraction = (b.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? '').padEnd(9, '0').slice(0, 9);
  if (aFraction !== bFraction) return aFraction.localeCompare(bFraction);

  return a.localeCompare(b);
}

export function sortMessages(messages: Types.MessageProjection[]): Types.MessageProjection[] {
  return [...messages].sort((a, b) => compareIsoTimestamp(a.created_at, b.created_at));
}

export function timelineItemKey(type: TimelineItem['type'], id: string): string {
  return `${type}:${id}`;
}

export function buildTimelineItems(timeline: Types.TimelineResponse): TimelineItem[] {
  const items: Array<TimelineItem & { ts: string }> = [
    ...timeline.messages.map((message) => ({
      type: 'message' as const,
      key: timelineItemKey('message', message.id),
      data: message,
      ts: message.created_at,
    })),
    ...timeline.tool_calls.map((toolCall) => ({
      type: 'tool_call' as const,
      key: timelineItemKey('tool_call', toolCall.tool_call_id || toolCall.id),
      data: toolCall,
      ts: toolCall.started_at,
    })),
    ...timeline.pending_permissions.map((request) => ({
      type: 'permission' as const,
      key: timelineItemKey('permission', request.id),
      data: request,
      ts: request.created_at,
    })),
  ];

  return items
    .sort((a, b) => {
      const timeDiff = compareIsoTimestamp(a.ts, b.ts);
      if (timeDiff !== 0) return timeDiff;
      return a.key.localeCompare(b.key);
    })
    .map(({ ts: _ts, ...item }) => item);
}

export function upsertTimelineItem(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const existingIndex = items.findIndex((entry) => entry.key === item.key);
  if (existingIndex >= 0) {
    return items.map((entry, index) => (index === existingIndex ? item : entry));
  }
  return [...items, item];
}

export function mergeTimelineItems(items: TimelineItem[], timeline: Types.TimelineResponse): TimelineItem[] {
  return buildTimelineItems(timeline).reduce((next, item) => upsertTimelineItem(next, item), items);
}

export function mergeTimelineMessage(
  timeline: Types.TimelineResponse,
  message: Types.MessageProjection,
): Types.TimelineResponse {
  const existingIndex = timeline.messages.findIndex((item) => item.id === message.id);
  const nextMessages =
    existingIndex >= 0
      ? timeline.messages.map((item, index) => (index === existingIndex ? message : item))
      : [...timeline.messages, message];
  return {
    ...timeline,
    messages: sortMessages(nextMessages),
  };
}

export function mergeToolCall(
  timeline: Types.TimelineResponse,
  toolCall: Types.ToolCallProjection,
): Types.TimelineResponse {
  const existingIndex = timeline.tool_calls.findIndex(
    (item) => item.tool_call_id === toolCall.tool_call_id || item.id === toolCall.id,
  );
  const nextToolCalls =
    existingIndex >= 0
      ? timeline.tool_calls.map((item, index) => (index === existingIndex ? toolCall : item))
      : [...timeline.tool_calls, toolCall];
  return {
    ...timeline,
    tool_calls: nextToolCalls.sort(
      (a, b) => compareIsoTimestamp(a.started_at, b.started_at),
    ),
  };
}

export function mergeTerminal(
  timeline: Types.TimelineResponse,
  terminal: Types.TerminalRecord,
): Types.TimelineResponse {
  const existingIndex = timeline.terminals.findIndex(
    (item) => item.terminal_id === terminal.terminal_id || item.id === terminal.id,
  );
  const nextTerminals =
    existingIndex >= 0
      ? timeline.terminals.map((item, index) => (index === existingIndex ? terminal : item))
      : [...timeline.terminals, terminal];
  return {
    ...timeline,
    terminals: nextTerminals.sort(
      (a, b) => compareIsoTimestamp(a.started_at, b.started_at),
    ),
  };
}

export function mergePendingPermission(
  pendingPermissions: Types.PendingPermissionRequest[],
  request: Types.PendingPermissionRequest,
): Types.PendingPermissionRequest[] {
  const existingIndex = pendingPermissions.findIndex(
    (item) => item.id === request.id || item.tool_call_id === request.tool_call_id,
  );
  const nextPendingPermissions =
    existingIndex >= 0
      ? pendingPermissions.map((item, index) => (index === existingIndex ? request : item))
      : [...pendingPermissions, request];
  return nextPendingPermissions.sort(
    (a, b) => compareIsoTimestamp(a.created_at, b.created_at),
  );
}
