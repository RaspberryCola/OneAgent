import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { listen } from '@tauri-apps/api/event';
import { Plus, X, Terminal as TerminalIcon } from 'lucide-react';
import * as API from '../../lib/backend/commands';
import 'xterm/css/xterm.css';

interface TerminalTab {
  id: string;
  name: string;
  cwd: string;
}

interface TerminalPanelProps {
  isOpen: boolean;
  onClose: () => void;
  activeWorkspaceCwd: string | null | undefined;
  tabs: TerminalTab[];
  activeTabId: string | null;
  onAddTab: () => void;
  onCloseTab: (id: string) => void;
  onSelectTab: (id: string) => void;
}

export function TerminalPanel({
  isOpen,
  onClose,
  activeWorkspaceCwd,
  tabs,
  activeTabId,
  onAddTab,
  onCloseTab,
  onSelectTab,
}: TerminalPanelProps) {
  const [height, setHeight] = useState(300);
  const isDragging = useRef(false);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const startY = e.clientY;
    const startHeight = height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDragging.current) return;
      const deltaY = moveEvent.clientY - startY;
      // Allow resizing between 150px and 80% of window height
      const newHeight = Math.max(150, Math.min(window.innerHeight * 0.8, startHeight - deltaY));
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div
      className="border-t border-light-gray bg-pure-white flex flex-col relative z-20"
      style={{ height: `${height}px`, display: isOpen ? 'flex' : 'none' }}
    >
      {/* Draggable top handle with subtle hover indicator */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute -top-1 left-0 right-0 h-2 cursor-ns-resize z-30 group"
        title="Drag to resize terminal"
      >
        <div className="w-full h-[2px] bg-transparent group-hover:bg-stone/30 transition-colors" />
      </div>
      {/* Tabs Header bar */}
      <div className="h-10 px-4 flex items-center justify-between shrink-0 select-none bg-pure-white">
        <div className="flex items-center gap-1.5 overflow-x-auto min-w-0">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1 text-[12px] font-medium rounded-interactive cursor-pointer transition-colors max-w-[150px] ${
                activeTabId === tab.id
                  ? 'bg-light-gray text-pure-black'
                  : 'text-stone hover:bg-light-gray/40 hover:text-pure-black'
              }`}
            >
              <TerminalIcon className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{tab.name}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className="p-0.5 rounded-full text-stone hover:bg-light-gray/80 hover:text-pure-black transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={onAddTab}
            className="p-1.5 text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/40 transition-colors"
            title="New Terminal"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="p-1.5 text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/40 transition-colors"
          title="Close Terminal Panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Terminals body */}
      <div className="flex-1 min-h-0 bg-pure-white text-pure-black relative overflow-hidden">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0 p-2 overflow-hidden"
            style={{ display: activeTabId === tab.id ? 'block' : 'none' }}
          >
            <SingleTerminalInstance
              id={tab.id}
              cwd={tab.cwd}
              isActive={activeTabId === tab.id}
            />
          </div>
        ))}
        {tabs.length === 0 && (
          <div className="w-full h-full flex items-center justify-center text-[13px] text-stone">
            No terminals running. Click '+' to start one.
          </div>
        )}
      </div>
    </div>
  );
}

interface SingleTerminalInstanceProps {
  id: string;
  cwd: string;
  isActive: boolean;
}

function SingleTerminalInstance({ id, cwd, isActive }: SingleTerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Use ref to keep track of active state in ResizeObserver closure without recreating terminal
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create xterm.js instance
    const term = new Terminal({
      cursorBlink: true,
      minimumContrastRatio: 4.5,
      scrollback: 5000,
      theme: {
        background: '#ffffff',
        foreground: '#1c1917',
        cursor: '#78716c',
        selectionBackground: 'rgba(0, 0, 0, 0.08)',
        black: '#1c1917',
        red: '#dc2626',
        green: '#16a34a',
        yellow: '#d97706',
        blue: '#2563eb',
        magenta: '#9333ea',
        cyan: '#0891b2',
        white: '#ffffff',
        brightBlack: '#78716c',
        brightRed: '#ef4444',
        brightGreen: '#22c55e',
        brightYellow: '#f59e0b',
        brightBlue: '#3b82f6',
        brightMagenta: '#a855f7',
        brightCyan: '#06b6d4',
        brightWhite: '#ffffff',
      },
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      allowProposedApi: true,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    term.open(containerRef.current);
    fitAddon.fit();

    // Spawn backend session
    void API.spawnTerminal(id, cwd).then(() => {
      // Set initial dimensions
      void API.resizeTerminal(id, term.cols, term.rows);
    });

    // Handle user input
    const onDataDisposable = term.onData((data) => {
      void API.writeToTerminal(id, data);
    });

    // Resize observer to handle container changes
    const resizeObserver = new ResizeObserver(() => {
      if (isActiveRef.current) {
        fitAddon.fit();
        void API.resizeTerminal(id, term.cols, term.rows);
      }
    });
    resizeObserver.observe(containerRef.current);

    // Listen for PTY output events
    let unlisten: (() => void) | null = null;
    void listen<{ id: string; data: string }>('terminal:output', (event) => {
      if (event.payload.id === id) {
        term.write(event.payload.data);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      onDataDisposable.dispose();
      resizeObserver.disconnect();
      if (unlisten) unlisten();
      term.dispose();
      void API.closeTerminal(id);
    };
  }, [id, cwd]);

  // Handle active status changes
  useEffect(() => {
    if (isActive && termRef.current && fitAddonRef.current) {
      // Short timeout to allow container display style change to render
      const timer = setTimeout(() => {
        if (fitAddonRef.current && termRef.current) {
          fitAddonRef.current.fit();
          termRef.current.focus();
          void API.resizeTerminal(id, termRef.current.cols, termRef.current.rows);
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isActive, id]);

  return <div ref={containerRef} className="w-full h-full" />;
}
