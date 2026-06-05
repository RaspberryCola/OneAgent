import { describe, it, expect } from 'vitest';
import type { TimelineItem } from '../timeline';
import {
  groupTimelineSegments,
  isActivityItem,
  isItemActive,
  computeBlockDurationMs,
  type GroupedSegment,
  type ActivityBlockData,
} from '../activityBlock';

// ---- Test Factories ----

function makeThinking(
  id: string,
  status: 'thinking' | 'done' = 'done',
  createdAt = '2025-01-01T00:00:00Z',
): TimelineItem {
  return {
    type: 'message',
    key: `message:${id}`,
    data: {
      id,
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
      role: 'system',
      kind: 'thinking',
      content_json: { text: `thinking ${id}`, status },
      created_at: createdAt,
    },
  };
}

function makeText(
  id: string,
  role: 'user' | 'agent' = 'agent',
  createdAt = '2025-01-01T00:00:01Z',
): TimelineItem {
  return {
    type: 'message',
    key: `message:${id}`,
    data: {
      id,
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
      role,
      kind: 'text',
      content_json: { text: `text ${id}` },
      created_at: createdAt,
    },
  };
}

function makeToolCall(
  toolCallId: string,
  status: string = 'completed',
  startedAt = '2025-01-01T00:00:02Z',
  endedAt = '2025-01-01T00:00:03Z',
): TimelineItem {
  return {
    type: 'tool_call',
    key: `tool_call:${toolCallId}`,
    data: {
      id: `tc-${toolCallId}`,
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
      tool_call_id: toolCallId,
      title: `Tool ${toolCallId}`,
      kind: 'read',
      status,
      raw_input_json: {},
      raw_output_json: {},
      content_json: {},
      diffs_json: [],
      terminal_ids_json: [],
      locations_json: {},
      started_at: startedAt,
      ended_at: endedAt,
    },
  };
}

function makePermission(id: string): TimelineItem {
  return {
    type: 'permission',
    key: `permission:${id}`,
    data: {
      id,
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
      tool_call_id: `tc-${id}`,
      fingerprint: 'fp',
      options_json: [],
      status: 'pending',
      created_at: '2025-01-01T00:00:04Z',
    },
  };
}

function makeStatus(id: string, createdAt = '2025-01-01T00:00:00Z'): TimelineItem {
  return {
    type: 'message',
    key: `message:${id}`,
    data: {
      id,
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
      role: 'system',
      kind: 'status',
      content_json: { message: `status ${id}` },
      created_at: createdAt,
    },
  };
}

function makePlan(id: string, createdAt = '2025-01-01T00:00:00Z'): TimelineItem {
  return {
    type: 'message',
    key: `message:${id}`,
    data: {
      id,
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
      role: 'system',
      kind: 'plan',
      content_json: { entries: [] },
      created_at: createdAt,
    },
  };
}

// ---- Tests ----

describe('isActivityItem', () => {
  it('returns true for thinking messages', () => {
    expect(isActivityItem(makeThinking('t1'))).toBe(true);
  });

  it('returns true for tool calls', () => {
    expect(isActivityItem(makeToolCall('tc1'))).toBe(true);
  });

  it('returns true for status messages', () => {
    expect(isActivityItem(makeStatus('s1'))).toBe(true);
  });

  it('returns false for text messages', () => {
    expect(isActivityItem(makeText('msg1'))).toBe(false);
  });

  it('returns false for permission items', () => {
    expect(isActivityItem(makePermission('p1'))).toBe(false);
  });

  it('returns false for plan messages', () => {
    expect(isActivityItem(makePlan('plan1'))).toBe(false);
  });
});

describe('isItemActive', () => {
  it('returns true for running tool calls', () => {
    expect(isItemActive(makeToolCall('tc1', 'running'))).toBe(true);
  });

  it('returns true for declared tool calls', () => {
    expect(isItemActive(makeToolCall('tc1', 'declared'))).toBe(true);
  });

  it('returns false for completed tool calls', () => {
    expect(isItemActive(makeToolCall('tc1', 'completed'))).toBe(false);
  });

  it('returns true for thinking status', () => {
    expect(isItemActive(makeThinking('t1', 'thinking'))).toBe(true);
  });

  it('returns false for done thinking', () => {
    expect(isItemActive(makeThinking('t1', 'done'))).toBe(false);
  });
});

describe('groupTimelineSegments', () => {
  it('returns empty array for empty input', () => {
    const result = groupTimelineSegments([], false);
    expect(result).toEqual([]);
  });

  it('groups consecutive thinking messages into one block', () => {
    const items = [makeThinking('t1'), makeThinking('t2'), makeThinking('t3')];
    const result = groupTimelineSegments(items, false);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('activity_block');
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.thinkingCount).toBe(3);
    expect(block.toolCallCount).toBe(0);
  });

  it('groups consecutive tool calls into one block', () => {
    const items = [makeToolCall('tc1'), makeToolCall('tc2')];
    const result = groupTimelineSegments(items, false);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('activity_block');
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.toolCallCount).toBe(2);
    expect(block.thinkingCount).toBe(0);
  });

  it('groups mixed thinking and tool calls into one block', () => {
    const items = [
      makeThinking('t1'),
      makeToolCall('tc1'),
      makeThinking('t2'),
      makeToolCall('tc2'),
    ];
    const result = groupTimelineSegments(items, false);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('activity_block');
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.toolCallCount).toBe(2);
    expect(block.thinkingCount).toBe(2);
  });

  it('splits blocks with text messages', () => {
    const items = [
      makeThinking('t1', 'done', '2025-01-01T00:00:00Z'),
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:01Z'),
      makeText('msg1', 'agent', '2025-01-01T00:00:02Z'),
      makeToolCall('tc2', 'completed', '2025-01-01T00:00:03Z'),
    ];
    const result = groupTimelineSegments(items, false);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('activity_block');
    expect(result[1].type).toBe('item');
    expect(result[2].type).toBe('activity_block');
  });

  it('permission items are standalone but do NOT break blocks', () => {
    const items = [
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:00Z'),
      makePermission('p1'),
      makeToolCall('tc2', 'completed', '2025-01-01T00:00:02Z'),
    ];
    const result = groupTimelineSegments(items, false);
    // Should be: permission item, then one block with both tool calls
    expect(result).toHaveLength(2);
    // Permission comes first (pushed immediately)
    expect(result[0].type).toBe('item');
    // Then one block with both tool calls
    expect(result[1].type).toBe('activity_block');
    const block = (result[1] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.toolCallCount).toBe(2);
  });

  it('plan messages break blocks', () => {
    const items = [
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:00Z'),
      makePlan('plan1', '2025-01-01T00:00:01Z'),
      makeToolCall('tc2', 'completed', '2025-01-01T00:00:02Z'),
    ];
    const result = groupTimelineSegments(items, false);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('activity_block');
    expect(result[1].type).toBe('item');
    expect(result[2].type).toBe('activity_block');
  });

  it('user message breaks blocks', () => {
    const items = [
      makeThinking('t1', 'done', '2025-01-01T00:00:00Z'),
      makeText('user1', 'user', '2025-01-01T00:00:01Z'),
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:02Z'),
    ];
    const result = groupTimelineSegments(items, false);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('activity_block');
    expect(result[1].type).toBe('item');
    expect(result[2].type).toBe('activity_block');
  });

  it('status and error messages are included in blocks', () => {
    const items = [
      makeStatus('s1', '2025-01-01T00:00:00Z'),
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:01Z'),
    ];
    const result = groupTimelineSegments(items, false);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('activity_block');
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.items).toHaveLength(2);
  });
});

describe('isActive logic', () => {
  it('stale running tool call + turn idle = not active (app restart scenario)', () => {
    const items = [
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:00Z', '2025-01-01T00:00:01Z'),
      makeToolCall('tc2', 'running', '2025-01-01T00:00:02Z', ''),
    ];
    const result = groupTimelineSegments(items, false);
    expect(result).toHaveLength(1);
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.isActive).toBe(false);
  });

  it('running tool call + turn active = active', () => {
    const items = [
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:00Z', '2025-01-01T00:00:01Z'),
      makeToolCall('tc2', 'running', '2025-01-01T00:00:02Z', ''),
    ];
    const result = groupTimelineSegments(items, true);
    expect(result).toHaveLength(1);
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.isActive).toBe(true);
  });

  it('stale thinking + turn idle = not active (app restart scenario)', () => {
    const items = [makeThinking('t1', 'thinking', '2025-01-01T00:00:00Z')];
    const result = groupTimelineSegments(items, false);
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.isActive).toBe(false);
  });

  it('thinking + turn active = active', () => {
    const items = [makeThinking('t1', 'thinking', '2025-01-01T00:00:00Z')];
    const result = groupTimelineSegments(items, true);
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.isActive).toBe(true);
  });

  it('all completed + turn idle = not active', () => {
    const items = [
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:00Z', '2025-01-01T00:00:01Z'),
      makeThinking('t1', 'done', '2025-01-01T00:00:02Z'),
    ];
    const result = groupTimelineSegments(items, false);
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.isActive).toBe(false);
  });

  it('all completed + turn active + last block = active', () => {
    const items = [
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:00Z', '2025-01-01T00:00:01Z'),
    ];
    const result = groupTimelineSegments(items, true);
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.isActive).toBe(true);
  });

  it('completed block before text + turn active = not active (not last block)', () => {
    const items = [
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:00Z', '2025-01-01T00:00:01Z'),
      makeText('msg1', 'agent', '2025-01-01T00:00:02Z'),
    ];
    const result = groupTimelineSegments(items, true);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('activity_block');
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.isActive).toBe(false);
  });
});

describe('time calculations', () => {
  it('startedAt is set from first item', () => {
    const items = [
      makeThinking('t1', 'done', '2025-01-01T00:00:00Z'),
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:05Z', '2025-01-01T00:00:10Z'),
    ];
    const result = groupTimelineSegments(items, false);
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.startedAt).toBe('2025-01-01T00:00:00Z');
  });

  it('endedAt is set from latest ended_at when all completed', () => {
    const items = [
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:00Z', '2025-01-01T00:00:05Z'),
      makeToolCall('tc2', 'completed', '2025-01-01T00:00:03Z', '2025-01-01T00:00:10Z'),
    ];
    const result = groupTimelineSegments(items, false);
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.endedAt).toBe('2025-01-01T00:00:10Z');
  });

  it('endedAt is null when any item is active and turn is active', () => {
    const items = [
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:00Z', '2025-01-01T00:00:05Z'),
      makeToolCall('tc2', 'running', '2025-01-01T00:00:03Z', ''),
    ];
    const result = groupTimelineSegments(items, true);
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    expect(block.endedAt).toBeNull();
  });

  it('endedAt is computed when items have stale running status but turn is idle', () => {
    const items = [
      makeToolCall('tc1', 'completed', '2025-01-01T00:00:00Z', '2025-01-01T00:00:05Z'),
      makeToolCall('tc2', 'running', '2025-01-01T00:00:03Z', ''),
    ];
    const result = groupTimelineSegments(items, false);
    const block = (result[0] as Extract<GroupedSegment, { type: 'activity_block' }>).block;
    // Stale running items should not prevent endedAt from being set when turn is idle
    expect(block.endedAt).toBe('2025-01-01T00:00:05Z');
    expect(block.isActive).toBe(false);
  });
});

describe('computeBlockDurationMs', () => {
  it('returns 0 when startedAt is null', () => {
    const block: ActivityBlockData = {
      id: 'b1',
      items: [],
      isActive: false,
      toolCallCount: 0,
      thinkingCount: 0,
      startedAt: null,
      endedAt: null,
    };
    expect(computeBlockDurationMs(block)).toBe(0);
  });

  it('computes completed duration correctly', () => {
    const block: ActivityBlockData = {
      id: 'b1',
      items: [],
      isActive: false,
      toolCallCount: 1,
      thinkingCount: 0,
      startedAt: '2025-01-01T00:00:00Z',
      endedAt: '2025-01-01T00:00:05Z',
    };
    expect(computeBlockDurationMs(block)).toBe(5000);
  });

  it('returns positive value for active blocks', () => {
    const block: ActivityBlockData = {
      id: 'b1',
      items: [],
      isActive: true,
      toolCallCount: 0,
      thinkingCount: 0,
      startedAt: new Date(Date.now() - 3000).toISOString(),
      endedAt: null,
    };
    const duration = computeBlockDurationMs(block);
    expect(duration).toBeGreaterThanOrEqual(2900);
    expect(duration).toBeLessThanOrEqual(4000);
  });
});
