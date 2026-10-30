# dsh-session-merge

> English · [简体中文](./README.md)

Merge several DeepSeek Harness (DSH) sessions into one, or append a stretch of history to the tail of an existing session.

Every write goes through DSH's own `sessionPersistence` — the plugin never edits `session.v4.jsonl.zstd` on disk. Files generated outside DSH are rejected by DSH (four different formats were tried and all failed).

## Supported DSH version

| Item | Value |
|---|---|
| **Tested against** | **DSH Desktop 0.2.1-rc.5** (`@deepseek-ai/dsh-desktop`) |
| Peer dependency | `@deepseek-ai/dsh` >= 0.2.1-rc.5 < 0.3.0-0 |
| Session format | v4 (`session.v4.jsonl.zstd`) |

The session format and the persistence API are what this plugin depends on. A newer DSH release may still work, but re-run `verify` after upgrading.

## Why

Once a DSH session grows past a few hundred thousand tokens, every message pays for the whole history. Starting a new session would lose the original words. This plugin offers two paths:

- **Merge**: fold a full old session into a new one, keeping its compaction nodes;
- **Append**: tack a stretch of history onto the tail of an existing session (e.g. two windows that ran in parallel).

## Install

Copy to `<DSH_HOME>/plugins/dsh-session-merge/`, then register it in the profile's `dsh.profile.bundles` (bundle-type plugins are not loaded unless registered):

```yaml
# profiles/desktop/cordis.patch.yml or profile config
bundles:
  - dsh-session-merge
```

Restart DSH afterwards. **There is no reliable hot reload** — editing `index.js` does not trigger a reload.

## Tool: `session_merge_build`

One tool, switched by parameters:

| Parameter | Mode | What it does |
|---|---|---|
| `inspect: true` | read-only | Session structure: events, turns, surface size, compaction nodes, time range, type histogram |
| `verify: true` | read-only | **Official check**: calls DSH's own `persistence.open`; opens = DSH accepts it, and error text matches the UI verbatim |
| `forkClone: true` | fork | Official `sessions.fork` clone (keeps compaction nodes, surface, seq) |
| `fullCopy: true` | copy | Multi-source full-type copy, deduplicated by assistant reply; `keepCompaction` keeps source compaction records |
| `mixCopy: true` | mix | Time-window mixing, turn blocks ordered by time; `byteBudget` stops at the limit and returns `nextFrom` |
| `foldTarget: true` | fold | Fold early surface of the target into one replace event (append-only, original stays in the log) |
| `fromJsonl: "path"` | write | Write a local JSONL range (`jsonlFrom`/`jsonlUntil`); auto-extends to turn boundary, auto-offsets seq |
| `copySequential: true` | linear | Single-source copy in event order, compaction events kept and all seq references remapped |
| `resumeOnly: true` | flush | Resume the target then release, to trigger a flush |
| (default) | merge | Merge by turn blocks (**deprecated** — doesn't keep compaction records, surface inflates; use `fullCopy`) |

All write modes accept `dryRun: true` — report only, nothing written.

Also `session_unlock`: diagnose the target's write handle and try to release it (a session open in the GUI holds one).

## Three layers of validation

| Layer | What it is | When |
|---|---|---|
| `validate-full.mjs` | Pre-write **light check**: surface folding, turn/step/tool lifecycle, request/header, compaction pairing, sourceEventSeqs, header fields, seq continuity | Runs before every write |
| `deep-validate.mjs` | **Six-layer deep check** (ported from the standalone validator): frames / header / path / event density and type table / inheritance / embedded-stream replay | After writes, when debugging |
| `verify` mode | **Official check**: calls DSH's `persistence.open`, error text passed through verbatim | When you need "exactly what DSH says" |

Run the deep check standalone:

```bash
node bin/validate.mjs <session-id-prefix|dir|file> [--json] [--no-replay] [--strict-replay]
```

> The deep check depends on DSH's own `@deepseek-ai/dsh-*` modules. Inside the DSH process they resolve; when run standalone, if they can't be resolved it **degrades** (skips header decode, relationship assertions and replay; still checks frames/path/seq).

## Hard limits (measured)

| Item | Value |
|---|---|
| Single request cap | 1,048,576 tokens |
| Completion reserve | 64K (occasionally 256K) |
| Bytes per token | ~**3.8** |
| **Safe line** | **surface ≤ 3.4 MB** (~900K tokens) |

`/compact` sends the compacted surface **verbatim** to the model to produce the summary. So whether a compaction can succeed depends on the surface size, not on the percentage shown in the UI.

## Typical flow

```js
// 1. Fork the skeleton (keeps the source's own compaction nodes)
session_merge_build({ forkClone: true, sources: ["<source>"], targetId: "session-merged-x" })

// 2. Generate the incremental JSONL offline (your own script, or use fullCopy)
// 3. Write by range, 1.4–1.5 MB per batch
session_merge_build({
  fromJsonl: "<your work dir>/_mix.jsonl", jsonlFrom: 0, jsonlUntil: 2467,
  targetId: "session-merged-x",
})

// 4. After each batch, hit /compact in the GUI to pull surface back under budget
// 5. Repeat 3–4 until done
// 6. Finish with verify, to confirm DSH can open it
```

**Never regenerate the JSONL per batch** — that is the classic source of duplicate turns. Compute the cut points once and write fixed ranges.

## Rules enforced locally

`validate-full.mjs` pulls the rules DSH actually enforces into the local pre-check:

- `sourceEventSeqs` must be unique and point to earlier events
- `user/assistant/system/developer` messages must carry `source.kind`
- `assistant/message` must have `message.content` and `stream`
- `tool/result` must have `message.source.callId`
- `session/end-seed { inherited: true }` is rejected outright
- `compaction/start` must land inside an open turn and match its turn number
- `compaction/summary` must match the start's `compactionId` and turn
- header fields must be complete, no unknown fields, `parentSession` must not be `null`
- `seq` must increase strictly by 1

## Known pitfalls

Everything learned while writing the merge logic lives in [`session-merge-runbook.md`](./session-merge-runbook.md): time going backwards, duplicate turns, compaction overflow, `already owned by an active write handle`, and eight different "won't open" errors.

## License

MIT
