#!/usr/bin/env node
// 独立运行：校验一个 DSH 会话文件（或按 id 前缀找）
// 用法：
//   node bin/validate.mjs <会话id前缀|会话目录|文件> [--json] [--no-replay] [--strict-replay]
// 会话根目录：DSH_SESSIONS 环境变量，默认 ~/.dsh/sessions
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSessionFile } from '../deep-validate.mjs';

const ROOT = process.env.DSH_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');
const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const noReplay = args.includes('--no-replay');
const strictReplay = args.includes('--strict-replay');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  console.error('用法: node bin/validate.mjs <会话id前缀|会话目录|文件> [--json] [--no-replay] [--strict-replay]');
  process.exit(2);
}

function pickLogFile(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(f));
  files.sort((a, b) => (Number((b.match(/v(\d+)/) || [])[1] || 0)) - (Number((a.match(/v(\d+)/) || [])[1] || 0)));
  return files.length ? path.join(dir, files[0]) : null;
}

function resolveTarget(a) {
  if (fs.existsSync(a)) {
    const st = fs.statSync(a);
    if (st.isFile()) return a;
    if (st.isDirectory()) return pickLogFile(a);
  }
  if (!fs.existsSync(ROOT)) return null;
  for (const ws of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    for (const d of fs.readdirSync(path.join(ROOT, ws.name), { withFileTypes: true })) {
      if (d.isDirectory() && d.name.startsWith(a)) {
        const f = pickLogFile(path.join(ROOT, ws.name, d.name));
        if (f) return f;
      }
    }
  }
  return null;
}

const file = resolveTarget(target);
if (!file) { console.error('找不到会话:', target); process.exit(2); }

const r = await validateSessionFile(file, { replay: !noReplay, strictReplay });

if (jsonOut) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

console.log(`${r.ok ? '✅ 通过' : '❌ 不通过'}  ${r.session}  (${r.mb} MB)`);
console.log(`  ${r.file}  帧 ${r.frames}  行 ${r.lines}  事件 ${r.events}${r.degraded ? '  ⚠ 缺 DSH 模块，已降级' : ''}`);
if (r.header) console.log(`  header: id=${r.header.id}  isSeeded=${r.header.isSeeded}  parent=${r.header.parentSession ?? '(无)'}  cut=${r.header.cut}`);
if (r.replay) console.log(`  重放: ${r.replay.total} 条可装配，装配成功 ${r.replay.assembled}`);
if (r.ms) console.log(`  耗时: ${Object.entries(r.ms).map(([k, v]) => `${k} ${v}ms`).join(' / ')}`);
for (const w of r.warnings) console.log('  ⚠ ' + w);
if (!r.ok) {
  console.log('');
  for (const p of r.problems.slice(0, 10)) console.log('  •', p);
  if (r.problems.length > 10) console.log(`  …还有 ${r.problems.length - 10} 条`);
}
process.exit(r.ok ? 0 : 1);
