import Link from "next/link";
import { FileQuestion } from "lucide-react";

/**
 * 404 页。
 *
 * 应用本身是 hash 路由的单页，正常使用不会走到这里；但只要有人手敲路径、
 * 或旧书签失效，就会撞上 Next 默认的裸 404 —— 与产品视觉完全断裂。
 */
export default function NotFound() {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-bg px-6 text-fg">
      <div className="flex max-w-[420px] flex-col items-center text-center">
        <div className="flex size-12 items-center justify-center rounded-card bg-accent-soft text-accent">
          <FileQuestion size={20} />
        </div>
        <div className="mt-3 text-[16px] font-bold">页面不存在</div>
        <p className="mt-1 text-[12px] leading-relaxed text-dim">
          ELENVA Web 是单页应用，所有视图都在根路径下用 <code className="font-mono">#hash</code> 切换。
        </p>
        <Link href="/" className="btn btn-primary mt-4">
          回到工作台
        </Link>
      </div>
    </div>
  );
}
