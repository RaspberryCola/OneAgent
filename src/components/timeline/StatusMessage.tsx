type StatusMessageProps = {
  content: string;
};

export function StatusMessage({ content }: StatusMessageProps) {
  return (
    <div className="flex w-full justify-center mt-1 mb-2">
      <div className="rounded-pill border border-light-gray bg-snow px-3 py-1.5 text-[12px] text-stone">
        {content || "Status updated"}
      </div>
    </div>
  );
}
