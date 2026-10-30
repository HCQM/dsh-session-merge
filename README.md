# 🔀 dsh-session-merge — 合并、追加 DSH 会话

[![npm version](https://img.shields.io/npm/v/dsh-session-merge?label=npm&color=blue)](https://www.npmjs.com/package/dsh-session-merge)
[![npm downloads](https://img.shields.io/npm/dm/dsh-session-merge?label=%E6%9C%88%E4%B8%8B%E8%BD%BD&color=brightgreen)](https://www.npmjs.com/package/dsh-session-merge)
[![license](https://img.shields.io/badge/license-MIT-orange)](./LICENSE)
[![stars](https://img.shields.io/github/stars/HCQM/dsh-session-merge?style=flat)](https://github.com/HCQM/dsh-session-merge/stargazers)
[![issues](https://img.shields.io/github/issues/HCQM/dsh-session-merge)](https://github.com/HCQM/dsh-session-merge/issues)
[![platform](https://img.shields.io/badge/platform-DSH%20Desktop-8A2BE2)](https://github.com/HCQM/dsh-session-merge)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-purple)](https://github.com/HCQM/dsh-session-merge)

**简体中文** · [English](README.en.md)

> **想合并 DSH 会话，直接拼文件不行——格式、压缩节点、seq 引用全是坑。**
>
> 这个插件走 DSH 自己的写入接口：不删一个事件，写进去的每个字节 DSH 都认。

- 🎯 **来自一次真实的手滑** —— 不是通用工具。做它是因为弄 QQ agent 时不小心开了新会话，想把两段合回去，当时没找到现成的合并方式。
- 🔒 **完整性优先** —— 合并/追加都不删事件。`/compact` 也只是把之前的内容生成摘要，**原文永远还在会话里**。
- 📐 **算切点，不靠猜** —— `planCompact` 按 turn 边界算每段 ≤ 预算的位置，避开已有压缩记录。
- 🛡️ **三层校验** —— 写入前预检 / 六层深度 / 官方 `open`，报错文案与 DSH 界面一字不差。
- 🧱 **断点续写** —— 每批 1.4~1.5 MB，压一次写一批。

<p align="center"><strong>⭐ 如果你也有"想把几个会话拼成一个"的需求，点个 star。</strong><br/>
<sub>一行安装：<code>dsh plugin --profile desktop add dsh-session-merge</code></sub></p>

## ⚡ 快速开始

```bash
dsh plugin --profile desktop add dsh-session-merge
# 重启 DSH → 插件列表里出现「会话合并」
```

装完先跑三个**只读**动作，不写任何东西：

```js
session_merge_build({ inspect: true, targetId: "<会话id>" })      // 看结构
session_merge_build({ verify: true, targetId: "<会话id>" })       // DSH 能不能打开
session_merge_build({ planCompact: true, targetId: "<会话id>" })  // 切点和体积
```

## 🧩 它解决什么

历史散在多个会话里：QQ agent 开错窗口、并行起了两条线、fork 出去又回不来。想回头查"那天到底怎么定的"得来回翻；想把它们并成一条——**直接拼文件 DSH 是打不开的**：

| 直接拼会踩的坑 | 为什么 |
|---|---|
| 压缩节点指向错位 | `shadowedRange` / `shadowedSeqs` 存的是旧 seq，搬过去全指错 |
| seq 不连续 | DSH 要求 seq 从 0 起密集递增，拼出来就断 |
| surface 折叠指错 | 会话里可能有 `surfaceOp:{op:'replace'}`，它的 `startSeq`/`endSeq` 指着旧 seq |
| 工具调用对不上 | `callId` / `toolCallId` 跨会话不匹配，孤儿结果一堆 |
| 时间线早就有分叉 | 并行会话本来就交错，硬拼会来回跳 |

插件做的事就两件：**合并**（`fullCopy` / `mixCopy`）和**追加**（`fromJsonl`）。

合并完得到的是**一个正常会话**：老历史在前、新对话接在后面，压缩节点跟着走，`/compact` 照常能用。代价是 surface 变大——换来一个完整、连贯、可检索的容器。

真正难的不是"把事件搬过去"，而是**搬完 DSH 还认**。这就是三层校验存在的理由。

## 🛡️ 三层校验（核心）

| 层 | 谁 | 查什么 | 何时跑 |
|---|---|---|---|
| 轻量预检 | `validate-full.mjs` | surface 折叠、生命周期、compaction 配对、header 字段、seq 连续、`sourceEventSeqs` | 每次写入前自动 |
| 六层深度 | `deep-validate.mjs` | 帧 / header / 路径 / 事件稠密与类型表 / 继承关系 / 内嵌流重放 | 写入后、排障时 |
| 官方校验 | `verify` | 直接调 `persistence.open` | 要"和 DSH 完全一样"的结论时 |

深度校验可独立跑：

```bash
node bin/validate.mjs <会话id前缀|目录|文件> [--json] [--no-replay] [--strict-replay]
node bin/validate.mjs --all     # 批量校验全部会话
```

## 📏 硬约束（实测）

| 项 | 数值 | 来源 |
|---|---|---|
| 单次请求上限 | 1,048,576 tokens | 模型硬限 |
| surface 字节/token | **3.8** | 22.52 MB ≈ 6.2M tokens 反推 |
| 安全线 | **surface ≤ 3.4 MB** | ≈900K tokens，再大 `/compact` 发不出去 |

> 能不能压，看的是**当前可见 surface 的体积**，不是界面上那个百分比。

## 🧰 完整能力

一个工具 `session_merge_build`，10 个模式均可独立调用：

| 参数 | 类型 | 做什么 |
|---|---|---|
| `inspect` | 只读 | 事件 / turn / surface 体积 / 压缩节点 / 时间范围 |
| `verify` | 只读 | 官方 `open` 校验（可单独调，也可配 `inspect`）|
| `planCompact` | 只读 | 算可压缩切点：`cuts[]` + 每段体积 |
| `makeRoot` | 写 | 把会话改造成合法根（修断链）|
| `forkClone` | 写 | 官方 `sessions.fork` 克隆，保留压缩节点 |
| `fullCopy` | 写 | 多源全类型复制，按 assistant 回复去重 |
| `mixCopy` | 写 | 按时间窗混合，`byteBudget` 到量停 |
| `fromJsonl` | 写 | 按区间写 JSONL，自动补 turn 边界 / 自动 seq 偏移 |
| `copySequential` | 写 | 单源直线复制，重映射全部 seq 引用 |
| `resumeOnly` | 写 | 只 resume 触发落盘 |

写入都支持 `dryRun`。用法细节：[FEATURES.md](FEATURES.md) · [CONFIG.md](CONFIG.md) · [API.md](API.md)

## 🩺 另外两个用途

**修断链会话** —— 以前合并过、父会话后来被删掉的，会报 `parentSession` 错误打不开。`makeRoot` 把它改造成合法根（四处标记同时改）。用法见 [FEATURES.md](FEATURES.md#makeroot--把会话改造成合法根)。

**救压不动的会话** —— 不是主用途：**DSH 有自动压缩，真卡死很少见**。真遇到 `requested N tokens > 1,048,576` 时，解法是分段压缩（不删不折）：`planCompact` 算切点 → 按切点 `forkClone` → 每段手动 `/compact` → `fullCopy` 拼回 → `verify`。完整步骤见 [排障手册](session-merge-runbook.md)。

## ⚖️ 代价与边界

| 是 | 不是 |
|---|---|
| 一次性的合并/救援工具 | 日常插件 |
| 保证上下文完整（0 删除）| 省钱工具（只会让 surface 变大）|
| 三层校验兜底 | 记忆系统（压缩后 AI 读到的仍是摘要）|

真正该长期活下来的东西在**记忆库**（记忆卡 / `memory_recall` / 日记）。会话只是"最近这段"的容器。

**跨会话搬运时确实会丢的**：

| 丢的 | 原因 | 防法 |
|---|---|---|
| 空回复的唤醒记录 | 去重被判重复 | `fullCopy` 空回复不参与去重 |
| 未闭合的 turn | 源会话被强杀 / 切点落在 turn 中间 | 切点自动补到 `turn/end`，只按整块搬 |
| 未结算的工具调用 | `callId` 对不上 | 丢弃孤儿 call/result |
| 收件箱事件（`agent/inbox/spliced`）| `target:'next-turn'` + `start` 索引对不上新会话时点 | 一律跳过（不在 surface 上，跳过无损）|
| 严格时间顺序 | 并行会话本就交错 | 保留真实时间戳 |

## 🧪 实测记录

用一个 **49,513 事件 / 1,310 turn / 22.52 MB** 的真实大会话跑过全量功能：

| 功能 | 结果 |
|---|---|
| `inspect` | 22.52 MB（含水下）/ 可见 2.56 MB |
| `planCompact`（800 KB 预算）| **3 段**（0.81 / 0.77 / 0.81 MB）|
| `forkClone` | 49,514 条 seed，`verify` 通过 |
| `fullCopy` | 47,233 条，跳过 spliced 2,041 / end-seed 88 |
| `mixCopy` | 47,069 条 / 22 MB |
| `copySequential` | 49,496 条 / 44 压缩记录，`verify` 通过 |
| `fromJsonl` | seq 偏移 49,496，写入后仍可打开 |
| `makeRoot` | 49,513 条 / 0 问题 / 修 delivery 18 |

另外扫了 80 个本机会话作为横向样本：10 个含 `surfaceOp:{op:'replace'}`（共 279 条），1 个末尾有未闭合 turn（进程被强杀）。

这轮实测修掉 7 个 bug，细节见 [CHANGELOG](CHANGELOG.md)。

## 📚 文档

[INSTALL](INSTALL.md) · [FEATURES](FEATURES.md) · [CONFIG](CONFIG.md) · [API](API.md) · [CHANGELOG](CHANGELOG.md) · [排障手册](session-merge-runbook.md) · [English](README.en.md)

## 🧩 兼容性

| 项 | 值 |
|---|---|
| 平台 | DSH 桌面端（Electron），实测 **0.2.1-rc.5** |
| 会话格式 | v4（`session.v4.jsonl.zstd`）|
| 操作系统 | Windows 实测；路径全走 `node:path` |

## 📄 License

[MIT](./LICENSE) © 2026 HCQM
