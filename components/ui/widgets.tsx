"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/components/lib/utils";
import { copyText } from "@/lib/clipboard";

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          // 局域网 http 访问时 navigator.clipboard 不存在，copyText 内含回退
          await copyText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* ignore */
        }
      }}
      className={cn(
        "inline-flex size-6.5 items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg cursor-pointer",
        className,
      )}
      title="复制"
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}
