import { useRef, useState, useEffect, useCallback } from 'react';
import { TIMING } from '../lib/constants';

export interface UseScrollManagerOptions {
  bottomThreshold?: number;      // 滚动到底部的阈值（默认 50px）
  smoothScrollDelay?: number;    // 平滑滚动重置延迟（默认 300ms）
  autoScrollDelay?: number;      // 自动滚动重置延迟（默认 80ms）
  enabled?: boolean;             // 是否启用自动滚动（默认 true）
}

export interface UseScrollManagerReturn {
  // Refs
  scrollAreaRef: React.RefObject<HTMLDivElement | null>;
  scrollContentRef: React.MutableRefObject<HTMLDivElement | null>;

  // Methods
  setScrollAreaRef: (element: HTMLDivElement | null) => void;
  scrollToBottom: () => void;                    // 平滑滚动
  scrollToBottomImmediate: () => void;           // 立即滚动
  forceScrollToBottom: () => void;               // 强制滚动（忽略用户状态）

  // State
  showScrollButton: boolean;
  isAtBottom: boolean;
  userHasScrolledUp: boolean;
}

/**
 * 自定义 Hook 用于管理聊天界面的自动滚动行为
 *
 * 功能：
 * - 检测用户是否手动滚动到顶部
 * - 自动滚动到底部（当有新消息时）
 * - 显示/隐藏"滚动到底部"按钮
 * - 处理程序化滚动与用户手动滚动的冲突
 */
export function useScrollManager(options: UseScrollManagerOptions = {}): UseScrollManagerReturn {
  const {
    bottomThreshold = TIMING.SCROLL_BOTTOM_THRESHOLD_PX,
    smoothScrollDelay = TIMING.SMOOTH_SCROLL_RESET_DELAY_MS,
    autoScrollDelay = TIMING.AUTO_SCROLL_RESET_DELAY_MS,
    enabled = true,
  } = options;

  // Refs
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const scrollContentRef = useRef<HTMLDivElement | null>(null);
  const userHasScrolledUpRef = useRef(false);
  const isProgrammaticScrollingRef = useRef(false);
  const scrollResetTimeoutRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);

  // State
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Check if scroll is near bottom (within threshold)
  const checkIsAtBottom = useCallback(() => {
    if (scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current;
      const maxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      return maxScrollTop - scrollContainer.scrollTop <= bottomThreshold;
    }
    return true;
  }, [bottomThreshold]);

  // Handle scroll events to detect user manual scrolling
  const handleScrollEvent = useCallback(() => {
    // Ignore scroll events triggered by programmatic scrolling
    if (isProgrammaticScrollingRef.current) {
      return;
    }

    const currentIsAtBottom = checkIsAtBottom();
    setIsAtBottom(currentIsAtBottom);
    setShowScrollButton(!currentIsAtBottom);

    if (currentIsAtBottom) {
      userHasScrolledUpRef.current = false;
    } else {
      userHasScrolledUpRef.current = true;
    }
  }, [checkIsAtBottom]);

  const clearProgrammaticScrollReset = useCallback(() => {
    if (scrollResetTimeoutRef.current !== null) {
      window.clearTimeout(scrollResetTimeoutRef.current);
      scrollResetTimeoutRef.current = null;
    }
  }, []);

  const scheduleProgrammaticScrollReset = useCallback((delayMs: number) => {
    clearProgrammaticScrollReset();
    scrollResetTimeoutRef.current = window.setTimeout(() => {
      isProgrammaticScrollingRef.current = false;
      scrollResetTimeoutRef.current = null;
      handleScrollEvent();
    }, delayMs);
  }, [clearProgrammaticScrollReset, handleScrollEvent]);

  const performScrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const scrollContainer = scrollAreaRef.current;
    if (!scrollContainer) return;

    if (scrollRafRef.current !== null) {
      window.cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }

    isProgrammaticScrollingRef.current = true;
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior,
    });
    userHasScrolledUpRef.current = false;
    setShowScrollButton(false);
    setIsAtBottom(true);

    const finalize = () => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scheduleProgrammaticScrollReset(behavior === 'smooth' ? smoothScrollDelay : autoScrollDelay);
    };

    if (typeof window !== 'undefined' && 'requestAnimationFrame' in window) {
      scrollRafRef.current = window.requestAnimationFrame(() => {
        scrollRafRef.current = window.requestAnimationFrame(() => {
          scrollRafRef.current = null;
          finalize();
        });
      });
    } else {
      finalize();
    }
  }, [autoScrollDelay, scheduleProgrammaticScrollReset, smoothScrollDelay]);

  // Scroll to bottom with smooth behavior
  const scrollToBottom = useCallback(() => {
    userHasScrolledUpRef.current = false;
    performScrollToBottom('smooth');
  }, [performScrollToBottom]);

  // Scroll to bottom immediately (no animation)
  const scrollToBottomImmediate = useCallback(() => {
    userHasScrolledUpRef.current = false;
    performScrollToBottom('auto');
  }, [performScrollToBottom]);

  // Force scroll to bottom (ignores user scroll state)
  const forceScrollToBottom = useCallback(() => {
    performScrollToBottom('smooth');
  }, [performScrollToBottom]);

  // Set up scroll listener when ref is available
  const setScrollAreaRef = useCallback((element: HTMLDivElement | null) => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.removeEventListener('scroll', handleScrollEvent);
    }
    scrollAreaRef.current = element;
    if (element && enabled) {
      element.addEventListener('scroll', handleScrollEvent);
      // Initial check
      const initialIsAtBottom = checkIsAtBottom();
      setIsAtBottom(initialIsAtBottom);
      setShowScrollButton(!initialIsAtBottom);
    }
  }, [checkIsAtBottom, enabled, handleScrollEvent]);

  // Cleanup scroll listener on unmount
  useEffect(() => {
    return () => {
      clearProgrammaticScrollReset();
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
      if (scrollAreaRef.current) {
        scrollAreaRef.current.removeEventListener('scroll', handleScrollEvent);
      }
    };
  }, [clearProgrammaticScrollReset, handleScrollEvent]);

  // Re-attach scroll listener when enabled changes
  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.removeEventListener('scroll', handleScrollEvent);
      if (enabled) {
        scrollAreaRef.current.addEventListener('scroll', handleScrollEvent);
      }
    }
  }, [enabled, handleScrollEvent]);

  return {
    // Refs
    scrollAreaRef,
    scrollContentRef,

    // Methods
    setScrollAreaRef,
    scrollToBottom,
    scrollToBottomImmediate,
    forceScrollToBottom,

    // State
    showScrollButton,
    isAtBottom,
    userHasScrolledUp: userHasScrolledUpRef.current,
  };
}
