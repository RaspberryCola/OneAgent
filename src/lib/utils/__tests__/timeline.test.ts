import { describe, it, expect } from 'vitest';
import {
  compareIsoTimestamp,
  sortMessages,
  timelineItemKey,
  buildTimelineItems,
  upsertTimelineItem,
  mergeTimelineMessage,
  mergeToolCall,
  mergePendingPermission,
} from '../timeline';
import type * as Types from '../../backend/types';
import type { MessageProjection, ToolCallProjection, PendingPermissionRequest } from '../../backend/types';

describe('timeline utilities', () => {
  describe('compareIsoTimestamp', () => {
    it('should return 0 for both null', () => {
      expect(compareIsoTimestamp(null, null)).toBe(0);
    });

    it('should return -1 when first is null', () => {
      expect(compareIsoTimestamp(null, '2024-01-01T00:00:00Z')).toBe(-1);
    });

    it('should return 1 when second is null', () => {
      expect(compareIsoTimestamp('2024-01-01T00:00:00Z', null)).toBe(1);
    });

    it('should compare ISO timestamps correctly', () => {
      const earlier = '2024-01-01T00:00:00Z';
      const later = '2024-01-02T00:00:00Z';
      expect(compareIsoTimestamp(earlier, later)).toBeLessThan(0);
      expect(compareIsoTimestamp(later, earlier)).toBeGreaterThan(0);
    });

    it('should return 0 for equal timestamps', () => {
      const same = '2024-01-01T00:00:00Z';
      expect(compareIsoTimestamp(same, same)).toBe(0);
    });

    it('should handle timestamps with milliseconds', () => {
      const t1 = '2024-01-01T00:00:00.100Z';
      const t2 = '2024-01-01T00:00:00.200Z';
      expect(compareIsoTimestamp(t1, t2)).toBeLessThan(0);
      expect(compareIsoTimestamp(t2, t1)).toBeGreaterThan(0);
    });

    it('should handle timestamps with nanoseconds precision', () => {
      const t1 = '2024-01-01T00:00:00.123456789Z';
      const t2 = '2024-01-01T00:00:00.123456790Z';
      expect(compareIsoTimestamp(t1, t2)).toBeLessThan(0);
    });

    it('should compare timestamps with different timezone formats lexicographically', () => {
      // Note: compareIsoTimestamp does string comparison, not date parsing
      // So timestamps representing the same instant but with different formats
      // will be compared lexicographically
      const t1 = '2024-01-01T00:00:00+00:00';
      const t2 = '2024-01-01T00:00:00Z';
      expect(compareIsoTimestamp(t1, t2)).toBeLessThan(0); // + < Z lexicographically
    });
  });

  describe('sortMessages', () => {
    const createMessage = (id: string, createdAt: string): MessageProjection => ({
      id,
      conversation_id: 'test',
      turn_id: 'turn1',
      role: 'user',
      kind: 'text',
      content_json: { text: 'test' },
      created_at: createdAt,
    });

    it('should return empty array for empty input', () => {
      expect(sortMessages([])).toEqual([]);
    });

    it('should sort messages by created_at', () => {
      const messages = [
        createMessage('c', '2024-01-03T00:00:00Z'),
        createMessage('a', '2024-01-01T00:00:00Z'),
        createMessage('b', '2024-01-02T00:00:00Z'),
      ];
      const sorted = sortMessages(messages);
      expect(sorted.map(m => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('should handle messages with same timestamp', () => {
      const messages = [
        createMessage('a', '2024-01-01T00:00:00Z'),
        createMessage('b', '2024-01-01T00:00:00Z'),
      ];
      const sorted = sortMessages(messages);
      expect(sorted.length).toBe(2);
    });

    it('should not mutate original array', () => {
      const messages = [
        createMessage('b', '2024-01-02T00:00:00Z'),
        createMessage('a', '2024-01-01T00:00:00Z'),
      ];
      const original = [...messages];
      sortMessages(messages);
      expect(messages).toEqual(original);
    });
  });

  describe('timelineItemKey', () => {
    it('should create key with type and id', () => {
      expect(timelineItemKey('message', '123')).toBe('message:123');
      expect(timelineItemKey('tool_call', '456')).toBe('tool_call:456');
      expect(timelineItemKey('permission', '789')).toBe('permission:789');
    });
  });

  describe('buildTimelineItems', () => {
    const createTimeline = () => ({
      events: [],
      messages: [
        { id: 'm1', conversation_id: 'c1', turn_id: 't1', role: 'user' as const, kind: 'text' as const, content_json: {}, created_at: '2024-01-01T00:00:00Z' },
        { id: 'm2', conversation_id: 'c1', turn_id: 't1', role: 'agent' as const, kind: 'text' as const, content_json: {}, created_at: '2024-01-01T00:00:01Z' },
      ],
      tool_calls: [
        { id: 'tc1', conversation_id: 'c1', turn_id: 't1', tool_call_id: 'tc1', title: 'Test', kind: 'execute', status: 'completed', raw_input_json: {}, raw_output_json: {}, content_json: {}, diffs_json: {}, terminal_ids_json: {}, locations_json: {}, started_at: '2024-01-01T00:00:00.500Z', ended_at: '2024-01-01T00:00:01Z' },
      ],
      pending_permissions: [
        { id: 'p1', conversation_id: 'c1', turn_id: 't1', tool_call_id: 'tc1', fingerprint: 'fp1', options_json: {}, status: 'pending' as const, created_at: '2024-01-01T00:00:00.250Z' },
      ],
      terminals: [],
    });

    it('should build timeline items from timeline', () => {
      const timeline = createTimeline();
      const items = buildTimelineItems(timeline);

      expect(items.length).toBe(4); // 2 messages + 1 tool_call + 1 permission
    });

    it('should sort items by timestamp', () => {
      const timeline = createTimeline();
      const items = buildTimelineItems(timeline);

      // Permission (0.250s) -> Tool (0.500s) -> Message 1 (0s but sorted by key) -> Message 2 (1s)
      expect(items[0].type).toBe('message'); // m1 at 00:00:00
      expect(items[1].type).toBe('permission'); // p1 at 00:00:00.250
      expect(items[2].type).toBe('tool_call'); // tc1 at 00:00:00.500
      expect(items[3].type).toBe('message'); // m2 at 00:00:01
    });

    it('should handle empty timeline', () => {
      const timeline = {
        events: [],
        messages: [],
        tool_calls: [],
        pending_permissions: [],
        terminals: [],
      };
      const items = buildTimelineItems(timeline);
      expect(items).toEqual([]);
    });
  });

  describe('upsertTimelineItem', () => {
    const createMessageItem = (id: string) => ({
      type: 'message' as const,
      key: `message:${id}`,
      data: { id, conversation_id: 'c1', turn_id: 't1', role: 'user' as const, kind: 'text' as const, content_json: {}, created_at: '2024-01-01T00:00:00Z' },
    });

    it('should add new item to end of array', () => {
      const items = [createMessageItem('a')];
      const newItem = createMessageItem('b');
      const result = upsertTimelineItem(items, newItem);

      expect(result.length).toBe(2);
      expect(result[1]).toEqual(newItem);
    });

    it('should update existing item with same key', () => {
      const items = [createMessageItem('a')];
      const updatedItem = {
        ...createMessageItem('a'),
        data: { ...createMessageItem('a').data, content_json: { updated: true } },
      };
      const result = upsertTimelineItem(items, updatedItem);

      expect(result.length).toBe(1);
      expect(result[0]).toEqual(updatedItem);
    });

    it('should not mutate original array', () => {
      const items = [createMessageItem('a')];
      const original = [...items];
      const newItem = createMessageItem('b');
      upsertTimelineItem(items, newItem);
      expect(items).toEqual(original);
    });
  });

  describe('mergeTimelineMessage', () => {
    const createTimeline = (): Types.TimelineResponse => ({
      events: [],
      messages: [
        { id: 'm1', conversation_id: 'c1', turn_id: 't1', role: 'user', kind: 'text', content_json: {}, created_at: '2024-01-01T00:00:00Z' },
      ],
      tool_calls: [],
      pending_permissions: [],
      terminals: [],
    });

    const createMessage = (id: string, content?: object): MessageProjection => ({
      id,
      conversation_id: 'c1',
      turn_id: 't1',
      role: 'user',
      kind: 'text',
      content_json: content || {},
      created_at: '2024-01-01T00:00:00Z',
    });

    it('should update existing message', () => {
      const timeline = createTimeline();
      const updatedMessage = createMessage('m1', { updated: true });
      const result = mergeTimelineMessage(timeline, updatedMessage);

      expect(result.messages.length).toBe(1);
      expect(result.messages[0].content_json).toEqual({ updated: true });
    });

    it('should add new message', () => {
      const timeline = createTimeline();
      const newMessage = createMessage('m2');
      const result = mergeTimelineMessage(timeline, newMessage);

      expect(result.messages.length).toBe(2);
      expect(result.messages.map(m => m.id)).toEqual(['m1', 'm2']);
    });

    it('should sort messages after merge', () => {
      const timeline: Types.TimelineResponse = {
        events: [],
        messages: [
          { id: 'm1', conversation_id: 'c1', turn_id: 't1', role: 'user', kind: 'text', content_json: {}, created_at: '2024-01-02T00:00:00Z' },
        ],
        tool_calls: [],
        pending_permissions: [],
        terminals: [],
      };
      const newMessage = createMessage('m2');
      // Give new message an earlier timestamp
      newMessage.created_at = '2024-01-01T00:00:00Z';

      const result = mergeTimelineMessage(timeline, newMessage);
      expect(result.messages.map(m => m.id)).toEqual(['m2', 'm1']);
    });
  });

  describe('mergeToolCall', () => {
    const createToolCall = (id: string, startedAt: string): ToolCallProjection => ({
      id,
      conversation_id: 'c1',
      turn_id: 't1',
      tool_call_id: id,
      title: 'Test',
      kind: 'execute',
      status: 'running',
      raw_input_json: {},
      raw_output_json: {},
      content_json: {},
      diffs_json: {},
      terminal_ids_json: {},
      locations_json: {},
      started_at: startedAt,
      ended_at: '2024-01-01T00:00:01Z',
    });

    const createTimeline = () => ({
      events: [],
      messages: [],
      tool_calls: [createToolCall('tc1', '2024-01-01T00:00:00Z')],
      pending_permissions: [],
      terminals: [],
    });

    it('should update existing tool call', () => {
      const timeline = createTimeline();
      const updatedToolCall = createToolCall('tc1', '2024-01-01T00:00:00Z');
      updatedToolCall.status = 'completed';

      const result = mergeToolCall(timeline, updatedToolCall);

      expect(result.tool_calls.length).toBe(1);
      expect(result.tool_calls[0].status).toBe('completed');
    });

    it('should add new tool call', () => {
      const timeline = createTimeline();
      const newToolCall = createToolCall('tc2', '2024-01-01T00:00:01Z');

      const result = mergeToolCall(timeline, newToolCall);

      expect(result.tool_calls.length).toBe(2);
    });

    it('should sort tool calls by started_at', () => {
      const timeline = {
        events: [],
        messages: [],
        tool_calls: [createToolCall('tc1', '2024-01-01T00:00:01Z')],
        pending_permissions: [],
        terminals: [],
      };
      const newToolCall = createToolCall('tc2', '2024-01-01T00:00:00Z');

      const result = mergeToolCall(timeline, newToolCall);

      expect(result.tool_calls.map(tc => tc.id)).toEqual(['tc2', 'tc1']);
    });
  });

  describe('mergePendingPermission', () => {
    const createPermission = (id: string, createdAt: string, toolCallId = 'tc1'): PendingPermissionRequest => ({
      id,
      conversation_id: 'c1',
      turn_id: 't1',
      tool_call_id: toolCallId,
      fingerprint: 'fp1',
      options_json: {},
      status: 'pending',
      created_at: createdAt,
    });

    it('should update existing permission', () => {
      const permissions = [createPermission('p1', '2024-01-01T00:00:00Z')];
      const updatedPermission = { ...createPermission('p1', '2024-01-01T00:00:00Z'), status: 'resolved' as const };

      const result = mergePendingPermission(permissions, updatedPermission);

      expect(result.length).toBe(1);
      expect(result[0].status).toBe('resolved');
    });

    it('should add new permission with different tool_call_id', () => {
      const permissions = [createPermission('p1', '2024-01-01T00:00:00Z', 'tc1')];
      const newPermission = createPermission('p2', '2024-01-01T00:00:01Z', 'tc2');

      const result = mergePendingPermission(permissions, newPermission);

      expect(result.length).toBe(2);
    });

    it('should sort permissions by created_at', () => {
      const permissions = [
        createPermission('p1', '2024-01-01T00:00:01Z', 'tc1'),
        createPermission('p2', '2024-01-01T00:00:00Z', 'tc2'),
      ];
      const newPermission = createPermission('p3', '2024-01-01T00:00:00.500Z', 'tc3');

      const result = mergePendingPermission(permissions, newPermission);

      expect(result.map(p => p.id)).toEqual(['p2', 'p3', 'p1']);
    });
  });
});
