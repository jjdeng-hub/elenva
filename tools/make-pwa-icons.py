#!/usr/bin/env python3
"""生成 ELENVA 的 PWA 图标（192 / 512 / apple-touch 180）。

图形取自 components/Logo.tsx 的 LogoMark —— 外方框（确定性）+ C 形缺口 + 红色出口块。
几何按 64×64 viewBox 等比换算，保证与界面里显示的 logo 完全一致。
色值取自 globals.css：--bg #F6F5F2 / --fg #2C2C2A / --accent #C9302C。
"""
from pathlib import Path

from PIL import Image, ImageDraw

BG = (246, 245, 242)      # --bg
INK = (44, 44, 42)        # --fg
ACCENT = (201, 48, 44)    # --accent

# LogoMark 在 64 单位 viewBox 内的几何（与 Logo.tsx 一一对应）
FRAME = (7.5, 7.5, 49.0, 49.0, 7.0)          # x, y, w, h, strokeWidth
C_PATH = [(42.0, 22.0), (22.0, 22.0), (22.0, 42.0), (42.0, 42.0)]
C_STROKE = 6.5
RED_BLOCK = (31.0, 28.75, 13.0, 6.5)         # x, y, w, h

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icons"


def render(size: int, logo_ratio: float = 0.62) -> Image.Image:
    img = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(img)

    side = size * logo_ratio
    scale = side / 64.0
    offset = (size - side) / 2.0

    def px(v: float) -> float:
        return offset + v * scale

    # 外方框：先填实心再挖内芯，得到与 SVG 居中描边等价的精确边框
    fx, fy, fw, fh, stroke = FRAME
    half = stroke / 2.0
    d.rectangle([px(fx - half), px(fy - half), px(fx + fw + half), px(fy + fh + half)], fill=INK)
    d.rectangle([px(fx + half), px(fy + half), px(fx + fw - half), px(fy + fh - half)], fill=BG)

    # C 形（开口朝右）
    line_width = max(1, round(C_STROKE * scale))
    d.line([(px(x), px(y)) for x, y in C_PATH], fill=INK, width=line_width, joint="curve")

    # 红色出口块
    rx, ry, rw, rh = RED_BLOCK
    d.rectangle([px(rx), px(ry), px(rx + rw), px(ry + rh)], fill=ACCENT)

    return img


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]
    for name, size in targets:
        path = OUT_DIR / name
        render(size).save(path, "PNG", optimize=True)
        print(f"  {name:24} {size}x{size}  {path.stat().st_size / 1024:5.1f} KB")

    # Windows 快捷方式（.lnk）用的多尺寸 .ico —— 必须含 16/32，否则任务栏与
    # 资源管理器小图标视图会糊。.ico 供便携包生成快捷方式时使用。
    ico_path = OUT_DIR / "elenva.ico"
    render(256).save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"  {'elenva.ico':24} {'16~256 多尺寸':>13}  {ico_path.stat().st_size / 1024:5.1f} KB")


if __name__ == "__main__":
    main()
