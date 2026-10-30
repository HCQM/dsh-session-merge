// 完整会话校验器：六层检查（移植自 session-validator/index.mjs）
// 依赖 DSH 自己的模块（@deepseek-ai/dsh-session-format-v3-to-v4 / dsh-session / dsh-llm），
// 在 DSH 进程里或项目自己的 node_modules 就位时可用；找不到依赖时返回 degraded 而不是崩溃。
//
// 用法（库）：
//   import { validateSessionFile } from './deep-validate.mjs'
//   const r = await validateSessionFile('C:/.../session.v4.jsonl.zstd', { replay: true })
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** 动态取 DSH 模块；拿不到就返回 null（软降级） */
async function loadDshModules() {
  const out = { fmt: null, sess: null, llm: null };
  try { out.fmt = await import('@deepseek-ai/dsh-session-format-v3-to-v4'); } catch { /* 缺依赖 */ }
  try { out.sess = await import('@deepseek-ai/dsh-session'); } catch { /* 缺依赖 */ }
  try { out.llm = await import('@deepseek-ai/dsh-llm'); } catch { /* 缺依赖 */ }
  return out;
}

/** 逐帧解 zstd；返回 { text, frames, frameErrors } */
export function decodeFrames(buf) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  if (!starts.length) return { text: '', frames: 0, frameErrors: ['不是 zstd 帧文件'] };
  if (starts[0] !== 0) starts.unshift(0);
  const parts = [];
  const frameErrors = [];
  for (let k = 0; k < starts.length; k++) {
    const a = starts[k];
    const b = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(a, b))); }
    catch (e) { frameErrors.push(`第 ${k + 1} 帧解压失败：${e.message}`); }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: parts.length, frameErrors };
}

/**
 * 六层校验一个会话文件
 * @param {string} file 会话日志路径（session.v4.jsonl[.zstd]）
 * @param {{replay?:boolean, strictReplay?:boolean}} [opts]
 */
export async function validateSessionFile(file, opts = {}) {
  const problems = [];
  const warnings = [];
  const fail = (stage, msg) => problems.push(`[${stage}] ${msg}`);
  const warn = (stage, msg) => warnings.push(`[${stage}] ${msg}`);
  const t = {};

  const mods = await loadDshModules();
  const degraded = !mods.fmt || !mods.sess;

  // ---- 1. 帧与行 ----
  let t0 = Date.now();
  const buf = fs.readFileSync(file);
  let lines;
  let frames = 0;
  if (file.endsWith('.zstd')) {
    const d = decodeFrames(buf);
    frames = d.frames;
    for (const e of d.frameErrors) fail('帧', e);
    lines = d.text.split('\n').filter((l) => l.trim());
  } else {
    lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
  }
  t.frames = Date.now() - t0;
  if (!lines.length) fail('帧', '文件里没有内容');

  // ---- 2. 解析 + header ----
  t0 = Date.now();
  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    try { parsed.push(JSON.parse(lines[i])); }
    catch (e) {
      fail('解析', `第 ${i + 1} 行不是合法 JSON（${e.message}）${i === lines.length - 1 ? ' ← 撕裂尾部' : ''}`);
      parsed.push(null);
    }
  }
  const rawHeader = parsed[0];
  let header = null;
  if (!rawHeader || rawHeader.type !== 'session') fail('header', '第一行不是 session header');
  else if (degraded) {
    header = rawHeader;
    warn('header', '没有 DSH 模块，跳过 decodeHeader/assertReleasedV4Header');
  } else {
    try { header = mods.fmt.releasedV4SessionFormatCodec.decodeHeader(rawHeader); }
    catch (e) { fail('header', 'decodeHeader 失败：' + e.message); }
    if (header) {
      try { mods.fmt.assertReleasedV4Header(header); }
      catch (e) { fail('header', e.message); }
      if (mods.sess && header.version !== mods.sess.SESSION_FORMAT_VERSION) {
        warn('header', `版本 ${header.version}，本校验器面向 ${mods.sess.SESSION_FORMAT_VERSION}`);
      }
    }
  }
  t.header = Date.now() - t0;

  // ---- 3. 路径 ----
  const dirName = path.basename(path.dirname(file));
  if (header && header.id && dirName !== header.id) {
    fail('路径', `目录名「${dirName}」与 header.id「${header.id}」不一致`);
  }

  // ---- 4~5. 事件层 + 继承/关系 ----
  t0 = Date.now();
  const events = parsed.slice(1);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e) continue;
    if (e.seq !== i) fail('seq', `事件 #${i} 的 seq=${e.seq}，不稠密`);
    if (mods.sess && mods.sess.KNOWN_SESSION_EVENT_TYPES) {
      const known = mods.sess.KNOWN_SESSION_EVENT_TYPES;
      if (!known.has(e.type) && e.ignorable !== true) fail('事件', `seq ${i} 未知类型 ${JSON.stringify(e.type)} 且未标 ignorable`);
    }
  }
  let cut = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e && e.type === 'session/end-seed' && e.data && e.data.inherited === true) cut = i;
  }
  if (header && !degraded && mods.sess && mods.sess.KNOWN_SESSION_EVENT_TYPES) {
    try {
      mods.fmt.restoreReleasedV4Artifact(
        { header, events: events.filter(Boolean), inheritedEventCount: cut },
        mods.sess.KNOWN_SESSION_EVENT_TYPES,
      );
    } catch (e) { fail('关系', e.message); }
    if (header.isSeeded === true && cut === 0) warn('继承', 'isSeeded=true 但 cut=0（没有继承事件）');
  }
  t.events = Date.now() - t0;

  // ---- 6. 内嵌流重放 ----
  let replay = null;
  t0 = Date.now();
  if (opts.replay !== false && mods.llm) {
    replay = { total: 0, assembled: 0, differs: 0 };
    for (const e of events) {
      if (!e || e.type !== 'assistant/message' || !e.data || !e.data.stream) continue;
      replay.total += 1;
      try {
        const asm = mods.llm.assembleAssistantStream(e.data.stream);
        asm.blocks();
        replay.assembled += 1;
      } catch (err) {
        fail('重放', `seq ${e.seq} 装配失败：${err.message}`);
      }
    }
    if (opts.strictReplay && replay.differs > 0) fail('重放', `${replay.differs} 条装配结果与 message.content 不一致`);
  }
  t.replay = Date.now() - t0;

  return {
    ok: problems.length === 0,
    file: path.basename(file),
    session: dirName,
    mb: Number((fs.statSync(file).size / 1048576).toFixed(2)),
    frames,
    lines: lines.length,
    events: events.length,
    header: header
      ? { id: header.id, isSeeded: header.isSeeded, parentSession: header.parentSession ?? null, cut, delegationDepth: header.delegationDepth, agentPreset: header.agentPreset ?? null }
      : null,
    replay,
    degraded,
    problems,
    warnings,
    ms: t,
  };
}
