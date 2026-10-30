# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
版本号形如 `主版本.次版本.修订号`；本插件为 0.x，接口仍可能变动。

---

## [0.5.0] — 2026-10-31

用一个 **49,513 事件 / 1,310 turn / 22.52 MB** 的真实大会话跑了全量功能测试，修掉 7 个实测出来的 bug。

### 修复（全部来自实测）
- **`data.sourceEventSeq` 未重映射**（影响 `copySequential` / `fullCopy` / `mixCopy` / `makeRoot`）：`command` 等事件用的是**单数** `sourceEventSeq`，之前只处理了事件级的复数 `sourceEventSeqs`，导致写出的会话直接 `SessionFormatError: command sourceEventSeq must name an earlier event`、打不开。
- **`planCompact` 切点永远为 0**：原来用 `turnEnds.has(surfaceSeq)` 判断，但 `surface` 里只有消息事件、根本没有 `turn/end`，条件永远为假。改成判断"当前事件是否是它所在 turn 的最后一个可见 surface 事件"。
- **`planCompact` 被 `sources 为空` 拦截**：豁免名单里漏了它。
- **`inspect` 只传 `targetId` 时崩溃**：`firstSourceCwd(undefined)` → `path.join` 报 `The "path" argument must be of type string`。三个函数都加了判空。
- **独立 `verify` 模式丢失**：删 deprecated 的 merge 模式时被连带删掉，只剩 `inspect + verify` 组合。已补回。
- **`session_unlock` 报 `targetId is not defined`**：它是独立工具的 execute，作用域里没有外层 `targetId`，改用 `args.targetId`。
- **`makeRoot` 两处结构错误**：
  - header 是**顶层字段**（不在 `data` 里），原来当 `data` 读，导致 `createdAt` 丢失 → `session metadata createdAt must be a non-negative safe integer`；
  - `persistence.create()` **不能带 `type`**（DSH 内部补），带了会 `format v4 header has unexpected field type`。
- **校验器误报**：`compaction/start 在 turn 外` 原来是硬失败，但实测原会话自身就有 3 个在 turn 外——DSH 允许，改成只在 turn 打开时校验一致性。

### 移除
- **`foldTarget`（折叠）**：它用 `replace` 把原文从 surface 换掉，和"保证上下文完整"的目标相反。救援流程改为 `planCompact` 算切点 → `forkClone` 分段 → 手动 `/compact` → `fullCopy` 拼回。

### 验证
11 个功能全部实测通过：`inspect` / `verify` / `inspect+verify` / `planCompact` / `makeRoot` / `forkClone` / `fullCopy` / `mixCopy` / `fromJsonl` / `copySequential` / `session_unlock`。

---

## [0.4.0] — 2026-10-31

### 新增
- **`inspect` 支持顺带 `verify`**：一次调用同时返回会话结构和"DSH 能否打开"，不用再跑两次。
- **写入后进度反馈**：`fromJsonl` 返回 `progress.writtenRows / totalRows / remainingRows / nextRange` 和 `shouldCompact`（surface ≥ 2.4 MB 时为 true），并给出下一步提示。
- **`foldTarget` / `resumeOnly` 支持 `dryRun`**：只算不写，先看会折叠多少条 / 目标是否存在。
- **`bin/validate.mjs --all`**：一次扫描整个会话根目录下所有会话并汇总通过/不通过。
- **`session_unlock` 句柄表探测**：除方法名外，还探测 `handles / writers / locks` 等 Map/Set/对象，报告目标是否被占着。

### 移除
- **删除 `merge` 模式**（早期按 turn 块合并的默认分支）。它不保留压缩记录、surface 会膨胀，功能已被 `fullCopy` 完全覆盖。未指定模式时现在返回明确的错误提示。

### 变更
- `index.js` 从 1,412 行降到 1,254 行（删掉 deprecated 分支并提供统一兜底）。

---

## [0.3.0] — 2026-10-31

### 新增
- **`verify` 模式**：直接调用 DSH 自己的 `persistence.open` 试读，能打开 = DSH 认，报错文案与界面一字不差。
- **`deep-validate.mjs`**：六层深度校验器（移植自独立版 `session-validator`）—— 帧 / header / 路径 / 事件稠密与类型表 / 继承关系 / 内嵌流重放。缺 DSH 模块时自动降级并标注，不会崩溃。
- **`bin/validate.mjs`**：独立 CLI，支持 `--json`、`--no-replay`、`--strict-replay`。
- **`validateHeader()`**：header 字段校验（对齐 DSH 的 `assertReleasedV4Header`），`parentSession` 不允许写 `null`。
- **seq 连续性检查**：写入前校验 seq 严格 +1 递增。
- **双语 README**（`README.md` 中文 / `README.en.md` 英文）。
- **支持版本标注**：实测 DSH 桌面端 **0.2.1-rc.5**，peer 依赖 `>=0.2.1-rc.5 <0.3.0-0`。

---

## [0.2.0] — 2026-10-29

### 新增
- **`fullCopy`**：多源全类型复制，保留压缩节点（`keepCompaction`）、`seqUntil` 截断、切点自动补 turn 边界。
- **`mixCopy`**：按时间窗混合多源，turn 块按时间排序，`byteBudget` 到量即停并返回 `nextFrom`。
- **`foldTarget`**：把目标会话早期 surface 折叠成一条 replace（`foldSkip` 避开已有压缩节点）。
- **`fromJsonl`**：按区间写本地 JSONL，自动补 turn 边界、自动 seq 偏移，支持 `dryRun`。
- **`inspect`**：只读查看会话结构。
- **`session_unlock`**：诊断目标会话的写句柄。
- **`fail(stage, error)`**：写入失败的统一返回格式。
- **JSONL 日志**（`debug.jsonl`）：避免 PowerShell 读中文乱码。

### 修复
- 空回复不参与去重（否则「定时唤醒 + 无回复」的块会被误判重复）。
- `foldTarget` 生成的消息补全 `source / role / id`（缺 `source.kind` 会被 DSH 判 corrupt）。
- 混合时不再搬运 `developer/message`（它的 `surfaceOp` 只认对象）。
- `seq` 自动偏移：压缩在末尾插事件后，下一批仍能续写。

---

## [0.1.0] — 2026-10-28

### 新增
- 初始版本：`forkClone`（官方 `sessions.fork` 克隆）、`copySequential`（单源直线复制）、`resumeOnly`（只 resume 触发落盘）、按 turn 块合并的默认模式。
- 只读探测与基础落盘链路。

---

## 版本速查

| 版本 | 关键变化 |
|---|---|
| 0.4.0 | 删 merge、inspect+verify、进度反馈、dryRun 全覆盖、`--all`、句柄探测 |
| 0.3.0 | 六层深度校验、`verify` 官方校验、双语 README、支持版本标注 |
| 0.2.0 | `fullCopy`/`mixCopy`/`foldTarget`/`fromJsonl`/`inspect`、去重与 seq 修复 |
| 0.1.0 | fork 克隆、直线复制、resumeOnly、turn 块合并 |
