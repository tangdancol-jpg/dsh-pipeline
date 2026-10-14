import fs from 'node:fs';
import path from 'node:path';

const ROOT = '<DSH_HOME>\\profiles\\desktop\\.pipeline';
const OUT = path.join(import.meta.dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const KEEP = /^(transition:|handoff:|wake:|clarify:|human:|artifact:|gate:|seat:|roster:|baseline:|record:compile|scope:amend|context:report|rework:|succession)/;
const lines = [];
const w = (s = '') => lines.push(s);

const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
for (const name of dirs) {
  const f = path.join(ROOT, name, 'audit.jsonl');
  w(`\n========== ${name} ==========`);
  if (!fs.existsSync(f)) { w('  (no audit.jsonl)'); continue; }
  const raw = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  w(`  audit entries: ${raw.length}`);
  for (const line of raw) {
    let e; try { e = JSON.parse(line) } catch { continue; }
    const a = String(e.action || '');
    if (!KEEP.test(a)) continue;
    const parts = [String(e.at || e.at_ms || ''), a];
    for (const k of ['from', 'to', 'actor', 'role', 'seat', 'handoff_id', 'kind', 'artifact_version', 'reason', 'note', 'request_id', 'verdict', 'state', 'counts', 'blocked', 'violation', 'rework', 'target', 'event', 'source', 'status', 'decision', 'action2']) {
      if (e[k] !== undefined && e[k] !== null && e[k] !== '') {
        let v = e[k];
        if (typeof v === 'object') v = JSON.stringify(v);
        v = String(v);
        if (v.length > 400) v = v.slice(0, 400) + '…';
        parts.push(`${k}=${v}`);
      }
    }
    // carry any extra informative fields
    for (const [k, v] of Object.entries(e)) {
      if (['at', 'at_ms', 'action', 'agent', 'task_id', 'actor', 'role', 'seat', 'from', 'to', 'handoff_id', 'kind', 'artifact_version', 'reason', 'note', 'request_id', 'verdict', 'state', 'counts', 'blocked', 'violation', 'rework', 'target', 'event', 'source', 'status', 'decision'].includes(k)) continue;
      if (v === undefined || v === null || v === '') continue;
      let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (s.length > 500) s = s.slice(0, 500) + '…';
      parts.push(`${k}=${s}`);
    }
    w('  ' + parts.join(' | '));
  }
}
fs.writeFileSync(path.join(OUT, 'audit.txt'), lines.join('\n'), 'utf8');
console.log('wrote audit.txt', lines.length, 'lines');
