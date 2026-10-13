#!/usr/bin/env node
// 실행 결과(results/<runId>)를 모아 report.html 을 만든다.
//
//   node report.mjs results/<runId>                      # AI가 페르소나별 이슈를 묶어 우선순위를 매긴다
//   node report.mjs results/<runId> --traps shop/TRAPS.md  # 데모용: 심어 둔 함정을 몇 개 찾았는지 대조
//   node report.mjs results/<runId> --no-ai               # AI 정리 없이 원본 이슈만

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const runDir = resolve(argv.find((a) => !a.startsWith('--')) || '');
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
if (!existsSync(join(runDir, 'summary.json'))) { console.error('사용법: node report.mjs results/<runId> [--traps shop/TRAPS.md] [--no-ai]'); process.exit(1); }

const summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
const traps = flag('traps') ? readFileSync(resolve(flag('traps')), 'utf8') : null;
const analysis = flag('no-ai') ? fallbackAnalysis(summary) : (aiAnalysis(summary, traps) || fallbackAnalysis(summary));
writeFileSync(join(runDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
writeFileSync(join(runDir, 'report.html'), render(summary, analysis, traps));
console.log(`✔ ${join(runDir, 'report.html')}`);

function aiAnalysis(summary, traps) {
  const schema = {
    type: 'object',
    required: ['headline', 'findings'],
    properties: {
      headline: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'severity', 'location', 'personas', 'evidence', 'suggestion'],
          properties: {
            title: { type: 'string' },
            severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
            location: { type: 'string' },
            personas: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'string' },
            suggestion: { type: 'string' },
            trap_id: { type: ['string', 'null'] },
          },
        },
      },
    },
  };
  const input = summary.results.map((r) => ({
    persona: r.persona, personaName: r.personaName, goal: r.goalTitle, outcome: r.outcome,
    issues: r.issues, worst_moments: (r.journey || []).filter((j) => j.frustration >= 3), quote: r.quote,
  }));
  const prompt = `아래는 여러 가상 고객(페르소나)이 같은 쇼핑몰을 사용해 본 결과다. QA 리드 입장에서 정리해라.

1. 같은 원인의 이슈는 하나로 묶고, 어떤 페르소나들이 겪었는지 personas 에 페르소나 id 를 모두 적는다.
2. severity 는 목표 달성을 막았으면 critical, 크게 헤매게 했으면 major, 불편 정도면 minor.
3. evidence 에는 페르소나의 실제 속마음이나 행동을 짧게 인용한다.
4. 심각도 높은 순, 영향받은 페르소나 많은 순으로 정렬한다.
5. headline 은 이번 테스트 결과를 한 문장으로 요약한다.
${traps ? `6. 아래 '함정 목록'과 같은 문제면 trap_id 에 그 ID(T1 등)를 적고, 해당 없으면 null.\n\n## 함정 목록\n${traps}\n` : '6. trap_id 는 null.\n'}
## 테스트 결과
${JSON.stringify(input, null, 1)}`;
  console.log('… AI가 이슈를 정리하는 중');
  const out = spawnSync('claude', ['-p', prompt, '--json-schema', JSON.stringify(schema), '--output-format', 'json', '--tools', '', '--no-session-persistence'], {
    cwd: mkdtempSync(join(tmpdir(), 'persona-qa-report-')), encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 10 * 60_000,
  });
  try {
    const res = JSON.parse(out.stdout);
    return res.structured_output || JSON.parse(res.result);
  } catch {
    console.warn('AI 정리에 실패해서 원본 이슈로 리포트를 만듭니다.', (out.stderr || '').slice(0, 500));
    return null;
  }
}

function fallbackAnalysis(summary) {
  const order = { critical: 0, major: 1, minor: 2 };
  const findings = summary.results.flatMap((r) => (r.issues || []).map((i) => ({
    title: i.problem.slice(0, 60), severity: i.severity, location: i.location, personas: [r.persona], evidence: i.problem, suggestion: i.suggestion, trap_id: null,
  }))).sort((a, b) => order[a.severity] - order[b.severity]);
  const ok = summary.results.filter((r) => r.outcome === 'success').length;
  return { headline: `${summary.results.length}회 중 ${ok}회 목표 달성`, findings };
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function render(summary, analysis, traps) {
  const { results, personas, goals } = summary;
  const pName = Object.fromEntries(personas.map((p) => [p.id, p.name]));
  const short = (id) => (pName[id] || id).split(' (')[0];
  const outcomeLabel = { success: '성공', gave_up: '포기', blocked: '진행불가' };
  const sevLabel = { critical: '치명', major: '주요', minor: '경미' };
  const ok = results.filter((r) => r.outcome === 'success').length;
  const totalIssues = analysis.findings.length;
  const critical = analysis.findings.filter((f) => f.severity === 'critical').length;
  const minutes = Math.round(results.reduce((s, r) => s + (r.seconds || 0), 0) / 60);

  const trapRows = traps ? [...traps.matchAll(/^\|\s*(T\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|/gm)].map((m) => ({ id: m[1], where: m[2].trim(), what: m[3].trim() })) : [];
  const found = new Set(analysis.findings.map((f) => f.trap_id).filter(Boolean));

  const matrix = goals.map((g) => `
    <tr><th scope="row">${esc(g.title)}</th>${personas.map((p) => {
      const rs = results.filter((r) => r.goal === g.id && r.persona === p.id);
      if (!rs.length) return '<td>—</td>';
      const s = rs.filter((r) => r.outcome === 'success').length;
      const cls = s === rs.length ? 'good' : s === 0 ? 'bad' : 'warn';
      const peak = Math.max(0, ...rs.flatMap((r) => (r.journey || []).map((j) => j.frustration)));
      return `<td><span class="pill ${cls}">${rs.length > 1 ? `${s}/${rs.length} 성공` : outcomeLabel[rs[0].outcome]}</span><div class="sub">행동 ${Math.round(rs.reduce((a, r) => a + r.actions_used, 0) / rs.length)}회 · 최대 짜증 ${peak}/5</div></td>`;
    }).join('')}</tr>`).join('');

  const findings = analysis.findings.map((f) => `
    <li class="finding sev-${f.severity}">
      <div class="f-head"><span class="sev">${sevLabel[f.severity]}</span><h3>${esc(f.title)}</h3>${f.trap_id ? `<span class="trap">${esc(f.trap_id)}</span>` : ''}</div>
      <div class="f-loc">${esc(f.location)}</div>
      <blockquote>${esc(f.evidence)}</blockquote>
      <div class="f-foot"><span class="who">${f.personas.map((id) => `<span class="chip">${esc(short(id))}</span>`).join('')}</span><span class="fix">개선안: ${esc(f.suggestion)}</span></div>
    </li>`).join('');

  const runs = results.map((r) => `
    <details class="run" ${r.outcome !== 'success' ? 'open' : ''}>
      <summary><span class="pill ${r.outcome === 'success' ? 'good' : 'bad'}">${outcomeLabel[r.outcome] || esc(r.outcome)}</span><b>${esc(r.personaName)}</b><span class="muted">${esc(r.goalTitle)}${r.n > 1 ? ` #${r.n}` : ''} · ${r.seconds}초 · 행동 ${r.actions_used}회</span></summary>
      <div class="run-body">
        <div class="journey">
          ${(r.journey || []).map((j) => `
            <div class="step">
              <span class="no">${j.step}</span>
              <div class="s-main"><div class="s-act"><span class="page">${esc(j.page)}</span>${esc(j.action)}</div><div class="s-thought">“${esc(j.thought)}”</div></div>
              <span class="meter" title="짜증 ${j.frustration}/5" aria-label="짜증 ${j.frustration}/5">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= j.frustration ? 'on' : ''} l${j.frustration}"></i>`).join('')}</span>
            </div>`).join('')}
          ${r.error ? `<p class="err">실행 오류: ${esc(r.error)}</p>` : ''}
          ${r.quote ? `<p class="quote">“${esc(r.quote)}”</p>` : ''}
        </div>
        ${r.video ? `<video controls preload="metadata" src="${esc(r.video)}"></video>` : ''}
      </div>
    </details>`).join('');

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>가상 고객 테스트 리포트</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;700&family=IBM+Plex+Mono:wght@500&display=swap">
<style>
/* Layout: 요약 → 매트릭스 → 우선순위 이슈 → 페르소나별 여정(영상) 순으로 내려가는 QA 리포트 */
:root{--bg:#f5f6f4;--surface:#fff;--fg:#1d2321;--muted:#5f6a66;--line:#dfe3e0;--accent:#0f7a63;--good:#1f8a4c;--warn:#b7791f;--bad:#c2410c;--font:"IBM Plex Sans KR","Malgun Gothic",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121615;--surface:#1a201e;--fg:#e4e9e6;--muted:#97a39e;--line:#2b3431;--accent:#4cc9a6;--good:#5ccf8a;--warn:#e3ab55;--bad:#f2865a;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#121615;--surface:#1a201e;--fg:#e4e9e6;--muted:#97a39e;--line:#2b3431;--accent:#4cc9a6;--good:#5ccf8a;--warn:#e3ab55;--bad:#f2865a;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--font);line-height:1.6;padding-inline:16px;padding-block:0 64px}
.wrap{max-width:1040px;margin:0 auto;display:flex;flex-direction:column;gap:40px}
header{padding-block:40px 0;display:flex;flex-direction:column;gap:10px}
.eyebrow{font-size:13px;letter-spacing:.06em;color:var(--accent);font-weight:500}
h1{margin:0;font-size:clamp(24px,4vw,32px);text-wrap:balance}h2{margin:0 0 14px;font-size:19px}h3{margin:0;font-size:16px}
.muted{color:var(--muted)}.sub{font-size:12px;color:var(--muted);margin-top:4px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px 16px}.kpi b{display:block;font-size:26px;font-variant-numeric:tabular-nums}.kpi span{font-size:13px;color:var(--muted)}
.table-wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;min-width:560px}th,td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:14px}thead th{font-size:13px;color:var(--muted);font-weight:500}tr:last-child>*{border-bottom:0}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:1px 9px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}.pill.good{color:var(--good)}.pill.warn{color:var(--warn)}.pill.bad{color:var(--bad)}
ol.findings{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.finding{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--muted);border-radius:6px;padding:14px 16px;display:flex;flex-direction:column;gap:6px}
.sev-critical{border-left-color:var(--bad)}.sev-major{border-left-color:var(--warn)}
.f-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.sev{font-size:12px;font-weight:700;color:var(--muted)}.sev-critical .sev{color:var(--bad)}.sev-major .sev{color:var(--warn)}
.trap{font-family:var(--mono);font-size:12px;color:var(--accent);margin-left:auto}
.f-loc{font-size:13px;color:var(--muted)}blockquote{margin:0;padding-left:10px;border-left:2px solid var(--line);font-size:14px}
.f-foot{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:13px;align-items:center}.who{display:flex;gap:4px;flex-wrap:wrap}.chip{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:0 6px}.fix{color:var(--muted);min-width:0}
.run{background:var(--surface);border:1px solid var(--line);border-radius:8px;margin-bottom:10px}
.run summary{cursor:pointer;padding:12px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.run summary:focus-visible{outline:2px solid var(--accent)}
.run-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:16px;padding:0 16px 16px}
@media (max-width:820px){.run-body{grid-template-columns:1fr}}
video{width:100%;border-radius:6px;border:1px solid var(--line);background:#000;max-height:520px}
.journey{display:flex;flex-direction:column;gap:8px;min-width:0}
.step{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:10px;align-items:start}
.no{font-family:var(--mono);font-size:12px;color:var(--muted);padding-top:2px}
.page{font-size:11px;border:1px solid var(--line);border-radius:4px;padding:0 5px;margin-right:6px;color:var(--muted)}
.s-act{font-size:14px}.s-thought{font-size:13px;color:var(--muted)}
.meter{display:flex;gap:2px;padding-top:6px}.meter i{width:6px;height:10px;border-radius:1px;background:var(--line)}.meter i.on{background:var(--warn)}.meter i.on.l4,.meter i.on.l5{background:var(--bad)}
.quote{margin:8px 0 0;font-weight:500}.err{color:var(--bad);font-size:13px}
.traps td.hit{color:var(--good);font-weight:700}.traps td.miss{color:var(--muted)}
</style></head><body><div class="wrap">
<header>
  <div class="eyebrow">AI 가상 고객 테스트단 · ${esc(summary.runId)}</div>
  <h1>${esc(analysis.headline)}</h1>
  <div class="muted">대상 ${esc(summary.startUrl)} · 페르소나 ${personas.length}명 × 목표 ${goals.length}개</div>
</header>
<section class="kpis">
  <div class="kpi"><b>${ok}/${results.length}</b><span>목표 달성</span></div>
  <div class="kpi"><b>${totalIssues}</b><span>발견한 문제</span></div>
  <div class="kpi"><b>${critical}</b><span>치명 (구매 실패 원인)</span></div>
  ${traps ? `<div class="kpi"><b>${found.size}/${trapRows.length}</b><span>심어 둔 함정 탐지</span></div>` : `<div class="kpi"><b>${minutes}분</b><span>총 테스트 시간</span></div>`}
</section>
<section><h2>페르소나별 결과</h2><div class="table-wrap"><table>
  <thead><tr><th>목표</th>${personas.map((p) => `<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>${matrix}</tbody></table></div></section>
<section><h2>우선 고쳐야 할 문제</h2><ol class="findings">${findings}</ol></section>
${traps ? `<section><h2>함정 탐지 대조 (데모용 정답지)</h2><div class="table-wrap"><table class="traps"><thead><tr><th>ID</th><th>위치</th><th>함정</th><th>탐지</th></tr></thead><tbody>
${trapRows.map((t) => `<tr><td>${t.id}</td><td>${esc(t.where)}</td><td>${esc(t.what)}</td><td class="${found.has(t.id) ? 'hit">탐지' : 'miss">미탐지'}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
<section><h2>페르소나별 여정과 녹화</h2>${runs}</section>
</div></body></html>`;
}
