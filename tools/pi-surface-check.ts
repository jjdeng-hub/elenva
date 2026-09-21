/**
 * pi 用法面探针 —— 升级内核后跑它，比 `tsc --noEmit` 多守一层。
 *
 * ## 为什么需要它
 *
 * `tsc --noEmit` 只守「**署名**」：函数/类型改名字、改参数，它抓得到。
 * 它守不住「**形态**」—— 而本项目的风险恰恰在形态：
 *
 *   · `lib/types.ts` 是**手抄的领域模型**，不是 SDK 类型的副本
 *     （有意不同：`ToolCallContent` 用 `toolCallId/toolName/input`，
 *      SDK 用 `id/name/arguments`；`ThinkingContent.deferred`、
 *      `ToolCallContent.rawInput` 是客户端专有字段）。
 *   · SDK → 领域模型的转换是**手写的**（`lib/normalize.ts`、`lib/session-reader.ts`、
 *      界面里的分支），边界处大量 `as unknown as` —— 类型系统在那里是关闭的。
 *
 * 于是「SDK 新增了一种消息角色 / 内容块 / 换了图片结构」这类变更**不会报错**，
 * 只会表现为界面少显示一点东西。本探针把这些断言显式写出来。
 *
 * ## 怎么跑
 *
 *   根 tsconfig 的 include 是 `**\/*.ts`，而 TypeScript 的 `**` **不进入点开头的目录**，
 *   所以 `.audit/` 默认完全不受检（实测：塞一行必然报错也全绿）。用：
 *
 *     node ./node_modules/typescript/bin/tsc -p .audit/tsconfig.json
 *
 * ## 怎么读结果
 *
 * 每个报错都指向一条**具体待办**，不是笼统的「不兼容」。当前预期是**部分红**——
 * 红的就是已知缺口（见各段注释）；修完之后本文件应当全绿，此后即为回归闸门。
 */

import type { AgentMessage as SDKAgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage as SDKAssistantMessage, ImageContent as SDKImageContent, ToolCall as SDKToolCall } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

import type { AgentMessage, AssistantContentBlock, ImageContent } from "../lib/types";

/* ─────────────── ① 会话文件格式版本 ───────────────
 * `CURRENT_SESSION_VERSION` 变化 = 磁盘格式变了。它一变，**必须**重跑会话兼容性
 * 夹具（读一份冻结的真实会话文件），别直接升级。
 * 升到新版本时：改下面这个字面量，并在当天的 daily 记忆里记一条「格式 N→M」。
 */
const _sessionFormat: 3 = CURRENT_SESSION_VERSION;

/* ─────────────── ② 消息角色覆盖 ───────────────
 * SDK 的 `AgentMessage` 由两部分组成：pi-ai 的 `Message`（user / assistant / toolResult）
 * 加上 pi 在 `core/messages.d.ts` 里对 `CustomAgentMessages` 的**声明合并**
 * （bashExecution / custom / branchSummary / compactionSummary）。
 *
 * 断言：SDK 的**每一个**角色，本项目的 `AgentMessage` 都得建模。
 * 少一个 = SDK 能产出我们渲染不了的消息。
 *
 * 已知缺口（2026-09-19 调研）：`branchSummary` / `compactionSummary` 未建模。
 *   · 目前不致命：磁盘实测 0 处以 `role` 形式出现 —— SDK 把 summary 存成独立的
 *     **条目类型**（`compaction` / `branchSummary`），而 `CompactionEntry` /
 *     `BranchSummaryEntry` 我们都建模了。
 *   · 但它**正因为 0 出现才危险**：pi 若改成塞进 `message`，我们既没有类型护栏，
 *     也没有数据演练过这条路径。
 *   → 修法：要么补两个消息类型，要么在 `lib/types.ts` 写明「刻意不建模」，
 *     把这里的断言改成显式白名单。
 */
type AssertRoleCovered<R extends AgentMessage["role"]> = R;
type _role0 = AssertRoleCovered<"user">;
type _role1 = AssertRoleCovered<"assistant">;
type _role2 = AssertRoleCovered<"toolResult">;
type _role3 = AssertRoleCovered<"custom">;
type _role4 = AssertRoleCovered<"bashExecution">;
type _role5 = AssertRoleCovered<"branchSummary">;
type _role6 = AssertRoleCovered<"compactionSummary">;

/** 反向：SDK 多出来的角色必须恰好是那两个已知缺口；否则就是新角色，得去适配层加分支。 */
type ExtraRoles = Exclude<SDKAgentMessage["role"], AgentMessage["role"]>;
type _extraRolesAreKnown = [ExtraRoles] extends ["branchSummary" | "compactionSummary"]
  ? true
  : "SDK 新增/删除了消息角色 —— 检查 normalize / 渲染分发 / 会话聚合是否漏了适配";
const _extraRolesKnown: _extraRolesAreKnown = true;

/* ─────────────── ③ assistant 内容块覆盖 ───────────────
 * 流式渲染按块类型分发。SDK 新增块类型而我们没分支 → 静默不显示。
 * 当前**完整**（text / thinking / toolCall），这条是防回归。
 */
type AssertBlockCovered<B extends AssistantContentBlock["type"]> = B;
type _block0 = AssertBlockCovered<"text">;
type _block1 = AssertBlockCovered<"thinking">;
type _block2 = AssertBlockCovered<"toolCall">;

type ExtraBlocks = Exclude<SDKAssistantMessage["content"][number]["type"], AssistantContentBlock["type"]>;
type _extraBlocksAreKnown = [ExtraBlocks] extends [never]
  ? true
  : "SDK 新增了 assistant 内容块类型 —— 渲染分发和 normalize 都要加分支";
const _extraBlocksKnown: _extraBlocksAreKnown = true;

/* ─────────────── ④ 图片形态 ───────────────
 * 已修复（2026-09-21，分支 `fix/image-shape`）：`ImageContent` 统一为 SDK 平铺形态
 * `{ type, data, mimeType }`（`url` 为客户端专有的懒加载字段，不写盘）；
 * legacy `{ source: { ... } }` 只在读取层兜底（`lib/image-block.ts` 单点取数：
 * `imageData` / `imageBlockSrc`）。本段此后为**回归闸门**：形态再漂移即红。
 */
type _imageShapeMatchesSDK = [ImageContent] extends [SDKImageContent]
  ? true
  : "ImageContent 形态与 SDK 不一致（见本段注释）";
const _imageShape: _imageShapeMatchesSDK = true;

/* ─────────────── ⑤ toolCall 命名（只记录事实，不做断言）───────────────
 * 同一类「有意不同」：我们是 UI 领域模型，靠 `lib/normalize.ts` 两套命名都认。
 */
const _sdkToolCallKeys: Array<keyof SDKToolCall> = ["id", "name", "arguments", "type"];

void [_sessionFormat, _extraRolesKnown, _extraBlocksKnown, _imageShape, _sdkToolCallKeys];
