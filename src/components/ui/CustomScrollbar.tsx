import React, { useRef, useEffect, useState, useCallback } from 'react';

interface CustomScrollbarProps {
  children: React.ReactNode;
  className?: string;
  /** Callback ref for the scrollable container */
  scrollRef?: (node: HTMLDivElement | null) => void;
  /** Ref forwarded to the content container */
  contentRef?: React.RefObject<HTMLDivElement | null>;
  /** Scroll speed multiplier (1 = normal, 1.5 = 50% faster) */
  scrollSpeed?: number;
}

export function CustomScrollbar({ children, className = '', scrollRef, contentRef, scrollSpeed = 1 }: CustomScrollbarProps) {
  const internalRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbHeight, setThumbHeight] = useState(0);
  const [thumbTop, setThumbTop] = useState(0);
  const [visible, setVisible] = useState(false);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartScrollTop = useRef(0);

  const setRef = useCallback((node: HTMLDivElement | null) => {
    (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    scrollRef?.(node);
  }, [scrollRef]);

  const updateThumb = useCallback(() => {
    const el = internalRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const ratio = clientHeight / scrollHeight;
    const height = Math.max(20, clientHeight * ratio);
    const maxTop = clientHeight - height;
    const top = (scrollTop / (scrollHeight - clientHeight)) * maxTop;
    setThumbHeight(height);
    setThumbTop(top);
  }, []);

  useEffect(() => {
    const el = internalRef.current;
    if (!el) return;

    updateThumb();

    const observer = new ResizeObserver(() => updateThumb());
    observer.observe(el);

    el.addEventListener('scroll', updateThumb, { passive: true });

    const handleWheel = (e: WheelEvent) => {
      if (scrollSpeed === 1) return;
      e.preventDefault();
      el.scrollTop += e.deltaY * scrollSpeed;
    };
    el.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', updateThumb);
      el.removeEventListener('wheel', handleWheel);
    };
  }, [updateThumb, scrollSpeed]);

  useEffect(() => {
    const content = contentRef?.current;
    if (!content) return;
    const observer = new ResizeObserver(() => updateThumb());
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentRef, updateThumb]);

  const handleThumbMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartY.current = e.clientY;
    dragStartScrollTop.current = internalRef.current?.scrollTop || 0;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDragging.current || !internalRef.current) return;
      const el = internalRef.current;
      const deltaY = moveEvent.clientY - dragStartY.current;
      const scrollRatio = (el.scrollHeight - el.clientHeight) / (el.clientHeight - thumbHeight);
      el.scrollTop = dragStartScrollTop.current + deltaY * scrollRatio;
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [thumbHeight]);

  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    if (!internalRef.current || e.target === thumbRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const el = internalRef.current;
    el.scrollTop = (clickY / rect.height) * el.scrollHeight;
  }, []);

  return (
    <div className={`relative flex flex-col min-h-0 group/scroll ${className}`}>
      <div
        ref={setRef}
        className="flex-1 min-h-0 overflow-y-auto no-scrollbar"
      >
        {children}
      </div>

      {visible && (
        <div
          className="absolute right-0 top-0 bottom-0 w-3 cursor-pointer z-10"
          onClick={handleTrackClick}
        >
          <div
            ref={thumbRef}
            className="absolute right-0 w-1.5 bg-black/[0.15] hover:bg-black/[0.25] transition-colors"
            style={{
              height: `${thumbHeight}px`,
              top: `${thumbTop}px`,
            }}
            onMouseDown={handleThumbMouseDown}
          />
        </div>
      )}
    </div>
  );
}
