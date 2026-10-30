# 🔀 dsh-session-merge — merge and append DSH sessions

[![npm version](https://img.shields.io/npm/v/dsh-session-merge?label=npm&color=blue)](https://www.npmjs.com/package/dsh-session-merge)
[![npm downloads](https://img.shields.io/npm/dm/dsh-session-merge?label=monthly%20downloads&color=brightgreen)](https://www.npmjs.com/package/dsh-session-merge)
[![license](https://img.shields.io/badge/license-MIT-orange)](./LICENSE)
[![stars](https://img.shields.io/github/stars/HCQM/dsh-session-merge?style=flat)](https://github.com/HCQM/dsh-session-merge/stargazers)
[![issues](https://img.shields.io/github/issues/HCQM/dsh-session-merge)](https://github.com/HCQM/dsh-session-merge/issues)
[![platform](https://img.shields.io/badge/platform-DSH%20Desktop-8A2BE2)](https://github.com/HCQM/dsh-session-merge)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-purple)](https://github.com/HCQM/dsh-session-merge)

**English** · [简体中文](README.md)

> **Merging DSH sessions by concatenating files doesn't work — format, compaction nodes and seq references are all pitfalls.**
>
> This plugin writes through DSH's own persistence API: nothing deleted, everything it writes is something DSH accepts.

- 🎯 **Born from one real slip** — not a general tool. It exists because I accidentally started a new session while setting up a QQ agent and wanted the two merged back; I couldn't find an existing way to do it.
- 🔒 **Integrity first** — merge/append delete nothing. `/compact` only summarizes previous content; **the raw text is always still in the session**.
- 📐 **Cut points, not guesses** — `planCompact` computes turn boundaries where each segment fits the budget, clear of existing compaction ranges.
- 🛡️ **Three validation layers** — pre-write check / six-layer deep check / official `open`, error text matching the DSH UI verbatim.
- 🧱 **Resumable writes** — 1.4–1.5 MB per batch; compact once, write a batch.

<p align="center"><strong>⭐ If you've ever wanted to stitch several sessions into one, a star helps.</strong><br/>
<sub>One-liner: <code>dsh plugin --profile desktop add dsh-session-merge</code></sub></p>

## ⚡ Quick start

```bash
dsh plugin --profile desktop add dsh-session-merge
# restart DSH → the plugin appears in the list
```

Then try the three **read-only** actions — nothing is written:

```js
session_merge_build({ inspect: true, targetId: "<session-id>" })      // structure
session_merge_build({ verify: true, targetId: "<session-id>" })       // can DSH open it?
session_merge_build({ planCompact: true, targetId: "<session-id>" })  // cut points and sizes
```

## 🧩 What it solves

History scatters across sessions: a QQ agent window opened by mistake, two parallel tracks, a fork that never came back. To answer "what did we decide that day" you hop between them; and merging them by concatenating the files — **DSH simply can't open the result**:

| Pitfall of concatenating | Why |
|---|---|
| Compaction pointers break | `shadowedRange` / `shadowedSeqs` hold old seqs; after moving they point nowhere |
| Non-dense seq | DSH requires seq to start at 0 and increase densely; concatenation breaks that |
| surface folding points wrong | Sessions may contain `surfaceOp:{op:'replace'}`; its `startSeq`/`endSeq` reference old seqs |
| Tool calls mismatch | `callId` / `toolCallId` don't line up across sessions, leaving orphans |
| The timeline already forked | Parallel sessions interleave by nature; blindly merging makes it jump around |

The plugin does exactly two things: **merge** (`fullCopy` / `mixCopy`) and **append** (`fromJsonl`).

The result is **a normal session**: old history first, new dialogue after it, compaction nodes carried along, `/compact` still works. The cost is a bigger surface — what you get is one complete, continuous, searchable container.

The hard part was never moving the events — it's **making DSH accept what you moved**. That's why the three-layer validator exists.

## 🛡️ Three validation layers (core)

| Layer | Who | Checks | When |
|---|---|---|---|
| Light pre-check | `validate-full.mjs` | surface folding, lifecycle, compaction pairing, header fields, seq continuity, `sourceEventSeqs` | Auto, before every write |
| Six-layer deep | `deep-validate.mjs` | frames / header / path / event density and type table / inheritance / embedded-stream replay | After writes, when debugging |
| Official | `verify` | DSH's `persistence.open` | When you need "exactly what DSH says" |

Standalone:

```bash
node bin/validate.mjs <session-id-prefix|dir|file> [--json] [--no-replay] [--strict-replay]
node bin/validate.mjs --all     # validate every session
```

## 📏 Hard limits (measured)

| Item | Value | Source |
|---|---|---|
| Single request cap | 1,048,576 tokens | Model hard limit |
| Bytes per token | **3.8** | Derived: 22.52 MB ≈ 6.2M tokens |
| Safe line | **surface ≤ 3.4 MB** | ≈900K tokens; above this `/compact` can't be sent |

> Whether a compaction succeeds depends on the **currently visible surface**, not the percentage in the UI.

## 🧰 Capabilities

One tool, `session_merge_build`, 10 modes each callable standalone:

| Parameter | Kind | Purpose |
|---|---|---|
| `inspect` | read-only | events / turns / surface size / compaction nodes / time range |
| `verify` | read-only | official `open` check (standalone or with `inspect`) |
| `planCompact` | read-only | compute compactable cut points: `cuts[]` + per-segment size |
| `makeRoot` | write | turn a session into a legal root (repair broken chains) |
| `forkClone` | write | official `sessions.fork` clone, keeps compaction nodes |
| `fullCopy` | write | multi-source full-type copy, dedup by assistant reply |
| `mixCopy` | write | time-window mixing, stops at `byteBudget` |
| `fromJsonl` | write | write a JSONL range; auto turn boundary, auto seq offset |
| `copySequential` | write | single-source linear copy, remaps all seq references |
| `resumeOnly` | write | resume then release, to trigger a flush |

All writes accept `dryRun`. Details: [FEATURES.md](FEATURES.md) · [CONFIG.md](CONFIG.md) · [API.md](API.md)

## 🩺 Two secondary uses

**Repairing broken chains** — sessions merged in the past whose parent was later deleted fail with `parentSession` errors. `makeRoot` turns them into legal roots (four markers changed together). See [FEATURES.md](FEATURES.md#makeroot--把会话改造成合法根).

**Rescuing a session that can't compact** — not the main purpose: **DSH auto-compacts, so genuine deadlocks are rare**. If you do hit `requested N tokens > 1,048,576`, the fix is compacting in segments (no deleting, no folding): `planCompact` → `forkClone` at cuts → `/compact` each segment → `fullCopy` back → `verify`. Full steps in the [runbook](session-merge-runbook.md).

## ⚖️ Cost and boundaries

| It is | It isn't |
|---|---|
| A one-off merge/rescue tool | A daily driver |
| Context integrity (0 deletions) | A cost saver (surface only grows) |
| Backed by three validation layers | A memory system (after compaction the AI reads a summary) |

What must survive long-term belongs in a **memory system** (cards / `memory_recall` / a journal). A session is just the container for "the recent stretch".

**What is actually lost when moving across sessions**:

| Lost | Why | Mitigation |
|---|---|---|
| Wake-up records with empty replies | Dedup treats them as duplicates | Empty replies don't participate in `fullCopy` dedup |
| Unclosed turns | Source killed mid-turn / cut point lands inside a turn | Cut points auto-extend to `turn/end`; only whole turn blocks are moved |
| Unsettled tool calls | `callId` mismatch | Orphan calls/results dropped |
| Inbox events (`agent/inbox/spliced`) | `target:'next-turn'` + `start` index point at the source timeline | Always skipped (not on surface; skipping loses nothing) |
| Strict chronological order | Parallel sessions interleave | Real timestamps kept |

## 🧪 Measured on real data

Tested on a real session with **49,513 events / 1,310 turns / 22.52 MB**:

| Feature | Result |
|---|---|
| `inspect` | 22.52 MB total / 2.56 MB visible |
| `planCompact` (800 KB budget) | **3 segments** (0.81 / 0.77 / 0.81 MB) |
| `forkClone` | 49,514 seeds, `verify` passes |
| `fullCopy` | 47,233 events, skipping spliced 2,041 / end-seed 88 |
| `mixCopy` | 47,069 events / 22 MB |
| `copySequential` | 49,496 events / 44 compaction records, `verify` passes |
| `fromJsonl` | seq offset by 49,496, still openable |
| `makeRoot` | 49,513 events / 0 problems / repaired 18 delivery markers |

A cross-check over 80 local sessions as a broader sample: 10 contained `surfaceOp:{op:'replace'}` (279 events total), 1 had an unclosed turn at the tail (process killed).

Seven bugs were found and fixed by this round — see [CHANGELOG](CHANGELOG.md).

## 📚 Docs

[INSTALL](INSTALL.md) · [FEATURES](FEATURES.md) · [CONFIG](CONFIG.md) · [API](API.md) · [CHANGELOG](CHANGELOG.md) · [Runbook](session-merge-runbook.md) · [简体中文](README.md)

## 🧩 Compatibility

| Item | Value |
|---|---|
| Platform | DSH Desktop (Electron), tested **0.2.1-rc.5** |
| Session format | v4 (`session.v4.jsonl.zstd`) |
| OS | Windows tested; all paths use `node:path` |

## 📄 License

[MIT](./LICENSE) © 2026 HCQM
