// results.json + REPORT.md writers with token-redaction guarantee.
'use strict';

import fs from 'node:fs';
import path from 'node:path';

export function makeRedactor(secrets) {
  const list = secrets.filter(Boolean);
  return (s) => {
    let out = typeof s === 'string' ? s : JSON.stringify(s);
    for (const sec of list) out = out.split(sec).join('<REDACTED>');
    return out;
  };
}

export class Recorder {
  constructor(outDir, redact) {
    this.outDir = outDir;
    this.redact = redact;
    this.checks = [];
    this.meta = {};
    this.notes = [];
    this.startedAt = new Date().toISOString();
  }

  /**
   * status: 'pass' | 'fail' | 'skip'
   * A scenario fn may return {status, detail, evidence, reason} or throw.
   */
  async run({ id, name, matrix = [], priority = 'P1' }, fn, ctx) {
    const t0 = Date.now();
    let rec = { id, name, matrix, priority, status: 'fail', detail: '', evidence: [], reason: null };
    console.log(`\n=== [${id}] ${name} (${priority}) ===`);
    try {
      const res = (await fn(ctx)) || {};
      rec.status = res.status || 'pass';
      rec.detail = res.detail || '';
      rec.evidence = res.evidence || [];
      rec.reason = res.reason || null;
    } catch (e) {
      rec.status = 'fail';
      rec.detail = String(e && e.message || e);
    }
    rec.durationMs = Date.now() - t0;
    // Defensive redaction of every free-text field before anything is written.
    rec.detail = this.redact(rec.detail);
    rec.reason = rec.reason ? this.redact(rec.reason) : null;
    rec.evidence = rec.evidence.map((p) => path.relative(this.outDir, p) || p);
    console.log(`--- [${id}] ${rec.status.toUpperCase()} (${Math.round(rec.durationMs / 1000)}s) ${rec.detail || rec.reason || ''}`);
    this.checks.push(rec);
    this.writeJson(); // crash-safe: results.json updated after every scenario
    return rec;
  }

  setMeta(patch) {
    this.meta = { ...this.meta, ...patch };
  }

  note(msg) {
    this.notes.push(this.redact(String(msg)));
  }

  summary() {
    const c = { pass: 0, fail: 0, skip: 0 };
    for (const r of this.checks) c[r.status] = (c[r.status] || 0) + 1;
    return { ...c, total: this.checks.length };
  }

  writeJson() {
    const doc = {
      meta: this.meta,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      summary: this.summary(),
      checks: this.checks,
      notes: this.notes,
    };
    fs.writeFileSync(path.join(this.outDir, 'results.json'), this.redact(JSON.stringify(doc, null, 2)));
    return doc;
  }

  writeMarkdown() {
    const doc = this.writeJson();
    const icon = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };
    const lines = [
      `# Plotina Lite Desktop — Electron regression run`,
      ``,
      `- **Target:** \`${this.meta.target}\` (kind: ${this.meta.targetKind})`,
      `- **Started:** ${doc.startedAt} · **Finished:** ${doc.finishedAt}`,
      `- **Verdict:** ${doc.summary.fail === 0 ? 'PASS' : 'FAIL'} — ${doc.summary.pass} pass / ${doc.summary.fail} fail / ${doc.summary.skip} skip of ${doc.summary.total}`,
      `- **Environment:** display ${this.meta.display}, CDP ${this.meta.cdpPort}, feed ${this.meta.feedPort}, node ${this.meta.node}`,
      `- **Scope note:** per QA direction (2026-11-07) Tauri \`.17\` upgrade/migration scenarios (matrix I-06/I-07, A-07, A-08) are deprioritized; this harness covers **clean install + Electron→Electron update paths**.`,
      ``,
      `| ID | Check | Matrix | P | Status | Time | Detail / reason | Evidence |`,
      `|---|---|---|---|---|---|---|---|`,
    ];
    for (const c of doc.checks) {
      lines.push(`| ${c.id} | ${c.name} | ${c.matrix.join(' ') || '—'} | ${c.priority} | ${icon[c.status]} | ${(c.durationMs / 1000).toFixed(0)}s | ${(c.detail || c.reason || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300)} | ${c.evidence.join(', ') || '—'} |`);
    }
    if (doc.notes.length) {
      lines.push('', '## Notes');
      for (const n of doc.notes) lines.push(`- ${n}`);
    }
    lines.push('', `## Evidence root`, `\`${this.outDir}\``, '', '_Token material is never written to this report (redaction enforced in results/report writers)._');
    const md = this.redact(lines.join('\n'));
    fs.writeFileSync(path.join(this.outDir, 'REPORT.md'), md + '\n');
    return md;
  }
}
