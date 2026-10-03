---
name: verify-before-claim
description: 验证纪律——改了代码/配置后，先跑能覆盖改动的检查并拿到真实输出，再宣称"完成"；单点检查不等于整体通过。Use after making code changes, before reporting a task as done or claiming something works.
---

# 验证先于结论

核心一句话：**没有验证证据的"完成"不算完成。**

## 收尾前必须做的事

1. **找到项目的检查门**（按优先级）：
   - `AGENTS.md` / `CONTRIBUTING.md` 里写的验证流程（最权威）
   - `package.json` scripts（test / lint / typecheck / build）
   - `Makefile`（make test / make check）
   - 语言惯例：Python `pytest`；TS `tsc --noEmit`；Go `go build ./... && go test ./...`
2. **跑能覆盖改动的检查**：改了哪个模块，就选覆盖它的检查；拿**真实输出**（退出码 / 关键行）作为证据。
3. **单点 ≠ 整体**：只跑了局部检查，就在结论里写清范围（"已验证 X，未覆盖 Y"）。
4. **失败不静默**：检查红了就如实报出红项；修复后用同一命令复跑。
5. **没有可跑的检查**：直接说明原因（这个项目确实没有测试），**不要造一条命令来应付**。

## 结论怎么写

- ✅ "已跑 `npm test`，32/32 通过；`tsc --noEmit` 无输出。"
- ❌ "应该没问题了。"
- 有未验证部分：明确列出"未验证：浏览器端交互（无自动化覆盖）"。

## 反模式

- 改完直接说"完成"（宿主会追问，返工更贵）
- 跑了检查但没看输出
- 用"看起来对"代替"跑过了"
