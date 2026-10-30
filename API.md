# 接口契约

## `session_merge_build`

一个工具，`args` 按模式取不同字段。返回值统一带 `ok` 字段。

### 模式判定顺序

```
inspect → verify → planCompact → makeRoot → fullCopy → mixCopy → fromJsonl → forkClone → copySequential → resumeOnly → （无匹配，报错）
```

### 返回值

**成功**（各模式字段见下）：

```json
{ "ok": true, "mode": "<模式名>", ... }
```

**失败**：

```json
{ "ok": false, "stage": "<阶段>", "error": "<信息>" }
```

`stage` 取值：`header` / `precheck` / `write` / `open`。

### 各模式成功返回

| 模式 | 关键字段 |
|---|---|
| `inspect` | `id / events / turns / userMessages / assistantMessages / toolCalls / toolResults / compactionSummaries / surfaceEvents / surfaceMB / approxTokens / timeRange / types`，带 `verify:true` 时追加 `verify: {ok, note|error}` |
| `verify` | `id / events / header / note` |
| `fullCopy` | `events / turns / stats[] / skipped{}` |
| `mixCopy` | `events / turns / nextFrom` |
| `planCompact` | `totalMB / totalTokens / budgetMB / surfaceEvents / cuts[] / tailMB / tailTokens / note` |
| `fromJsonl` | `events / turns / surfaceMB / from / until / progress{writtenRows,totalRows,remainingRows,nextRange,shouldCompact} / hint` |
| `forkClone` | `id` |
| `copySequential` | `events / turns / compactions` |
| `resumeOnly` | `targetId` |
| `makeRoot` | `from / to / events / clearedInherited / deliveryFixed / note` |
| 任意 + `dryRun` | 上述规模字段，无写入 |

### 错误示例

```json
// 预检没过
{ "ok": false, "stage": "precheck", "problems": ["seq 不连续（10 → 12）"], "total": 1 }

// header 不合法
{ "ok": false, "stage": "header", "problems": ["header 缺必需字段 delegationDepth"] }

// 会话被占用
{ "ok": false, "stage": "write", "error": "session \"x\" is already owned by an active write handle" }

// 官方打不开
{ "ok": false, "mode": "verify", "stage": "open", "errorName": "SessionFormatError", "error": "stored log is corrupt: …" }
```

---

## `session_unlock`

| 参数 | 类型 | 说明 |
|---|---|---|
| `targetId` | string | 目标会话 id |
| `action` | string | `release` 时尝试释放 |

返回：`members[]`（persistence 成员方法名）、`table_*`（句柄表探测）、`statPreview`、`ok_*`/`err_*`（释放尝试结果）。

---

## `bin/validate.mjs`

```bash
node bin/validate.mjs <会话id前缀|目录|文件> [--json] [--no-replay] [--strict-replay]
node bin/validate.mjs --all [--json] [--no-replay]
```

退出码：`0` 通过 / `1` 不通过 / `2` 参数错误。

`--json` 输出结构：

```json
{
  "ok": true,
  "file": "session.v4.jsonl.zstd",
  "session": "<会话id>",
  "mb": 1.43,
  "frames": 114,
  "lines": 5332,
  "events": 5331,
  "header": { "id": "...", "isSeeded": false, "parentSession": null, "cut": 0, "delegationDepth": 0, "agentPreset": "standard" },
  "replay": { "total": 0, "assembled": 0, "differs": 0 },
  "degraded": false,
  "problems": [],
  "warnings": [],
  "ms": { "frames": 47, "header": 66, "events": 0, "replay": 0 }
}
```

`--all` 时输出 `{ total, failed, results[] }`。

`degraded: true` 表示没解析到 DSH 模块，只查了帧/路径/seq。

---

## 环境变量（仅 CLI）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_SESSIONS` | `~/.dsh/sessions` | 会话根目录 |
