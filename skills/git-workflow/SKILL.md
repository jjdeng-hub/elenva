---
name: git-workflow
description: 分支、提交、推送、合并的规范流程，含国内服务器直连 GitHub 不通时的绕行方法（ssh.github.com:443 / gh-proxy）。Use when committing, branching, pushing, merging, or when git network operations fail.
---

# Git 工作流

## 基本流程

1. 确认工作区状态：`git status`（脏工作区里要看清哪些是自己改的）。
2. 分支命名：`feat/<短名>` / `fix/<短名>`；小改动可以直接在用户指定的分支上做。
3. 提交信息**当公开文本写**：不写真名、账号、本机绝对路径、隐私数据；
   多行提交信息用 `git commit -F <文件>`。
4. 推送：`git push -u origin <分支>`。

## 国内服务器的网络绕行（实测）

直连 `github.com` 的 git 通道经常不通，两条可靠路径：

- **SSH over 443**：在 `~/.ssh/config` 加
  ```
  Host github.com
    HostName ssh.github.com
    Port 443
    User git
  ```
  之后 `git clone/push git@github.com:...` 正常走 443 端口。
- **HTTPS 代理**：文件类请求（raw 文件、release）用 `https://gh-proxy.com/<原始URL>` 前缀。

## 提交前

- 跑项目的检查门（见 verify-before-claim 技能），别把红着的代码提交。
- 有 pre-commit 钩子的仓库：小内存机器上钩子可能跑全量检查导致卡死/OOM——
  与用户确认后可用 `git commit --no-verify`，并在汇报里说明。

## 合并与发布

- 合并用 `git merge --no-ff`（保留合并记录）；合并前在目标分支复核检查门。
- **部署/发布类命令可能读"工作区"而不是 git 提交**——执行前确认没有未提交改动，
  否则会把没提交的代码带上线。
- 不要 force push 共享分支（main/master）；不要动别人正在用的分支。
