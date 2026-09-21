#!/usr/bin/env python3
"""组装 Windows 便携包（免开发环境、免安装）。

产物 dist/elenva-web/：
  start.cmd            双击入口
  launcher.js          启动逻辑（等就绪后用 App 模式开窗）
  runtime/node.exe     内置 Node 运行时（用户机器无需装 Node）
  elenva.ico           快捷方式图标
  app/                 Next standalone 产物 + public/

前置：先运行 `npm run build`（产出 .next/standalone）。
node.exe 默认复用本机托管 Node，可用环境变量 ELENVA_NODE_EXE 覆盖。
"""
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STANDALONE = ROOT / ".next" / "standalone"
PUBLIC = ROOT / "public"
BIN = ROOT / "bin"
OUT = ROOT / "dist" / "elenva-web"
ARCHIVE = Path(os.environ.get("TEMP") or "/tmp") / "elenva-dist-archive"

# 默认取本机托管 Node（相对家目录，不写死用户名）；再退到 PATH 里的 node
DEFAULT_NODE = Path.home() / ".workbuddy" / "binaries" / "node" / "versions" / "22.22.2-2" / "node.exe"


def archive_previous() -> None:
    """旧产物移走而非删除 —— 避免触发沙箱的批量删除守卫。"""
    if not OUT.exists():
        return
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    target = ARCHIVE / f"elenva-web-{int(time.time())}"
    shutil.move(str(OUT), str(target))
    print(f"  旧产物已归档 → {target}")


def copy_tree(src: Path, dst: Path) -> None:
    shutil.copytree(src, dst, dirs_exist_ok=True)


def human(size: float) -> str:
    return f"{size / 1048576:.1f} MB"


def main() -> None:
    node_exe = Path(os.environ.get("ELENVA_NODE_EXE") or DEFAULT_NODE)
    if not node_exe.exists():
        from_path = shutil.which("node")
        if from_path:
            node_exe = Path(from_path)
    if not node_exe.exists():
        sys.exit(f"找不到 node.exe：{node_exe}（可用 ELENVA_NODE_EXE 指定）")
    if not (STANDALONE / "server.js").exists():
        sys.exit("缺少 .next/standalone —— 请先运行 `npm run build`")
    if not (PUBLIC / "icons" / "elenva.ico").exists():
        sys.exit("缺少 public/icons/elenva.ico —— 请先运行 .audit/make-pwa-icons.py")

    archive_previous()

    app_dir = OUT / "app"
    runtime_dir = OUT / "runtime"
    app_dir.mkdir(parents=True, exist_ok=True)
    runtime_dir.mkdir(parents=True, exist_ok=True)

    print("  · 复制 Next standalone 产物 → app/")
    copy_tree(STANDALONE, app_dir)

    # standalone 默认不含这两块，必须手动补齐，否则静态资源与 PWA 全 404
    print("  · 补 app/.next/static")
    copy_tree(ROOT / ".next" / "static", app_dir / ".next" / "static")
    print("  · 补 app/public（PWA 图标 / sw / 离线页）")
    copy_tree(PUBLIC, app_dir / "public")

    print("  · 内置 Node 运行时 → runtime/node.exe")
    shutil.copy2(node_exe, runtime_dir / "node.exe")
    print(f"    {human(node_exe.stat().st_size)}")

    print("  · 启动脚本与图标")
    shutil.copy2(BIN / "elenva-web-portable.js", OUT / "launcher.js")
    shutil.copy2(PUBLIC / "icons" / "elenva.ico", OUT / "elenva.ico")
    shutil.copy2(BIN / "install-shortcut.ps1", OUT / "install-shortcut.ps1")
    # .cmd 必须是 CRLF，否则部分 cmd.exe 会解析异常
    for name in ("start.cmd", "install-shortcut.cmd"):
        raw = (BIN / name).read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        (OUT / name).write_bytes(raw)

    files = [p for p in OUT.rglob("*") if p.is_file()]
    total = sum(p.stat().st_size for p in files)
    print(f"\n  ✅ 便携包完成：{OUT}")
    print(f"     {len(files)} 个文件，{human(total)}（未压缩）")


if __name__ == "__main__":
    main()
