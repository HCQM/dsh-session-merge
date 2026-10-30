# 🔀 dsh-session-merge — merge, append, and rescue DSH sessions

[![version](https://img.shields.io/badge/version-0.5.0-blue)](./CHANGELOG.md)
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
- 📐 **Cut points, not guesses** — `planCompact` computes turn boundaries where each segment fits the budget, clear of existing compaction ranges.
- 🛡️ **Three validation layers** — pre-write check / six-layer deep check / official `open` check, error text matching the DSH UI verbatim.
- 🧱 **Resumable writes** — 1.4–1.5 MB per batch; compact once, write a batch.

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

// Can DSH open it? (standalone, or together with inspect)
session_merge_build({ verify: true, targetId: "<session-id>" })

// Are there cut points, how many segments, how big
session_merge_build({ planCompact: true, targetId: "<session-id>" })
```

## 🩺 What it actually rescues

A concrete deadlock (one we actually hit):

```
requested 1,370,066 tokens > 1,048,576 (maximum context length)
```

The session can neither continue nor compact. Why not? **Because `/compact` sends the currently visible surface to the model in one request** — above the per-request limit it can't be sent.

| Fact about `/compact` | Meaning |
|---|---|
| It **deletes nothing** | The original conversation is all still in the log |
| It only **appends** a summary | Summary + `shadowedRange` |
| Afterwards the AI sees "summary + raw text after the cut" | Covered text isn't read verbatim, but **still in the session** |

So the fix is **compacting in segments** — not deleting, not folding:

```
inspect → planCompact → fork at cuts → /compact each segment → fullCopy back → verify
```

## 🛡️ Three validation layers (the core)

Anyone can move events. **Making DSH accept what you moved** is the hard part. Three independent layers, each callable on its own:

| Layer | Who | Checks | When |
|---|---|---|---|
| Light pre-check | `validate-full.mjs` | surface folding, turn/step/tool lifecycle, compaction pairing, header fields, seq continuity, `sourceEventSeqs` | Auto, before every write |
| Six-layer deep | `deep-validate.mjs` | frames / header / path / event density and type table / inheritance / embedded-stream replay | After writes, when debugging |
| Official | `verify` mode | DSH's `persistence.open` | When you need "exactly what DSH says" |

Standalone:

```bash
node bin/validate.mjs <session-id-prefix|dir|file> [--json] [--no-replay] [--strict-replay]
node bin/validate.mjs --all     # validate every session
```

## 📏 Hard limits (measured)

| Item | Value | Source |
|---|---|---|
| Single request cap | 1,048,576 tokens | Model hard limit |
| Completion reserve | 64K (occasionally 256K) | Measured compaction requests |
| Bytes per token | **3.8** | Derived: 22.52 MB ≈ 6.2M tokens |
| Safe line | **surface ≤ 3.4 MB** | ≈900K tokens; above this `/compact` always fails |

> Key: whether a compaction succeeds depends on the **currently visible surface**, not the percentage in the UI.

## 🧰 Capabilities

One tool, `session_merge_build`, **9 modes each callable standalone**; plus `session_unlock` and a standalone CLI.

| Parameter | Kind | Purpose |
|---|---|---|
| `inspect` | read-only | events / turns / surface size / compaction nodes / time range / type histogram |
| `verify` | read-only | official `open` check, error text passed through (standalone or with `inspect`) |
| `planCompact` | read-only | compute compactable cut points: `cuts[]` + per-segment size, clear of existing compaction ranges |
| `makeRoot` | write | turn a session into a legal root: `isSeeded=false`, drop `parentSession`, clear inherited markers, repoint `delivery` |
| `forkClone` | write | official `sessions.fork` clone, keeps compaction nodes |
| `fullCopy` | write | multi-source full-type copy, dedup by assistant reply, `keepCompaction` retains source records |
| `mixCopy` | write | time-window mixing, stops at `byteBudget` and returns `nextFrom` |
| `fromJsonl` | write | write a JSONL range; auto turn boundary, auto seq offset, returns `progress` |
| `copySequential` | write | single-source linear copy, remaps all seq references (including `data.sourceEventSeq`) |
| `resumeOnly` | write | resume then release, to trigger a flush |

All writes accept `dryRun: true`. Details: [FEATURES.md](FEATURES.md) · [CONFIG.md](CONFIG.md) · [API.md](API.md)

## 🚑 Rescue flow

```js
// 1. See the current state
session_merge_build({ inspect: true, targetId: "<stuck session>" })

// 2. Compute cut points (read-only, touches no events)
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

## 🔗 Another use: repairing broken chains

Sessions merged in the past whose parent was later deleted often fail with `parentSession` errors. `makeRoot` turns them into legal roots:

```js
session_merge_build({
  makeRoot: true,
  sourceId: "<broken session>",
  targetId: "<new session id>",
})
// → { events, clearedInherited, deliveryFixed }
```

Four things must change together: `isSeeded=false`, drop `parentSession` (never `null`), `end-seed.inherited` → `false`, and `delivery.sessionId` repointed.

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

## 🧪 Measured on real data

Tested on a real session with **49,513 events / 1,310 turns / 22.52 MB**:

| Feature | Result |
|---|---|
| `inspect` | 22.52 MB total / 2.56 MB visible |
| `planCompact` (800 KB budget) | **3 segments** (0.81 / 0.77 / 0.81 MB) |
| `forkClone` | 49,514 seeds, `verify` passes after flush |
| `fullCopy` | 47,233 events, skipping spliced 2,041 / end-seed 88 |
| `mixCopy` | 47,069 events / 22 MB |
| `copySequential` | 49,496 events / 44 compaction records, `verify` passes |
| `fromJsonl` | seq auto-offset by 49,496, still openable afterwards |
| `makeRoot` | 49,513 events / 0 validation problems / repaired 18 delivery markers |

Seven bugs were found and fixed by this round — see [CHANGELOG](CHANGELOG.md).

## 📚 Docs

| Doc | Contents |
|---|---|
| [INSTALL.md](INSTALL.md) | Install, register, restart, verify |
| [FEATURES.md](FEATURES.md) | All 9 modes |
| [CONFIG.md](CONFIG.md) | All parameters and defaults |
| [API.md](API.md) | Tool contract |
| [CHANGELOG.md](CHANGELOG.md) | 0.1.0 → 0.5.0 |
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
