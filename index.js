// 会话合并插件 v10
//
// 两种模式：
//   copySequential  单源按事件顺序直线复制，保留压缩事件并重映射全部 seq 引用（已验证 0 问题）
//   默认            多源按 turn 块合并（用于追加会话2）
//
// 关键规则（读源码 + 实测定下来的）：
//   1. 落盘走 ctx.sessionPersistence（create/open → append → flush）
//   2. SURFACE_TYPES = system/user/developer/assistant/tool-result（少了 developer 会算错 surface）
//   3. replace 的 startSeq/endSeq/sourceEventSeqs 必须重映射
//   4. compaction 的 shadowedRange/shadowedSeqs 必须重映射
//   5. developer/message 的 headerSeq 必须重映射
//   6. job 的 owner 要换成本会话，session-log-deepseek/* 直接跳过
//   7. tool/result 若 surfaceOp 不是 append（replace 修正），跳过配对检查

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateEventsFull, validateHeader } from './validate-full.mjs';

export const name = 'dsh-session-merge';
export const inject = ['tools'];

// 日志写在插件自己目录里，不往用户工作区丢文件
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(PLUGIN_DIR, 'debug.log');
const LOG_JSON = path.join(PLUGIN_DIR, 'debug.jsonl');
// 会话目录跟随当前用户，不写死路径
const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');

function log(line) {
  const t = new Date().toISOString();
  try { fs.appendFileSync(LOG, `[${t}] ${line}\n`, 'utf8'); } catch { /* 忽略 */ }
  // 结构化日志：PowerShell 读普通 log 时中文会乱码，JSONL 用 UTF-8 自己读
  try { fs.appendFileSync(LOG_JSON, JSON.stringify({ t, msg: String(line) }) + '\n', 'utf8'); } catch { /* 忽略 */ }
}

/** 统一的失败返回：stage 标明卡在哪一步，方便定位 */
function fail(stage, error, extra = {}) {
  return { ok: false, stage, error: String(error), ...extra };
}

function decompressAllFrames(buf) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  if (!starts.length) return null;
  if (starts[0] !== 0) starts.unshift(0);
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const a = starts[k];
    const b = k + 1 < starts.length ? starts[k + 1] : buf.length;
    if (b <= a) continue;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(a, b))); } catch { /* 坏帧跳过 */ }
  }
  return parts.length ? Buffer.concat(parts) : null;
}

/** 读一个会话的 header（只为拿 cwd，不解析事件）。 */
function readSessionHeader(sessionId) {
  let dirs = [];
  try { dirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  for (const d of dirs) {
    const full = path.join(SESSIONS_ROOT, d.name, sessionId);
    if (!fs.existsSync(full)) continue;
    let files = [];
    try { files = fs.readdirSync(full).filter((f) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(f)); } catch { continue; }
    if (!files.length) continue;
    files.sort((a, b) => (Number((b.match(/v(\d+)/) || [])[1] || 0)) - (Number((a.match(/v(\d+)/) || [])[1] || 0)));
    const file = path.join(full, files[0]);
    try {
      const buf = fs.readFileSync(file);
      const out = file.endsWith('.zstd') ? decompressAllFrames(buf) : buf;
      if (!out) return null;
      const firstLine = out.toString('utf8').split('\n').find((l) => l.trim());
      if (!firstLine) return null;
      const h = JSON.parse(firstLine);
      return typeof h === 'object' && h ? h : null;
    } catch { return null; }
  }
  return null;
}

/** 合并时默认跟着源会话的工作区，避免落到 DSH 的启动目录。 */
function firstSourceCwd(sourceId) {
  const h = readSessionHeader(sourceId);
  return h && typeof h.cwd === 'string' && h.cwd ? h.cwd : null;
}

function readSessionEvents(sessionId, includeShadowed = false) {
  let dirs = [];
  try { dirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }

  for (const d of dirs) {
    const full = path.join(SESSIONS_ROOT, d.name, sessionId);
    if (!fs.existsSync(full)) continue;
    const files = fs.readdirSync(full).filter((f) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(f));
    if (!files.length) continue;
    files.sort((a, b) => (Number((b.match(/v(\d+)/) || [])[1] || 0)) - (Number((a.match(/v(\d+)/) || [])[1] || 0)));
    const file = path.join(full, files[0]);
    try {
      const buf = fs.readFileSync(file);
      const out = file.endsWith('.zstd') ? decompressAllFrames(buf) : buf;
      if (!out) return null;
      const list = [];
      for (const line of out.toString('utf8').split('\n').filter(Boolean)) {
        try { list.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
      }

      const shadowed = new Set();
      for (const e of list) {
        if (e.type !== 'compaction/summary' && e.type !== 'compaction/prune') continue;
        const seqs = e.data && e.data.shadowedSeqs;
        if (Array.isArray(seqs)) for (const s of seqs) shadowed.add(s);
      }
      const SURFACE_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result']);
      const kept = (shadowed.size && !includeShadowed)
        ? list.filter((e) => e.seq === undefined || !SURFACE_TYPES.has(e.type) || !shadowed.has(e.seq))
        : list;
      log('[reader] ' + sessionId + ' -> ' + list.length + ' 事件，遮蔽 ' + shadowed.size + '，保留 ' + kept.length);
      return kept;
    } catch (err) {
      log('[reader] 读 ' + sessionId + ' 失败: ' + (err?.message ?? err));
      return null;
    }
  }
  return null;
}

function sliceTurns(events) {
  const blocks = [];
  let cur = null;
  for (const e of events) {
    if (!e || !e.type) continue;
    if (e.type === 'turn/start') cur = { startTime: e.time, events: [e] };
    else if (cur) {
      cur.events.push(e);
      if (e.type === 'turn/end') { blocks.push(cur); cur = null; }
    }
  }
  if (cur) log('[slice] 丢弃未闭合的 turn 块（' + cur.events.length + ' 条）');
  return blocks;
}

/** 动词/动作词（空转行几乎都由它们构成，没有宾语） */
const VERB = '做|写|停|输出|继续|完了|好了|行了|校验|验证|检查|确认|执行|跑|看|改|删|加|发|读|存|记|收|报|等|试|来|走|重试|再看|再试|再跑|写答案|写代码|写文件|开始|结束';

/**
 * 单行空转判定：括号动作、词干动词、时间戳、「好，X」这类起手废话
 * @param {string} line
 * @returns {boolean}
 */
function isNoiseLine(line) {
  const t = line.trim();
  if (!t || t.length > 40) return false;
  if (/^[(（][^）)]{1,4}[)）]$/.test(t)) return true;
  if (/^(时间|现在|当前)?\s*\d{1,2}\s*[:：]\s*\d{2}\s*[。，]?$/.test(t)) return true;
  const bare = t.replace(/[（()）[\]【】。，、！？…~：:；;,.!?"'“”‘’\s]/g, '');
  if (!bare) return false;
  if (bare.length <= 2 && !/[A-Za-z0-9]/.test(bare)) return true;
  const m = new RegExp('^(好|嗯|行|对|就|那|先|再|然后|继续)?' + '(' + VERB + ')$').exec(bare);
  if (m) return true;
  const parts = bare.split(/[，,]/).filter(Boolean);
  if (parts.length === 2) {
    const tail = new RegExp('^(我|就|再|又|也)?(' + VERB + ')$');
    const head = /^(好|嗯|行|对|那|先|现在|时间紧|时间|然后|继续|行吧|好吧|是|可以|总之|反正)$/;
    if (tail.test(parts[1]) && (head.test(parts[0]) || parts[0].length <= 6)) return true;
  }
  return false;
}

/** 短碎行：去标点后 <= 6 个汉字、不含数字英文 */
function isShortLine(line) {
  const t = line.trim().replace(/[（()）[\]【】。，、！？…~：:；;,.!?"'“”‘’\s]/g, '');
  return t.length > 0 && t.length <= 6 && !/[A-Za-z0-9]/.test(t);
}

/**
 * 删除 reasoning 里的空转：① 单行硬判定；② 连续 >=3 行短碎整段丢弃
 * @param text - reasoning 正文
 * @returns 清理后的正文
 */
function stripNoise(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const lines = text.split('\n');
  const flagged = lines.map((l) => isNoiseLine(l));
  let i = 0;
  while (i < lines.length) {
    if (isShortLine(lines[i])) {
      let j = i;
      while (j < lines.length && isShortLine(lines[j])) j++;
      if (j - i >= 3) for (let k = i; k < j; k++) flagged[k] = true;
      i = j;
    } else i += 1;
  }
  const out = [];
  for (let k = 0; k < lines.length; k++) if (!flagged[k]) out.push(lines[k]);
  return out.join('\n');
}

const KEEP = new Set([
  'turn/start', 'step/start', 'user/message', 'assistant/message',
  'tool/call', 'tool/result', 'step/end', 'turn/end',
  'workspace/changes', 'request/header',
]);

export function apply(ctx) {
  log('apply 开始（v10）');

  ctx.effect(() => ctx.tools.register({
    name: 'session_merge_build',
    description:
      'DSH 会话合并/追加工具。模式：inspect=查看结构（只读）；fullCopy=多源全类型复制（保留压缩节点）；' +
      'mixCopy=按时间窗混合；foldTarget=折叠早期 surface；fromJsonl=按区间写本地 JSONL（自动补 turn 边界、自动 seq 偏移）；' +
      'forkClone=官方 fork 克隆；copySequential=单源直线复制；resumeOnly=只 resume 触发落盘。' +
      '安全线：surface ≤ 3.4MB（约 900K tokens），超了 /compact 会报超限。',
    parameters: {
      type: 'object',
      properties: {
        sources: { type: 'array', items: { type: 'string' } },
        targetId: { type: 'string' },
        cwd: { type: 'string', description: '会话落在哪个工作区目录；省略则继承源会话的 cwd' },
        limit: { type: 'number' },
        skip: { type: 'number' },
        fromStart: { type: 'boolean' },
        fromTime: { type: 'number' },
        untilTime: { type: 'number' },
        includeShadowed: { type: 'boolean' },
        seqFrom: { type: 'number' },
        seqUntil: { type: 'number' },
        copySequential: { type: 'boolean' },
        forkClone: { type: 'boolean', description: 'true=用官方 sessions.fork 克隆源会话（保留全部结构）' },
        forkBoundary: { type: 'number', description: 'fork 到哪个源事件 seq（含）；省略则到当前最后一条' },
        resumeOnly: { type: 'boolean', description: 'true=只 resume 目标会话再释放（触发落盘）' },
        stripNoise: { type: 'boolean', description: 'true=删除 reasoning 里的空转行（单行词干 + 连续短碎段）' },
        dropEmptyReasoning: { type: 'boolean', description: 'true=删除内容为空的 reasoning 块（空转留存物）' },
        dryRun: { type: 'boolean', description: '只算不写：报告这批的事件数/turn/surface' },
        inspect: { type: 'boolean', description: '只读查看会话结构：事件数、turn、surface 体积、压缩节点、时间范围、类型分布' },
        verify: { type: 'boolean', description: '官方校验：调 DSH 自己的 persistence.open 试读，能打开=DSH 认，报错文案与界面一致' },
        fromJsonl: { type: 'string', description: '从本地 JSONL 按区间写入（自动补 turn 边界、自动 seq 偏移，压缩后也能续写）' },
        jsonlFrom: { type: 'number', description: 'fromJsonl 起始行号（0 基，含）' },
        jsonlUntil: { type: 'number', description: 'fromJsonl 结束行号（不含）' },
        fullCopy: { type: 'boolean', description: '多源全类型复制（保留压缩节点 + 按 assistant 回复去重），用于建合并体' },
        keepCompaction: { type: 'boolean', description: 'fullCopy 时保留源自己的压缩记录（compaction/summary|prune）并重映射区间' },
        mixCopy: { type: 'boolean', description: '按时间窗混合多源：turn 块按时间排序写入，跨源去重' },
        timeFrom: { type: 'number', description: 'mixCopy 起始时间戳（毫秒，含）' },
        timeUntil: { type: 'number', description: 'mixCopy 结束时间戳（毫秒，不含）' },
        byteBudget: { type: 'number', description: 'mixCopy 单批 surface 字节预算，到量就在 turn 边界停，返回 nextFrom' },
        seqUntil: { type: 'number', description: 'fullCopy 取源事件 seq 上限（含），用于把压缩段截断在压缩节点覆盖范围内' },
        foldTarget: { type: 'boolean', description: '折叠目标会话已有的早期 surface（只追加一条 replace）' },
        foldBudgetBytes: { type: 'number', description: 'foldTarget 保留的 surface 文本字节预算，默认 2700000' },
        foldSkip: { type: 'number', description: 'foldTarget 跳过开头 N 条 surface（避开已有压缩节点覆盖区）' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args = {}) {
      const now = Date.now();
      // args 在 DSH 里是冻结的，不能原地改；统一用局部变量
      const targetId = args.targetId || ('session-' + randomUUID());
      log('execute targetId=' + targetId + ' copySequential=' + args.copySequential + ' seqFrom=' + args.seqFrom + ' seqUntil=' + args.seqUntil);

      const persistence = ctx.get('sessionPersistence');
      if (!persistence || typeof persistence.create !== 'function') {
        return { ok: false, error: '拿不到 sessionPersistence' };
      }
      const sources = Array.isArray(args.sources) ? args.sources : [];
      if (!sources.length && args.inspect !== true && !args.fromJsonl) return { ok: false, error: 'sources 为空' };

      const header = {
        id: targetId,
        version: 4,
        createdAt: now,
        // cwd 决定会话落在哪个工作区目录，不能用 process.cwd()（那是 DSH 的启动目录）
        cwd: typeof args.cwd === 'string' && args.cwd
          ? args.cwd
          : (firstSourceCwd(sources[0]) || process.cwd()),
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: 'standard',
      };
      // header 形状先过一遍（对齐 DSH 的 assertReleasedV4Header）
      const headerProbs = validateHeader(header);
      if (headerProbs.length) {
        log('header 预检失败: ' + headerProbs.slice(0, 3).join(' | '));
        return { ok: false, stage: 'header', problems: headerProbs };
      }

      // ============ 模式 -1：只 resume 触发落盘 ============
      if (args.resumeOnly === true) {
        const agents = ctx.get('agents');
        if (!agents || typeof agents.resume !== 'function') return { ok: false, error: '拿不到 agents' };
        let h = null;
        try {
          log('resumeOnly：' + targetId);
          h = await agents.resume({ resumeSessionId: targetId });
          log('resume ok');
          return { ok: true, mode: 'resumeOnly', targetId: targetId };
        } catch (err) {
          log('resumeOnly 失败: ' + (err?.name ?? '') + ' ' + (err?.message ?? err));
          return { ok: false, error: (err?.name ?? '') + ': ' + (err?.message ?? err) };
        } finally {
          try { if (h && typeof h.dispose === 'function') { await h.dispose(); log('已释放'); } } catch (err) { log('dispose 失败: ' + (err?.message ?? err)); }
        }
      }

      // ============ 模式：多源全类型复制（保留压缩节点 + 跨源去重）============
      if (args.fullCopy === true) {
        log('fullCopy：多源全类型复制，' + sources.length + ' 个源');
        const keepCompaction = args.keepCompaction === true;
        const ALLOW = new Set([
          'turn/start', 'turn/end', 'step/start', 'step/end',
          'user/message', 'assistant/message', 'tool/call', 'tool/result', 'request/header',
          'system/message', 'developer/message',
          'job/registered', 'job/settled', 'workspace/changes',
          'permission/preset', 'sandbox/mode', 'approval/policy',
          'subagent/catalog', 'model/selection',
        ]);
        if (keepCompaction) {
          for (const t of ['compaction/start', 'compaction/summary', 'compaction/prune', 'compaction/end']) ALLOW.add(t);
        }
        const sha = (e) => createHash('sha1').update(JSON.stringify(e.data ?? {})).digest('hex');
        const textHash = (e) => {
          const d = e.data || {};
          if (e.type === 'user/message') {
            const c = d.content;
            const t = Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : String(c ?? '');
            return t ? createHash('sha1').update('U:' + t).digest('hex') : null;
          }
          if (e.type === 'assistant/message') {
            const c = d.message?.content;
            if (!Array.isArray(c)) return null;
            const t = c.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
            return t.trim() ? createHash('sha1').update('A:' + t).digest('hex') : null;
          }
          return null;
        };
        let h0 = null;
        let startSeq = 0;
        let startTurn = 0;
        const seenMsgs = new Set();
        const stat0 = await persistence.stat(targetId).catch(() => null);
        if (stat0) {
          h0 = await persistence.open(targetId, 'write');
          try {
            const all = await h0.read(0);
            const evs = all?.events || [];
            startSeq = evs.length ? Math.max(...evs.map((e) => (typeof e.seq === 'number' ? e.seq : -1))) + 1 : 0;
            for (const e of evs) {
              const v = e?.data?.turn;
              if (typeof v === 'number' && v > startTurn) startTurn = v;
              if (e.type === 'assistant/message') { const h = textHash(e); if (h) seenMsgs.add(h); }
            }
            log('[full] 目标已有 ' + evs.length + ' 条，去重池 ' + seenMsgs.size);
          } catch (err) { log('读现有事件失败: ' + (err?.message ?? err)); }
        }

        const out = [];
        let newSeq = startSeq;
        let newTurn = startTurn;
        const stats = [];
        const skipped = {};
        let orphanCalls = 0;
        let noiseStripped = 0;
        let emptied = 0;

        for (const sid of sources) {
          const events = readSessionEvents(sid, true);
          if (!events) { stats.push({ id: sid, ok: false }); continue; }

          // ① 切块 + 去重（只按 assistant 回复内容）
          const dropSeqs = new Set();
          const pack = [];
          let cur = null;
          for (const e of events) {
            if (e.type === 'turn/start') cur = { seqs: [e.seq], msgs: [] };
            else if (cur) {
              cur.seqs.push(e.seq);
              if (e.type === 'assistant/message') { const h = textHash(e); if (h) cur.msgs.push(h); }
              if (e.type === 'turn/end') { pack.push(cur); cur = null; }
            }
          }
          let dropped = 0;
          let kept = 0;
          if (keepCompaction) {
            kept = pack.length;
          } else for (const b of pack) {
            if (b.msgs.length && b.msgs.some((h) => seenMsgs.has(h))) {
              for (const s of b.seqs) dropSeqs.add(s);
              dropped += 1;
            } else kept += 1;
          }

          // ② 类型过滤
          const candidates = [];
          for (const e of events) {
            if (!e || !e.type) continue;
            if (e.type === 'session') continue;
            if (e.type === 'session/end-seed') { skipped[e.type] = (skipped[e.type] || 0) + 1; continue; }
            if (e.type.startsWith('session-log-deepseek/')) continue;
            if (typeof args.seqUntil === 'number' && typeof e.seq === 'number' && e.seq > args.seqUntil) { skipped['（超出 seqUntil）'] = (skipped['（超出 seqUntil）'] || 0) + 1; continue; }
            if (stat0 && e.type === 'system/message') { skipped[e.type] = (skipped[e.type] || 0) + 1; continue; }
            if (!ALLOW.has(e.type)) { skipped[e.type] = (skipped[e.type] || 0) + 1; continue; }
            if (dropSeqs.has(e.seq)) { skipped['（整块继承跳过）'] = (skipped['（整块继承跳过）'] || 0) + 1; continue; }
            candidates.push(e);
          }

          // seqUntil 可能截断在 turn 中间：丢掉尾部未闭合的 turn（压缩记录保留）
          if (typeof args.seqUntil === 'number') {
            let lastEnd = -1;
            for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].type === 'turn/end') { lastEnd = i; break; }
            if (lastEnd >= 0) {
              let cutFrom = -1;
              for (let i = lastEnd + 1; i < candidates.length; i++) if (candidates[i].type === 'turn/start') { cutFrom = i; break; }
              if (cutFrom >= 0) {
                const keep2 = candidates.filter((c, i) => i < cutFrom || c.type.startsWith('compaction/'));
                skipped['（尾部未闭合 turn）'] = (skipped['（尾部未闭合 turn）'] || 0) + (candidates.length - keep2.length);
                candidates.length = 0;
                candidates.push(...keep2);
              }
            }
          }

          // ③ 工具配对
          const resolved = new Set();
          const appendIds = new Set();
          for (const e of candidates) {
            if (e.type !== 'tool/result') continue;
            const id = e.data?.message?.toolCallId;
            if (!id) continue;
            if (e.surfaceOp === undefined || e.surfaceOp === 'append') { appendIds.add(id); resolved.add(id); }
          }
          for (const e of candidates) {
            if (e.type !== 'tool/result') continue;
            const id = e.data?.message?.toolCallId;
            if (id && e.surfaceOp !== undefined && e.surfaceOp !== 'append' && !appendIds.has(id)) resolved.add(id);
          }

          // ④ 预映射
          const preMap = new Map();
          let p = newSeq;
          for (const ev of candidates) { if (typeof ev.seq === 'number') preMap.set(ev.seq, p++); }
          const seqMap = new Map();
          const turnMap = new Map();

          for (const ev of candidates) {
            if (ev.type === 'compaction/start' || ev.type === 'compaction/end') { skipped['compaction/标记'] = (skipped['compaction/标记'] || 0) + 1; continue; }
            let outSurfaceOp = ev.surfaceOp;
            if (ev.surfaceOp !== undefined && ev.surfaceOp !== 'append') {
              const so = ev.surfaceOp;
              if (keepCompaction) {
                const ns = seqMap.get(so?.startSeq) ?? preMap.get(so?.startSeq);
                const ne = seqMap.get(so?.endSeq) ?? preMap.get(so?.endSeq);
                if (typeof ns !== 'number' || typeof ne !== 'number') { skipped['（replace 区间无法映射）'] = (skipped['（replace 区间无法映射）'] || 0) + 1; continue; }
                outSurfaceOp = { ...so, startSeq: ns, endSeq: ne };
              } else {
                if (ev.type === 'tool/result') {
                  const rid = ev.data?.message?.toolCallId;
                  if (rid && appendIds.has(rid)) { skipped['（重复的 result 修正条）'] = (skipped['（重复的 result 修正条）'] || 0) + 1; continue; }
                }
                skipped['（' + (so?.op ?? 'obj') + ' 降级为 append）'] = (skipped['（' + (so?.op ?? 'obj') + ' 降级为 append）'] || 0) + 1;
                outSurfaceOp = 'append';
              }
            }

            const data = { ...(ev.data || {}) };
            if (typeof data.owner === 'string' && data.owner === sid) data.owner = targetId;
            if (typeof data.turn === 'number') {
              if (ev.type === 'turn/start') {
                newTurn += 1;
                turnMap.set(data.turn, newTurn);
                data.turn = newTurn;
              } else if (turnMap.has(data.turn)) data.turn = turnMap.get(data.turn);
            }
            if (ev.type === 'developer/message' && typeof data.headerSeq === 'number') {
              const m = seqMap.get(data.headerSeq) ?? preMap.get(data.headerSeq);
              if (typeof m === 'number') data.headerSeq = m; else delete data.headerSeq;
            }
            if (ev.type === 'session/title' && Array.isArray(data.messageSeqs)) {
              data.messageSeqs = data.messageSeqs.map((x) => seqMap.get(x) ?? preMap.get(x)).filter((x) => typeof x === 'number');
            }
            if (keepCompaction && (ev.type === 'compaction/summary' || ev.type === 'compaction/prune')) {
              const oldSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [];
              data.shadowedSeqs = oldSeqs.map((x) => seqMap.get(x)).filter((x) => typeof x === 'number');
              if (data.shadowedRange) {
                const rs = seqMap.get(data.shadowedRange.start);
                const re = seqMap.get(data.shadowedRange.end);
                if (typeof rs !== 'number' || typeof re !== 'number') { skipped['（压缩区间无法映射）'] = (skipped['（压缩区间无法映射）'] || 0) + 1; continue; }
                data.shadowedRange = { start: rs, end: re };
              }
            }
            if (ev.type === 'tool/call' && data.callId && !resolved.has(data.callId)) { orphanCalls += 1; continue; }
            if (ev.type === 'tool/result') {
              const rid = data.message?.toolCallId;
              if (rid && !resolved.has(rid)) { orphanCalls += 1; continue; }
            }
            if (ev.type === 'assistant/message') {
              data.stream = [];
              if (!Array.isArray(data.message?.content)) continue;
              const keep3 = [];
              for (const blk of data.message.content) {
                if (!blk) continue;
                if (blk.type === 'tool-call' && blk.id && !resolved.has(blk.id)) { orphanCalls += 1; continue; }
                if (blk.type === 'reasoning' && typeof blk.text === 'string') {
                  const cleaned = stripNoise(blk.text);
                  if (cleaned !== blk.text) noiseStripped += 1;
                  if (!cleaned.trim()) { emptied += 1; continue; }
                  keep3.push(cleaned === blk.text ? blk : { ...blk, text: cleaned });
                  continue;
                }
                keep3.push(blk);
              }
              data.message = { ...data.message, content: keep3 };
            }
            if (ev.type === 'request/header') data.reason = out.some((x) => x.type === 'request/header') ? 'series' : 'initial';

            seqMap.set(ev.seq, newSeq);
            const isSurf = ev.type === 'user/message' || ev.type === 'assistant/message' || ev.type === 'tool/result';
            out.push({
              seq: newSeq,
              time: typeof ev.time === 'number' ? ev.time : (out.length ? out[out.length - 1].time + 1 : now),
              type: ev.type,
              data,
              ...(outSurfaceOp ? { surfaceOp: outSurfaceOp } : {}),
              ...(() => {
                if (!Array.isArray(ev.sourceEventSeqs)) return {};
                const mapped = ev.sourceEventSeqs.map((x) => seqMap.get(x)).filter((x) => typeof x === 'number' && x < newSeq);
                const uniq = [...new Set(mapped)];
                return uniq.length ? { sourceEventSeqs: uniq } : {};
              })(),
            });
            newSeq += 1;
          }

          for (const e of events) {
            if (e.type === 'assistant/message') { const h = textHash(e); if (h) seenMsgs.add(h); }
          }
          stats.push({ id: sid, blocks: pack.length, keptBlocks: kept, droppedBlocks: dropped, events: candidates.length });
          log('[full] ' + sid + '：块 ' + pack.length + '，保留 ' + kept + '，去重跳过 ' + dropped + '，候选 ' + candidates.length);
        }

        out.push({
          seq: newSeq,
          time: (out.length ? out[out.length - 1].time : now) + 1,
          type: 'session/title',
          data: { title: args.title || '整合会话', messageSeqs: [], source: { kind: 'user' } },
        });
        newSeq += 1;

        log('fullCopy 生成 ' + out.length + ' 条，清噪音 ' + noiseStripped + '，删空思考块 ' + emptied +
            '，丢工具 ' + orphanCalls + '，跳过 ' + JSON.stringify(skipped));
        if (args.dryRun === true) return { ok: true, dryRun: true, mode: 'fullCopy', events: out.length, turns: newTurn - startTurn, stats };

        const probs = validateEventsFull(out, startTurn + 1, { isSeeded: true });
        if (probs.length) {
          log('fullCopy 预检失败 ' + probs.length + ': ' + probs.slice(0, 3).join(' | '));
          if (h0) { try { await h0.close(); } catch { /* 忽略 */ } }
          return { ok: false, stage: 'precheck', problems: probs.slice(0, 20), total: probs.length };
        }
        let h1 = h0;
        if (!h1) h1 = await persistence.create(header);
        try {
          await h1.append(out);
          await h1.flush();
          log('fullCopy append+flush ok');
        } catch (err) {
          log('fullCopy 写盘失败: ' + (err?.message ?? err));
          return fail('write', err?.message ?? err);
        } finally {
          try { if (h1) await h1.close(); } catch { /* 忽略 */ }
        }
        return { ok: true, mode: 'fullCopy', events: out.length, turns: newTurn - startTurn, stats, skipped };
      }

      // ============ 模式：按时间窗混合多个源（turn 块按时间排序，跨源去重）============
      if (args.mixCopy === true) {
        log('mixCopy：按时间混合 ' + sources.length + ' 个源');
        const timeFrom = typeof args.timeFrom === 'number' ? args.timeFrom : -Infinity;
        const timeUntil = typeof args.timeUntil === 'number' ? args.timeUntil : Infinity;
        const ALLOW2 = new Set([
          'turn/start', 'turn/end', 'step/start', 'step/end',
          'user/message', 'assistant/message', 'tool/call', 'tool/result', 'request/header',
          'workspace/changes', 'job/registered', 'job/settled', 'subagent/catalog', 'model/selection',
        ]);
        const textHashOf = (e) => {
          const d = e.data || {};
          if (e.type === 'user/message') {
            const c = d.content;
            const t = Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : String(c ?? '');
            return t ? createHash('sha1').update('U:' + t).digest('hex') : null;
          }
          if (e.type === 'assistant/message') {
            const c = d.message?.content;
            if (!Array.isArray(c)) return null;
            const t = c.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
            return t.trim() ? createHash('sha1').update('A:' + t).digest('hex') : null;
          }
          return null;
        };
        let h6 = null;
        let baseSeq = 0;
        let baseTurn = 0;
        const seen = new Set();
        const st6 = await persistence.stat(targetId).catch(() => null);
        if (st6) {
          h6 = await persistence.open(targetId, 'write');
          try {
            const all = await h6.read(0);
            const evs = all?.events || [];
            baseSeq = evs.length ? Math.max(...evs.map((e) => (typeof e.seq === 'number' ? e.seq : -1))) + 1 : 0;
            for (const e of evs) {
              const v = e?.data?.turn;
              if (typeof v === 'number' && v > baseTurn) baseTurn = v;
              if (e.type === 'assistant/message') { const h = textHashOf(e); if (h) seen.add(h); }
            }
            log('[mix] 目标已有 ' + evs.length + ' 条，去重池 ' + seen.size);
          } catch (err) { log('读现有事件失败: ' + (err?.message ?? err)); }
        }

        const blocks = [];
        for (const sid of sources) {
          const evs = readSessionEvents(sid, true);
          if (!evs) continue;
          let cur = null;
          for (const e of evs) {
            if (e.type === 'turn/start') cur = { sid, startTime: e.time, endTime: 0, events: [e], msgs: [] };
            else if (cur) {
              cur.events.push(e);
              if (e.type === 'assistant/message') { const h = textHashOf(e); if (h) cur.msgs.push(h); }
              if (e.type === 'turn/end') { cur.endTime = typeof e.time === 'number' ? e.time : cur.startTime; blocks.push(cur); cur = null; }
            }
          }
        }
        blocks.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
        const picked = [];
        for (const b of blocks) {
          const t = b.startTime;
          if (typeof t !== 'number' || t < timeFrom || t >= timeUntil) continue;
          if (b.msgs.length && b.msgs.some((h) => seen.has(h))) continue;
          picked.push(b);
          for (const h of b.msgs) seen.add(h);
        }
        log('[mix] 候选块 ' + blocks.length + '，时间窗内 ' + picked.length);

        const resolved2 = new Set();
        for (const b of picked) for (const e of b.events) {
          if (e.type !== 'tool/result') continue;
          if (e.surfaceOp !== undefined && e.surfaceOp !== 'append') continue;
          const id = e.data?.message?.toolCallId;
          if (id) resolved2.add(id);
        }

        const out2 = [];
        let s2 = baseSeq;
        let t2 = baseTurn;
        const seqMap2 = new Map();
        let noise2 = 0;
        let orphan2 = 0;
        const byteBudget = Number(args.byteBudget) || 0;
        let accBytes = 0;
        let nextFrom = null;
        for (const b of picked) {
          if (byteBudget > 0 && accBytes >= byteBudget) { nextFrom = b.startTime; break; }
          t2 += 1;
          for (const e of b.events) {
            if (!ALLOW2.has(e.type)) continue;
            if (e.type === 'system/message') continue;
            if (e.surfaceOp !== undefined && e.surfaceOp !== 'append') continue;
            const data = { ...(e.data || {}) };
            if (typeof data.turn === 'number') data.turn = t2;
            if (e.type === 'developer/message' && typeof data.headerSeq === 'number') {
              const m = seqMap2.get(data.headerSeq);
              if (typeof m === 'number') data.headerSeq = m; else delete data.headerSeq;
            }
            if (e.type === 'tool/call' && data.callId && !resolved2.has(data.callId)) { orphan2 += 1; continue; }
            if (e.type === 'tool/result') {
              const rid = data.message?.toolCallId;
              if (rid && !resolved2.has(rid)) { orphan2 += 1; continue; }
            }
            if (e.type === 'assistant/message') {
              data.stream = [];
              if (!Array.isArray(data.message?.content)) continue;
              const keep4 = [];
              for (const blk of data.message.content) {
                if (!blk) continue;
                if (blk.type === 'tool-call' && blk.id && !resolved2.has(blk.id)) { orphan2 += 1; continue; }
                if (blk.type === 'reasoning' && typeof blk.text === 'string') {
                  const cleaned = stripNoise(blk.text);
                  if (cleaned !== blk.text) noise2 += 1;
                  if (!cleaned.trim()) continue;
                  keep4.push(cleaned === blk.text ? blk : { ...blk, text: cleaned });
                  continue;
                }
                keep4.push(blk);
              }
              data.message = { ...data.message, content: keep4 };
            }
            if (e.type === 'request/header') data.reason = out2.some((x) => x.type === 'request/header') ? 'series' : 'initial';
            const isSurf2 = e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result';
            out2.push({
              seq: s2,
              time: typeof e.time === 'number' ? e.time : (out2.length ? out2[out2.length - 1].time + 1 : now),
              type: e.type,
              data,
              ...(isSurf2 ? { surfaceOp: 'append' } : {}),
            });
            if (typeof e.seq === 'number') seqMap2.set(e.seq, s2);
            if (isSurf2) accBytes += JSON.stringify(data).length;
            s2 += 1;
          }
        }
        log('[mix] 生成 ' + out2.length + ' 条，turn ' + (t2 - baseTurn) + '，清噪音 ' + noise2 + '，丢工具 ' + orphan2 +
            '，字节 ' + (accBytes / 1048576).toFixed(2) + 'MB' + (nextFrom ? '，下一批起点 ' + nextFrom : '，已到末尾'));

        if (args.dryRun === true) return { ok: true, dryRun: true, mode: 'mixCopy', events: out2.length, turns: t2 - baseTurn, nextFrom };
        const probs2 = validateEventsFull(out2, baseTurn + 1, { isSeeded: true });
        if (probs2.length) {
          log('mix 预检失败 ' + probs2.length + ': ' + probs2.slice(0, 3).join(' | '));
          if (h6) { try { await h6.close(); } catch { /* 忽略 */ } }
          return { ok: false, stage: 'precheck', problems: probs2.slice(0, 20), total: probs2.length };
        }
        let h7 = h6;
        if (!h7) h7 = await persistence.create(header);
        try {
          await h7.append(out2);
          await h7.flush();
          log('mix append+flush ok');
        } catch (err) {
          log('mix 写盘失败: ' + (err?.message ?? err));
          return fail('write', err?.message ?? err);
        } finally {
          try { if (h7) await h7.close(); } catch { /* 忽略 */ }
        }
        return { ok: true, mode: 'mixCopy', events: out2.length, turns: t2 - baseTurn, nextFrom };
      }

      // ============ 模式：折叠既有会话的早期 surface ============
      if (args.foldTarget === true) {
        log('foldTarget：' + targetId);
        const st8 = await persistence.stat(targetId).catch(() => null);
        if (!st8) return { ok: false, error: '目标不存在' };
        let h8 = null;
        try {
          h8 = await persistence.open(targetId, 'write');
          const all = await h8.read(0);
          const evs = all?.events || [];
          const budget = Number(args.foldBudgetBytes) || 2700000;
          const SURF = new Set(['user/message', 'assistant/message', 'tool/result']);
          const surface = [];
          for (const e of evs) {
            if (!SURF.has(e.type)) continue;
            if (e.surfaceOp === 'append') surface.push(e.seq);
            else if (e.surfaceOp && typeof e.surfaceOp === 'object') {
              const a = surface.indexOf(e.surfaceOp.startSeq);
              const b = surface.indexOf(e.surfaceOp.endSeq);
              if (a >= 0 && b >= a) surface.splice(a, b - a + 1, e.seq);
            }
          }
          const bySeq = new Map(evs.map((e) => [e.seq, e]));
          const sizeOf = (seq) => {
            const e = bySeq.get(seq);
            if (!e) return 0;
            let sz = JSON.stringify(e.data).length;
            if (Array.isArray(e.data?.stream)) sz -= JSON.stringify(e.data.stream).length;
            return sz;
          };
          let acc = 0;
          let cutIdx = 0;
          for (let i = surface.length - 1; i >= 0; i--) {
            acc += sizeOf(surface[i]);
            if (acc > budget) { cutIdx = i + 1; break; }
          }
          const skip = Math.max(0, Number(args.foldSkip) || 0);
          if (cutIdx <= skip) {
            return { ok: true, mode: 'foldTarget', folded: 0, note: cutIdx <= 0 ? '已在预算内' : 'foldSkip 太大', surfaceCount: surface.length };
          }
          const fromSeq = surface[skip];
          const toSeq = surface[cutIdx - 1];
          const lastEv = evs[evs.length - 1];
          const ev = {
            seq: (typeof lastEv?.seq === 'number' ? lastEv.seq : -1) + 1,
            time: (lastEv?.time ?? now) + 1,
            type: 'user/message',
            data: {
              content: [{ type: 'text', text: `（第 ${skip + 1}~${cutIdx} 条历史已折叠为压缩视图；原始记录完整保存在本会话事件日志中，可检索）` }],
              source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Asia/Shanghai' },
              role: 'user',
              id: randomUUID(),
            },
            surfaceOp: { op: 'replace', startSeq: fromSeq, endSeq: toSeq },
          };
          await h8.append([ev]);
          await h8.flush();
          log('foldTarget 折叠 surface[' + skip + '..' + (cutIdx - 1) + ']');
          return { ok: true, mode: 'foldTarget', folded: cutIdx - skip, remaining: surface.length - (cutIdx - skip) + 1 };
        } catch (err) {
          log('foldTarget 失败: ' + (err?.message ?? err));
          return fail('write', err?.message ?? err);
        } finally {
          try { if (h8) await h8.close(); } catch { /* 忽略 */ }
        }
      }

      // ============ 模式：官方校验（调 DSH 自己的 open，报错原样透传）============
      if (args.verify === true) {
        const id = args.targetId || sources[0];
        if (!id) return { ok: false, error: '需要 targetId 或 sources[0]' };
        let hv = null;
        try {
          hv = await persistence.open(id, 'read');
          const cur = await hv.read(0);
          const evs = cur?.events || [];
          const head = cur?.header || evs.find((e) => e.type === 'session') || null;
          log('[verify] ' + id + ' 打开成功，事件 ' + evs.length);
          return {
            ok: true, mode: 'verify', id, events: evs.length, header: head,
            note: '这是 DSH 自己的 open 路径：能打开 = DSH 认；报错文案与界面一字不差',
          };
        } catch (err) {
          log('[verify] ' + id + ' 打不开：' + (err?.name ?? '') + ' ' + (err?.message ?? err));
          return {
            ok: false, mode: 'verify', id, stage: 'open',
            errorName: err?.name ?? null,
            error: String(err?.message ?? err),
          };
        } finally {
          try { if (hv) await hv.close(); } catch { /* 忽略 */ }
        }
      }

      // ============ 模式 -6：查看会话结构（只读）============
      if (args.inspect === true) {
        const id = targetId || sources[0];
        if (!id) return { ok: false, error: '需要 targetId 或 sources[0]' };
        const evs = readSessionEvents(id, true);
        if (!evs || !evs.length) return { ok: false, error: '读不到会话 ' + id };
        const c = {};
        for (const e of evs) c[e.type] = (c[e.type] || 0) + 1;
        const SURF = new Set(['user/message', 'assistant/message', 'tool/result']);
        let surfBytes = 0;
        let surfEvents = 0;
        for (const e of evs) {
          if (!SURF.has(e.type)) continue;
          let sz = JSON.stringify(e.data || {}).length;
          if (Array.isArray(e.data?.stream)) sz -= JSON.stringify(e.data.stream).length;
          surfBytes += sz;
          surfEvents += 1;
        }
        const times = evs.map((e) => e.time).filter((x) => typeof x === 'number' && x > 1e12);
        const fmt = (t) => new Date(t + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
        const info = {
          ok: true, id, events: evs.length,
          turns: c['turn/end'] || 0,
          userMessages: c['user/message'] || 0,
          assistantMessages: c['assistant/message'] || 0,
          toolCalls: c['tool/call'] || 0,
          toolResults: c['tool/result'] || 0,
          compactionSummaries: c['compaction/summary'] || 0,
          surfaceEvents: surfEvents,
          surfaceMB: Number((surfBytes / 1048576).toFixed(2)),
          approxTokens: Math.round(surfBytes / 3.8),
          timeRange: times.length ? [fmt(Math.min(...times)), fmt(Math.max(...times))] : null,
          types: c,
        };
        log('[inspect] ' + id + ' | 事件 ' + evs.length + ' | turn ' + info.turns +
            ' | surface ' + info.surfaceMB + 'MB ≈ ' + info.approxTokens + ' tokens');
        return info;
      }

      // ============ 模式 -5：从本地 JSONL 按范围写入 ============
      if (typeof args.fromJsonl === 'string' && args.fromJsonl) {
        log('fromJsonl：' + args.fromJsonl);
        const all = fs.readFileSync(args.fromJsonl, 'utf8').split('\n').filter((l) => l.trim());
        const from = Math.max(0, Number(args.jsonlFrom) || 0);
        let until = Math.min(all.length, Number(args.jsonlUntil) || all.length);
        const batch = [];
        for (let i = from; i < until; i++) {
          try { batch.push(JSON.parse(all[i])); } catch { /* 跳过坏行 */ }
        }
        // 切点可能落在 turn 中间：自动往后补到 turn/end
        if (batch.length && batch[batch.length - 1].type !== 'turn/end') {
          let extra = until;
          while (extra < all.length) {
            let ev = null;
            try { ev = JSON.parse(all[extra]); } catch { /* 跳过坏行 */ }
            extra += 1;
            if (!ev) continue;
            batch.push(ev);
            if (ev.type === 'turn/end') break;
          }
          until = extra;
          log('[jsonl] 切点补齐到 turn 边界，实际取到 ' + until);
        }
        if (!batch.length) return { ok: false, error: 'JSONL 区间为空' };
        const SURF2 = new Set(['user/message', 'assistant/message', 'tool/result']);
        let surfBytes2 = 0;
        for (const e of batch) if (SURF2.has(e.type)) surfBytes2 += JSON.stringify(e.data || {}).length;
        const turnCount = batch.filter((e) => e.type === 'turn/end').length;
        if (args.dryRun === true) {
          const st5 = await persistence.stat(targetId).catch(() => null);
          log('[jsonl dryRun] 事件 ' + batch.length + ' | turn ' + turnCount + ' | surface ' + (surfBytes2 / 1048576).toFixed(2) + 'MB');
          return { ok: true, dryRun: true, events: batch.length, turns: turnCount, surfaceMB: Number((surfBytes2 / 1048576).toFixed(2)), targetExists: !!st5 };
        }
        let h5 = null;
        try {
          h5 = await persistence.open(targetId, 'write');
          const cur = await h5.read(0);
          const evs = cur?.events || [];
          const nextSeq = evs.length ? Math.max(...evs.map((e) => (typeof e.seq === 'number' ? e.seq : -1))) + 1 : 0;
          let maxTurn = 0;
          for (const e of evs) { const v = e?.data?.turn; if (typeof v === 'number' && v > maxTurn) maxTurn = v; }
          const delta = nextSeq - batch[0].seq;
          if (delta !== 0) {
            log('[jsonl] seq 偏移 ' + delta + '（批次首 ' + batch[0].seq + ' → ' + nextSeq + '）');
            for (const e of batch) if (typeof e.seq === 'number') e.seq += delta;
          }
          const firstTurn = Math.min(...batch.map((e) => (typeof e.data?.turn === 'number' ? e.data.turn : Infinity)));
          const probs5 = validateEventsFull(batch, Number.isFinite(firstTurn) ? firstTurn : maxTurn + 1, { isSeeded: true });
          if (probs5.length) {
            log('jsonl 预检失败 ' + probs5.length + ': ' + probs5.slice(0, 3).join(' | '));
            return { ok: false, stage: 'precheck', problems: probs5.slice(0, 20), total: probs5.length };
          }
          await h5.append(batch);
          await h5.flush();
          log('jsonl append+flush ok，' + batch.length + ' 条 | turn ' + turnCount + ' | surface ' + (surfBytes2 / 1048576).toFixed(2) + 'MB');
          return { ok: true, mode: 'fromJsonl', events: batch.length, turns: turnCount, surfaceMB: Number((surfBytes2 / 1048576).toFixed(2)), from, until };
        } catch (err) {
          log('jsonl 写盘失败: ' + (err?.message ?? err));
          return fail('write', err?.message ?? err);
        } finally {
          try { if (h5) await h5.close(); } catch { /* 忽略 */ }
        }
      }

      // ============ 模式零：官方 fork 克隆 ============
      if (args.forkClone === true && sources.length === 1) {
        log('forkClone：用 sessions.fork 克隆 ' + sources[0]);
        const agents = ctx.get('agents');
        const sessions = ctx.get('sessions');
        if (!agents || typeof agents.resume !== 'function') return { ok: false, error: '拿不到 agents' };
        if (!sessions || typeof sessions.fork !== 'function') return { ok: false, error: '拿不到 sessions.fork' };

        let resumed = null;
        try {
          resumed = await agents.resume({ resumeSessionId: sources[0] });
          log('resume ok');
          const srcSession = resumed.agent ? resumed.agent.session : null;
          if (!srcSession) return { ok: false, error: 'resume 没给出 session' };

          const child = sessions.fork(srcSession, typeof args.forkBoundary === 'number' ? args.forkBoundary : undefined, targetId);
          log('fork 返回: ' + (child ? child.id : 'null'));

          // 落盘：fork 出来的只是内存 Session，必须自己建 handle 再 append seed
          if (child) {
            const persistence = ctx.get('sessionPersistence');
            if (!persistence || typeof persistence.create !== 'function') {
              return { ok: false, error: '拿不到 sessionPersistence，无法落盘' };
            }
            const handle = await persistence.create(child.header, {
              inheritedEventCount: child.inheritedEventCount,
            });
            log('persistence.create ok, inheritedEventCount=' + child.inheritedEventCount);
            const seedEvents = child.snapshotEvents();
            log('准备 append ' + seedEvents.length + ' 条 seed 事件');
            await handle.append(seedEvents);
            await handle.flush();
            await handle.close();
            log('seed 落盘完成');
          }
          return { ok: true, mode: 'forkClone', targetId: targetId, forked: child ? child.id : null, seq: child ? child.seq : null };
        } catch (err) {
          log('forkClone 失败: ' + (err?.name ?? '') + ' ' + (err?.message ?? err));
          return { ok: false, error: (err?.name ?? '') + ': ' + (err?.message ?? err) };
        } finally {
          try {
            if (resumed && typeof resumed.dispose === 'function') { await resumed.dispose(); log('resume 已释放'); }
          } catch (err) { log('dispose 失败: ' + (err?.message ?? err)); }
        }
      }

      // ============ 模式一：单源直线复制（保留压缩节点）============
      if (args.copySequential === true && sources.length === 1) {
        log('copySequential：单源直线复制');
        let srcEvents = readSessionEvents(sources[0], true);
        if (!srcEvents) return { ok: false, error: '读不到源会话' };

        let lo = typeof args.seqFrom === 'number' ? args.seqFrom : -Infinity;
        let hi = typeof args.seqUntil === 'number' ? args.seqUntil : Infinity;
        if (lo !== -Infinity) {
          const prevStarts = srcEvents.filter((e) => e.type === 'turn/start' && typeof e.seq === 'number' && e.seq <= lo);
          if (prevStarts.length) lo = prevStarts[prevStarts.length - 1].seq;
        }
        if (hi !== Infinity) {
          const nextEnds = srcEvents.filter((e) => e.type === 'turn/end' && typeof e.seq === 'number' && e.seq >= hi);
          if (nextEnds.length) hi = nextEnds[0].seq;
        }
        if (lo !== -Infinity || hi !== Infinity) {
          log('[seq] 实际范围 ' + lo + ' → ' + hi);
          srcEvents = srcEvents.filter((e) => typeof e.seq !== 'number' || (e.seq >= lo && e.seq <= hi));
        }

        let startSeq = 0;
        let startTurn = 0;
        const stat0 = await persistence.stat(targetId).catch(() => null);
        let handle0 = null;
        if (stat0) {
          handle0 = await persistence.open(targetId, 'write');
          try {
            const all = await handle0.read(0);
            const evs = all?.events || [];
            startSeq = evs.length ? evs[evs.length - 1].seq + 1 : 0;
            for (const e of evs) {
              const v = e?.data?.turn;
              if (typeof v === 'number' && v > startTurn) startTurn = v;
            }
          } catch (err) { log('读现有事件失败: ' + (err?.message ?? err)); }
        }

        const preMap = new Map();
        let p = startSeq;
        for (const ev of srcEvents) {
          if (!ev || !ev.type || ev.type === 'session') continue;
          if (typeof ev.seq !== 'number') continue;
          preMap.set(ev.seq, p++);
        }

        const seqMap = new Map();
        const turnMap = new Map();
        const out = [];
        let newSeq = startSeq;
        let newTurn = startTurn;
        let compactionCount = 0;

        for (const ev of srcEvents) {
          if (!ev || !ev.type || ev.type === 'session') continue;
          if (typeof ev.seq !== 'number') continue;
          if (ev.type.startsWith('session-log-deepseek/')) continue;

          let outSurfaceOp = ev.surfaceOp;
          if (ev.surfaceOp !== undefined && ev.surfaceOp !== 'append') {
            const so = ev.surfaceOp;
            if (so && typeof so === 'object') {
              const ns = seqMap.get(so.startSeq) ?? preMap.get(so.startSeq);
              const ne = seqMap.get(so.endSeq) ?? preMap.get(so.endSeq);
              if (typeof ns !== 'number' || typeof ne !== 'number') continue;
              outSurfaceOp = { ...so, startSeq: ns, endSeq: ne };
            } else continue;
          }

          const data = { ...(ev.data || {}) };
          if (typeof data.owner === 'string' && data.owner === sources[0]) data.owner = targetId;

          if (typeof data.turn === 'number') {
            if (ev.type === 'turn/start') {
              newTurn += 1;
              turnMap.set(data.turn, newTurn);
              data.turn = newTurn;
            } else if (turnMap.has(data.turn)) {
              data.turn = turnMap.get(data.turn);
            }
          }

          if (ev.type === 'developer/message' && typeof data.headerSeq === 'number') {
            const m = seqMap.get(data.headerSeq) ?? preMap.get(data.headerSeq);
            if (typeof m === 'number') data.headerSeq = m;
            else delete data.headerSeq;
          }

          if (ev.type === 'compaction/summary' || ev.type === 'compaction/prune') {
            const oldSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [];
            data.shadowedSeqs = oldSeqs.map((x) => seqMap.get(x) ?? preMap.get(x)).filter((x) => typeof x === 'number');
            if (data.shadowedRange) {
              const rs = seqMap.get(data.shadowedRange.start) ?? preMap.get(data.shadowedRange.start);
              const re = seqMap.get(data.shadowedRange.end) ?? preMap.get(data.shadowedRange.end);
              if (typeof rs === 'number' && typeof re === 'number') data.shadowedRange = { start: rs, end: re };
            }
            compactionCount += 1;
          }

          seqMap.set(ev.seq, newSeq);
          out.push({
            seq: newSeq,
            time: typeof ev.time === 'number' ? ev.time : (out.length ? out[out.length - 1].time + 1 : now),
            type: ev.type,
            data,
            ...(outSurfaceOp ? { surfaceOp: outSurfaceOp } : {}),
            ...(Array.isArray(ev.sourceEventSeqs)
              ? { sourceEventSeqs: ev.sourceEventSeqs.map((x) => seqMap.get(x) ?? preMap.get(x)).filter((x) => typeof x === 'number') }
              : {}),
          });
          newSeq += 1;
        }

        out.push({
          seq: newSeq,
          time: (out.length ? out[out.length - 1].time : now) + 1,
          type: 'session/title',
          data: { title: '合并会话', messageSeqs: [], source: { kind: 'user' } },
        });

        log('copySequential 完成：' + out.length + ' 条事件，' + newTurn + ' turn，' + compactionCount + ' 压缩记录');

        if (args.dryRun) return { ok: true, dryRun: true, mode: 'copySequential', events: out.length, turns: newTurn, compactions: compactionCount };

        const problems2 = validateEventsFull(out, startTurn + 1, { isSeeded: true });
        if (problems2.length) {
          log('预检失败 ' + problems2.length + ' 条: ' + problems2.slice(0, 5).join(' | '));
          if (handle0) { try { await handle0.close(); } catch { /* 忽略 */ } }
          return { ok: false, stage: 'precheck', problems: problems2.slice(0, 20), total: problems2.length };
        }
        log('预检通过');

        let handle2 = handle0;
        if (!handle2) {
          try {
            handle2 = await persistence.create(header);
            log('create 模式');
          } catch (err) {
            return { ok: false, error: 'create 失败: ' + (err?.message ?? err) };
          }
        }

        try {
          await handle2.append(out);
          await handle2.flush();
          log('append+flush ok');
        } catch (err) {
          log('写盘失败: ' + (err?.message ?? err));
          try { await handle2.close(); } catch { /* 忽略 */ }
          return { ok: false, error: '写盘失败: ' + (err?.message ?? err) };
        }
        try { await handle2.close(); } catch { /* 忽略 */ }
        return { ok: true, mode: 'copySequential', targetId: targetId, events: out.length, turns: newTurn, compactions: compactionCount };
      }

      // ============ 模式二：多源按 turn 块合并（deprecated，用 fullCopy 代替）============
      log('merge 模式：按 turn 块合并（deprecated：不保留压缩记录，surface 会膨胀，建议改用 fullCopy）');
      const limit = Math.min(Math.max(Number(args.limit) || 120, 1), 5000);
      const allBlocks = [];
      const stats = [];

      for (const sid of sources) {
        let events = readSessionEvents(sid, args.includeShadowed === true);
        if (!events) { stats.push({ id: sid, ok: false }); continue; }

        // seqFrom/seqUntil 只作用于第一个源：第二个源（会话2）的 seq 是独立编号，
        // 混用会把它的内容整段过滤掉
        const applySeq = sid === sources[0] && (typeof args.seqFrom === 'number' || typeof args.seqUntil === 'number');
        if (applySeq) {
          let lo = typeof args.seqFrom === 'number' ? args.seqFrom : -Infinity;
          let hi = typeof args.seqUntil === 'number' ? args.seqUntil : Infinity;
          if (lo !== -Infinity) {
            const prevStarts = events.filter((e) => e.type === 'turn/start' && typeof e.seq === 'number' && e.seq <= lo);
            if (prevStarts.length) lo = prevStarts[prevStarts.length - 1].seq;
          }
          if (hi !== Infinity) {
            const nextEnds = events.filter((e) => e.type === 'turn/end' && typeof e.seq === 'number' && e.seq >= hi);
            if (nextEnds.length) hi = nextEnds[0].seq;
          }
          events = events.filter((e) => typeof e.seq !== 'number' || (e.seq >= lo && e.seq <= hi));
        }

        let blocks = sliceTurns(events).filter((b) => b.events.some((x) =>
          (x.type === 'user/message' && Array.isArray(x.data?.content)) ||
          (x.type === 'assistant/message' && Array.isArray(x.data?.message?.content))));

        if (typeof args.fromTime === 'number') blocks = blocks.filter((b) => typeof b.startTime !== 'number' || b.startTime >= args.fromTime);
        if (typeof args.untilTime === 'number') blocks = blocks.filter((b) => typeof b.startTime !== 'number' || b.startTime < args.untilTime);

        const skip = Math.max(0, Number(args.skip) || 0);
        let taken;
        if (args.fromStart) {
          taken = blocks.slice(skip, Math.min(blocks.length, skip + limit));
        } else {
          const end = Math.max(0, blocks.length - skip);
          taken = blocks.slice(Math.max(0, end - limit), end);
        }
        stats.push({ id: sid, turns: blocks.length, taken: taken.length });
        allBlocks.push(...taken);
      }

      allBlocks.sort((a, b) => (a.startTime ?? Number.MAX_SAFE_INTEGER) - (b.startTime ?? Number.MAX_SAFE_INTEGER));
      log('合并 ' + allBlocks.length + ' 个 turn 块');
      if (args.dryRun) return { ok: true, dryRun: true, blocks: allBlocks.length, stats };

      let handle = null;
      let startSeq = 0;
      let startTurn = 0;
      let mode = 'create';
      const stat = await persistence.stat(targetId).catch(() => null);
      if (stat) {
        mode = 'append';
        handle = await persistence.open(targetId, 'write');
        try {
          const all = await handle.read(0);
          const evs = all?.events || [];
          startSeq = evs.length ? evs[evs.length - 1].seq + 1 : 0;
          for (const e of evs) {
            const v = e?.data?.turn;
            if (typeof v === 'number' && v > startTurn) startTurn = v;
          }
        } catch (err) { log('读现有事件失败: ' + (err?.message ?? err)); }
        log('append 模式：现有 ' + startSeq + ' 条，最大 turn=' + startTurn);
      } else {
        handle = await persistence.create(header);
        log('create 模式');
      }

      const firstTimed = allBlocks.find((b) => typeof b.startTime === 'number');
      const baseTime = firstTimed ? firstTimed.startTime - 1000 : now;

      const out = [];
      let seq = startSeq;
      let newTurn = startTurn;
      let systemInjected = false;

      // 前置环境设置
      const preEvents = (readSessionEvents(sources[0], false) || []).filter((e) => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(e.type));
      let noiseStripped = 0;

      let emptiedReasoning = 0;

      let preIdx = 0;
      for (const e of preEvents) {
        out.push({ seq: seq++, time: baseTime + preIdx, type: e.type, data: { ...(e.data || {}) } });
        preIdx += 1;
      }

      for (const block of allBlocks) {
        newTurn += 1;
        let stepOpen = false;
        for (const e of block.events) {
          if (!KEEP.has(e.type)) continue;
          if (e.type === 'turn/end' && stepOpen) {
            out.push({ seq: seq++, time: (out.length ? out[out.length - 1].time : now) + 1, type: 'step/end', data: { turn: newTurn, step: 1 } });
            stepOpen = false;
          }
          const isFirstStepStart = e.type === 'step/start' && !systemInjected;
          if (e.type === 'step/start') stepOpen = true;
          if (e.type === 'step/end') stepOpen = false;
          if (e.surfaceOp !== undefined && e.surfaceOp !== 'append') continue;
          const data = { ...(e.data || {}) };
          if (data.turn !== undefined) data.turn = newTurn;
          if (e.type === 'assistant/message') {
            if (!Array.isArray(data.stream)) data.stream = [];
            if (!Array.isArray(data.message?.content)) continue;
            if (args.stripNoise === true || args.dropEmptyReasoning === true) {
              let removed = 0;
              data.message = {
                ...data.message,
                content: data.message.content.map((b) => {
                  if (!b || b.type !== 'reasoning' || typeof b.text !== 'string') return b;
                  const cleaned = stripNoise(b.text);
                  if (cleaned !== b.text) removed += 1;
                  return { ...b, text: cleaned };
                }).filter((b) => b && (b.type !== 'reasoning' || (typeof b.text === 'string' && b.text.trim().length > 0))),
              };
              if (removed) noiseStripped += removed;
            }
            if (args.dropEmptyReasoning === true) {
              const before = data.message.content.length;
              data.message = {
                ...data.message,
                content: data.message.content.filter((b) => !(b && b.type === 'reasoning' && !(b.text ?? '').trim().length)),
              };
              emptiedReasoning += before - data.message.content.length;
            }
          }
          if (e.type === 'request/header') {
            data.reason = out.some((x) => x.type === 'request/header') ? 'series' : 'initial';
          }
          let evTime = typeof e.time === 'number' ? e.time : now + seq;
          const prevTime = out.length ? out[out.length - 1].time : 0;
          if (evTime <= prevTime) evTime = prevTime + 1;
          out.push({
            seq: seq++,
            time: evTime,
            type: e.type,
            data,
            ...(e.surfaceOp ? { surfaceOp: e.surfaceOp } : {}),
          });

          if (isFirstStepStart) {
            out.push({
              seq: seq++,
              time: (out.length ? out[out.length - 1].time : now) + 1,
              type: 'system/message',
              data: {
                turn: newTurn,
                step: data.step ?? 1,
                message: {
                  role: 'system',
                  content: [{ type: 'text', text: '（合并会话：原始系统提示未取得）' }],
                  source: { kind: 'system-prompt' },
                  id: randomUUID(),
                },
              },
              surfaceOp: 'append',
            });
            systemInjected = true;
          }
        }
      }

      out.push({ seq: seq++, time: (out.length ? out[out.length - 1].time : now) + 1, type: 'session/title', data: { title: '合并会话', messageSeqs: [], source: { kind: 'user' } } });

      const problems = validateEventsFull(out, startTurn + 1, { isSeeded: true });
      if (problems.length) {
        log('预检失败 ' + problems.length + ' 条: ' + problems.slice(0, 5).join(' | '));
        try { await handle.close(); } catch { /* 忽略 */ }
        return { ok: false, stage: 'precheck', problems: problems.slice(0, 20), total: problems.length };
      }
      log('预检通过 ' + out.length + ' 条，清理思考噪音 ' + noiseStripped + ' 块，删除空思考块 ' + emptiedReasoning + ' 个');

      try {
        await handle.append(out);
        await handle.flush();
        log('append+flush ok');
      } catch (err) {
        log('写盘失败: ' + (err?.message ?? err));
        try { await handle.close(); } catch { /* 忽略 */ }
        return { ok: false, error: '写盘失败: ' + (err?.message ?? err) };
      }
      try { await handle.close(); } catch { /* 忽略 */ }
      // 进度：告诉调用方下一段从哪开始、还剩多少、该不该先压缩
      const totalTurns = stats.reduce((s, x) => s + (x.turns || 0), 0)
      const takenTurns = stats.reduce((s, x) => s + (x.taken || 0), 0)
      const nextSkip = (Number(args.skip) || 0) + takenTurns
      const remaining = Math.max(0, totalTurns - nextSkip)
      // 估算本次写进去的 surface 字节：assistant/user 文本 + tool/result 文本
      let surfBytes = 0
      for (const e of out) {
        if (e.type !== 'user/message' && e.type !== 'assistant/message' && e.type !== 'tool/result') continue
        const c = e.type === 'assistant/message' ? e.data?.message?.content : e.type === 'tool/result' ? e.data?.message?.content : e.data?.content
        if (!Array.isArray(c)) continue
        for (const b of c) if (b && typeof b.text === 'string') surfBytes += Buffer.byteLength(b.text, 'utf8')
      }
      const surfMB = Number((surfBytes / 1048576).toFixed(2))
      const approxTokens = Math.round(surfBytes / 3.8)
      log('[progress] 本段 ' + takenTurns + '/' + totalTurns + '，下一段 skip=' + nextSkip + '，剩 ' + remaining + '，surface ' + surfMB + 'MB ≈ ' + approxTokens + ' tokens，shouldCompact=' + (surfMB >= 2.4));
      return {
        ok: true, mode, targetId: targetId,
        events: out.length, turns: newTurn - startTurn, stats,
        progress: {
          written: takenTurns,
          total: totalTurns,
          nextSkip,
          remaining,
          nextArgs: remaining > 0 ? { skip: nextSkip, limit: Number(args.limit) || 120 } : null,
        },
        surface: { mb: surfMB, approxTokens, shouldCompact: surfMB >= 2.4 },
        hint: remaining > 0
          ? (surfMB >= 2.4
            ? '本次写入 ' + surfMB + 'MB（约 ' + approxTokens + ' tokens），已到该压缩的线：先在 GUI 里 /compact，再按 nextArgs 继续。'
            : '还有 ' + remaining + ' 个 turn 未写。可直接按 nextArgs 继续，也可以先压缩。')
          : '全部写完了，最后压一次收尾。',
      };
    },
  }), 'dsh-session-merge: merge tool');

  // 诊断 + 释放写句柄
  ctx.effect(() => ctx.tools.register({
    name: 'session_unlock',
    description: '诊断并尝试释放目标会话的活跃写句柄（目标在 GUI 里开着时会占用）',
    parameters: {
      type: 'object',
      properties: { targetId: { type: 'string' }, action: { type: 'string' } },
      required: ['targetId'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args = {}) {
      log('unlock 调用 targetId=' + targetId + ' action=' + args.action);
      const out = { targetId: targetId };
      const persistence = ctx.get('sessionPersistence');
      if (!persistence) return { error: '拿不到 sessionPersistence' };
      try {
        const names = new Set();
        let p = persistence;
        while (p && p !== Object.prototype) { for (const n of Object.getOwnPropertyNames(p)) names.add(n); p = Object.getPrototypeOf(p); }
        out.members = [...names];
      } catch (err) { out.membersErr = String(err?.message ?? err); }
      if (args.action === 'release') {
        for (const m of ['close', 'release', 'evict', 'dispose', 'unlock', 'closeSession', 'releaseSession', 'forceRelease']) {
          if (typeof persistence[m] === 'function') {
            try { out['ok_' + m] = String(await persistence[m](targetId)); }
            catch (err) { out['err_' + m] = String(err?.message ?? err); }
          }
        }
      }
      try {
        const st = await persistence.stat(targetId);
        let s = JSON.stringify(st);
        out.statPreview = s.length > 1200 ? s.slice(0, 1200) + '…' : s;
      } catch (err) { out.statErr = String(err?.message ?? err); }
      return out;
    },
  }), 'dsh-session-merge: unlock tool');

  log('apply 结束（v11）');
}
