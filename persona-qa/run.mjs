#!/usr/bin/env node
// AI 가상 고객 테스트단 실행기.
// 페르소나 × 목표 조합마다 Claude Code(claude -p)를 한 번씩 실행하고,
// Playwright MCP로 브라우저를 조작하게 한 뒤 결과(JSON)와 녹화 영상을 results/<runId>/ 에 모은다.
//
//   node run.mjs                       # 모든 페르소나 × 모든 목표, 1회씩
//   node run.mjs --persona elder,busy  # 일부 페르소나만
//   node run.mjs --repeat 3            # 조합마다 3회 (성공률 측정용)
//   node run.mjs --url https://stg.example.com --goals goals.live.json   # 데모 쇼핑몰 대신 실제 사이트
//   node run.mjs --headed              # 브라우저 창을 띄워서 실행 (내 PC에서 지켜볼 때)
//
// 인증: claude CLI의 로그인 상태를 그대로 쓴다.
// Enterprise 계정 토큰(CLAUDE_CODE_OAUTH_TOKEN) 또는 ANTHROPIC_API_KEY / Bedrock 환경변수 중 무엇이든 동작한다.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync, createWriteStream } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const personas = JSON.parse(readFileSync(join(ROOT, 'personas.json'), 'utf8')).filter((p) => !args.persona || args.persona.split(',').includes(p.id));
const goals = JSON.parse(readFileSync(resolve(ROOT, args.goals || 'goals.json'), 'utf8')).filter((g) => !args.goal || args.goal.split(',').includes(g.id));
const repeat = Number(args.repeat || 1);
const concurrency = Number(args.parallel || 1);
const timeoutMin = Number(args.timeout || 15);
const browserPath = args.browser || process.env.PERSONA_QA_BROWSER || defaultBrowser();
const mcpCli = join(ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js');

const RESULT_SCHEMA = {
  type: 'object',
  required: ['outcome', 'actions_used', 'journey', 'issues', 'quote'],
  properties: {
    outcome: { type: 'string', enum: ['success', 'gave_up', 'blocked'] },
    order_no: { type: ['string', 'null'] },
    paid_amount: { type: ['number', 'null'] },
    actions_used: { type: 'integer' },
    journey: {
      type: 'array',
      items: {
        type: 'object',
        required: ['step', 'page', 'action', 'thought', 'frustration'],
        properties: {
          step: { type: 'integer' },
          page: { type: 'string' },
          action: { type: 'string' },
          thought: { type: 'string' },
          frustration: { type: 'integer', minimum: 0, maximum: 5 },
        },
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'location', 'problem', 'suggestion'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          location: { type: 'string' },
          problem: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
    quote: { type: 'string' },
  },
};

main().catch((e) => { console.error(e); process.exit(1); });

async function main() {
  if (!personas.length || !goals.length) throw new Error('실행할 페르소나나 목표가 없습니다. --persona / --goal 값을 확인하세요.');
  const server = args.url ? null : await serveShop(Number(args.port || 4173));
  const startUrl = args.url || `http://localhost:${server.address().port}/index.html`;
  // 웹 서버(server.mjs)는 결과 폴더 이름을 직접 정해서 넘긴다.
  const runId = args['run-id'] || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = join(ROOT, 'results', runId);
  mkdirSync(runDir, { recursive: true });

  const jobs = [];
  for (const g of goals) for (const p of personas) for (let i = 1; i <= repeat; i++) jobs.push({ persona: p, goal: g, n: i });
  console.log(`▶ ${jobs.length}개 실행 (페르소나 ${personas.length} × 목표 ${goals.length} × ${repeat}회), 대상: ${startUrl}`);

  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      results.push(await runOne(job, startUrl, runDir));
    }
  }));

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify({ runId, startUrl, personas, goals, results }, null, 2));
  server?.close();
  console.log(`\n✔ 완료: ${join('results', runId)}`);
  console.log(`  리포트 만들기: node report.mjs results/${runId}`);
}

async function runOne({ persona, goal, n }, startUrl, runDir) {
  const id = `${persona.id}__${goal.id}__${n}`;
  const dir = join(runDir, id);
  const videoDir = join(dir, 'video');
  mkdirSync(videoDir, { recursive: true });
  const started = Date.now();
  console.log(`  · ${persona.name} / ${goal.title} #${n} 시작`);

  const mobile = persona.device === 'mobile';
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const pwConfig = {
    browser: {
      browserName: 'chromium',
      isolated: true,
      launchOptions: { headless: !args.headed, ...(browserPath ? { executablePath: browserPath } : {}) },
      contextOptions: {
        viewport,
        locale: 'ko-KR',
        ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
        recordVideo: { dir: videoDir, size: viewport },
      },
    },
    outputDir: join(dir, 'artifacts'),
    imageResponses: persona.vision ? 'allow' : 'omit',
  };
  writeFileSync(join(dir, 'playwright.json'), JSON.stringify(pwConfig, null, 2));
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
    mcpServers: { playwright: { command: process.execPath, args: [mcpCli, '--config', join(dir, 'playwright.json')] } },
  }, null, 2));

  // 페르소나가 쓸 수 없는 도구는 막는다. 화면을 못 보는 페르소나는 스크린샷도 금지.
  const blocked = [
    'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit', 'TodoWrite',
    'mcp__playwright__browser_evaluate', 'mcp__playwright__browser_run_code', 'mcp__playwright__browser_file_upload',
    'mcp__playwright__browser_install', 'mcp__playwright__browser_network_requests',
    ...(persona.vision ? [] : ['mcp__playwright__browser_take_screenshot']),
  ];

  const cliArgs = [
    '-p', buildPrompt(persona, goal, startUrl, Boolean(args.url)),
    '--mcp-config', join(dir, 'mcp.json'), '--strict-mcp-config',
    '--allowedTools', 'mcp__playwright',
    '--disallowedTools', ...blocked,
    '--json-schema', JSON.stringify(RESULT_SCHEMA),
    '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence',
    ...(args.model ? ['--model', args.model] : []),
  ];

  // 실행 폴더를 git 저장소 밖 임시 폴더로 두어 프로젝트 설정/훅의 영향을 받지 않게 한다.
  const cwd = mkdtempSync(join(tmpdir(), 'persona-qa-'));
  const transcript = createWriteStream(join(dir, 'transcript.jsonl'));
  const final = await new Promise((resolve) => {
    const child = spawn('claude', cliArgs, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', last = null, toolCalls = 0, stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMin * 60_000);
    child.stdout.on('data', (d) => {
      transcript.write(d);
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'assistant') toolCalls += (ev.message?.content || []).filter((c) => c.type === 'tool_use').length;
          if (ev.type === 'result') last = ev;
        } catch { /* 부분 줄 */ }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); transcript.end(); resolve({ code, last, toolCalls, stderr }); });
  });

  let result = final.last?.structured_output ?? tryParseJson(final.last?.result);
  if (!result) {
    result = { outcome: 'blocked', actions_used: final.toolCalls, journey: [], issues: [], quote: '', error: (final.last?.result || final.stderr || `exit ${final.code}`).slice(0, 2000) };
  }

  // 녹화 영상은 브라우저가 닫힐 때 임의 이름으로 저장되므로 이름을 정리한다.
  const videos = existsSync(videoDir) ? readdirSync(videoDir).filter((f) => f.endsWith('.webm')) : [];
  const video = videos.length ? join(id, 'video', 'session.webm') : null;
  if (videos.length) renameSync(join(videoDir, videos[0]), join(videoDir, 'session.webm'));

  const record = {
    id, persona: persona.id, personaName: persona.name, goal: goal.id, goalTitle: goal.title, n,
    seconds: Math.round((Date.now() - started) / 1000),
    toolCalls: final.toolCalls,
    costUsd: final.last?.total_cost_usd ?? null,
    video,
    ...result,
  };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(record, null, 2));
  const mark = { success: '성공', gave_up: '포기', blocked: '진행불가' }[record.outcome] || record.outcome;
  console.log(`  · ${persona.name} / ${goal.title} #${n} → ${mark} (${record.seconds}s, 행동 ${record.actions_used}회, 이슈 ${record.issues.length}건)`);
  return record;
}

function buildPrompt(persona, goal, startUrl, live) {
  const profile = Object.entries(goal.profile || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  // 실제 운영 사이트에서는 실제 주문·가입·개인정보 입력이 일어나지 않도록 막는다.
  const liveRules = live ? `
## 실제 운영 사이트 안전 규칙 (페르소나 규칙보다 우선)
- 로그인, 회원가입, 본인인증, 결제, 주문 확정을 절대 하지 않는다. 그런 화면이 나오면 거기서 멈추고, 그 지점까지를 결과로 기록한다.
- 이름, 전화번호, 주소, 카드번호 등 어떤 개인정보도 입력하지 않는다.
- 리뷰 작성, 문의 등록, 알림 신청처럼 사이트에 기록을 남기는 행동은 하지 않는다.
` : '';
  return `너는 지금부터 쇼핑몰 사용성 테스트에 참여한 가상 고객이다. 아래 인물이 되어 실제로 브라우저를 조작한다.

## 너는 누구인가
${persona.name}
${persona.summary}

## 반드시 지킬 행동 규칙
${persona.rules.map((r) => `- ${r}`).join('\n')}
- 행동(클릭, 입력, 선택, 스크롤, 뒤로가기 등 브라우저 조작)은 최대 ${persona.maxActions}번까지만 한다. 넘으면 그 자리에서 포기한다.
- 이 인물이 현실에서 할 수 없는 방법은 쓰지 않는다. 페이지 소스를 읽거나, 자바스크립트를 실행하거나, 주소창에 URL을 추측해서 입력하지 않는다.
- browser_navigate 는 처음 시작 주소(${startUrl})를 여는 데에만 쓴다.
- 이 인물이 이해하지 못했을 것들을 네가 대신 이해해서 진행하지 마라. 이 테스트의 목적은 이 인물이 어디서 막히는지 찾는 것이다.

## 목표
${goal.goal}
${goal.success ? `\n성공 기준: ${goal.success}\n` : ''}${liveRules}
${profile ? `필요하면 아래 정보를 사용한다.\n${profile}` : ''}

## 진행 방법
1. ${startUrl} 를 연다.
2. 매 행동마다 이 인물의 입장에서 무엇을 보고 무엇을 생각했는지 기억해 둔다.
3. 목표를 달성하거나, 포기하거나, 더 이상 진행할 수 없으면 멈춘다.
4. 마지막에 결과를 지정된 JSON 형식으로 답한다.
   - outcome: success(목표 달성) / gave_up(인물이 포기) / blocked(기술적으로 진행 불가)
   - journey: 행동 단계별 기록. thought는 이 인물의 속마음 말투로, frustration은 0(편함)~5(화남).
   - issues: 이 인물이 겪은 사용성 문제. location은 화면/요소, problem은 무엇이 문제였는지, suggestion은 개선안.
   - quote: 테스트를 마친 이 인물의 한마디.
`;
}

function serveShop(port) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  const root = join(ROOT, 'shop');
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(root, path === '/' ? 'index.html' : path);
    if (!file.startsWith(root) || !existsSync(file) || file.endsWith('.md')) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function defaultBrowser() {
  // 클라우드 세션 등 Playwright 브라우저가 미리 설치된 환경이면 그 경로를 쓴다.
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return null;
  const dir = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  const exe = dir && join(base, dir, 'chrome-linux', 'chrome');
  return exe && existsSync(exe) ? exe : null;
}

function tryParseJson(text) {
  if (!text) return null;
  const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  try { return JSON.parse(m ? m[1] : text); } catch { return null; }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}
