# 🔀 dsh-session-merge — 合并、追加、救活 DSH 会话

[![version](https://img.shields.io/badge/version-0.5.0-blue)](./CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-orange)](./LICENSE)
[![stars](https://img.shields.io/github/stars/HCQM/dsh-session-merge?style=flat)](https://github.com/HCQM/dsh-session-merge/stargazers)
[![issues](https://img.shields.io/github/issues/HCQM/dsh-session-merge)](https://github.com/HCQM/dsh-session-merge/issues)
[![platform](https://img.shields.io/badge/platform-DSH%20Desktop-8A2BE2)](https://github.com/HCQM/dsh-session-merge)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-purple)](https://github.com/HCQM/dsh-session-merge)

**简体中文** · [English](README.en.md)

> **会话爆了、既不能继续也不能压缩——把它救回来。**
>
> 不删一个事件，三层校验兜底，写进去的每一个字节 DSH 都认。

- 🎯 **只为救援而生** —— 不是日常插件，平时开着什么都不变；只在会话卡死时登场。
- 🔒 **上下文完整性优先** —— 合并/追加都不删事件，`/compact` 也只追加摘要；原文永远在日志里。
- 📐 **算切点，不靠猜** —— `planCompact` 按 turn 边界算出每段 ≤ 预算的位置，避开已有压缩记录。
- 🛡️ **三层校验** —— 写入前预检 / 六层深度 / 官方 `open` 校验，报错文案与 DSH 界面一字不差。
- 🧱 **断点续写** —— 每批 1.4~1.5 MB，压一次写一批。

<p align="center"><strong>⭐ 如果你也遇到过"上下文爆了救不回来"，点个 star 让我知道。</strong><br/>
<sub>一行安装：<code>dsh plugin --profile desktop add dsh-session-merge</code></sub></p>

## ⚡ 快速开始

```bash
dsh plugin --profile desktop add dsh-session-merge
# 重启 DSH → 插件列表里出现「会话合并」
```

装完先跑三个**只读**动作，不写任何东西：

```js
// 看结构
session_merge_build({ inspect: true, targetId: "<会话id>" })

// DSH 能不能打开（可单独调，也可和 inspect 一起）
session_merge_build({ verify: true, targetId: "<会话id>" })

// 切点算好了没有、分几段、每段多大
session_merge_build({ planCompact: true, targetId: "<会话id>" })
```

## 🩺 它到底救什么

一个具体的死锁（实测遇到的那次）：

```
requested 1,370,066 tokens > 1,048,576 (maximum context length)
```

会话既不能继续，也不能压缩。为什么压不动？**因为 `/compact` 要把当前可见 surface 一次性发给模型**，超过单次请求上限就发不出去。

| 关于 `/compact` 的事实 | 含义 |
|---|---|
| 它**不删**任何事件 | 原始对话全部还在日志里，一条不少 |
| 它只**追加**一条摘要 | 生成摘要 + `shadowedRange` |
| 之后 AI 看到「摘要 + 压缩点后的原文」| 被覆盖的原文 AI 不再逐字读，但**仍在会话里** |

所以解法是**分段压缩**，不是删、也不是折叠：

```
inspect 看现状  →  planCompact 算切点  →  按切点 fork 分段
     →  每段手动 /compact  →  fullCopy 拼回  →  verify 确认
```

## 🛡️ 三层校验（这个项目的核心）

搬运事件谁都会，**搬完让 DSH 认**才是难点。三层独立校验，各自可单独调用：

| 层 | 谁 | 查什么 | 何时跑 |
|---|---|---|---|
| 轻量预检 | `validate-full.mjs` | surface 折叠、turn/step/tool 生命周期、compaction 配对、header 字段、seq 连续、`sourceEventSeqs` | 每次写入前自动 |
| 六层深度 | `deep-validate.mjs` | 帧 / header / 路径 / 事件稠密与类型表 / 继承关系 / 内嵌流重放 | 写入后、排障时 |
| 官方校验 | `verify` 模式 | 直接调 DSH 的 `persistence.open` | 要"和 DSH 完全一样"的结论时 |

深度校验可独立跑：

```bash
node bin/validate.mjs <会话id前缀|目录|文件> [--json] [--no-replay] [--strict-replay]
node bin/validate.mjs --all     # 批量校验全部会话
```

## 📏 硬约束（实测）

| 项 | 数值 | 来源 |
|---|---|---|
| 单次请求上限 | 1,048,576 tokens | 模型硬限 |
| completion 预留 | 64K（偶发 256K）| 实测压缩请求 |
| surface 字节/token | **3.8** | 22.52 MB ≈ 6.2M tokens 反推 |
| 安全线 | **surface ≤ 3.4 MB** | ≈900K tokens，再大 `/compact` 必失败 |

> 关键：能不能压，看的是**当前可见 surface 的体积**，不是界面上那个百分比。

## 🧰 完整能力

一个工具 `session_merge_build`，**9 个模式可独立调用**；另有 `session_unlock` 和独立 CLI。

| 参数 | 类型 | 做什么 |
|---|---|---|
| `inspect` | 只读 | 事件 / turn / surface 体积 / 压缩节点 / 时间范围 / 类型分布 |
| `verify` | 只读 | 官方 `open` 校验，报错原文透传（可单独调，也可配 `inspect`）|
| `planCompact` | 只读 | 算可压缩切点：`cuts[]` + 每段体积，避开已有压缩记录 |
| `makeRoot` | 写 | 把会话改造成合法根：`isSeeded=false`、删 `parentSession`、继承标记清零、`delivery` 重指 |
| `forkClone` | 写 | 官方 `sessions.fork` 克隆，保留压缩节点 |
| `fullCopy` | 写 | 多源全类型复制，按 assistant 回复去重，`keepCompaction` 保留压缩记录 |
| `mixCopy` | 写 | 按时间窗混合，`byteBudget` 到量停并返回 `nextFrom` |
| `fromJsonl` | 写 | 按区间写 JSONL，自动补 turn 边界 / 自动 seq 偏移 / 返回 `progress` |
| `copySequential` | 写 | 单源直线复制，重映射全部 seq 引用（含 `data.sourceEventSeq`）|
| `resumeOnly` | 写 | 只 resume 触发落盘 |

所有写入都支持 `dryRun: true`。参数细节：[FEATURES.md](FEATURES.md) · [CONFIG.md](CONFIG.md) · [API.md](API.md)

## 🚑 抢救流程

```js
// 1. 看清现状
session_merge_build({ inspect: true, targetId: "<卡住的会话>" })

// 2. 算切点（只读，不动任何事件）
session_merge_build({ planCompact: true, targetId: "<卡住的会话>" })
// → cuts[]，每个带 cutAfterSeq / prefixMB / prefixTokens

// 3. 按切点逐个 fork（每段都是能压得动的小会话）
session_merge_build({ forkClone: true, sources: ["<卡住的会话>"], targetId: "<段1>", forkBoundary: <cuts[0].cutAfterSeq> })
session_merge_build({ forkClone: true, sources: ["<卡住的会话>"], targetId: "<段2>", forkBoundary: <cuts[1].cutAfterSeq> })

// 4. 在 GUI 里对每段手动 /compact

// 5. 拼回一个新会话
session_merge_build({ fullCopy: true, sources: ["<段1>", "<段2>"], targetId: "<新会话>", keepCompaction: true })

// 6. 确认能打开
session_merge_build({ verify: true, targetId: "<新会话>" })
```

结果：新会话里 AI 读到「几段摘要 + 最后一段原文」——这是 DSH 正常的压缩形态，不是数据丢失。原始事件全部保留在各分支里。

## 🔗 另一个用途：修断链会话

以前合并过会话、父会话后来被删掉的，会报 `parentSession` 相关错误、怎么都打不开。用 `makeRoot` 把它改造成合法根：

```js
session_merge_build({
  makeRoot: true,
  sourceId: "<断链的会话>",
  targetId: "<新会话id>",
})
// 返回: { events, clearedInherited, deliveryFixed }
```

四处同时改（少一处 DSH 仍拒绝）：`isSeeded=false`、删 `parentSession`（不能写 `null`）、`end-seed.inherited` 改 `false`、`delivery.sessionId` 指向新 id。

## ⚖️ 代价与边界

| 是 | 不是 |
|---|---|
| 一次性救援工具 | 日常插件 |
| 保证上下文完整（0 删除）| 省钱工具（只会让 surface 变大）|
| 三层校验兜底 | 记忆系统（压缩后 AI 读到的仍是摘要）|

真正该长期活下来的东西在**记忆库**（记忆卡 / `memory_recall` / 日记）。会话只是"最近这段"的容器。

**跨会话搬运时确实会丢的**：

| 丢的 | 原因 | 防法 |
|---|---|---|
| 空回复的唤醒记录 | 去重被判重复 | `fullCopy` 空回复不参与去重 |
| 未闭合的 turn | 跨会话拼接 | 切点落 `turn/end`（自动补）|
| 未结算的工具调用 | `callId` 对不上 | 丢弃孤儿 call/result |
| 结构事件（`agent/inbox/spliced` 等）| 跨会话校验失败 | 一律跳过 |
| 严格时间顺序 | 并行会话本就交错 | 保留真实时间戳 |

## 🧪 实测记录

用一个 **49,513 事件 / 1,310 turn / 22.52 MB** 的真实大会话跑过全量功能：

| 功能 | 结果 |
|---|---|
| `inspect` | 22.52 MB（含水下）/ 可见 2.56 MB |
| `planCompact`（800 KB 预算）| 切出 **3 段**（0.81 / 0.77 / 0.81 MB）|
| `forkClone` | 49,514 条 seed，落盘后 `verify` 通过 |
| `fullCopy` | 47,233 条，跳过 spliced 2,041 / end-seed 88 |
| `mixCopy` | 47,069 条 / 22 MB |
| `copySequential` | 49,496 条 / 44 条压缩记录，`verify` 通过 |
| `fromJsonl` | seq 自动偏移 49,496，写入后仍可打开 |
| `makeRoot` | 49,513 条 / 校验 0 问题 / 修 delivery 18 |

这轮实测修掉 7 个 bug，细节见 [CHANGELOG](CHANGELOG.md)。

## 📚 文档

| 文档 | 内容 |
|---|---|
| [INSTALL.md](INSTALL.md) | 安装、注册、重启、验证 |
| [FEATURES.md](FEATURES.md) | 9 个模式逐个说明 |
| [CONFIG.md](CONFIG.md) | 全部参数与默认值 |
| [API.md](API.md) | 接口契约 |
| [CHANGELOG.md](CHANGELOG.md) | 0.1.0 → 0.5.0 |
| [session-merge-runbook.md](session-merge-runbook.md) | 排障手册：12 个坑 + 验收清单 |
| [README.en.md](README.en.md) | English |

## 🧩 兼容性

| 项 | 值 |
|---|---|
| 平台 | DSH 桌面端（Electron），实测 **0.2.1-rc.5** |
| 会话格式 | v4（`session.v4.jsonl.zstd`）|
| 操作系统 | Windows 实测；路径全走 `node:path`，Linux/macOS 理论可用 |

## 📄 License

[MIT](./LICENSE) © 2026 HCQM
