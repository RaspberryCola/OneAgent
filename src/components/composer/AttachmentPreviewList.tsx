import { Paperclip, X } from 'lucide-react';
import type { AttachmentResolution, LocalAttachment } from '../../hooks';

function humanFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

interface AttachmentPreviewListProps {
  attachments: Array<{ attachment: LocalAttachment; resolution: AttachmentResolution }>;
  onRemoveAttachment: (id: string) => void;
  // onSetUsageIntent 已经在组件内不使用了，可以保留 props 方便后续不再修改外部依赖
  onSetUsageIntent?: (id: string, usageIntent: 'vision_input' | 'file_resource') => void;
}

export function AttachmentPreviewList({ attachments, onRemoveAttachment }: AttachmentPreviewListProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="px-3 pt-3 flex flex-wrap gap-2">
      {attachments.map(({ attachment }) => (
        <div key={attachment.id} className="relative group flex items-center gap-2.5 rounded-lg border border-light-gray bg-snow p-1.5 pr-3 max-w-[200px]">
          {attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt={attachment.name} className="w-9 h-9 rounded-md object-cover shrink-0 border border-light-gray/50" />
          ) : (
            <div className="w-9 h-9 rounded-md bg-pure-white border border-light-gray shrink-0 flex items-center justify-center">
              <Paperclip className="w-4 h-4 text-stone" />
            </div>
          )}
          
          <div className="min-w-0 flex-1 flex flex-col justify-center">
            <div className="text-[12px] font-medium truncate text-pure-black leading-tight">
              {attachment.name}
            </div>
            <div className="text-[10px] text-stone mt-0.5 truncate leading-tight">
              {humanFileSize(attachment.size)}
            </div>
          </div>
          
          <button
            type="button"
            className="absolute -top-2 -right-2 bg-pure-white border border-light-gray w-5 h-5 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-light-gray text-stone hover:text-pure-black shadow-sm"
            onClick={() => onRemoveAttachment(attachment.id)}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
