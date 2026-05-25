import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, FolderOpen } from 'lucide-react';
import { Command } from '@tauri-apps/plugin-shell';
import type * as Types from '../../lib/backend/types';

interface WorkspaceFileContextMenuProps {
  entry: Types.WorkspaceFileEntry;
  cwd: string;
  position: { x: number; y: number };
  onClose: () => void;
  onNotice: (message: string | null) => void;
}

// Calculate menu position to avoid overflow
function calculateMenuPosition(
  position: { x: number; y: number },
  menuWidth: number = 200,
  menuHeight: number = 130
): React.CSSProperties {
  const padding = 8;
  let x = position.x;
  let y = position.y;

  // Avoid right edge
  if (x + menuWidth > window.innerWidth - padding) {
    x = window.innerWidth - menuWidth - padding;
  }

  // Avoid bottom edge
  if (y + menuHeight > window.innerHeight - padding) {
    y = window.innerHeight - menuHeight - padding;
  }

  return { left: x, top: y };
}

// Get relative path from workspace root
function getRelativePath(absolutePath: string, cwd: string): string {
  if (absolutePath.startsWith(cwd)) {
    const relative = absolutePath.slice(cwd.length);
    return relative.startsWith('/') ? relative.slice(1) : relative;
  }
  return absolutePath;
}

// Reveal file in platform file manager using native commands
async function revealInFileManager(filePath: string): Promise<void> {
  const platform = navigator.platform.toLowerCase();

  if (platform.includes('mac')) {
    // macOS: open -R selects the file in Finder
    // Args must match capability config: ["-R", { validator }]
    await Command.create('open-in-finder', ['-R', filePath]).execute();
  } else if (platform.includes('win')) {
    // Windows: explorer /select,<path> opens Explorer with file selected
    // Args must match capability config: ["/select,", { validator }]
    await Command.create('open-in-explorer', ['/select,', filePath]).execute();
  } else {
    // Linux: xdg-open opens the parent directory
    // Args must match capability config: [{ validator }]
    const parentDir = filePath.split('/').slice(0, -1).join('/') || filePath;
    await Command.create('open-file-manager', [parentDir]).execute();
  }
}

export function WorkspaceFileContextMenu({
  entry,
  cwd,
  position,
  onClose,
  onNotice,
}: WorkspaceFileContextMenuProps) {
  const { t } = useTranslation('workspace');
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Use setTimeout to avoid closing immediately on the same click that opened it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Close on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const handleCopyRelativePath = async () => {
    const relativePath = getRelativePath(entry.path, cwd);
    await navigator.clipboard.writeText(relativePath);
    onNotice(t('pathCopied'));
    setTimeout(() => onNotice(null), 2000);
    onClose();
  };

  const handleCopyAbsolutePath = async () => {
    await navigator.clipboard.writeText(entry.path);
    onNotice(t('pathCopied'));
    setTimeout(() => onNotice(null), 2000);
    onClose();
  };

  const handleRevealInFileManager = async () => {
    try {
      await revealInFileManager(entry.path);
    } catch (error) {
      console.error('Failed to reveal file:', error);
    }
    onClose();
  };

  const revealLabel = navigator.platform.toLowerCase().includes('mac')
    ? t('revealInFinder')
    : navigator.platform.toLowerCase().includes('win')
      ? t('revealInExplorer')
      : t('openInFileManager');

  const menuStyle = calculateMenuPosition(position);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-pure-white border border-light-gray rounded-interactive py-1 min-w-[200px] shadow-lg"
      style={menuStyle}
    >
      <MenuItem icon={<Copy className="w-3.5 h-3.5" />} onClick={handleCopyRelativePath}>
        {t('copyRelativePath')}
      </MenuItem>
      <MenuItem icon={<Copy className="w-3.5 h-3.5" />} onClick={handleCopyAbsolutePath}>
        {t('copyAbsolutePath')}
      </MenuItem>
      <div className="h-px bg-light-gray my-1" />
      <MenuItem icon={<FolderOpen className="w-3.5 h-3.5" />} onClick={handleRevealInFileManager}>
        {revealLabel}
      </MenuItem>
    </div>
  );
}

function MenuItem({
  icon,
  children,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="w-full px-3 py-1.5 text-left text-[12px] text-pure-black hover:bg-snow flex items-center gap-2 transition-colors"
      onClick={onClick}
    >
      <span className="text-stone">{icon}</span>
      <span>{children}</span>
    </button>
  );
}