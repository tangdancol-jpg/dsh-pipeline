import fs from 'node:fs';
import path from 'node:path';

const ROOT = '<DSH_HOME>\\profiles\\desktop\\.pipeline';
const OUT = path.join(import.meta.dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const lines = [];
const w = (s = '') => lines.push(s);

const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

for (const name of dirs) {
  const dir = path.join(ROOT, name);
  const tj = path.join(dir, 'task.json');
  w(`\n========== ${name} ==========`);
  if (!fs.existsSync(tj)) { w('  (no task.json)'); continue; }
  let j;
  try { j = JSON.parse(fs.readFileSync(tj, 'utf8')); }
  catch (e) { w('  JSON parse error: ' + e.message); continue; }

  const keys = Object.keys(j);
  w(`  top-keys: ${keys.join(', ')}`);
  for (const k of ['state', 'status', 'tier', 'created_at', 'updated_at', 'deliverable_format', 'deadline']) {
    if (j[k] !== undefined) w(`  ${k}: ${JSON.stringify(j[k])}`);
  }
  if (j.requirement) w(`  requirement [len ${j.requirement.length}]:\n----BEGIN REQ----\n${j.requirement}\n----END REQ----`);
  if (j.constraints?.length) w(`  constraints:\n` + j.constraints.map(c => '    - ' + c).join('\n'));
  if (j.acceptance_from_user?.length) w(`  acceptance_from_user:\n` + j.acceptance_from_user.map(c => '    - ' + c).join('\n'));
  if (j.artifact_version_counter !== undefined) w(`  artifact_version_counter: ${j.artifact_version_counter}`);
  if (j.rework) w(`  rework: ${JSON.stringify(j.rework)}`);
  if (j.writers) w(`  writers: ${JSON.stringify(j.writers)}`);
  if (j.roster) w(`  roster: ${JSON.stringify(j.roster)}`);
  if (j.change_scope) w(`  change_scope: ${JSON.stringify(j.change_scope, null, 1)}`);
  if (j.forbidden) w(`  forbidden:\n` + j.forbidden.map(c => '    - ' + c).join('\n'));
  if (j.role_boundaries) w(`  role_boundaries: ${JSON.stringify(j.role_boundaries)}`);
  if (j.relay_policy) w(`  relay_policy: ${JSON.stringify(j.relay_policy)}`);
  if (j.plan_reason) w(`  plan_reason: ${j.plan_reason}`);
  if (j.based_on_analysis) w(`  based_on_analysis: ${j.based_on_analysis}`);

  w(`  handoffs(${j.handoffs?.length ?? 0}):`);
  for (const h of (j.handoffs ?? [])) {
    w(`    ${h.handoff_id} ${h.kind} ${h.from_role}->${h.to_role} @${h.created_at} av=${h.artifact_version}`);
  }
  w(`  artifacts(${j.artifacts?.length ?? 0}): ` + (j.artifacts ?? []).map(a => JSON.stringify(a)).join(' | '));
  w(`  dispatched(${j.dispatched?.length ?? 0}):`);
  for (const d of (j.dispatched ?? [])) w(`    ${JSON.stringify(d)}`);
  w(`  clarification_requests(${j.clarification_requests?.length ?? 0}):`);
  for (const c of (j.clarification_requests ?? [])) {
    w(`    ${c.request_id} from=${c.from_role} seat=${c.seat} status=${c.status} verdict=${c.verdict ?? ''} q=${(c.question || '').slice(0, 200)}`);
  }
  w(`  human_requests(${j.human_requests?.length ?? 0}):`);
  for (const c of (j.human_requests ?? [])) {
    w(`    ${c.request_id} from=${c.from_role} status=${c.status} q=${(c.question_for_human || '').slice(0, 300)}`);
    if (c.answer?.user_quote) w(`      user_quote: ${String(c.answer.user_quote).slice(0, 1500)}`);
  }
  w(`  records(${j.records?.length ?? 0}): ` + (j.records ?? []).map(r => `${r.role}/${r.seat ?? '-'}@${r.at}`).join(', '));
  w(`  close_report: ${JSON.stringify(j.close_report)}`);
  w(`  liveness: ${JSON.stringify(j.liveness)}`);
  w(`  hash_gate: ${JSON.stringify(j.hash_gate)} streak=${j.hash_gate_streak}`);
  w(`  contacts: ${JSON.stringify(j.contacts)}`);
  w(`  successions: ${JSON.stringify(j.successions)}`);
  w(`  amendments: ${JSON.stringify(j.amendments)}`);
  w(`  roster_requests: ${JSON.stringify(j.roster_requests)}`);
  w(`  context_reports: ${JSON.stringify(j.context_reports)}`);
  w(`  writer_submissions: ${JSON.stringify(j.writer_submissions)}`);
  w(`  full_test_approvals: ${JSON.stringify(j.full_test_approvals)}`);
  w(`  task_card: ${JSON.stringify(j.task_card)}`);
  if (j.analysis || j.requirement_analysis) w(`  analysis: ${JSON.stringify(j.analysis || j.requirement_analysis).slice(0, 3000)}`);

  // full history actions
  const hist = j.history ?? [];
  w(`  history(${hist.length}) actions:`);
  const counts = {};
  for (const h of hist) counts[h.action] = (counts[h.action] || 0) + 1;
  w('    ' + JSON.stringify(counts));
}

fs.writeFileSync(path.join(OUT, 'tasks.txt'), lines.join('\n'), 'utf8');
console.log('wrote tasks.txt', lines.length, 'lines');
