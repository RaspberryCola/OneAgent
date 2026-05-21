import { useEffect, useRef, useState } from 'react';
import type { AvailableCommand } from '../../lib/backend/types';

interface SlashCommandDropdownProps {
  commands: AvailableCommand[];
  query: string;
  onSelect: (command: AvailableCommand) => void;
  onDismiss: () => void;
}

export function SlashCommandDropdown({
  commands,
  query,
  onSelect,
  onDismiss,
}: SlashCommandDropdownProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = commands.filter((cmd) =>
    cmd.name.toLowerCase().startsWith(query.toLowerCase()),
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (filtered.length === 0) {
      onDismiss();
    }
  }, [filtered.length, onDismiss]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          onSelect(filtered[selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [filtered, selectedIndex, onSelect, onDismiss]);

  useEffect(() => {
    const selected = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="max-h-[200px] overflow-y-auto bg-pure-white border border-light-gray rounded-container shadow-sm"
    >
      {filtered.map((cmd, index) => (
        <button
          key={cmd.name}
          type="button"
          className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
            index === selectedIndex
              ? 'bg-light-gray/50'
              : 'hover:bg-light-gray/30'
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd);
          }}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <span className="text-[12px] font-mono text-pure-black shrink-0">
            /{cmd.name}
          </span>
          <span className="text-[11px] text-stone truncate">
            {cmd.description}
          </span>
          {cmd.input_hint && (
            <span className="text-[10px] text-silver shrink-0 ml-auto">
              {cmd.input_hint}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
