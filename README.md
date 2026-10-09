# ELENVA Web

> 在确定性中寻找出口

我给自己做的 [pi coding agent](https://pi.dev) 控制台。

它不帮我写代码。它让我在把事情交给 agent 之后，还能清楚地知道：哪个在跑，哪个在等我，这一轮到底做了什么，做错了能不能退回去。

![ELENVA 工作台总览](docs/screenshots/01-workbench.png)

## 为什么做它

pi 在终端里很好用。直到我同时开了十几个会话。

哪个卡住了？哪个改坏了东西？它说“已完成”，是真的完成了，还是只是它觉得完成了？今天又花了多少钱？这些问题只能一个个会话翻着找。而且我本来就不太喜欢把终端当成主要的工作界面，我更想看见变化。

于是有了 ELENVA。

我想要的不是一个更好的编辑器，而是一块仪表盘。

## 在确定性中寻找出口

这句话是我做 ELENVA 时一直守着的原则。

agent 的价值在于放手：让它去探索、去试，去走我没想到的路。这就是“出口”。

但只有在确定的前提下，我才敢放手：

- 我知道它做了什么，
- 我知道它的结论有没有证据，
- 我知道做错了可以退回去，
- 我知道真正危险的事，它会先问我。

ELENVA 里几乎每个功能，都是在给我补其中一块确定性。

---

## 它为我做的三件事

### 一、让我一眼看清

- 需要你处理的：被中断、工具报错的会话，会自动推到首页。这是整个工作台里唯一会主动找我的功能，我希望它保持这样克制。
- 过程自动收起：一轮里几十条思考和工具调用，结束后收成一行：思考 8 次 · 工具 11 次 · 1 个失败。想看细节再点开。
- 离线用量：直接读本地会话文件，看今天、近 14 天花了多少 token、多少钱，哪个模型最贵。数据不出本机。

### 二、不让它把“我觉得完成了”说成“完成了”

这是我最在意的部分。

![一轮任务完成](docs/screenshots/02-session.png)

做过排查的人都知道，“看起来好了”和“验证过了”是两回事。所以 ELENVA 对措辞很较真：

- 只跑了一个文件的检查，显示“仅单点验证”，不会写成“验证通过”。
- 一次验证都没跑，就直接写“结论未经核对”。
- 改了代码却没留下对应的检查记录，收尾前会追问一次：要么补检查，要么说清楚哪些还没通过，或者这个项目确实没有检查可跑。

每一步都可以展开核查，改动的 diff、执行过的命令、成功还是失败，全部留痕：

![write 工具卡展开：改动 diff](docs/screenshots/03-write-diff.png)

### 三、做错了能退，危险的事先问

- 一键整轮回滚：每次写入前都会保存原文件。回滚时，我后来手动改过的内容不会被覆盖。
- 危险动作审批：删除文件、强制推送、安装依赖、修改凭据、写到工作区以外，都要先经过一张确认卡。默认只拦这几类，不想被打扰时也可以整体关掉。
- 计划模式：先只读勘察，计划经我批准才能动手。我不想再在 prompt 里反复叮嘱“先给方案，别动手”。

## 其他在日常里长出来的东西

| 功能 | 为什么需要它 |
| --- | --- |
| 并行试验 | 拿不准方案时，同时开 2–3 个候选，各自在独立 worktree 里跑，并排比较后选一个合回去 |
| 子代理监控 | 子代理跑偏了，可以直接插话纠正或中止 |
| 上下文可视化 | 回答开始变糊的时候，能看到上次压缩丢了什么 |
| 记住这条 | 纠正过一次的话，一键写进 AGENTS.md，不用等它下次再犯 |
| 看得见的过程态 | 自动重试、压缩、模型报错实时显示，不用对着“等待模型…”猜 |
| 技能归档 | 按使用情况分层，只归档不删除，随时可以恢复 |
| 三步接入模型 | 选厂商、填 Key 或用订阅账号登录、选默认模型。不用回终端敲 /login |
| 插件市场 | 在界面里搜索并安装 pi-package |

| 技能页 | 浅色主题 |
| --- | --- |
| ![技能页](docs/screenshots/04-skills.png) | ![浅色主题](docs/screenshots/05-light-theme.png) |

截图来自演示工作区，数据是虚构的。

## 我的取舍

ELENVA 是我的个人工作台，我每天都在用。

决定一个功能留不留，我只问一句：我上一次真正用到它是什么时候？

所以它会一直是这个样子：

- 自用优先，不为想象中的用户加功能；
- 不做多用户，不做多语言；
- 源码公开，欢迎 fork、issue 和 PR，但不提供上手支持。

如果它刚好也适合你，那很好。

## 快速开始

需要 Node ≥ 22.19。

```bash
git clone https://github.com/jjdeng-hub/elenva.git
cd elenva
npm run setup -- --build    # 检查 Node、安装依赖、生产构建
npm run start               # http://127.0.0.1:30200
```

Windows：双击根目录的 `启动.cmd`（或 `start.cmd`），会自动安装依赖、构建并打开浏览器。

首次使用：首页会提示“接入模型”。如果你已经用过 pi，会自动继承 `~/.pi/agent/` 里已有的 key 和会话。

版本发布只通过 [GitHub Releases](https://github.com/jjdeng-hub/elenva/releases) 提供。

## 与 pi 的关系

pi 是引擎，ELENVA 是仪表盘。

- pi 内核（[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)）作为库在同一进程内运行，版本锁定在 1.0.0。不需要另外安装 pi CLI。
- 数据目录与 pi 共用 `~/.pi/agent/`。在 ELENVA 里归档技能、修改设置，也会影响 pi CLI。
- 后端大量代码 fork 自 [pi-web](https://github.com/agegr/pi-web)（MIT），界面和交互是我独立实现的。感谢上游作者。

## 数据与安全

- 会话、凭据、设置都只保存在本机 `~/.pi/agent/`，用量统计离线完成。
- 服务默认只监听 127.0.0.1。
- 设置 `PI_WEB_PASSWORD` 可以开放局域网访问。ELENVA 能执行命令、写文件，请只在可信网络中开启，不要暴露到公网。

## 开发者信息

### 开发

```bash
npm run setup   # 检查 Node 版本、安装依赖
npm run dev     # 开发模式，热更新
npm run build   # 生产构建
```

### 提交前检查（与 CI 相同）

```bash
npx tsc --noEmit                # 1) 类型检查
npx tsc -p tools/tsconfig.json  # 2) 内核 API 形态探针
python tools/style-converge.py  # 3) 设计系统收敛（需要 Python）
```

## 架构

一个 Node 进程同时运行 Next.js 服务和 pi 内核。内核通过函数调用驱动，不是子进程，所以不需要 node-pty。打开会话时才实例化内核，空闲 10 分钟后自动回收。

## 目录结构

```
app/            Next.js 路由与 API
components/     界面组件
lib/            内核适配与业务逻辑
  agent-runtime.ts       会话生命周期
  host-guardrails-extension.ts  审批 / 快照 / 计划模式 / 验证门禁
  tool-risk.ts           工具调用风险分级
  checkpoints.ts         改动快照与回滚
  verification-*.ts      验证识别与证据账本
  attention.ts           需要关注检测
  candidates.ts          并行试验
  usage-aggregate.ts     离线用量聚合
  skill-lifecycle.ts     技能分层与归档
bin/            启动器
tools/          设计系统规范与收敛脚本
```

升级记录见 [`docs/pi-upgrade.md`](docs/pi-upgrade.md)，发布约定见 [`docs/release.md`](docs/release.md)。

---

[MIT](LICENSE) · v0.1.1 · 一个人的工作台，慢慢长。
