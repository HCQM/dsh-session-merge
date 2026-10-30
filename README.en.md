# 🔀 dsh-session-merge — rescue a stuck session

[![version](https://img.shields.io/badge/version-0.4.0-blue)](./CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-orange)](./LICENSE)
[![stars](https://img.shields.io/github/stars/HCQM/dsh-session-merge?style=flat)](https://github.com/HCQM/dsh-session-merge/stargazers)
[![issues](https://img.shields.io/github/issues/HCQM/dsh-session-merge)](https://github.com/HCQM/dsh-session-merge/issues)
[![platform](https://img.shields.io/badge/platform-DSH%20Desktop-8A2BE2)](https://github.com/HCQM/dsh-session-merge)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-purple)](https://github.com/HCQM/dsh-session-merge)

**English** · [简体中文](README.md)

> **When a session blows up — can't continue, can't compact — pull it back.**
>
> Not one event deleted. Three validation layers. Everything written is something DSH accepts.

- 🎯 **Built for rescue** — not a daily driver; idle most of the time, shows up when a session is stuck.
- 🔒 **Context integrity first** — merge/append delete nothing; `/compact` only appends a summary; raw text stays in the log forever.
- 📐 **Cut points, not guesses** — `planCompact` computes `turn/end` boundaries where each segment fits the budget, clear of existing compaction ranges.
- 🛡️ **Three validation layers** — pre-write check / six-layer deep check / official `open` check, error text matching the DSH UI verbatim.
- 🧱 **Resumable writes** — 1.4–1.5 MB per batch; compact once, write a batch, repeat.

<p align="center"><strong>⭐ If you've ever hit "context blew up and I can't get it back", a star helps.</strong><br/>
<sub>One-liner: <code>dsh plugin --profile desktop add dsh-session-merge</code></sub></p>

## ⚡ Quick start

```bash
dsh plugin --profile desktop add dsh-session-merge
# restart DSH → the plugin appears in the list
```

Then try the three **read-only** actions — nothing is written:

```js
// Structure
session_merge_build({ inspect: true, targetId: "<session-id>" })

// Can DSH open it?
session_merge_build({ verify: true, targetId: "<session-id>" })

// Are there cut points, how many segments, how big
session_merge_build({ planCompact: true, targetId: "<session-id>" })
```

## 🩺 What it actually rescues

A concrete deadlock (one we actually hit):

```
requested 1,370,066 tokens > 1,048,576 (maximum context length)
```

The session can neither continue nor compact. Why can't it compact? **Because `/compact` sends the entire surface verbatim to the model in one request** — above the per-request limit, it can't be sent.

| Fact about `/compact` | Meaning |
|---|---|
| It **deletes nothing** | The original conversation is all still in the log |
| It only **appends** a summary | Summary + `shadowedRange` |
| Afterwards the AI sees "summary + raw text after the cut" | Covered text isn't read verbatim, but **still in the session** |

So the fix is **compacting in segments** — not deleting, not folding:

```
inspect → planCompact → fork at cuts → /compact each segment → fullCopy back → verify
```

Full commands in [Rescue flow](#-rescue-flow).

## 🛡️ Three validation layers (the core)

Anyone can move events. **Making DSH accept what you moved** is the hard part. Hence three independent layers:

| Layer | Who | Checks | When |
|---|---|---|---|
| Light pre-check | `validate-full.mjs` | surface folding, turn/step/tool lifecycle, compaction pairing, header fields, seq continuity | Auto, before every write |
| Six-layer deep | `deep-validate.mjs` | frames / header / path / event density and type table / inheritance / embedded-stream replay | After writes, when debugging |
| Official | `verify` mode | DSH's `persistence.open` | When you need "exactly what DSH says" |

Standalone:

```bash
node bin/validate.mjs <session-id-prefix|dir|file> [--json] [--no-replay] [--strict-replay]
node bin/validate.mjs --all     # validate every session
```

## 📏 Hard limits (measured, not estimated)

| Item | Value | Source |
|---|---|---|
| Single request cap | 1,048,576 tokens | Model hard limit |
| Completion reserve | 64K (occasionally 256K) | Measured compaction requests |
| Bytes per token | **3.8** | Derived: 5.21 MB ≈ 1.37M tokens |
| Safe line | **surface ≤ 3.4 MB** | ≈900K tokens; above this `/compact` always fails |

> Key: whether a compaction succeeds depends on **surface size**, not the percentage in the UI.

## 🧰 Capabilities

One tool, switched by parameters:

| Parameter | Kind | Purpose |
|---|---|---|
| `inspect` | read-only | events / turns / surface size / compaction nodes / time range / type histogram |
| `verify` | read-only | official `open` check, error text passed through |
| `planCompact` | read-only | compute compactable cut points (`cuts[]` + per-segment size) |
| `forkClone` | write | official `sessions.fork` clone, keeps compaction nodes |
| `fullCopy` | write | multi-source full-type copy, dedup by assistant reply |
| `mixCopy` | write | time-window mixing, stops at `byteBudget` |
| `fromJsonl` | write | write a JSONL range; auto turn boundary, auto seq offset |
| `copySequential` | write | single-source linear copy, seq remapped |
| `resumeOnly` | write | resume then release, to trigger a flush |
| `makeRoot` | write | turn a session into a legal root: `isSeeded=false`, drop `parentSession`, clear inherited markers, repoint `delivery` |

All writes accept `dryRun: true`; `session_unlock` diagnoses the write handle.

Details: [FEATURES.md](FEATURES.md) · [CONFIG.md](CONFIG.md) · [API.md](API.md)

## 🚑 Rescue flow

```js
// 1. See the current state
session_merge_build({ inspect: true, targetId: "<stuck session>" })

// 2. Let the plugin compute cut points (read-only, touches no events)
session_merge_build({ planCompact: true, targetId: "<stuck session>" })
// → cuts[], each with cutAfterSeq / prefixMB / prefixTokens

// 3. Fork at each cut (every segment is a small session that can compact)
session_merge_build({ forkClone: true, sources: ["<stuck session>"], targetId: "<seg1>", forkBoundary: <cuts[0].cutAfterSeq> })
session_merge_build({ forkClone: true, sources: ["<stuck session>"], targetId: "<seg2>", forkBoundary: <cuts[1].cutAfterSeq> })

// 4. Run /compact on each segment in the GUI

// 5. Stitch them into a new session
session_merge_build({ fullCopy: true, sources: ["<seg1>", "<seg2>"], targetId: "<new>", keepCompaction: true })

// 6. Confirm DSH can open it
session_merge_build({ verify: true, targetId: "<new>" })
```

Result: the AI reads "a few summaries + the raw text of the last segment" — DSH's normal compacted shape, not data loss. Every original event remains in the branches.

> ⚠️ Don't rescue by folding. `foldTarget` (removed in 0.4.0) used `replace` to swap the original out of the surface — the opposite of context integrity.

## ⚖️ Cost and boundaries

| It is | It isn't |
|---|---|
| A one-off rescue tool | A daily driver |
| Context integrity (0 deletions) | A cost saver (surface only grows) |
| Backed by three validation layers | A memory system (after compaction the AI reads a summary) |

What must survive long-term belongs in a **memory system** (cards / `memory_recall` / a journal). A session is just the container for "the recent stretch".

**What is actually lost when moving across sessions**:

| Lost | Why | Mitigation |
|---|---|---|
| Wake-up records with empty replies | Dedup treats them as duplicates | Empty replies don't participate in `fullCopy` dedup |
| Unclosed turns | Cross-session stitching | Cut points land on `turn/end` (auto-extended) |
| Unsettled tool calls | `callId` mismatch | Orphan calls/results dropped |
| Structural events (`agent/inbox/spliced` etc.) | Fail cross-session validation | Always skipped |
| Strict chronological order | Parallel sessions interleave | Real timestamps kept |

## 📚 Docs

| Doc | Contents |
|---|---|
| [INSTALL.md](INSTALL.md) | Install, register, restart, verify |
| [FEATURES.md](FEATURES.md) | All 9 operations |
| [CONFIG.md](CONFIG.md) | All parameters and defaults |
| [API.md](API.md) | Tool contract |
| [CHANGELOG.md](CHANGELOG.md) | 0.1.0 → 0.4.0 |
| [session-merge-runbook.md](session-merge-runbook.md) | Runbook: 12 pitfalls + checklist |
| [README.md](README.md) | 简体中文 |

## 🧩 Compatibility

| Item | Value |
|---|---|
| Platform | DSH Desktop (Electron), tested **0.2.1-rc.5** |
| Session format | v4 (`session.v4.jsonl.zstd`) |
| OS | Windows tested; all paths use `node:path`, Linux/macOS should work |

## 📄 License

[MIT](./LICENSE) © 2026 HCQM
