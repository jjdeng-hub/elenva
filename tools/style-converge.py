#!/usr/bin/env python3
"""一次性样式收敛脚本：圆角 4 档 / 字号 7 档 / 图标 5 档 / 阴影 2 档 / 动效 3 档 / 消除硬编码原生色。

规则来源见 app/globals.css 顶部「排版尺度」与「动效节奏」注释。幂等：重复执行不产生新改动。
"""
import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
TARGETS = []
for pat in ("components/**/*.tsx", "app/**/*.tsx"):
    TARGETS.extend(sorted(ROOT.glob(pat)))

FS_MAP = {  # 字号收敛（半像素档并入相邻整档）
    "9.5": "10", "10.5": "11", "11.5": "12", "12.5": "12",
    "13.5": "13", "15": "14", "17": "16", "21": "20",
}
ICON_MAP = {  # 图标收敛：10 内嵌 / 12 行内 / 14 导航 / 16 强调 / 20 空态
    "9": "10", "10.5": "10", "11": "12", "12.5": "12",
    "13": "14", "15": "14", "22": "20", "26": "20", "28": "20",
}
COLOR_MAP = {
    "text-blue-600": "text-muted",
    "text-green-700": "text-success",
    "bg-green-500/10": "bg-success/10",
    "bg-red-500/10": "bg-danger/10",
}

fs_re = re.compile(r"text-\[(" + "|".join(re.escape(k) for k in sorted(FS_MAP, key=len, reverse=True)) + r")px\]")
icon_re = re.compile(r"size=\{(" + "|".join(re.escape(k) for k in sorted(ICON_MAP, key=len, reverse=True)) + r")\}")
color_re = re.compile(r"\b(" + "|".join(re.escape(k) for k in COLOR_MAP) + r")\b")

total = 0
changed_files = []

for path in TARGETS:
    src = path.read_text(encoding="utf-8")
    out = src

    # 圆角：2xl/xl → card（12px）；裸 rounded → sm（6px）
    out = re.sub(r"\brounded-(?:2xl|xl)\b", "rounded-card", out)
    out = re.sub(r"\brounded\b(?![-\w])", "rounded-sm", out)

    # 字号 / 图标 / 硬编码色
    out = fs_re.sub(lambda m: f"text-[{FS_MAP[m.group(1)]}px]", out)
    out = icon_re.sub(lambda m: f"size={{{ICON_MAP[m.group(1)]}}}", out)
    out = color_re.sub(lambda m: COLOR_MAP[m.group(1)], out)

    # 阴影：只保留 sm（细描边级）与 lg（浮层级）
    out = re.sub(r"\bshadow-(?:2xl|xl)\b", "shadow-lg", out)
    out = re.sub(r"\bshadow\b(?![-\w])", "shadow-sm", out)

    # 动效节奏：颜色过渡统一 t-fast（120ms）；整块位移/尺寸过渡统一 t-slow（200ms）
    out = re.sub(r"\btransition-all duration-200\b", "t-slow", out)
    out = re.sub(r"\btransition-colors\b", "t-fast", out)

    if out != src:
        n = sum(1 for a, b in zip(src.splitlines(), out.splitlines()) if a != b)
        path.write_text(out, encoding="utf-8", newline="")
        changed_files.append((path.relative_to(ROOT).as_posix(), n))
        total += n

for name, n in changed_files:
    print(f"  {n:>3} 行  {name}")
print(f"\n共修改 {len(changed_files)} 个文件 / {total} 行")
