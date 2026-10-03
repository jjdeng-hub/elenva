---
name: doc-extract
description: 从 PDF / Word / Excel 等文档里提取文本和表格（pdftotext + 专用 venv 里的 pymupdf / python-docx / openpyxl）。Use when asked to read, summarize, or process a PDF, .docx, .xlsx, or other document file.
---

# 文档文本提取

## 环境（一次准备）

- PDF 快速提取：系统自带 `pdftotext`（poppler）。
- 深度解析（表格、分页、图片）：专用 venv 在 `~/.pi/agent/venvs/docs`（已装 `pymupdf` `python-docx` `openpyxl`）。
  不存在时重建：
  ```bash
  python3 -m venv ~/.pi/agent/venvs/docs
  ~/.pi/agent/venvs/docs/bin/pip install pymupdf python-docx openpyxl
  ```

## PDF

```bash
pdftotext -layout -enc UTF-8 in.pdf /tmp/out.txt   # 保留版式，适合有表格/多栏的
```

```bash
~/.pi/agent/venvs/docs/bin/python - <<'PY'
import pymupdf  # 注意：老写法 import fitz 已废弃，直接用 pymupdf
doc = pymupdf.open("in.pdf")
print("页数:", len(doc))
for i, page in enumerate(doc):
    print(f"--- 第 {i+1} 页 ---")
    print(page.get_text()[:1500])
PY
```

- 扫描件（无文字层）：`page.get_images()` 导出图片后用视觉模型看图；做不到就如实说明。
- 大文档：先转文本，`grep -n` 定位，再读片段——别整本塞进上下文。

## Word（.docx）

```bash
~/.pi/agent/venvs/docs/bin/python - <<'PY'
import docx
d = docx.Document("in.docx")
for p in d.paragraphs:
    if p.text.strip(): print(p.text)
for t in d.tables:
    for row in t.rows: print(" | ".join(c.text for c in row.cells))
PY
```

## Excel（.xlsx）

```bash
~/.pi/agent/venvs/docs/bin/python - <<'PY'
import openpyxl
wb = openpyxl.load_workbook("in.xlsx", data_only=True)
for ws in wb.worksheets:
    print(f"=== {ws.title} ({ws.max_row}行 x {ws.max_column}列) ===")
    for row in ws.iter_rows(max_row=50, values_only=True):
        print(row)
PY
```

## 通用纪律

- 先输出"结构摘要"（页数 / 工作表 / 章节标题），再按需深入——省上下文
- 中文文档注意编码：pdftotext 加 `-enc UTF-8`；Python 一律显式 `encoding="utf-8"`
- 提取不了的部分如实说明（扫描件？加密？），不要猜内容
