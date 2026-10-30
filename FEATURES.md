# 功能

一个工具 `session_merge_build`，靠参数切模式；另有 `session_unlock` 和独立 CLI。

## 只读类

### `inspect` —— 查结构

```js
session_merge_build({ inspect: true, targetId: "<会话id>" })
```

返回：事件数、turn、user/assistant 消息数、tool 调用与结果数、surface 事件数与体积（MB）、估算 tokens、压缩节点数、时间范围、类型分布。

- 只传 `targetId` 即可，不需要 `sources`；
- 加上 `verify: true` 会顺带做一次官方试开（一次调用拿两份结论）。

### `verify` —— 官方校验

```js
session_merge_build({ verify: true, targetId: "<会话id>" })
```

直接调 DSH 自己的 `persistence.open(id, 'read')`：

- 能打开 → `ok: true`，DSH 认这个会话；
- 打不开 → `ok: false`，`errorName` + `error` 是 DSH 抛出的原文，和界面上那句一字不差。

## 写入类

### `forkClone` —— 官方 fork

```js
session_merge_build({ forkClone: true, sources: ["<源会话>"], targetId: "<新id>", forkBoundary?: <seq> })
```

用 `sessions.fork` 克隆源会话，压缩节点、surface、seq 全部由 DSH 处理，最干净。

- `forkBoundary`：fork 到哪个源事件 seq（含），省略则到末尾；
- 源会话被 GUI 打开时会报 `already owned`，要么等，要么改用 `fullCopy`。

### `fullCopy` —— 多源全类型复制

```js
session_merge_build({
  fullCopy: true, sources: ["<源A>", "<源B>"], targetId: "<新id>",
  keepCompaction: true,   // 保留源压缩记录
  seqUntil: 27508,        // 只取到某个 seq（含）
})
```

- 按 assistant 回复文本去重（空回复不参与，避免误杀定时唤醒块）；
- 保留压缩节点时，`shadowedRange` / `shadowedSeqs` 会重新映射；
- 切点落在 turn 中间会**自动补到 turn/end**；
- 不支持 `developer/message`（它的 `surfaceOp` 只认对象）。

### `mixCopy` —— 按时间窗混合

```js
session_merge_build({
  mixCopy: true, sources: ["<源A>", "<源B>"], targetId: "<新id>",
  timeFrom: 1793194341167, timeUntil: 1793300000000,
  byteBudget: 2400000,
})
```

- turn 块按时间排序写入，跨源去重；
- `byteBudget` 到量就在 turn 边界停，返回 `nextFrom` 作为下一批的 `timeFrom`；
- 时间戳保留真实值（并行会话本来就会交错，不做单调压平）。

### `makeRoot` —— 把会话改造成合法根

```js
session_merge_build({
  makeRoot: true, sourceId: "<断链的源会话>", targetId: "<新会话id>",
})
```

修复"父会话已不存在"导致的断链会话。四处必须同时一致（少一处 DSH 仍拒绝）：

| 改什么 | 怎么改 |
|---|---|
| header `isSeeded` | `true` → `false` |
| header `parentSession` | **删除**（不能写 `null`，null 非法）|
| `session/end-seed` 的 `inherited` | `true` → `false` |
| `delivery` 里的 `sessionId` | 旧 id → 新 id |

产出是一个**新会话**（不改源）。用完跑一次 `verify` 确认能打开。

### `planCompact` —— 计算可压缩切点（只读）

```js
session_merge_build({
  planCompact: true, targetId: "<卡住的会话>",
  compactBudgetBytes: 3000000,   // 每段 surface 预算，默认 ≈790K tokens
})
```

按 `turn/end` 边界把 surface 切成若干段，每段体积都不超过预算（也就是每段都能被 `/compact` 发出去）。

- **只读**：不写任何事件，原始上下文一条不动；
- 自动避开已有压缩记录（`shadowedRange`）覆盖的区间；
- 返回 `cuts[]`：每个切点的 `cutAfterSeq`（交给 `forkClone` 的 `forkBoundary`）、`prefixMB`、`prefixTokens`；
- `tailMB` / `tailTokens`：切完之后最后一段的体积；
- `note`：下一步该干什么。

典型用法：`planCompact` 拿切点 → 按 `cutAfterSeq` 逐个 `forkClone` → 每段手动 `/compact` → `fullCopy` 拼回。

### `fromJsonl` —— 按区间写本地 JSONL

```js
session_merge_build({
  fromJsonl: "<工作目录>/_mix.jsonl", jsonlFrom: 0, jsonlUntil: 2467,
  targetId: "<会话id>", dryRun: false,
})
```

- 自动补 turn 边界（切点落在 turn 中间会往后补到 `turn/end`）；
- 自动 seq 偏移（压缩在末尾插事件后也能续写）；
- 返回 `progress`：已写行、总行、剩余行、`nextRange`（下一批参数）、`shouldCompact`。

### `copySequential` —— 单源直线复制

```js
session_merge_build({ copySequential: true, sources: ["<源>"], targetId: "<新id>" })
```

按事件顺序直线复制，保留压缩事件并重映射全部 seq 引用。

### `resumeOnly` —— 只 resume 触发落盘

```js
session_merge_build({ resumeOnly: true, targetId: "<会话id>" })
```

只 resume 再释放，用于触发落盘，不改内容。

## 配套工具

### `session_unlock` —— 诊断写句柄

```js
session_unlock({ targetId: "<会话id>", action: "release" })
```

- 列出 `sessionPersistence` 的成员方法；
- 探测 `handles / writers / locks` 等句柄表，报告目标是否被占着；
- `action: "release"` 时尝试调用可能存在的释放方法。

### `bin/validate.mjs` —— 独立深度校验

```bash
node bin/validate.mjs <会话id前缀|目录|文件> [--json] [--no-replay] [--strict-replay]
node bin/validate.mjs --all
```

六层：帧 / header / 路径 / 事件稠密与类型表 / 继承关系 / 内嵌流重放。

## dryRun

所有写入模式都支持 `dryRun: true`：

| 模式 | dryRun 返回 |
|---|---|
| `fromJsonl` | 事件数、turn、surface、目标是否存在 |
| `fullCopy` | 生成事件数、turn 数、各源统计 |
| `mixCopy` | 生成事件数、turn 数、`nextFrom` |
| `resumeOnly` | 目标是否存在 |
