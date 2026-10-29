# dsh-session-merge

把多个 DeepSeek Harness（DSH）会话合成一个，或者往会话尾部追加另一段历史。

Merge or append DeepSeek Harness sessions — through DSH's own writer, never by editing session files on disk.

所有写入都走 DSH 自己的 `sessionPersistence`，不直接改磁盘上的 `session.v4.jsonl.zstd` —— 外部生成的文件格式 DSH 一律不认（实测四种写法全部失败）。

## 为什么需要它

DSH 一个会话堆到几十万 token 后，每句话都在为整段历史付费。换新会话能把这笔开销清掉，但新会话接不上旧内容——**旧历史还在磁盘上，一个字没少，只是不在它的视野里**。这个插件做的事就是把这个视野接回去。

**什么时候真的需要**：

- **QQ 桥换了会话**，新会话不知道前情，接不上一小时前聊的事；
- **桌面端和 QQ 两端并行聊过**，两条线各记一半，想并成一条看；
- **同一天开了好几个会话**，散在几处，想按时间合成一条完整时间线。

它提供两条路：

- **合并**：把旧会话的完整历史并进一个新会话，压缩节点跟着走；
- **追加**：往现有会话尾部补一段历史（比如两个窗口并行聊过的内容）。

## 和其他做法比

| 维度 | 手动 `/compact` | 复制粘贴文本 | 外部脚本拼 JSONL | 本插件 |
| --- | --- | --- | --- | --- |
| 历史保留 | 压成摘要，原话只剩归档 | 要人肉复制，工具调用和推理全丢 | 文件能拼出来 | 完整搬，一条不少 |
| 压缩节点 | 重新生成，措辞会变 | 没有 | 会破坏 surface 段 | 原样搬，`shadowedSeqs` 重映射 |
| 时间线 | 保持 | 要手工排 | 容易全变成"现在" | 保持原始 `time` |
| DSH 认不认 | 认 | 认 | **不认**（四种写法实测全败） | 认，因为走它自己的写入器 |
| 压缩后体积 | 变小 | 不变 | — | fork 前缀不膨胀，追加段可逐段压 |

最上面那行的差别最关键：**会话文件只能由 DSH 自己的写入器产生**。外部生成的哪怕格式完全正确、还按代命名（`session.v5`）也一律不加载。这插件的全部价值就在于绕开这个限制——不是伪造文件，而是驱动 DSH 自己写。


## 安装

插件目录：`<DSH_HOME>/plugins/dsh-session-merge/`，然后在 profile 的 `dsh.profile.bundles` 里登记（bundle 型插件必须登记，否则不加载）：

```yaml
# profiles/desktop/cordis.patch.yml 或 profile 配置
bundles:
  - dsh-session-merge
```

改完重启 DSH（**插件没有可靠热载**，改 `index.js` 不会触发重载）。

## 工具：`session_merge_build`

一个工具，靠参数切模式：

| 参数 | 模式 | 用途 |
|---|---|---|
| `inspect: true` | 只读 | 查会话结构：事件数、turn、surface 体积、压缩节点、时间范围、类型分布 |
| `forkClone: true` | fork | 用官方 `sessions.fork` 克隆源会话（保留压缩节点、surface、seq）；配 `forkBoundary: <seq>` 切到指定事件 |
| `fullCopy: true` | 复制 | 多源全类型复制，按 assistant 回复去重；`keepCompaction` 保留源压缩记录 |
| `mixCopy: true` | 混合 | 按时间窗混合多源，turn 块按时间排序；`byteBudget` 到量就停并返回 `nextFrom` |
| `foldTarget: true` | 折叠 | 把目标会话早期 surface 折叠成一条 replace（只追加，不删原文）|
| `fromJsonl: "路径"` | 写入 | 按 `jsonlFrom`/`jsonlUntil` 区间写本地 JSONL；自动补 turn 边界、自动 seq 偏移 |
| `copySequential: true` | 直线 | 单源按事件顺序复制，保留压缩事件并重映射全部 seq 引用 |
| `resumeOnly: true` | 落盘 | 只 resume 目标会话再释放，触发落盘（fork 出来的会话必须走一步，否则 dispose 即消失）|
| （默认） | 合并 | 按 turn 块合并多源（**deprecated**，不保留压缩记录，surface 会膨胀，建议用 `fullCopy`）|

**补充参数**：

| 参数 | 作用 |
|---|---|
| `includeShadowed: true` | 连被压缩遮蔽的原文一起取（默认只取 surface 可见部分）|
| `seqFrom` / `seqUntil` | 按原始 seq 精确切段，边界自动贴到完整 turn（`turn/start` / `turn/end`）|
| `fromTime` / `untilTime` | 按时间窗过滤 turn 块 |
| `stripNoise: true` | 删 reasoning 里的空转行（`好。` `做。` 这类无宾语短词）|
| `dropEmptyReasoning: true` | 删内容为空的 reasoning 块 |
| `dryRun: true` | 只算不写，报告这批的事件数 / turn / surface |

另有 `session_unlock`：诊断目标会话的写句柄，必要时尝试释放（目标在 GUI 里开着时会占用）。

## 硬约束（实测）

| 项 | 数值 |
|---|---|
| 单次请求上限 | 1,048,576 tokens |
| completion 预留 | 64K（偶发 256K）|
| surface 字节/token | 约 **3.8** |
| **安全线** | **surface ≤ 3.4 MB**（约 900K tokens）|

`/compact` 会把压缩后的 surface **原文**重新发给模型生成摘要。所以能不能压，看的是 surface 体积，不是界面上那个百分比。

## 典型流程

实测跑通的那条路（2026-10-29，把 10-23 到 10-29 的两条会话并成一条）：

```js
// 1. fork 出前半段，边界切在混合点之前（必须是完整 turn 的 turn/end）
session_merge_build({
  forkClone: true, forkBoundary: 27508,
  sources: ["session-<前半段>"], targetId: "session-merged-x",
})
// → 27510 事件 / 646 turn，5 个原压缩节点原样保留

// 2. 分段追加后半段，每段 60~80 个 turn
session_merge_build({
  sources: ["session-<后半段>"],
  targetId: "session-merged-x",
  fromStart: true, skip: 0, limit: 80,
  stripNoise: true, dropEmptyReasoning: true,
})

// 3. 追加完在 GUI 里点 /compact（surface 到 70% 左右就该压一次）
// 4. 接着追加下一段：skip 累加，limit 不变
```

**四个必须知道的点**：

- **fork 出来的会话必须落盘**。`sessions.fork` 只创建内存会话，`resume.dispose()` 时会跟着消失。要在插件里主动 `persistence.create(header, { inheritedEventCount })` 再 append seed。
- **不要每批重新生成 JSONL**，那是重复 turn 的经典来源：切点一次算好、固定区间逐批写。
- **`seqFrom` / `seqUntil` 会自动贴到完整 turn**。切在 `turn/start` 之前会让整个 turn 缺头被丢弃，内容整体错位一条。
- **追加前先释放写句柄**。目标会话在 GUI 里开着时 `append` 会报 `already owned by an active write handle`，切到别的会话再追加。

## 实际效果

同一份数据（两条并行会话，10-23 到 10-29）：

| 项 | 数值 |
|---|---|
| 合并后 | 35515 事件 / 971 turn / 11.74 MB |
| 压缩节点 | 5 个原样保留（`shadowedSeqs` 和各 30 万+ token 的统计都对得上） |
| 打开后 surface | 259K / 1M（25%）|
| 清掉的空转 | 760 个 reasoning 块 |
| 后台结构校验 | 行级 0 失败、关系校验通过（用 DSH 源码的 `assertV4RowAdmission` + `assertV4LifecycleRelationships`）|

## 校验器

`validate-full.mjs` 把 DSH 真实会拦的规则提前到本地预检：

- `sourceEventSeqs` 必须唯一且都指向更早事件
- `user/assistant/system/developer` 消息必须带 `source.kind`
- `assistant/message` 必须有 `message.content` 和 `stream`
- `tool/result` 必须有 `message.source.callId`
- `session/end-seed { inherited: true }` 直接判死
- `compaction/start` 必须落在打开着的 turn 内、turn 值匹配
- `compaction/summary` 必须对上 start 的 `compactionId` + 同 turn
- surface 类型只有 `user/message`、`assistant/message`、`tool/result`

## 已知坑

写合并逻辑时踩过的，都在 [`session-merge-runbook.md`](./session-merge-runbook.md)：时间倒退、重复 turn、压缩超限、`already owned by an active write handle`、8 种打不开的报错。

## License

MIT
