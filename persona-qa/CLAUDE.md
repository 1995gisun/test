# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

persona-qa ("AI 가상 고객 테스트단") is a usability-testing tool. AI personas drive a real browser through a shopping site toward a goal (e.g. "buy water and apply coupon WELCOME3000"), and the tool reports where each persona got stuck. There are no scripted test steps; only personas × goals. The README, code comments, prompts and report UI are all in Korean, so keep new user-facing strings and comments in Korean too.

## Commands

There is no build, lint, or test suite. Plain Node ESM (`"type": "module"`, Node 18+). The only dependency is `@playwright/mcp`, pinned to an exact version.

```bash
npm install
node run.mjs --parallel 2                          # demo shop, every persona × every goal
node run.mjs --persona elder --goal water-coupon   # one combination (cheapest end-to-end check)
node run.mjs --url <site> --goals goals.himart.json  # live site (live safety rules are added automatically)
node run.mjs --headed --browser "C:\Program Files\Google\Chrome\Application\chrome.exe"   # Windows, visible browser
node report.mjs results/<runId> [--traps shop/TRAPS.md] [--no-ai]
ACCESS_CODE=xxx node server.mjs                    # web UI on :3000 (PORT, MAX_PARALLEL, DAILY_LIMIT env)
```

Other `run.mjs` flags: `--repeat N`, `--model`, `--timeout <min>` (default 15), `--port` (demo shop, default 4173). The browser can also come from the `PERSONA_QA_BROWSER` env var.

To change the report without spending model calls, re-render the committed sample: `node report.mjs samples/himart-aircon-2026-10-13 --no-ai`. This overwrites that sample's `report.html` and `analysis.json`, so restore them afterwards (`git checkout`) unless you mean to update the sample.

## Architecture

**run.mjs**: for each persona × goal × repeat it:
- Writes a per-run `playwright.json` and `mcp.json` into `results/<runId>/<persona>__<goal>__<n>/`. The persona's `device: "mobile"` sets a 390×844 touch viewport. `vision: false` sets `imageResponses: 'omit'` and also blocks `browser_take_screenshot`.
- Spawns `claude -p` with `--strict-mcp-config`, only `mcp__playwright` allowed, and every file, shell and web tool plus `browser_evaluate`/`run_code`/`network_requests` disallowed. The point is that personas can't "cheat" by reading the DOM or source. If you add a new Playwright MCP tool that exposes page internals, block it here.
- Runs `claude` from a fresh temp dir outside the repo, so this project's settings and hooks never apply to persona runs.
- Gets structured output via `--json-schema RESULT_SCHEMA` (`outcome`, `journey[]` with per-step `frustration` 0–5, `issues[]`, `quote`). It falls back to parsing JSON from the result text, and failing that records `outcome: 'blocked'` with an `error`.
- Streams `transcript.jsonl` and renames the recorded `.webm` to `video/session.webm`. Writes `result.json` for each run and `summary.json` for the whole run.
- Without `--url`, serves `shop/` itself on 127.0.0.1. `.md` files return 404 so the agent can never see `TRAPS.md`.
- `buildPrompt` assembles the persona rules, action limit, goal/success/profile, and (only when `--url` is given) the live-site safety rules: no login, payment, order, PII entry, or reviews.

**report.mjs**: reads `summary.json`. Unless `--no-ai` is given, it calls `claude -p --tools ''` with its own schema to merge issues across personas into ranked `findings`, and optionally maps them to trap IDs. Then it renders a single self-contained `report.html` (inline CSS with light/dark tokens). Videos are referenced by relative path, so `report.html` must stay inside its run folder.

**server.mjs + web/index.html**: the web UI, deployed to Render through `Dockerfile` and `../render.yaml` (Render reads the blueprint from the git repo root, one level up). It is a dependency-free `node:http` server. It runs jobs one at a time from an in-memory queue by spawning `run.mjs --run-id <id>` and then `report.mjs`. User-entered goals are written to `results/<id>/goals.input.json`. For external users it requires an access code (`ACCESS_CODE`), enforces a daily limit, and blocks private and loopback URLs. Under `/results/` it serves only `.html` and `.webm` files, so transcripts stay private.

**Coupling to keep in sync:** the result fields in `RESULT_SCHEMA` (run.mjs) are consumed directly by `report.mjs` (`aiAnalysis` input, `fallbackAnalysis`, `render`). The trap table in `shop/TRAPS.md` is parsed by the regex `^\|\s*(T\d+)\s*\|...`, so keep its `| T1 | 위치 | 함정 | ... |` row format.

## Data files

- `personas.json`: `id`, `name`, `summary`, `device` (`mobile`/`desktop`), `vision` (bool), `maxActions`, `rules[]`. Behaviour differences come from specific `rules`.
- `goals*.json`: `id`, `title`, `goal`, optional `success` and `profile` (order info fed to the persona). One file per target site (`goals.json` = demo shop, `goals.himart.json`, `goals.lotteon.json`).
- `shop/`: a static demo store whose usability bugs are **intentional** (T1–T8 in `shop/TRAPS.md`, marked `함정:` in the code). Do not "fix" them unless asked; they are the answer key the report's trap-detection rate is measured against.
- `results/` is gitignored. Curated runs go in `samples/` without `transcript.jsonl` or the `artifacts/` screenshots.
