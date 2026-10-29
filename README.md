# dsh-session-merge

把多个 DeepSeek Harness（DSH）会话合成一个，或者往会话尾部追加另一段历史。

所有写入都走 DSH 自己的 `sessionPersistence`，不直接改磁盘上的 `session.v4.jsonl.zstd` —— 外部生成的文件格式 DSH 一律不认（实测四种写法全部失败）。

## 为什么需要它

DSH 一个会话堆到几十万 token 后，每句话都在为整段历史付费；想换新会话又会丢掉原话。这个插件提供两条路：

- **合并**：把旧会话的完整历史并进一个新会话，压缩节点跟着走；
- **追加**：往现有会话尾部补一段历史（比如两个窗口并行聊过的内容）。

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
| `forkClone: true` | fork | 用官方 `sessions.fork` 克隆源会话（保留压缩节点、surface、seq）|
| `fullCopy: true` | 复制 | 多源全类型复制，按 assistant 回复去重；`keepCompaction` 保留源压缩记录 |
| `mixCopy: true` | 混合 | 按时间窗混合多源，turn 块按时间排序；`byteBudget` 到量就停并返回 `nextFrom` |
| `foldTarget: true` | 折叠 | 把目标会话早期 surface 折叠成一条 replace（只追加，不删原文）|
| `fromJsonl: "路径"` | 写入 | 按 `jsonlFrom`/`jsonlUntil` 区间写本地 JSONL；自动补 turn 边界、自动 seq 偏移 |
| `copySequential: true` | 直线 | 单源按事件顺序复制，保留压缩事件并重映射全部 seq 引用 |
| `resumeOnly: true` | 落盘 | 只 resume 目标会话再释放，触发落盘 |
| （默认） | 合并 | 按 turn 块合并多源（**deprecated**，不保留压缩记录，surface 会膨胀，建议用 `fullCopy`）|

所有模式都支持 `dryRun: true`：只报告规模，不写盘。

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

```js
// 1. fork 骨架（保留源自己的压缩节点）
session_merge_build({ forkClone: true, sources: ["<源会话>"], targetId: "session-merged-x" })

// 2. 离线生成增量 JSONL（自己写脚本，或直接用 fullCopy）
// 3. 按区间写入，每批 1.4~1.5MB
session_merge_build({
  fromJsonl: "E:/work/_mix.jsonl", jsonlFrom: 0, jsonlUntil: 2467,
  targetId: "session-merged-x",
})

// 4. 每批写完在 GUI 里点一次 /compact，把 surface 压回预算内
// 5. 重复 3~4，直到写完
```

**不要每批重新生成 JSONL** —— 这是重复 turn 的经典来源：切点要一次算好、固定区间逐批写。

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
