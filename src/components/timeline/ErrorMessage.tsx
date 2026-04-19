import { AlertCircle } from "lucide-react";

type ErrorMessageProps = {
  content: string;
};

export function ErrorMessage({ content }: ErrorMessageProps) {
  return (
    <div className="flex w-full justify-start mt-1 mb-2">
      <div className="w-full max-w-[95%] md:max-w-[85%] border border-light-gray bg-snow rounded-container px-4 py-3 text-near-black">
        <div className="flex items-center gap-2 mb-1 text-stone">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="text-[11px] font-medium uppercase tracking-wider">Error</span>
        </div>
        <div className="text-[14px] leading-relaxed whitespace-pre-wrap">{content || "Unknown error"}</div>
      </div>
    </div>
  );
}
