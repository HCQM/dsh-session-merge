# 会话合并/追加 操作手册（2026-10-29 定稿）

> 给以后的我看。这一轮踩的坑全在这里，按这个顺序做不会再返工。

## 一、先搞清 DSH 的硬约束（实测数据）

| 项 | 数值 | 说明 |
|---|---|---|
| 单次请求上限 | 1,048,576 tokens | 超了直接报 `maximum context length` |
| completion 预留 | 64K ~ 256K | 会浮动的，按 64K 算安全 |
| 字节/token | 约 **3.8** | 中文 UTF-8，实测 5.21MB ≈ 1.37M tokens |
| **安全线** | **surface ≤ 3.4 MB** | 约 900K tokens，压缩请求能发出去 |

**关键**：`/compact` 是把压缩后的 surface **原文重新发一遍**给模型生成摘要。所以能不能压，看的是 surface 体积，不是界面上那个百分比（那是压缩后视图）。

## 二、标准流程（四步）

### 1. fork 骨架（保留源自己的压缩节点）

```
session_merge_build {
  forkClone: true,
  sources: ["<源会话>"],
  targetId: "session-merged-X",
  forkBoundary: <可选，截到某个 turn/end 的 seq>
}
```

- fork 让 DSH 自己处理压缩节点、surface、seq，比手搬干净 4 倍
- 源会话被占用会报 `already owned`，要么等，要么改用 fullCopy

### 2. 离线生成增量（一次生成，不反复重生成）

`_build-append.mjs <targetId> <srcId> <outJsonl>`：
- 按 assistant 回复文本去重（空回复不参与，避免误杀定时唤醒块）
- 保留真实时间戳（不做单调压平）
- 清 reasoning 空转、丢空思考块
- 输出 JSONL，seq 从目标 max+1 开始

### 3. 一次算好切点，固定区间逐批写

按 surface 1.4~1.5MB 一批切，切点必须落在 `turn/end` 上。

```
session_merge_build {
  fromJsonl: "<你的工作目录>/_mix.jsonl",
  jsonlFrom: <起点>, jsonlUntil: <终点>,
  targetId: "session-merged-X",
  sources: ["session-merged-X"]
}
```

- **不要每批重新生成 JSONL**（这是之前 48 个重复 turn 的根因）
- 插件会自动：切点补到 turn/end、seq 偏移（压缩后插事件也能接上）

### 4. 每批之后要压

写第 1 批 → 主人点 `/compact` → 写第 2 批 → 再压 …… 
每批都压在 3.4MB 以内，压完 surface 归零，空间就回来了。

## 三、踩过的坑（别再踩）

| 坑 | 现象 | 原因 | 修法 |
|---|---|---|---|
| 重复 turn | 同一段出现 2~10 次 | 每批重新生成"剩余"，无 assistant 的块认不出 | 一次生成 + 固定切点 |
| 时间倒退 5 天 | 10-29 后接 10-24 | 混合段边界用 0，把旧内容又搬进来 | `timeFrom` 设成目标末尾时间 |
| 时间全变 21:22 | 时间戳堆在一起 | 强制时间单调 | 保留真实时间，允许倒退（并行会话本来交错）|
| 压缩报超限 | `requested 1370066 tokens` | surface > 3.4MB | 切批按 1.4MB 算 |
| 压缩返回空摘要 | `produced no text summary content` | 偶发 | 再点一次就好 |
| `compaction/start does not match the open turn` | 打不开 | start/summary/end 必须同 turn | 三个一起搬，或都不搬 |
| `has no matching compaction/start` | 打不开 | 只搬了 summary | 同上 |
| `unseeded Session contains an inherited end-seed` | 打不开 | 搬了 `session/end-seed` | 跳过该类型 |
| `format v4 message requires a producer-owned source kind` | 打不开 | 自己造的消息缺 `source` | 补 `source:{kind:'user',rpcId,clientTimeZone}` + `role` + `id` |
| `developer/message surfaceOp requires an object` | 打不开 | 给 developer 塞了 `'append'` 字符串 | 混合时不搬 developer/message |
| `sourceEventSeqs must contain unique earlier seqs` | 打不开 | 引用没去重/指到自己 | 严格 seqMap、去重、过滤 >= 自身 |
| 写不进去 | `already owned by an active write handle` | GUI 里开着那个会话 | 让主人切走 |

## 四、验收清单（每批都做）

1. `node _surface.mjs <id>` —— surface ≤ 3.4MB、token 占比合理
2. `node _readable.mjs <id>` + 读文件 —— **实际通读**，别只看统计
3. `node _jumps.mjs <id>` —— 时间倒退是不是真实交错
4. `node _coverage2.mjs` 改一下源 —— 覆盖率（缺的要能解释成"压缩检查点/系统注入"）
5. 看末尾 10 个 turn 有没有重复残骸

## 五、登记

`workspace.json` 的 `sessionIds` 加进去，DSH 重启后列表可见。
标题用 `session/title` 事件（`messageSeqs: []` + `source.kind: 'user'`）。

## 六、热载与改文件的坑（2026-10-29 夜）

- **插件没有可靠热载**：改 `index.js`、改 `cordis.patch.yml` 都不触发 `apply`；日志里那些 `apply` 全是重启时发生的。改插件只能重启验证。
- **绝对不要用 PowerShell 读写这个插件文件**：`Get-Content -Raw` 用 GBK 解码 UTF-8，整份中文会坏，写回去不可逆。`Set-Content`、`-replace` 批量改同理危险。
  - 正确做法：`edit`/`write` 工具（UTF-8 安全），或 node 脚本 `fs.readFileSync(f,'utf8')`。
  - 写坏了：从自己的备份目录找回上一版，没有就按本文档重写。
- 损坏特征：`node --check` 报 `Invalid regular expression` / `Invalid or unexpected token`；`read` 工具报 `invalid UTF-8 text`。看到就别再用 PowerShell 修。

