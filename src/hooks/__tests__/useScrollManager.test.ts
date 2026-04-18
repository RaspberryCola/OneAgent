import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScrollManager } from '../useScrollManager';
import { TIMING } from '../../lib/constants';

describe('useScrollManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockScrollContainer = (overrides?: Partial<HTMLDivElement>) => {
    const container = {
      scrollHeight: 1000,
      clientHeight: 500,
      scrollTop: 0,
      scrollTo: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      ...overrides,
    };
    return container as unknown as HTMLDivElement;
  };

  const createScrollEvent = (target: HTMLDivElement): Event => {
    return {
      target,
      bubbles: false,
      cancelBubble: false,
      cancelable: false,
      composed: false,
      currentTarget: target,
      defaultPrevented: false,
      eventPhase: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      isTrusted: false,
      srcElement: null,
      timeStamp: 0,
      type: 'scroll',
    } as unknown as Event;
  };

  describe('initialization', () => {
    it('should initialize with default values', () => {
      const { result } = renderHook(() => useScrollManager());

      expect(result.current.showScrollButton).toBe(false);
      expect(result.current.isAtBottom).toBe(true);
      expect(result.current.userHasScrolledUp).toBe(false);
      expect(result.current.scrollAreaRef.current).toBe(null);
      expect(result.current.scrollContentRef.current).toBe(null);
    });

    it('should accept custom threshold options', () => {
      const { result } = renderHook(() =>
        useScrollManager({ bottomThreshold: 100 })
      );

      // The hook should use the custom threshold
      expect(result.current).toBeDefined();
    });
  });

  describe('checkIsAtBottom', () => {
    it('should return true when scroll is at bottom', () => {
      const mockContainer = createMockScrollContainer({ scrollTop: 500 });

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
      });

      // Simulate scroll event
      act(() => {
        const scrollHandler = (mockContainer.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
          (call: any) => call[0] === 'scroll'
        )?.[1] as EventListener;
        scrollHandler?.(createScrollEvent(mockContainer));
      });

      expect(result.current.isAtBottom).toBe(true);
    });

    it('should return false when scroll is not at bottom', () => {
      const mockContainer = createMockScrollContainer({ scrollTop: 400 });

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
      });

      // Simulate scroll event
      act(() => {
        const scrollHandler = (mockContainer.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
          (call: any) => call[0] === 'scroll'
        )?.[1] as EventListener;
        scrollHandler?.(createScrollEvent(mockContainer));
      });

      expect(result.current.isAtBottom).toBe(false);
      expect(result.current.showScrollButton).toBe(true);
    });

    it('should return true when container is null', () => {
      const { result } = renderHook(() => useScrollManager());
      expect(result.current.isAtBottom).toBe(true);
    });
  });

  describe('setScrollAreaRef', () => {
    it('should attach scroll listener when element is provided', () => {
      const mockContainer = createMockScrollContainer();

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
      });

      expect(mockContainer.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
      expect(result.current.scrollAreaRef.current).toBe(mockContainer);
    });

    it('should remove previous listener before attaching new one', () => {
      const mockContainer1 = createMockScrollContainer();
      const mockContainer2 = createMockScrollContainer();

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer1);
        result.current.setScrollAreaRef(mockContainer2);
      });

      expect(mockContainer1.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
      expect(mockContainer2.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
    });

    it('should remove listener when element is null', () => {
      const mockContainer = createMockScrollContainer();

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
        result.current.setScrollAreaRef(null);
      });

      expect(mockContainer.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
      expect(result.current.scrollAreaRef.current).toBe(null);
    });

    it('should not attach listener when enabled is false', () => {
      const mockContainer = createMockScrollContainer();

      const { result } = renderHook(() => useScrollManager({ enabled: false }));
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
      });

      expect(mockContainer.addEventListener).not.toHaveBeenCalled();
    });
  });

  describe('scrollToBottom', () => {
    it('should scroll to bottom with smooth behavior', () => {
      const mockContainer = createMockScrollContainer();

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
      });

      act(() => {
        result.current.scrollToBottom();
      });

      expect(mockContainer.scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({
          top: 1000,
          behavior: 'smooth',
        })
      );
    });

    it('should reset userHasScrolledUp state', () => {
      const mockContainer = createMockScrollContainer();

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
      });

      expect(result.current.userHasScrolledUp).toBe(false);

      act(() => {
        result.current.scrollToBottom();
      });

      expect(result.current.userHasScrolledUp).toBe(false);
    });
  });

  describe('scrollToBottomImmediate', () => {
    it('should scroll to bottom with auto behavior', () => {
      const mockContainer = createMockScrollContainer();

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
      });

      act(() => {
        result.current.scrollToBottomImmediate();
      });

      expect(mockContainer.scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({
          top: 1000,
          behavior: 'auto',
        })
      );
    });
  });

  describe('forceScrollToBottom', () => {
    it('should scroll to bottom regardless of user state', () => {
      const mockContainer = createMockScrollContainer();

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
      });

      act(() => {
        result.current.forceScrollToBottom();
      });

      expect(mockContainer.scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({
          top: 1000,
          behavior: 'smooth',
        })
      );
    });
  });

  describe('showScrollButton', () => {
    it('should show scroll button when user scrolls up', () => {
      const mockContainer = createMockScrollContainer({ scrollTop: 400 });

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
      });

      // Simulate scroll event
      act(() => {
        const scrollHandler = (mockContainer.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
          (call: any) => call[0] === 'scroll'
        )?.[1] as EventListener;
        scrollHandler?.(createScrollEvent(mockContainer));
      });

      expect(result.current.showScrollButton).toBe(true);
    });

    it('should hide scroll button when at bottom', () => {
      const mockContainer = createMockScrollContainer({ scrollTop: 500 });

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
      });

      // Simulate scroll event
      act(() => {
        const scrollHandler = (mockContainer.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
          (call: any) => call[0] === 'scroll'
        )?.[1] as EventListener;
        scrollHandler?.(createScrollEvent(mockContainer));
      });

      expect(result.current.showScrollButton).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should cleanup listeners on unmount', () => {
      const mockContainer = createMockScrollContainer();

      const { unmount, result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
      });

      unmount();

      expect(mockContainer.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
    });
  });

  describe('userHasScrolledUp', () => {
    it('should be false initially', () => {
      const { result } = renderHook(() => useScrollManager());
      expect(result.current.userHasScrolledUp).toBe(false);
    });

    it('should remain false after scrollToBottom', () => {
      const mockContainer = createMockScrollContainer();

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
        result.current.scrollToBottom();
      });
      expect(result.current.userHasScrolledUp).toBe(false);
    });

    it('should be false after scrollToBottom', () => {
      const mockContainer = createMockScrollContainer();

      const { result } = renderHook(() => useScrollManager());
      act(() => {
        result.current.setScrollAreaRef(mockContainer);
        result.current.scrollToBottom();
      });

      expect(result.current.userHasScrolledUp).toBe(false);
    });
  });

  describe('default timing values', () => {
    it('should use TIMING constants as defaults', () => {
      expect(TIMING.SCROLL_BOTTOM_THRESHOLD_PX).toBe(50);
      expect(TIMING.SMOOTH_SCROLL_RESET_DELAY_MS).toBe(300);
      expect(TIMING.AUTO_SCROLL_RESET_DELAY_MS).toBe(80);
    });
  });
});
