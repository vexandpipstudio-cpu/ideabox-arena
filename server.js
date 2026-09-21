#!/usr/bin/env node
/*
 * IdeaBox Arena — Month 3 Week 4 Practical Week server
 * -----------------------------------------------------
 * Zero-dependency Node.js (18+). Serves the Arena UI from public/ and provides
 * the JSON API behind the student dashboards, the AI grading agent and the
 * leaderboard. All state lives in data/state.json; uploads in data/uploads/.
 * All API keys stay on the server (the Month 3 .env rule).
 *
 * Grading brains (pick one in the Instructor tab, or 'auto' for failover):
 *   mistral    — https://api.mistral.ai/v1          (the class's usual door)
 *   unorouter  — https://api.unorouter.com/v1       (OpenAI-compatible, :free models)
 *   nararouter — https://router.bynara.id/v1        (OpenAI-compatible, free tier)
 *
 * Run:       node server.js
 * Configure: .env  (PORT, INSTRUCTOR_PIN, LEADERBOARD_MODE, one key per brain)
 * Days:      data/days.json  (edit freely, then restart or reloadDays)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DAYS_FILE = path.join(DATA_DIR, 'days.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ENV_FILE = path.join(ROOT, '.env');

/* ---------------- config (.env, process.env wins) ---------------- */
const fileEnv = {};
try {
  fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const i = line.indexOf('=');
    if (i > 0) fileEnv[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  });
} catch (_) { /* no .env yet — fine */ }
const env = (k, fallback) => (process.env[k] || fileEnv[k] || fallback);

const CFG = {
  PORT: parseInt(env('PORT', '3100'), 10),
  INSTRUCTOR_PIN: String(env('INSTRUCTOR_PIN', '1234')),
  LEADERBOARD_MODE: ['growth', 'podium', 'full'].includes(env('LEADERBOARD_MODE', 'growth'))
    ? env('LEADERBOARD_MODE', 'growth') : 'growth',
  MAX_BODY_MB: 40,
  MAX_IMAGES: 4,
  MAX_IMAGE_MB: 3,
};

/* ---------------- LLM brains ---------------- */
const PROVIDERS = {
  mistral: {
    label: 'Mistral',
    baseUrl: String(env('MISTRAL_BASE_URL', 'https://api.mistral.ai/v1')).replace(/\/+$/, ''),
    key: env('MISTRAL_API_KEY', ''),
    model: env('MISTRAL_MODEL', 'mistral-small-latest'),
  },
  unorouter: {
    label: 'UnoRouter',
    baseUrl: String(env('UNOROUTER_BASE_URL', 'https://api.unorouter.com/v1')).replace(/\/+$/, ''),
    key: env('UNOROUTER_API_KEY', ''),
    model: env('UNOROUTER_MODEL', 'deepseek-v4-flash:free'),
  },
  nararouter: {
    label: 'NaraRouter',
    baseUrl: String(env('NARAROUTER_BASE_URL', 'https://router.bynara.id/v1')).replace(/\/+$/, ''),
    key: env('NARAROUTER_API_KEY', ''),
    model: env('NARAROUTER_MODEL', 'auto/bynara'),
  },
};
const AUTO_ORDER = ['mistral', 'nararouter', 'unorouter'];
const providerStatus = () => Object.fromEntries(
  Object.entries(PROVIDERS).map(([id, p]) => [id, { label: p.label, configured: !!p.key, model: p.model }]));

/* Vision pass: free vision models on UnoRouter, tried in order (all images in ONE call). */
const VISION_MODELS = String(env('VISION_MODELS',
  'qwen2.5-vl-7b-instruct-awq:free,llama-3.2-11b-vision:free,ling-3.0-flash-vl:free,nemotron-nano-12b-v2-vl:free'))
  .split(',').map((s) => s.trim()).filter(Boolean);
const VISION_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

async function describeImages(images) {
  const files = (images || []).slice(0, CFG.MAX_IMAGES);
  if (!files.length || !PROVIDERS.unorouter.key) return null;
  const content = [{
    type: 'text',
    text: 'These are images a teenage student attached to their timed project submission. For each image, in order, write one or two factual lines: "IMAGE n: ..." — what it shows, any visible text, branding, UI, or quality details. Do not invent details you cannot see.',
  }];
  for (const img of files) {
    try {
      const p = path.join(DATA_DIR, img.file);
      const buf = fs.readFileSync(p);
      if (buf.length > 2.5 * 1024 * 1024) continue; // keep request size sane for free gateways
      const mime = VISION_MIME[path.extname(img.file).toLowerCase()] || 'image/png';
      content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } });
    } catch (_) { /* unreadable file — skip it */ }
  }
  if (content.length === 1) return null; // every image failed to load
  let lastErr = '';
  for (const model of VISION_MODELS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 90000);
      const res = await fetch(PROVIDERS.unorouter.baseUrl + '/chat/completions', {
        method: 'POST', signal: ctrl.signal,
        headers: { Authorization: 'Bearer ' + PROVIDERS.unorouter.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 500 }),
      });
      clearTimeout(t);
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.choices) { lastErr = (j && j.error && j.error.message) || ('HTTP ' + res.status); continue; }
      const text = String(j.choices[0].message.content || '').trim();
      if (text) return { model, text };
    } catch (e) { lastErr = e.message; }
    await sleep(1500); // small breather before the next vision model
  }
  return { model: null, text: '', error: 'VISION_UNAVAILABLE: ' + lastErr };
}

/* ---------------- days + state ---------------- */
function loadDays() {
  const raw = JSON.parse(fs.readFileSync(DAYS_FILE, 'utf8'));
  if (!raw || !Array.isArray(raw.days) || raw.days.length === 0) throw new Error('days.json is empty or malformed');
  return raw;
}
let DAYS = loadDays();

function freshState() {
  return {
    activeDay: 1,
    clock: { status: 'idle', startedAt: null, durationMin: null, endsAt: null },
    boardMode: CFG.LEADERBOARD_MODE,
    graderBrain: 'auto',
    vision: true,      // vision pass: AI reads uploaded images before grading
    roster: [],
    codenames: {},     // { [student]: codename }
    starts: {},        // { [day]: { [student]: first-engagement timestamp } }
    assignments: {},   // { [day]: { [student]: business } }
    submissions: {},   // { [day]: { [student]: [ {at, text, links, images[]} ] } }
    grades: {},        // { [day]: { [student]: {...} } }
    selfChecks: {},    // { [day]: { [student]: {at, result} } }
  };
}
let STATE = freshState();
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    STATE = Object.assign(freshState(), s);
    if (!['growth', 'podium', 'full'].includes(STATE.boardMode)) STATE.boardMode = CFG.LEADERBOARD_MODE;
  } catch (_) { /* first run */ }
}
function saveState() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(STATE, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
loadState();
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (_) {}

/* ---------------- accounts (users.json) ---------------- */
let USERS = { users: [] };
function loadUsers() {
  try { USERS = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (_) { USERS = { users: [] }; }
  if (!Array.isArray(USERS.users)) USERS.users = [];
}
function saveUsers() {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(USERS, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}
loadUsers();
function findUser(username) {
  const u = String(username || '').trim().toLowerCase();
  return USERS.users.find((x) => String(x.username).toLowerCase() === u) || null;
}
function genPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no confusing 0/o/1/l/i
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[crypto.randomInt(chars.length)];
  return s.slice(0, 3) + '-' + s.slice(3);
}
// keep the roster in sync with student accounts
for (const u of USERS.users) {
  if (u.role === 'student' && !STATE.roster.includes(u.name)) STATE.roster.push(u.name);
}
saveState();

/* ---------------- helpers ---------------- */
const CATEGORY_KEYS = ['goal', 'craft', 'creativity', 'technical', 'process', 'time'];
const BADGE_META = {
  goal: { icon: '🎯', label: 'Goal Getter' },
  craft: { icon: '✨', label: 'Craft Star' },
  creativity: { icon: '💡', label: 'Creative Spark' },
  technical: { icon: '🔧', label: 'Tech Whiz' },
  process: { icon: '🧾', label: 'Proof Pro' },
  time: { icon: '⏱️', label: 'On-Time Champ' },
  improved: { icon: '🚀', label: 'Most Improved' },
  personalBest: { icon: '💪', label: 'Personal Best' },
  leader: { icon: '👑', label: 'Week Leader' },
};

function hash(str) { return crypto.createHash('sha256').update(String(str)).digest(); }
function pickBusiness(day, student) {
  const pool = DAYS.days[day - 1].businessPool || [];
  if (!pool.length) return 'Free choice';
  return pool[hash(student + '::day' + day).readUInt32BE(0) % pool.length];
}
function assignedBusiness(day, student) {
  STATE.assignments[day] = STATE.assignments[day] || {};
  if (!STATE.assignments[day][student]) {
    STATE.assignments[day][student] = pickBusiness(day, student);
    saveState();
  }
  return STATE.assignments[day][student];
}
function attempts(day, student) {
  return (STATE.submissions[day] && STATE.submissions[day][student]) || [];
}
function gradeOut(day, student) {
  const g = STATE.grades[day] && STATE.grades[day][student];
  return g ? { ...g } : null;
}
function displayName(student) {
  return STATE.codenames[student] || student;
}
function cleanCodename(s) {
  return String(s || '').trim().replace(/[<>"'`]/g, '').slice(0, 24);
}
function clockInfo() {
  const c = STATE.clock;
  const info = { ...c, serverTime: Date.now() };
  if (c.status === 'running' && c.endsAt) info.timeUp = Date.now() >= c.endsAt;
  return info;
}
function minutesLate(day, atMs) {
  const c = STATE.clock;
  if (!c.endsAt) return 0;
  return atMs <= c.endsAt ? 0 : Math.ceil((atMs - c.endsAt) / 60000);
}
function timeScore(minsLate) {
  if (minsLate <= 0) return 10;
  if (minsLate <= 15) return 7;
  if (minsLate <= 30) return 5;
  if (minsLate <= 60) return 3;
  return 1;
}
function publicDays() {
  return DAYS.days.map((d) => ({
    day: d.day, weekday: d.weekday, title: d.title, tagline: d.tagline, skills: d.skills,
    timeLimitMin: d.timeLimitMin, mission: d.mission, simpleWords: d.simpleWords || [],
    steps: d.steps || [], ifStuck: d.ifStuck || '', ifEarly: d.ifEarly || '',
    doneWhen: d.doneWhen, deliverables: d.deliverables, caveats: d.caveats, evidenceNote: d.evidenceNote,
  }));
}

/* ---------------- leaderboard core ---------------- */
function computeFullRows() {
  const rows = STATE.roster.map((name) => {
    const days = {};
    let overall = 0, gradedDays = 0, goalSum = 0, lastSubmit = 0;
    for (let d = 1; d <= DAYS.days.length; d++) {
      const g = gradeOut(d, name);
      if (g) {
        days[d] = { ...g.scores, total: g.total };
        overall += g.total; gradedDays += 1; goalSum += g.scores.goal || 0;
        if (g.submittedAt) lastSubmit = Math.max(lastSubmit, g.submittedAt);
      }
    }
    return { name, display: displayName(name), days, overall, gradedDays, goalSum, lastSubmit };
  });
  rows.sort((a, b) =>
    b.overall - a.overall ||
    b.goalSum - a.goalSum ||
    (a.lastSubmit || Infinity) - (b.lastSubmit || Infinity) ||
    a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}
/* Public board — shaped by the mode. In growth mode NO scores or ranks leave the server. */
function publicBoard() {
  const full = computeFullRows();
  const mode = STATE.boardMode;
  if (mode === 'full') {
    return full.map((r) => ({ name: r.name, display: r.display, rank: r.rank, days: r.days, overall: r.overall, gradedDays: r.gradedDays }));
  }
  if (mode === 'podium') {
    return full.map((r, i) => (i < 3
      ? { name: r.name, display: r.display, rank: r.rank, days: r.days, overall: r.overall, gradedDays: r.gradedDays }
      : { name: r.name, display: r.display, participant: true }));
  }
  // growth: alphabetical, no scores anywhere
  return full.slice().sort((a, b) => a.display.localeCompare(b.display))
    .map((r) => ({ name: r.name, display: r.display, participant: true }));
}

/* ---------------- spotlight badges ---------------- */
const GRADE_CATS = ['goal', 'craft', 'creativity', 'technical', 'process'];
function computeSpotlights() {
  const perDay = {};
  const dayTotals = {}; // { [day]: { [student]: total } }
  for (let d = 1; d <= DAYS.days.length; d++) {
    const grades = STATE.grades[d] || {};
    const names = Object.keys(grades);
    if (!names.length) continue;
    const badges = [];
    const winners = (cat) => {
      const max = Math.max(...names.map((n) => grades[n].scores[cat] || 0));
      return names.filter((n) => (grades[n].scores[cat] || 0) === max);
    };
    for (const cat of GRADE_CATS) {
      for (const n of winners(cat)) badges.push({ ...BADGE_META[cat], type: cat, student: n });
    }
    for (const n of names.filter((x) => grades[x].scores.time === 10)) {
      badges.push({ ...BADGE_META.time, type: 'time', student: n });
    }
    // personal best: beat every previous graded day's own total
    for (const n of names) {
      let prevMax = -1;
      for (let p = 1; p < d; p++) {
        const g = gradeOut(p, n);
        if (g) prevMax = Math.max(prevMax, g.total);
      }
      if (prevMax >= 0 && grades[n].total > prevMax) badges.push({ ...BADGE_META.personalBest, type: 'personalBest', student: n });
    }
    // most improved vs previous day (if both graded)
    if (d > 1) {
      const deltas = names
        .filter((n) => gradeOut(d - 1, n))
        .map((n) => ({ n, delta: grades[n].total - gradeOut(d - 1, n).total }))
        .filter((x) => x.delta > 0);
      if (deltas.length) {
        const best = Math.max(...deltas.map((x) => x.delta));
        for (const x of deltas.filter((y) => y.delta === best)) {
          badges.push({ ...BADGE_META.improved, type: 'improved', student: x.n, detail: '+' + best });
        }
      }
    }
    perDay[d] = badges.map((b) => ({ ...b, display: displayName(b.student) }));
    dayTotals[d] = Object.fromEntries(names.map((n) => [n, grades[n].total]));
  }
  // weekly category champions (students with 2+ graded days)
  const weekly = [];
  const qualified = STATE.roster.filter((n) =>
    computeFullRows().find((r) => r.name === n && r.gradedDays >= 2));
  if (qualified.length) {
    for (const cat of GRADE_CATS) {
      const sums = qualified.map((n) => {
        let s = 0, c = 0;
        for (let d = 1; d <= DAYS.days.length; d++) {
          const g = gradeOut(d, n);
          if (g) { s += g.scores[cat] || 0; c += 1; }
        }
        return { n, avg: c ? s / c : 0 };
      }).filter((x) => x.avg > 0);
      if (!sums.length) continue;
      const max = Math.max(...sums.map((x) => x.avg));
      for (const x of sums.filter((y) => y.avg === max)) {
        weekly.push({ ...BADGE_META[cat], type: cat, student: x.n, display: displayName(x.n), scope: 'week' });
      }
    }
    if (STATE.boardMode !== 'growth') {
      const top = computeFullRows().find((r) => r.gradedDays > 0);
      if (top && top.overall > 0) weekly.push({ ...BADGE_META.leader, type: 'leader', student: top.name, display: top.display, scope: 'week' });
    }
  }
  return { perDay, weekly };
}

/* ---------------- LLM calls ---------------- */
function stripFences(s) {
  return String(s).replace(/```json/gi, '```').split('```').map((p) => p.trim()).filter(Boolean)
    .find((p) => p.startsWith('{')) || String(s);
}
function extractJSON(text) {
  const s = stripFences(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('GRADER_BAD_JSON: no JSON object found');
  return JSON.parse(s.slice(start, end + 1));
}
function clampScore(n) {
  return Math.max(0, Math.min(10, Math.round(Number(n) || 0)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function chatCompletion(providerId, messages, { jsonMode = true, maxTokens = 1400, attempts = 3, timeoutMs = 150000 } = {}) {
  const p = PROVIDERS[providerId];
  if (!p || !p.key) {
    const e = new Error(`NO_KEY: ${providerId} has no API key — set ${providerId.toUpperCase()}_API_KEY in .env`);
    e.code = 'NO_KEY';
    throw e;
  }
  const base = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + p.key,
      'X-Title': 'IdeaBox Arena',
    },
  };
  const payload = (json) => JSON.stringify({
    model: p.model,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  });
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      // longer backoff if the previous failure looked like a rate limit / busy channel
      const msg = String(lastErr && lastErr.message || '');
      const rateLimited = /429|too many|rate.?limit|busy|retry in|concurrency|free tier/i.test(msg);
      await sleep(rateLimited ? Math.min(70000, 12000 * i) : 1200 * i);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res = await fetch(p.baseUrl + '/chat/completions', { ...base, body: payload(jsonMode), signal: ctrl.signal });
      if (!res.ok && jsonMode) {
        // some models/gateways reject or choke on response_format — retry without it
        res = await fetch(p.baseUrl + '/chat/completions', { ...base, body: payload(false), signal: ctrl.signal });
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`${p.label.toUpperCase()}_HTTP_${res.status}: ${t.replace(/<[^>]*>/g, '').slice(0, 180)}`);
      }
      const data = await res.json();
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error(p.label + '_EMPTY: model returned no content');
      return { content, provider: providerId, model: p.model };
    } catch (err) {
      if (err.name === 'AbortError') lastErr = new Error(p.label + '_TIMEOUT after ' + Math.round(timeoutMs / 1000) + 's');
      else lastErr = err;
      if (err.code === 'NO_KEY') throw err; // no point retrying a missing key
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(p.label + '_FAILED');
}

/* brain = 'auto' tries configured brains in AUTO_ORDER until one answers */
async function callBrain(messages, opts) {
  const brain = STATE.graderBrain || 'auto';
  const order = brain === 'auto' ? AUTO_ORDER.filter((id) => PROVIDERS[id].key) : [brain];
  if (!order.length) {
    const e = new Error('NO_KEY: configure at least one grading brain in .env (MISTRAL_API_KEY, UNOROUTER_API_KEY or NARAROUTER_API_KEY)');
    e.code = 'NO_KEY';
    throw e;
  }
  const errors = [];
  for (const id of order) {
    try { return await chatCompletion(id, messages, opts); } catch (err) { errors.push(err.message); }
  }
  throw new Error('ALL_BRAINS_FAILED: ' + errors.join(' | '));
}

/* ---------------- grading + coaching ---------------- */
const GRADER_SYSTEM =
`You are the official Grading Agent of the IdeaBox AI Masterclass Practical Week (Lagos, Nigeria).
You grade ONE student's submission for ONE timed daily project. The students are teenagers.
Rules:
- Be strict but fair. Grade ONLY what is present in the submission. Never invent work that is not there.
- If evidence is missing, score the affected category low and say exactly what is missing.
- You grade the pasted text: the work, the descriptions, the prompt log. If an IMAGE ANALYSIS block is provided below, it was written by a separate AI vision model that looked at the student's attached images — treat it as EXTRA EVIDENCE to factor into craft/technical, but never as proof of work that was not pasted. If no IMAGE ANALYSIS block is present, you cannot see images.
- Caveats are hard constraints. A submission that breaks one must be flagged in "violations".
- Feedback must build confidence: name what EXISTS and works before what is missing. Encouraging, specific, short. No lectures, no sarcasm.
Score scale per category: 9-10 exceeds the brief; 7-8 solid; 5-6 partial; 3-4 weak; 0-2 missing or ignored.
Return STRICT JSON only. No markdown, no commentary outside the JSON.`;

function graderUserPrompt(dayBrief, submission) {
  const f = dayBrief.gradingFocus || {};
  return `PROJECT — Day ${dayBrief.day} (${dayBrief.weekday}): ${dayBrief.title}
MISSION: ${dayBrief.mission.replace('{business}', submission.business)}

DELIVERABLES EXPECTED:
${dayBrief.deliverables.map((d) => '- ' + d).join('\n')}

CAVEATS (hard constraints — breaking one must appear in "violations"):
${dayBrief.caveats.map((c) => '- ' + c).join('\n')}

GRADE THESE CATEGORIES 0-10 (with what each means today):
- goal: ${f.goal || 'every deliverable delivered in full'}
- craft: ${f.craft || 'polish, formatting, realistic detail, consistency'}
- creativity: ${f.creativity || 'original, specific ideas, not generic AI filler'}
- technical: ${f.technical || 'the tools and rules of the month used correctly'}
- process: ${f.process || 'prompts, traces and logs pasted as evidence — proof of steps, not vibes'}
("time" is computed by the server clock — do NOT grade time.)

STUDENT SUBMISSION (attempt #${submission.attempt}, pasted text below):
"""
${(submission.text || '').slice(0, 12000)}
"""
LINKS: ${(submission.links || []).join(', ') || '(none)'}
IMAGE FILES ATTACHED: ${(submission.images || []).map((i) => i.originalName).join(', ') || '(none)'}
${submission.imageAnalysis ? `IMAGE ANALYSIS (written by an AI vision model that looked at the attached images — extra evidence):\n${submission.imageAnalysis}` : '(No image analysis available — the human instructor reviews attached files; you only see names.)'}

Respond with STRICT JSON exactly in this shape:
{"goal":0,"craft":0,"creativity":0,"technical":0,"process":0,"violations":["caveat broken and which one"],"strengths":["2-3 short items"],"fixes":["2-3 short, specific fixes"],"summary":"two short sentences"}`;
}

const COACH_SYSTEM =
`You are the Practice Coach of the IdeaBox AI Masterclass Practical Week (Lagos, Nigeria).
A teenage student has submitted a DRAFT and asked for a self-check BEFORE official grading. This is a rehearsal, not the official grade.
Be warm, direct and specific. Estimate category scores 0-10 the same way the official grader would, then give the three highest-value fixes.
Always end with genuine encouragement. Return STRICT JSON only. No markdown.`;

function coachUserPrompt(dayBrief, submission) {
  return `PROJECT — Day ${dayBrief.day}: ${dayBrief.title}
MISSION: ${dayBrief.mission.replace('{business}', submission.business)}
DELIVERABLES EXPECTED:
${dayBrief.deliverables.map((d) => '- ' + d).join('\n')}
CAVEATS (hard constraints):
${dayBrief.caveats.map((c) => '- ' + c).join('\n')}

STUDENT DRAFT:
"""
${(submission.text || '').slice(0, 12000)}
"""
LINKS: ${(submission.links || []).join(', ') || '(none)'}

Respond with STRICT JSON exactly in this shape:
{"goal":0,"craft":0,"creativity":0,"technical":0,"process":0,"topFixes":["fix 1","fix 2","fix 3"],"pepLine":"one encouraging line"}`;
}

async function gradeSubmission(day, student, brainOverride) {
  const brief = DAYS.days[day - 1];
  const list = attempts(day, student);
  if (!list.length) throw new Error('NO_SUBMISSION: ' + student + ' has not submitted on day ' + day);
  const last = list[list.length - 1];
  // Vision pass: have a free vision model describe the attached images (if enabled + present).
  let imageAnalysis = null, visionModel = null;
  if (STATE.vision && (last.images || []).length) {
    try {
      const v = await describeImages(last.images);
      if (v && v.text) { imageAnalysis = v.text; visionModel = v.model; }
    } catch (_) { /* vision is a bonus — never block grading on it */ }
  }
  const savedBrain = STATE.graderBrain;
  if (brainOverride) STATE.graderBrain = brainOverride;
  let result;
  try {
    result = await callBrain([
      { role: 'system', content: GRADER_SYSTEM },
      { role: 'user', content: graderUserPrompt(brief, { ...last, attempt: list.length, business: assignedBusiness(day, student), imageAnalysis }) },
    ], { jsonMode: true, maxTokens: 1600 });
  } finally {
    if (brainOverride) STATE.graderBrain = savedBrain;
  }
  const j = extractJSON(result.content);
  const late = minutesLate(day, last.at);
  const scores = {
    goal: clampScore(j.goal),
    craft: clampScore(j.craft),
    creativity: clampScore(j.creativity),
    technical: clampScore(j.technical),
    process: clampScore(j.process),
    time: timeScore(late), // server-computed, never AI
  };
  const grade = {
    student,
    day,
    business: assignedBusiness(day, student),
    scores,
    total: CATEGORY_KEYS.reduce((s, k) => s + scores[k], 0),
    violations: Array.isArray(j.violations) ? j.violations.slice(0, 5).map(String) : [],
    strengths: Array.isArray(j.strengths) ? j.strengths.slice(0, 5).map(String) : [],
    fixes: Array.isArray(j.fixes) ? j.fixes.slice(0, 5).map(String) : [],
    summary: String(j.summary || '').slice(0, 500),
    minutesLate: late,
    submittedAt: last.at,
    attempt: list.length,
    source: 'ai',
    provider: result.provider,
    model: result.model,
    imageAnalysis,   // vision-model description of attached images (null if none/disabled)
    visionModel,     // which vision model wrote it (null if none)
    gradedAt: Date.now(),
  };
  STATE.grades[day] = STATE.grades[day] || {};
  STATE.grades[day][student] = grade;
  saveState();
  return grade;
}

async function selfCheckSubmission(day, student) {
  const brief = DAYS.days[day - 1];
  const list = attempts(day, student);
  if (!list.length) throw new Error('NO_SUBMISSION: submit your draft first, then run the self-check');
  const last = list[list.length - 1];
  const result = await callBrain([
    { role: 'system', content: COACH_SYSTEM },
    { role: 'user', content: coachUserPrompt(brief, { ...last, attempt: list.length, business: assignedBusiness(day, student) }) },
  ], { jsonMode: true, maxTokens: 1200 });
  const j = extractJSON(result.content);
  const out = {
    estimated: {
      goal: clampScore(j.goal), craft: clampScore(j.craft), creativity: clampScore(j.creativity),
      technical: clampScore(j.technical), process: clampScore(j.process),
    },
    topFixes: Array.isArray(j.topFixes) ? j.topFixes.slice(0, 3).map(String) : [],
    pepLine: String(j.pepLine || ''),
    brain: result.provider,
    note: 'Self-checks are rehearsals — they never touch the leaderboard.',
  };
  STATE.selfChecks[day] = STATE.selfChecks[day] || {};
  STATE.selfChecks[day][student] = { at: Date.now(), result: out };
  saveState();
  return out;
}

/* ---------------- student progress (private) ---------------- */
function studentProgress(name) {
  const days = [];
  let personalBest = null;
  for (let d = 1; d <= DAYS.days.length; d++) {
    const g = gradeOut(d, name);
    if (!g) continue;
    const prev = days[days.length - 1];
    const entry = {
      day: d, total: g.total,
      delta: prev ? g.total - prev.total : null,
      isPersonalBest: !personalBest || g.total > personalBest.total,
    };
    if (entry.isPersonalBest) personalBest = { day: d, total: g.total };
    days.push(entry);
  }
  const spot = computeSpotlights();
  const badges = [];
  for (const [d, list] of Object.entries(spot.perDay)) {
    for (const b of list) if (b.student === name) badges.push({ ...b, day: parseInt(d, 10) });
  }
  for (const b of spot.weekly) if (b.student === name) badges.push(b);
  return { days, personalBest, badges };
}

/* ---------------- console helpers ---------------- */
function usersForConsole() {
  return USERS.users.map((u) => ({ role: u.role, name: u.name, username: u.username, password: u.role === 'student' ? u.password : '••••••' }));
}
function attemptsCountToday() {
  const out = {};
  for (const n of STATE.roster) out[n] = attempts(STATE.activeDay, n).length;
  return out;
}

/* ---------------- CSV export ---------------- */
function csvEscape(v) {
  const s = String(v == null ? '' : v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? '"' + s + '"' : s;
}
function buildStandingsCSV() {
  const head = ['Rank', 'Student', 'Codename', ...DAYS.days.map((d) => 'Day ' + d.day + ' — ' + d.title), 'Overall', 'Days graded'];
  const lines = [head.join(',')];
  for (const r of computeFullRows()) {
    const row = [r.rank, r.name, STATE.codenames[r.name] || ''];
    for (let d = 1; d <= DAYS.days.length; d++) row.push(r.days[d] ? r.days[d].total : '');
    row.push(r.overall, r.gradedDays);
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\n');
}
function buildDetailedCSV() {
  const head = ['Day', 'Project', 'Student', 'Codename', 'Business', 'Goal', 'Craft', 'Creativity', 'Technical', 'Process', 'Time', 'Total (60)', 'Percent', 'Minutes late', 'Submitted at', 'Violations', 'Source', 'Brain/Model', 'Vision (images)', 'Summary'];
  const lines = [head.join(',')];
  for (let d = 1; d <= DAYS.days.length; d++) {
    const brief = DAYS.days[d - 1];
    for (const name of STATE.roster) {
      const g = gradeOut(d, name);
      if (!g) continue;
      lines.push([
        d, brief.title, name, STATE.codenames[name] || '', g.business,
        g.scores.goal, g.scores.craft, g.scores.creativity, g.scores.technical, g.scores.process, g.scores.time,
        g.total, Math.round((g.total / 60) * 100) + '%',
        g.minutesLate,
        g.submittedAt ? new Date(g.submittedAt).toISOString() : '',
        (g.violations || []).join('; '),
        g.source,
        (g.provider || g.model || 'instructor'),
        g.imageAnalysis ? `${g.visionModel ? '[' + g.visionModel + '] ' : ''}${g.imageAnalysis}` : '',
        g.summary || '',
      ].map(csvEscape).join(','));
    }
  }
  return lines.join('\n');
}

/* ---------------- uploads ---------------- */
const IMG_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'file'; }
function saveImages(day, student, images) {
  const saved = [];
  for (const img of (images || []).slice(0, CFG.MAX_IMAGES)) {
    if (!img || typeof img.name !== 'string' || typeof img.data !== 'string') continue;
    const ext = IMG_EXT[img.type] || path.extname(img.name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) continue;
    const b64 = img.data.replace(/^data:[^,]+,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length || buf.length > CFG.MAX_IMAGE_MB * 1024 * 1024) continue;
    const fname = `day${day}-${slug(student)}-${Date.now()}-${slug(path.basename(img.name, ext))}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, fname), buf);
    saved.push({ originalName: img.name, file: 'uploads/' + fname, size: buf.length });
  }
  return saved;
}

/* ---------------- tiny HTTP framework ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
};
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function sendFile(res, absPath) {
  let st; try { st = fs.statSync(absPath); } catch { res.writeHead(404); res.end('Not found'); return; }
  if (!st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(absPath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(absPath).pipe(res);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > CFG.MAX_BODY_MB * 1024 * 1024) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function isPinOk(body) {
  return body && String(body.pin || '') === CFG.INSTRUCTOR_PIN;
}

/* ---------------- API routes ---------------- */
async function handleAPI(req, res, url) {
  const route = url.pathname;
  const send = (obj, code = 200) => sendJSON(res, code, obj);
  let body = {};
  if (req.method === 'POST') {
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) { return send({ ok: false, error: 'BAD_JSON: ' + e.message }, 400); }
  }

  try {
    /* ---- public ---- */
    if (route === '/api/bootstrap' && req.method === 'GET') {
      const spot = computeSpotlights();
      return send({
        ok: true,
        mode: 'live',
        arenaName: DAYS.arenaName,
        weekTitle: DAYS.weekTitle,
        rules: DAYS.rules,
        days: publicDays(),
        roster: STATE.roster,
        codenames: STATE.codenames,
        activeDay: STATE.activeDay,
        clock: clockInfo(),
        boardMode: STATE.boardMode,
        vision: STATE.vision !== false,
        board: publicBoard(),
        spotlights: spot,
        providers: providerStatus(),
        brain: STATE.graderBrain,
        serverTime: Date.now(),
      });
    }

    if (route === '/api/login' && req.method === 'POST') {
      const user = findUser(body.username);
      if (!user || String(body.password || '') !== user.password) {
        return send({ ok: false, error: 'BAD_CREDENTIALS: wrong username or password' }, 401);
      }
      if (user.role === 'student' && !STATE.roster.includes(user.name)) STATE.roster.push(user.name);
      // record first engagement with the active day = their start time
      const day = STATE.activeDay;
      if (user.role === 'student') {
        STATE.starts[day] = STATE.starts[day] || {};
        if (!STATE.starts[day][user.name]) { STATE.starts[day][user.name] = Date.now(); saveState(); }
      }
      return send({
        ok: true, role: user.role, name: user.name,
        ...(user.role === 'instructor' ? { pin: CFG.INSTRUCTOR_PIN } : {}),
        startedAt: user.role === 'student' ? STATE.starts[day][user.name] : null,
      });
    }

    if (route === '/api/me' && req.method === 'GET') {
      const name = String(url.searchParams.get('name') || '').trim();
      if (!name || !STATE.roster.includes(name)) return send({ ok: false, error: 'UNKNOWN_STUDENT' }, 404);
      // record start time on first access to the active day
      STATE.starts[STATE.activeDay] = STATE.starts[STATE.activeDay] || {};
      if (!STATE.starts[STATE.activeDay][name]) { STATE.starts[STATE.activeDay][name] = Date.now(); saveState(); }
      const days = {};
      for (let d = 1; d <= DAYS.days.length; d++) {
        days[d] = {
          business: assignedBusiness(d, name),
          attempts: attempts(d, name),
          grade: gradeOut(d, name),
          selfCheck: (STATE.selfChecks[d] && STATE.selfChecks[d][name]) || null,
        };
      }
      return send({
        ok: true, name, codename: STATE.codenames[name] || '', days,
        progress: studentProgress(name),
        startedAt: (STATE.starts[STATE.activeDay] || {})[name] || null,
        activeDay: STATE.activeDay, clock: clockInfo(), boardMode: STATE.boardMode, serverTime: Date.now(),
      });
    }

    if (route === '/api/codename' && req.method === 'POST') {
      const name = String(body.name || '').trim();
      if (!STATE.roster.includes(name)) return send({ ok: false, error: 'UNKNOWN_STUDENT' }, 404);
      const code = cleanCodename(body.codename);
      if (!code) { delete STATE.codenames[name]; }
      else if (Object.values(STATE.codenames).includes(code)) return send({ ok: false, error: 'CODENAME_TAKEN: pick another' }, 400);
      else STATE.codenames[name] = code;
      saveState();
      return send({ ok: true, codename: STATE.codenames[name] || '' });
    }

    /* ---- self-service: change your own password ---- */
    if (route === '/api/change-password' && req.method === 'POST') {
      const user = findUser(body.username);
      if (!user || String(body.current || '') !== user.password) {
        return send({ ok: false, error: 'BAD_CREDENTIALS: wrong current password' }, 401);
      }
      const next = String(body.next || '');
      if (next.length < 4 || next.length > 40) return send({ ok: false, error: 'BAD_PASSWORD: 4–40 characters' }, 400);
      if (next === user.password) return send({ ok: false, error: 'SAME_PASSWORD: pick a different one' }, 400);
      user.password = next;
      saveUsers();
      // invalidate any stale cached roster login so the new password takes effect immediately
      return send({ ok: true, username: user.username });
    }

    if (route === '/api/submit' && req.method === 'POST') {
      const name = String(body.name || '').trim();
      const day = parseInt(body.day, 10);
      if (!STATE.roster.includes(name)) return send({ ok: false, error: 'UNKNOWN_STUDENT' }, 404);
      if (day !== STATE.activeDay) return send({ ok: false, error: 'NOT_ACTIVE_DAY: today is Day ' + STATE.activeDay }, 400);
      if (STATE.clock.status === 'idle') return send({ ok: false, error: 'CLOCK_NOT_STARTED: wait for the instructor to start the clock' }, 400);
      if (STATE.clock.status === 'closed') return send({ ok: false, error: 'DAY_CLOSED: submissions are closed' }, 400);
      const text = String(body.text || '').trim();
      const links = (Array.isArray(body.links) ? body.links : []).map(String).filter(Boolean).slice(0, 10);
      if (!text && !links.length) return send({ ok: false, error: 'EMPTY_SUBMISSION: paste your work or add a link' }, 400);
      const images = saveImages(day, name, body.images);
      const at = Date.now();
      STATE.submissions[day] = STATE.submissions[day] || {};
      STATE.submissions[day][name] = STATE.submissions[day][name] || [];
      STATE.submissions[day][name].push({ at, text, links, images });
      saveState();
      return send({ ok: true, attempt: STATE.submissions[day][name].length, minutesLate: minutesLate(day, at), images });
    }

    if (route === '/api/selfcheck' && req.method === 'POST') {
      const name = String(body.name || '').trim();
      const day = parseInt(body.day, 10);
      if (!STATE.roster.includes(name)) return send({ ok: false, error: 'UNKNOWN_STUDENT' }, 404);
      if (day !== STATE.activeDay) return send({ ok: false, error: 'NOT_ACTIVE_DAY' }, 400);
      const result = await selfCheckSubmission(day, name);
      return send({ ok: true, result });
    }

    /* ---- instructor ---- */
    if (route === '/api/grade' && req.method === 'POST') {
      if (!isPinOk(body)) return send({ ok: false, error: 'BAD_PIN' }, 403);
      const day = parseInt(body.day, 10);
      if (!DAYS.days[day - 1]) return send({ ok: false, error: 'BAD_DAY' }, 400);
      const names = Array.isArray(body.names) && body.names.length
        ? body.names.map(String)
        : STATE.roster.filter((n) => attempts(day, n).length);
      const graded = []; const failed = [];
      for (let ni = 0; ni < names.length; ni++) {
        const n = names[ni];
        if (!STATE.roster.includes(n) || !attempts(day, n).length) continue;
        if (ni > 0) await sleep(4000); // pace free-tier rate limits between students
        try { graded.push(await gradeSubmission(day, n, body.brain || null)); } catch (e) { failed.push({ student: n, error: e.message }); }
      }
      return send({
        ok: true, graded, failed,
        leaderboard: computeFullRows(), spotlights: computeSpotlights(),
        starts: STATE.starts[STATE.activeDay] || {}, attemptsToday: attemptsCountToday(),
        users: usersForConsole(),
      });
    }

    if (route === '/api/admin' && req.method === 'POST') {
      if (!isPinOk(body)) return send({ ok: false, error: 'BAD_PIN' }, 403);
      const a = body.action;
      if (a === 'setDay') {
        const day = parseInt(body.day, 10);
        if (!DAYS.days[day - 1]) return send({ ok: false, error: 'BAD_DAY' }, 400);
        STATE.activeDay = day;
        STATE.clock = { status: 'idle', startedAt: null, durationMin: null, endsAt: null };
        saveState();
      } else if (a === 'startClock') {
        const day = STATE.activeDay;
        STATE.clock = {
          status: 'running',
          startedAt: Date.now(),
          durationMin: parseInt(body.durationMin, 10) || DAYS.days[day - 1].timeLimitMin,
          endsAt: Date.now() + (parseInt(body.durationMin, 10) || DAYS.days[day - 1].timeLimitMin) * 60000,
        };
        saveState();
      } else if (a === 'closeDay') {
        STATE.clock.status = 'closed';
        saveState();
      } else if (a === 'reopenDay') {
        STATE.clock.status = 'running';
        STATE.clock.endsAt = Math.max(STATE.clock.endsAt || 0, Date.now() + 10 * 60000);
        saveState();
      } else if (a === 'resetTimer') {
        // stop the clock AND clear today's per-student start stamps (the "you started at" timer)
        STATE.clock = { status: 'idle', startedAt: null, durationMin: null, endsAt: null };
        STATE.starts[STATE.activeDay] = {};
        saveState();
      } else if (a === 'addStudent') {
        const name = String(body.name || '').trim();
        if (!name) return send({ ok: false, error: 'BAD_NAME' }, 400);
        if (STATE.roster.includes(name)) return send({ ok: false, error: 'ALREADY_EXISTS' }, 400);
        STATE.roster.push(name);
        saveState();
        // create a login account too
        let created = null;
        if (!findUser(name)) {
          let uname = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
          let n = 2; while (findUser(uname)) { uname = uname.replace(/-\d+$/, '') + '-' + n++; }
          created = { role: 'student', name, username: uname, password: genPassword() };
          USERS.users.push(created);
          saveUsers();
        }
        return send({
          ok: true, activeDay: STATE.activeDay, clock: clockInfo(), roster: STATE.roster,
          boardMode: STATE.boardMode, brain: STATE.graderBrain,
          leaderboard: computeFullRows(), spotlights: computeSpotlights(),
          starts: STATE.starts[STATE.activeDay] || {}, attemptsToday: attemptsCountToday(),
          users: usersForConsole(), createdUser: created,
        });
      } else if (a === 'removeStudent') {
        const name = String(body.name || '').trim();
        STATE.roster = STATE.roster.filter((n) => n !== name);
        saveState();
        USERS.users = USERS.users.filter((u) => !(u.role === 'student' && u.name === name));
        saveUsers();
      } else if (a === 'resetPassword') {
        const name = String(body.name || '').trim();
        const user = USERS.users.find((u) => u.role === 'student' && u.name === name);
        if (!user) return send({ ok: false, error: 'UNKNOWN_USER' }, 404);
        user.password = genPassword();
        saveUsers();
        return send({
          ok: true, activeDay: STATE.activeDay, clock: clockInfo(), roster: STATE.roster,
          boardMode: STATE.boardMode, brain: STATE.graderBrain,
          leaderboard: computeFullRows(), spotlights: computeSpotlights(),
          starts: STATE.starts[STATE.activeDay] || {}, attemptsToday: attemptsCountToday(),
          users: usersForConsole(), newPassword: user.password,
        });
      } else if (a === 'setVision') {
        STATE.vision = !!body.on;
        saveState();
      } else if (a === 'setBoardMode') {
        const mode = String(body.mode || '');
        if (!['growth', 'podium', 'full'].includes(mode)) return send({ ok: false, error: 'BAD_MODE' }, 400);
        STATE.boardMode = mode;
        saveState();
      } else if (a === 'setBrain') {
        const brain = String(body.brain || '');
        if (brain !== 'auto' && !PROVIDERS[brain]) return send({ ok: false, error: 'BAD_BRAIN' }, 400);
        STATE.graderBrain = brain;
        saveState();
      } else if (a === 'setCodename') {
        const name = String(body.name || '').trim();
        if (!STATE.roster.includes(name)) return send({ ok: false, error: 'UNKNOWN_STUDENT' }, 404);
        const code = cleanCodename(body.codename);
        if (!code) delete STATE.codenames[name];
        else STATE.codenames[name] = code;
        saveState();
      } else if (a === 'overrideGrade') {
        const day = parseInt(body.day, 10);
        const name = String(body.name || '').trim();
        const s = body.scores || {};
        const list = attempts(day, name);
        if (!list.length) return send({ ok: false, error: 'NO_SUBMISSION' }, 400);
        const last = list[list.length - 1];
        const late = minutesLate(day, last.at);
        const scores = {
          goal: clampScore(s.goal), craft: clampScore(s.craft), creativity: clampScore(s.creativity),
          technical: clampScore(s.technical), process: clampScore(s.process),
          time: s.time == null ? timeScore(late) : clampScore(s.time),
        };
        const prev = gradeOut(day, name) || {};
        STATE.grades[day] = STATE.grades[day] || {};
        STATE.grades[day][name] = {
          ...prev,
          student: name, day, business: assignedBusiness(day, name), scores,
          total: CATEGORY_KEYS.reduce((t, k) => t + scores[k], 0),
          minutesLate: late, submittedAt: last.at, attempt: list.length,
          source: 'manual', provider: 'instructor', model: 'instructor',
          violations: Array.isArray(prev.violations) ? prev.violations : [],
          strengths: Array.isArray(prev.strengths) ? prev.strengths : [],
          fixes: Array.isArray(prev.fixes) ? prev.fixes : [],
          summary: String(body.notes || prev.summary || 'Manually adjusted by the instructor.').slice(0, 500),
          gradedAt: Date.now(),
        };
        saveState();
      } else if (a === 'resetAll') {
        if (String(body.confirm) !== 'RESET') return send({ ok: false, error: 'CONFIRM_REQUIRED: send confirm:"RESET"' }, 400);
        const keepBoardMode = STATE.boardMode;
        STATE = freshState();
        STATE.boardMode = keepBoardMode;
        // accounts survive the reset — rebuild the roster from them
        for (const u of USERS.users) if (u.role === 'student') STATE.roster.push(u.name);
        saveState();
      } else if (a === 'reloadDays') {
        DAYS = loadDays();
      } else {
        return send({ ok: false, error: 'UNKNOWN_ACTION: ' + a }, 400);
      }
      return send({
        ok: true, activeDay: STATE.activeDay, clock: clockInfo(), roster: STATE.roster,
        boardMode: STATE.boardMode, brain: STATE.graderBrain, vision: STATE.vision !== false,
        leaderboard: computeFullRows(), spotlights: computeSpotlights(),
        starts: STATE.starts[STATE.activeDay] || {}, attemptsToday: attemptsCountToday(),
        users: usersForConsole(),
      });
    }

    if (route === '/api/export' && req.method === 'POST') {
      if (!isPinOk(body)) return send({ ok: false, error: 'BAD_PIN' }, 403);
      const type = body.type === 'detailed' ? 'detailed' : 'standings';
      const csv = type === 'detailed' ? buildDetailedCSV() : buildStandingsCSV();
      return send({ ok: true, type, csv, filename: `ideabox-arena-${type}-${new Date().toISOString().slice(0, 10)}.csv` });
    }

    return send({ ok: false, error: 'UNKNOWN_ROUTE: ' + route }, 404);
  } catch (e) {
    const code = e.code === 'NO_KEY' ? 503 : 500;
    return send({ ok: false, error: e.message }, code);
  }
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleAPI(req, res, url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel.startsWith('/uploads/')) {
      const p = path.normalize(path.join(UPLOADS_DIR, rel.slice('/uploads/'.length)));
      if (!p.startsWith(UPLOADS_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
      return sendFile(res, p);
    }
    const p = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!p.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    return sendFile(res, p);
  } catch (e) {
    res.writeHead(500); res.end('Server error: ' + e.message);
  }
});

server.listen(CFG.PORT, '0.0.0.0', () => {
  const brains = Object.entries(PROVIDERS).map(([id, p]) => `${p.key ? '✔' : '✖'} ${p.label}`).join('  ');
  console.log(`
  ┌────────────────────────────────────────────────────────────────────┐
  │  ⚡ IdeaBox Arena — Month 3 Week 4 Practical Week                   │
  │                                                                    │
  │  UI:        http://localhost:${String(CFG.PORT).padEnd(37)}│
  │  Brains:    ${brains.padEnd(55)}│
  │  Grader:    ${(STATE.graderBrain + ' · board: ' + STATE.boardMode + ' mode').padEnd(55)}│
  │  Sign-in:   one form — username + password (see data/users.json)  │
  └────────────────────────────────────────────────────────────────────┘`);
});
