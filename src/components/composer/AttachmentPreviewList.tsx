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
  onSetUsageIntent: (id: string, usageIntent: 'vision_input' | 'file_resource') => void;
}

export function AttachmentPreviewList({ attachments, onRemoveAttachment, onSetUsageIntent }: AttachmentPreviewListProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="px-3 pt-3 space-y-2">
      {attachments.map(({ attachment, resolution }) => (
        <div key={attachment.id} className="flex items-center gap-3 rounded-xl border border-light-gray bg-snow px-3 py-2">
          {attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt={attachment.name} className="w-12 h-12 rounded-lg object-cover shrink-0" />
          ) : (
            <div className="w-12 h-12 rounded-lg bg-pure-white border border-light-gray shrink-0 flex items-center justify-center">
              <Paperclip className="w-4 h-4 text-stone" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium truncate">{attachment.name}</div>
            <div className="text-[11px] text-stone flex flex-wrap gap-2">
              <span>{humanFileSize(attachment.size)}</span>
              <span>{resolution.label}</span>
            </div>
            {attachment.kind === 'image' && (
              <div className="mt-1 inline-flex rounded-md border border-light-gray overflow-hidden text-[11px]">
                <button
                  type="button"
                  className={`px-2 py-0.5 transition-colors ${attachment.usageIntent !== 'file_resource' ? 'bg-pure-black text-pure-white' : 'bg-pure-white text-stone hover:text-pure-black'}`}
                  onClick={() => onSetUsageIntent(attachment.id, 'vision_input')}
                >
                  Read image
                </button>
                <button
                  type="button"
                  className={`px-2 py-0.5 border-l border-light-gray transition-colors ${attachment.usageIntent === 'file_resource' ? 'bg-pure-black text-pure-white' : 'bg-pure-white text-stone hover:text-pure-black'}`}
                  onClick={() => onSetUsageIntent(attachment.id, 'file_resource')}
                >
                  As file
                </button>
              </div>
            )}
            {resolution.reason && <div className="text-[11px] text-stone truncate">{resolution.reason}</div>}
          </div>
          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-light-gray/60 text-stone hover:text-pure-black"
            onClick={() => onRemoveAttachment(attachment.id)}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
