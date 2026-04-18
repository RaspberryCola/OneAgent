import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { DISPLAY_LIMITS } from '../../lib/constants';

interface CollapsibleContentProps {
  children: React.ReactNode;
  /** Maximum height in pixels */
  maxHeight?: number;
  /** Whether initially collapsed */
  defaultCollapsed?: boolean;
  className?: string;
  contentClassName?: string;
}

export function CollapsibleContent({
  children,
  maxHeight = DISPLAY_LIMITS.COLLAPSIBLE_DEFAULT_MAX_HEIGHT,
  defaultCollapsed = true,
  className = '',
  contentClassName = '',
}: CollapsibleContentProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    let rafId: number | null = null;
    const scheduleHeightCheck = () => {
      const update = () => {
        const contentHeight = element.scrollHeight;
        setNeedsCollapse(contentHeight > maxHeight);
      };

      if (typeof window !== 'undefined' && 'requestAnimationFrame' in window) {
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = window.requestAnimationFrame(update);
      } else {
        update();
      }
    };

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => {
        scheduleHeightCheck();
      });
      resizeObserver.observe(element);
      scheduleHeightCheck();
      return () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        resizeObserver.disconnect();
      };
    } else {
      const timer = setTimeout(scheduleHeightCheck, 100);
      return () => {
        clearTimeout(timer);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }
  }, [children, maxHeight]);

  const contentStyle: React.CSSProperties = {
    maxHeight: isCollapsed && needsCollapse ? `${maxHeight}px` : undefined,
    overflow: isCollapsed && needsCollapse ? 'hidden' : 'visible',
  };

  return (
    <div className={`flex flex-col relative w-full ${className}`}>
      <div 
        ref={contentRef} 
        className={`w-full ${contentClassName}`} 
        style={contentStyle}
      >
        {children}
      </div>

      {needsCollapse && (
        <div className="flex justify-center mt-2">
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-pill bg-pure-white border border-light-gray text-[12px] font-medium text-pure-black transition-none cursor-pointer hover:bg-snow"
            type="button"
          >
            {isCollapsed ? (
              <>
                <span>Expand</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </>
            ) : (
              <>
                <span>Collapse</span>
                <ChevronUp className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
