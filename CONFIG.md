# 配置

插件参数全部通过工具调用的 `args` 传入，没有配置文件。

## 公共参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `sources` | string[] | 源会话 id 列表（`inspect` / `fromJsonl` 可省略）|
| `targetId` | string | 目标会话 id |
| `dryRun` | boolean | 只算不写 |
| `inspect` | boolean | 只读查结构 |
| `verify` | boolean | 官方校验（可单独用，也可配合 `inspect`）|
| `cwd` | string | 新建会话时写入 header 的 cwd；省略则继承源会话，再退到 `process.cwd()` |

## forkClone

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `forkClone` | boolean | — | 开关 |
| `forkBoundary` | number | 末尾 | fork 到哪个源事件 seq（含）|

## fullCopy

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `fullCopy` | boolean | — | 开关 |
| `keepCompaction` | boolean | false | 保留源的 `compaction/summary|prune` 并重映射区间 |
| `seqUntil` | number | — | 只取源事件 seq ≤ 该值（含）|

## mixCopy

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mixCopy` | boolean | — | 开关 |
| `timeFrom` | number | -∞ | 起始时间戳（毫秒，含）|
| `timeUntil` | number | +∞ | 结束时间戳（毫秒，不含）|
| `byteBudget` | number | 0（不限）| 单批 surface 字节预算，到量停并返回 `nextFrom` |

## planCompact

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `planCompact` | boolean | — | 开关（只读）|
| `compactBudgetBytes` | number | 3000000 | 每段 surface 字节预算（≈790K tokens）|

> 旧版本有过 `foldTarget`（折叠早期 surface），已移除——它用 replace 把原文从当前视图换掉，和"保证上下文完整"的目标相反。

## makeRoot

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `makeRoot` | boolean | — | 开关 |
| `sourceId` | string | — | 源会话 id（也可用 `sources[0]`）|
| `targetId` | string | — | 新建的根会话 id |
| `cwd` | string | 继承源 header | 新 header 的 cwd |

## fromJsonl

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `fromJsonl` | string | — | JSONL 文件路径 |
| `jsonlFrom` | number | 0 | 起始行号（0 基，含）|
| `jsonlUntil` | number | 文件末尾 | 结束行号（不含）|

## copySequential / resumeOnly / inspect / verify

这三个模式只有开关参数，无额外配置。

## 硬约束（不可配置）

| 项 | 值 | 说明 |
|---|---|---|
| 单次请求上限 | 1,048,576 tokens | 模型侧 |
| completion 预留 | 64K（偶发 256K）| 压缩请求要留 |
| surface 字节/token | ~3.8 | 实测换算 |
| 安全线 | surface ≤ 3.4 MB | 超过则 `/compact` 会报超限 |
| 建议单批 | 1.4~1.5 MB | 留余量给压缩 |
| 该压缩的线 | 2.4 MB | 插件在 `shouldCompact` 里用这个值 |

## 会话 header

新建会话时插件构造的 header：

```js
{
  id: targetId,
  version: 4,
  createdAt: Date.now(),
  cwd: args.cwd || firstSourceCwd(sources[0]) || process.cwd(),
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
}
```

写入前会用 `validateHeader()` 检查：必需字段齐全、无未知字段、`parentSession` 不能写 `null`。

> `type: 'session'` 由 DSH 落盘时补，`create()` 的参数里通常不需要带。
