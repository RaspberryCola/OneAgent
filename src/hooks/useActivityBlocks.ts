import { useMemo } from 'react';
import type { TimelineItem } from '../lib/utils/timeline';
import { groupTimelineSegments, type GroupedSegment } from '../lib/utils/activityBlock';

export interface UseActivityBlocksOptions {
  activeTimelineItems: TimelineItem[];
  isTurnActive: boolean;
}

export interface UseActivityBlocksReturn {
  segments: GroupedSegment[];
}

/**
 * Hook that groups timeline items into activity blocks.
 * Wraps groupTimelineSegments with useMemo for performance.
 */
export function useActivityBlocks({
  activeTimelineItems,
  isTurnActive,
}: UseActivityBlocksOptions): UseActivityBlocksReturn {
  const segments = useMemo(
    () => groupTimelineSegments(activeTimelineItems, isTurnActive),
    [activeTimelineItems, isTurnActive],
  );

  return { segments };
}
