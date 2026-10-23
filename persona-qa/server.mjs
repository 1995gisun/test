#!/usr/bin/env node
// 웹 화면 서버. 사용자가 URL·페르소나·목표를 넣으면 run.mjs → report.mjs 를 차례로 실행하고 리포트를 보여준다.
//
//   node server.mjs                        # http://localhost:3000
//   ACCESS_CODE=비밀번호 node server.mjs    # 실행할 때 접속 코드를 요구 (외부 공개 시 필수)
//
// 환경변수
//   PORT          서버 포트 (기본 3000, Render가 자동 지정)
//   ACCESS_CODE   설정하면 테스트 실행에 이 코드가 필요
//   MAX_PARALLEL  한 테스트 안에서 동시에 도는 페르소나 수 (기본 2)
//   DAILY_LIMIT   하루 최대 테스트 횟수 (기본 20, UTC 기준)
//   + claude CLI 인증 (ANTHROPIC_API_KEY 등), PERSONA_QA_BROWSER
//
// 테스트는 한 번에 하나씩 순서대로 실행한다. 나머지는 대기열에서 기다린다.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { join, dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(ROOT, 'results');
const PORT = Number(process.env.PORT || 3000);
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL || 2);
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 20);
const MAX_QUEUE = 5;

const personas = JSON.parse(readFileSync(join(ROOT, 'personas.json'), 'utf8'));
const demoGoal = JSON.parse(readFileSync(join(ROOT, 'goals.json'), 'utf8'))[0];
const jobs = new Map();
const queue = [];
let busy = false;
let daily = { day: '', count: 0 };

createServer((req, res) => handle(req, res).catch((e) => {
  console.error(e);
  if (!res.headersSent) json(res, 500, { error: '서버 오류가 발생했습니다.' });
})).listen(PORT, () => {
  console.log(`▶ http://localhost:${PORT}${ACCESS_CODE ? '' : '  (ACCESS_CODE 없음: 누구나 실행 가능)'}`);
});

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://x');
  if (req.method === 'GET' && pathname === '/') return sendFile(req, res, join(ROOT, 'web', 'index.html'));
  if (req.method === 'GET' && pathname === '/api/config') {
    return json(res, 200, {
      needCode: Boolean(ACCESS_CODE),
      personas: personas.map(({ id, name, summary, device, vision }) => ({ id, name, summary, device, vision })),
      demoGoal: demoGoal.goal,
    });
  }
  if (req.method === 'POST' && pathname === '/api/runs') return createRun(req, res);
  let m = pathname.match(/^\/api\/runs\/([\w-]+)$/);
  if (req.method === 'GET' && m) return runStatus(res, m[1]);
  m = pathname.match(/^\/results\/([\w-]+)\/(.+)$/);
  if (req.method === 'GET' && m) {
    // 리포트와 녹화 영상만 내보낸다. 대화 기록(transcript)이나 설정 파일은 공개하지 않는다.
    const file = resolve(RESULTS, m[1], decodeURIComponent(m[2]));
    if (file.startsWith(join(RESULTS, m[1]) + sep) && ['.html', '.webm'].includes(extname(file)) && existsSync(file)) return sendFile(req, res, file);
  }
  json(res, 404, { error: '찾을 수 없습니다.' });
}

async function createRun(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: '요청 형식이 올바르지 않습니다.' }); }
  if (ACCESS_CODE && !sameText(String(body.code || ''), ACCESS_CODE)) return json(res, 403, { error: '접속 코드가 맞지 않습니다.' });

  const ids = (Array.isArray(body.personas) ? body.personas : []).filter((id) => personas.some((p) => p.id === id));
  if (!ids.length) return json(res, 400, { error: '페르소나를 한 명 이상 고르세요.' });
  const goal = String(body.goal || '').trim().slice(0, 1000);
  let url = String(body.url || '').trim();
  if (url) {
    try { url = await checkUrl(url); } catch (e) { return json(res, 400, { error: e.message }); }
    if (!goal) return json(res, 400, { error: '실제 사이트를 테스트할 때는 목표를 적어야 합니다.' });
  }

  const today = new Date().toISOString().slice(0, 10);
  if (daily.day !== today) daily = { day: today, count: 0 };
  if (daily.count >= DAILY_LIMIT) return json(res, 429, { error: '오늘 실행 가능한 횟수를 모두 썼습니다. 내일 다시 시도하세요.' });
  if (queue.length >= MAX_QUEUE) return json(res, 429, { error: '대기 중인 테스트가 많습니다. 잠시 후 다시 시도하세요.' });
  daily.count++;

  // 결과 주소를 추측할 수 없도록 실행 시각 뒤에 임의 문자열을 붙인다.
  const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomBytes(4).toString('hex')}`;
  const job = { id, url, goal, personas: ids, status: 'queued', log: '', created: Date.now() };
  jobs.set(id, job);
  queue.push(job);
  pump();
  json(res, 201, { id });
}

function runStatus(res, id) {
  const job = jobs.get(id);
  if (!job) {
    // 서버가 재시작되어 메모리에 없으면 결과 폴더로 판단한다.
    if (existsSync(join(RESULTS, id, 'report.html'))) return json(res, 200, { status: 'done', report: `/results/${id}/report.html` });
    return json(res, 404, { error: '해당 테스트를 찾을 수 없습니다.' });
  }
  json(res, 200, {
    status: job.status,
    position: job.status === 'queued' ? queue.indexOf(job) + 1 : 0,
    personas: job.personas.length,
    url: job.url || null,
    log: job.log.slice(-4000),
    report: job.status === 'done' ? `/results/${id}/report.html` : null,
  });
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  try { await runJob(job); } catch (e) { job.status = 'failed'; job.log += `\n${e.message}`; }
  busy = false;
  pump();
}

async function runJob(job) {
  job.status = 'running';
  const dir = join(RESULTS, job.id);
  mkdirSync(dir, { recursive: true });
  const runArgs = ['run.mjs', '--run-id', job.id, '--persona', job.personas.join(','), '--parallel', String(MAX_PARALLEL)];
  if (job.goal) {
    const goalsFile = join(dir, 'goals.input.json');
    writeFileSync(goalsFile, JSON.stringify([{
      id: 'custom', title: job.goal.slice(0, 40), goal: job.goal,
      // 데모 쇼핑몰은 주문까지 가야 하므로 주문 정보를 준다. 실제 사이트는 안전 규칙상 개인정보를 입력하지 않는다.
      ...(job.url ? {} : { profile: demoGoal.profile }),
    }], null, 2));
    runArgs.push('--goals', goalsFile);
  }
  if (job.url) runArgs.push('--url', job.url);
  const code = await exec(job, runArgs);
  if (code !== 0 || !existsSync(join(dir, 'summary.json'))) { job.status = 'failed'; return; }

  job.status = 'reporting';
  await exec(job, ['report.mjs', dir, ...(job.url ? [] : ['--traps', join(ROOT, 'shop', 'TRAPS.md')])]);
  job.status = existsSync(join(dir, 'report.html')) ? 'done' : 'failed';
}

function exec(job, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (d) => { job.log = (job.log + d).slice(-20000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('close', done);
  });
}

// 외부 사용자가 서버 내부망(localhost, 사설 IP)을 브라우저로 열어보지 못하게 막는다.
async function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('주소 형식이 올바르지 않습니다. https:// 로 시작하는 전체 주소를 넣으세요.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('http 또는 https 주소만 테스트할 수 있습니다.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try { addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address); } catch { throw new Error('주소를 찾을 수 없습니다.'); }
  if (addrs.some(isPrivate)) throw new Error('내부망 주소는 테스트할 수 없습니다.');
  return u.href;
}

function isPrivate(ip) {
  if (ip.includes(':')) {
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return isPrivate(x.slice(7));
    return x === '::1' || x === '::' || /^f[cd]/.test(x) || x.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function sameText(a, b) {
  const h = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

function readBody(req) {
  return new Promise((done, fail) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 20000) req.destroy(); });
    req.on('end', () => done(s));
    req.on('error', fail);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// 영상 탐색(seek)이 되도록 Range 요청을 지원한다.
function sendFile(req, res, file) {
  const type = { '.html': 'text/html; charset=utf-8', '.webm': 'video/webm' }[extname(file)] || 'application/octet-stream';
  const size = statSync(file).size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
  createReadStream(file).pipe(res);
}
