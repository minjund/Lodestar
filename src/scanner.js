'use strict';

// GSD/.planning 산출물을 "읽어서" phase·진행도·논의 질문을 역산하는 모듈.
// 절대 GSD 워크플로우를 다시 돌리거나 소스를 수정하지 않는다 (읽기 전용).

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

// 비동기 git (메인 이벤트루프 블로킹 방지)
function gitA(projectPath, args) {
  return execFileP('git', ['-C', projectPath, ...args], {
    encoding: 'utf8', timeout: 8000, windowsHide: true,
  }).then(r => (r.stdout || '').trim()).catch(() => null);
}

// ---------- 저수준 유틸 ----------

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// ---------- git 상태 (읽기 전용 조회) ----------
function git(projectPath, args) {
  try {
    return execFileSync('git', ['-C', projectPath, ...args], {
      encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

async function scanGit(projectPath) {
  // status·log 를 비동기 병렬 호출 (블로킹 없음 + wall-clock 단축)
  const [sb, last, recentRaw] = await Promise.all([
    gitA(projectPath, ['status', '-sb', '--porcelain']),
    gitA(projectPath, ['log', '-1', '--format=%h%x1f%s%x1f%cr%x1f%cI']),
    gitA(projectPath, ['log', '-8', '--date=iso-strict', '--format=%h%x1f%s%x1f%cr%x1f%cI%x1e']),
  ]);
  if (sb == null) return { isRepo: false };
  const sbLines = sb.split(/\r?\n/);
  const header = sbLines[0] || '';      // "## branch...upstream [ahead N, behind M]"
  const statusLines = sbLines.slice(1).filter(Boolean);
  const dirty = statusLines.length;

  let branch = null, upstream = null, ahead = null, behind = null;
  let h = header.replace(/^##\s*/, '');
  const lb = h.indexOf(' [');
  if (lb >= 0) {
    const ab = h.slice(lb + 2).replace(/\]\s*$/, '');
    h = h.slice(0, lb);
    const am = ab.match(/ahead (\d+)/); const bm = ab.match(/behind (\d+)/);
    ahead = am ? parseInt(am[1], 10) : 0;
    behind = bm ? parseInt(bm[1], 10) : 0;
  }
  const dots = h.indexOf('...');
  if (dots >= 0) {
    branch = h.slice(0, dots); upstream = h.slice(dots + 3);
    if (ahead == null) { ahead = 0; behind = 0; }
  } else {
    branch = h || null;  // detached: "HEAD (no branch)"
  }

  // 최근 커밋
  let lastCommit = null;
  if (last) {
    const [hash, subject, rel, iso] = last.split(String.fromCharCode(31));
    lastCommit = { hash, subject, rel, iso };
  }

  const recentCommits = [];
  if (recentRaw) {
    for (const rec of recentRaw.split(String.fromCharCode(30)).filter(Boolean)) {
      const [hash, subject, rel, iso] = rec.trim().split(String.fromCharCode(31));
      if (hash) recentCommits.push({ hash, subject: subject || '', rel: rel || '', iso: iso || '' });
    }
  }
  const statusFiles = statusLines.slice(0, 12).map(line => ({
    code: line.slice(0, 2).trim() || '??',
    file: line.slice(3).trim() || line.trim(),
  }));

  return { isRepo: true, branch, dirty, ahead, behind, upstream, lastCommit, recentCommits, statusFiles };
}

// ---------- Claude Code 세션 로그에서 서브에이전트 활동 추출 ----------
// WCC 서브에이전트(wcc-executor/planner/verifier 등) 진행을 타임스탬프와 함께 읽는다.
// 경로 → Claude Code 세션 폴더 슬러그. 콜론·슬래시·역슬래시·언더스코어를 모두 '-'.
// 주의: 정규식 [:\\/] 는 백슬래시를 못 잡는 환경이 있어, replaceAll 로 명시 치환한다.
function pathToSlug(p) {
  const bs = String.fromCharCode(92);
  return String(p).split(bs).join('-').split('/').join('-').split(':').join('-').split('_').join('-');
}
function projectsRoot() { return path.join(os.homedir(), '.claude', 'projects'); }

function activityDirs(projectPath) {
  const root = projectsRoot();
  const slug = pathToSlug(projectPath);
  const dirs = [];
  const exact = path.join(root, slug);
  if (exists(exact)) dirs.push({ dir: exact, hint: projectPath });
  for (const d of listDir(root)) {
    if (!d.isDirectory() || d.name === slug || !d.name.startsWith(slug + '-')) continue;
    dirs.push({ dir: path.join(root, d.name), hint: `${projectPath}\\${d.name.slice(slug.length + 1)}` });
  }
  return dirs;
}

function toolHint(c) {
  const i = c.input || {};
  if (c.name === 'Bash') return (i.command || '').slice(0, 60);
  if (c.name === 'Read' || c.name === 'Edit' || c.name === 'Write') return path.basename(i.file_path || '');
  if (c.name === 'Skill') return i.skill || '';
  if (isAskUserQuestionTool(c.name)) return (i.question || i.prompt || i.text || '').slice(0, 80);
  if (c.name === 'Task' || c.name === 'Agent') return i.subagent_type || '';
  if (c.name === 'Grep' || c.name === 'Glob') return i.pattern || '';
  if (c.name === 'WebFetch') return i.url || '';
  if (c.name === 'WebSearch') return i.query || '';
  return '';
}

function isAskUserQuestionTool(name) {
  return /(^|[_:-])ask[_:-]?user[_:-]?question$|AskUserQuestion|request_user_input/i.test(String(name || ''));
}

function askUserChoices(input) {
  const raw = input && (input.options || input.choices || input.answers || input.buttons || input.items);
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === 'string') return { label: item, value: item };
    if (!item || typeof item !== 'object') return null;
    const label = item.label || item.title || item.text || item.name || item.value || '';
    const value = item.value || item.answer || item.text || label;
    const description = item.description || item.detail || item.help || '';
    return label ? { label: String(label), value: String(value || label), description: String(description || '') } : null;
  }).filter(Boolean).slice(0, 8);
}

function textDecisionSegment(text) {
  const s = String(text || '');
  const markers = [
    /▶\s*결정\s*요청[^\n]*/gi,
    /논의할\s+회색\s+영역/gi,
    /방향\s*결정\s*필요/gi,
    /결정\s*필요/gi,
    /필요한\s*결정/gi,
    /사용자\s*결정/gi,
    /진짜\s*갈림길/gi,
    /상충\s*상황/gi,
    /어떻게\s+진행할까요\??/gi,
    /아래에서[^\n]*(?:번호|영역)[^\n]*/gi,
    /어느\s+쪽으로\s+할까요\??/gi,
  ];
  let idx = -1;
  for (const pattern of markers) {
    for (const m of s.matchAll(pattern)) idx = Math.max(idx, m.index || 0);
  }
  return (idx >= 0 ? s.slice(idx) : s.slice(-5000)).trim();
}

function numberedTextChoices(segment) {
  const s = String(segment || '').replace(/\r/g, '\n');
  const choices = [];
  const re = /(?:^|\n|\s)(\d{1,2})[.)]\s+([\s\S]*?)(?=(?:\n|\s)\d{1,2}[.)]\s+|$)/g;
  for (const m of s.matchAll(re)) {
    const num = m[1];
    let raw = String(m[2] || '').trim();
    if (!raw) continue;
    raw = raw.replace(/\n{2,}[\s\S]*$/g, '').trim();
    const firstLine = raw.split(/\n/).map(x => x.trim()).find(Boolean) || raw;
    const clean = firstLine.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 2) continue;
    choices.push({
      label: `${num}. ${clean.slice(0, 96)}`,
      value: num,
      description: raw.replace(firstLine, '').replace(/\s+/g, ' ').trim().slice(0, 220),
    });
  }
  return choices.slice(0, 8);
}

function textDecisionPrompt(segment) {
  const s = String(segment || '');
  const firstChoice = s.search(/(?:^|\n|\s)\d{1,2}[.)]\s+/);
  const head = firstChoice >= 0 ? s.slice(0, firstChoice) : s;
  const lines = head.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/^[-*#>\s]+/, '').trim();
    if (/(방향\s*결정\s*필요|결정\s*필요|필요한\s*결정|사용자\s*결정|진짜\s*갈림길|상충\s*상황|결정\s*요청|어떻게\s+진행|어느\s+쪽|번호|선택|골라|논의할\s+영역|회색\s+영역)/.test(line)) return line.slice(0, 220);
  }
  return '사용자 결정이 필요합니다. 번호를 선택하거나 직접 답변하세요.';
}

function textDecisionQuestionFromAssistant(text, firstUser) {
  const s = String(text || '');
  if (!s.trim()) return null;
  const kind = sessionWorkflowKind(firstUser, s);
  const wccDiscuss = kind === 'discuss' || /\/?wcc[:-]discuss-phase|\/wcc-discuss-phase/i.test(`${firstUser || ''}\n${s}`);
  const decisionCue = /(방향\s*결정\s*필요|결정\s*필요|필요한\s*결정|사용자\s*결정|진짜\s*갈림길|상충\s*상황|결정\s*요청|논의할\s+회색\s+영역|번호로\s*(알려|선택)|번호를\s*(알려|선택)|골라\s*주세요|선택(?:해|하세요)|어떻게\s+진행할까요|어느\s+쪽으로\s+할까요)/i.test(s);
  if (!wccDiscuss && !decisionCue) return null;
  const segment = textDecisionSegment(s);
  let choices = numberedTextChoices(segment);
  if (choices.length < 2 && /옵션\s*1|옵션1/i.test(segment) && /08-02-PLAN|PLAN|플랜/i.test(segment)) {
    choices = [
      { label: '1. 승인된 옵션1로 진행', value: '1', description: 'RefundTarget 6필드와 UI 확장까지 반영해서 진행' },
      { label: '2. 현재 08-02-PLAN 경계 유지', value: '2', description: '어댑터 본문 범위만 유지하고 환불 잔여는 보류' },
    ];
  }
  if (choices.length < 2) return null;
  if (!/(결정|갈림길|상충|번호|선택|골라|논의할|회색|어떻게\s+진행|어느\s+쪽)/i.test(segment.slice(0, 1200))) return null;
  return {
    ts: null,
    id: `text-decision-${choices.map(c => c.value).join('-')}`,
    question: textDecisionPrompt(segment),
    choices,
    freeText: true,
    done: false,
    inferred: true,
  };
}

function looksLikeBlocked(text) {
  const tail = String(text || '').slice(-1200).trim();
  return /(session limit|usage limit|rate limit|quota|resets\s+\d|try again later|too many requests|hit your .*limit|사용량\s*한도|요청\s*한도|한도\s*초과|제한에\s*도달)/i.test(tail);
}

function resetTime(text) {
  const m = String(text || '').match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2] || '00', 10);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function resetPassed(text, basisTs, nowMs) {
  const rt = resetTime(text);
  if (!rt || !basisTs || !Number.isFinite(nowMs)) return false;
  const basis = new Date(Date.parse(basisTs));
  if (Number.isNaN(basis.getTime())) return false;
  const resetAt = new Date(basis);
  resetAt.setHours(rt.hour, rt.minute, 0, 0);
  // If the message was logged after the reset clock time, the reset points to
  // the next local day. Otherwise it is the same local date as the message.
  if (resetAt.getTime() <= basis.getTime() - 60 * 1000) resetAt.setDate(resetAt.getDate() + 1);
  return nowMs >= resetAt.getTime();
}

function activeBlocked(text, basisTs, nowMs) {
  if (!looksLikeBlocked(text)) return false;
  if (resetPassed(text, basisTs, nowMs)) return false;
  return true;
}

function sessionWorkflowKind(firstUser, lastAssistantText) {
  const s = `${firstUser || ''}\n${lastAssistantText || ''}`;
  if (/\/?wcc[:-]quick|\/wcc-quick|WCC\s*▸\s*QUICK|Quick Task/i.test(s)) return 'quick';
  if (/\/?wcc[:-]debug|\/wcc-debug|debug-session/i.test(s)) return 'debug';
  if (/\/?wcc[:-]sketch|\/wcc-sketch/i.test(s)) return 'sketch';
  if (/\/?wcc[:-]review|\/wcc-review/i.test(s)) return 'review';
  if (/\/?wcc[:-]discuss-phase|\/wcc-discuss-phase/i.test(s)) return 'discuss';
  if (/\/?wcc[:-]progress|\/wcc-progress/i.test(s)) return 'progress';
  return 'session';
}

function userTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c && (c.type === 'text' || typeof c.text === 'string'))
    .map(c => c.text || '')
    .join('');
}

function normalizeTokenUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (...keys) => keys.reduce((sum, key) => sum + (Number(raw[key]) || 0), 0);
  const usage = {
    input: pick('input_tokens', 'inputTokens'),
    output: pick('output_tokens', 'outputTokens'),
    cacheCreate: pick('cache_creation_input_tokens', 'cacheCreationInputTokens'),
    cacheRead: pick('cache_read_input_tokens', 'cacheReadInputTokens'),
  };
  usage.total = usage.input + usage.output + usage.cacheCreate + usage.cacheRead;
  return usage.total ? usage : null;
}

function mergeTokenUsage(prev, next) {
  if (!next) return prev || null;
  if (!prev) return { ...next };
  return {
    input: (prev.input || 0) + (next.input || 0),
    output: (prev.output || 0) + (next.output || 0),
    cacheCreate: (prev.cacheCreate || 0) + (next.cacheCreate || 0),
    cacheRead: (prev.cacheRead || 0) + (next.cacheRead || 0),
    total: (prev.total || 0) + (next.total || 0),
  };
}

function tokenUsageFromEvent(event) {
  return normalizeTokenUsage(event && (event.usage || (event.message && event.message.usage)));
}

function quotaRemainingFromText(text, ts) {
  const s = String(text || '');
  if (!s) return null;
  const readPct = (pattern) => {
    const m = s.match(pattern);
    if (!m) return null;
    const pct = Math.max(0, Math.min(100, parseInt(m[1], 10)));
    return {
      pct,
      reset: m[2] || '',
    };
  };
  const readModelPct = () => {
    const lines = s.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/[◆🔷]\s*(?:opus(?:\([^)]*\))?|sonnet|haiku|claude|gpt[-\w.]*)\b[^\n%]{0,160}?(\d{1,3})\s*%(?:\s*\(([^)]+)\))?/i)
        || line.match(/\b(?:opus(?:\([^)]*\))?|sonnet|haiku|claude|gpt[-\w.]*|소넷)\b[^\n%]{0,160}?(\d{1,3})\s*%(?:\s*\(([^)]+)\))?/i);
      if (!m) continue;
      return {
        pct: Math.max(0, Math.min(100, parseInt(m[1], 10))),
        reset: m[2] || '',
      };
    }
    return null;
  };
  const fiveHour = readPct(/(?:5\s*시간|5h|5\s*hour)[^\d%]{0,24}(\d{1,3})\s*%(?:\s*\(([^)]+)\))?/i);
  const sevenDay = readPct(/(?:7\s*일|7d|7\s*day)[^\d%]{0,24}(\d{1,3})\s*%(?:\s*\(([^)]+)\))?/i);
  const sonnet = readModelPct();
  if (!fiveHour && !sevenDay && !sonnet) return null;
  return {
    fiveHour: fiveHour || null,
    sevenDay: sevenDay || null,
    sonnet: sonnet || null,
    ts: ts || null,
  };
}

function mergeQuotaRemaining(prev, next) {
  if (!next) return prev || null;
  if (!prev) return { ...next };
  const pt = prev.ts ? Date.parse(prev.ts) : 0;
  const nt = next.ts ? Date.parse(next.ts) : 0;
  const newer = nt && (!pt || nt >= pt);
  const out = { ...prev };
  for (const key of ['fiveHour', 'sevenDay', 'sonnet']) {
    if (newer) {
      if (next[key]) out[key] = next[key];
    } else if (!out[key] && next[key]) {
      out[key] = next[key];
    }
  }
  out.ts = newer ? (next.ts || prev.ts || null) : (prev.ts || next.ts || null);
  return out;
}

function subagentHintFromText(text) {
  const s = String(text || '');
  if (!/subagent\s*실행\s*중|서브\s*에이전트\s*실행|서브에이전트.*실행|background agent/i.test(s)) return null;
  const line = s.split(/\r?\n/).map(x => x.trim()).find(x =>
    /subagent\s*실행\s*중|서브\s*에이전트\s*실행|서브에이전트.*실행|background agent/i.test(x)
  ) || s.trim().split(/\r?\n/)[0] || 'subagent 실행 중';
  const named = s.match(/[●◯]\s*([a-z0-9_-]*(?:executor|manager|agent)[a-z0-9_-]*)/i)
    || s.match(/([a-z0-9_-]*(?:executor|manager|agent)[a-z0-9_-]*)/i);
  return {
    sub: named ? named[1] : 'subagent',
    desc: line.replace(/`/g, '').slice(0, 180),
  };
}

// 하나의 세션 jsonl을 파싱해 활동(에이전트/도구/타임스탬프)을 추출.
// aux=자동 보조 세션(Hermes 메모리 추출 등) 여부도 판별한다.
function parseSession(file) {
  let lines, tail = false;
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return null; }
  const agents = [];
  const shells = [];
  const askUserQuestions = [];
  const doneIds = new Set();
  const recentTools = [];
  let lastTs = null, sessionId = null, firstUser = null, cwd = null, toolCount = 0, userMsgs = 0;
  let lastTurn = null, lastAssistantText = '', lastAssistantTs = null;
  let lastUserTextTs = null;
  let tokenUsage = null;
  let quotaRemaining = null;
  const modelUsage = {};

  for (const l of lines) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.sessionId) sessionId = o.sessionId;
    if (!cwd) cwd = o.cwd || o.projectPath || (o.message && (o.message.cwd || (o.message.metadata && o.message.metadata.cwd))) || null;
    if (o.timestamp) lastTs = o.timestamp;
    const usage = tokenUsageFromEvent(o);
    if (usage) {
      tokenUsage = o.type === 'result' ? usage : mergeTokenUsage(tokenUsage, usage);
      const model = String(o.model || (o.message && o.message.model) || '').toLowerCase();
      if (model) modelUsage[model] = mergeTokenUsage(modelUsage[model], usage);
    }
    if (o.type === 'user' && o.message) {
      userMsgs++;
      const userText = userTextFromContent(o.message.content);
      if (firstUser == null) {
        firstUser = userText;
      }
      if (Array.isArray(o.message.content)) {
        for (const c of o.message.content) if (c.type === 'tool_result' && c.tool_use_id) doneIds.add(c.tool_use_id);
      }
      const hint = subagentHintFromText(userText);
      if (hint && !agents.some(a => a.id === `pseudo-subagent-${agents.length + 1}` || a.desc === hint.desc)) {
        agents.push({ ts: o.timestamp || lastTs, sub: hint.sub, desc: hint.desc, id: `pseudo-subagent-${agents.length + 1}`, done: false, inferred: true });
      }
      if (userText.trim()) {
        quotaRemaining = mergeQuotaRemaining(quotaRemaining, quotaRemainingFromText(userText, o.timestamp || lastTs));
        lastTurn = 'user';
        lastUserTextTs = o.timestamp || lastTs;
      }
    }
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const c of o.message.content) {
        if (c.type === 'text' && c.text) {
          lastAssistantText = c.text;
          lastAssistantTs = o.timestamp || lastTs;
          quotaRemaining = mergeQuotaRemaining(quotaRemaining, quotaRemainingFromText(c.text, lastAssistantTs));
          lastTurn = 'assistant';
          const hint = subagentHintFromText(c.text);
          if (hint && !agents.some(a => a.desc === hint.desc)) {
            agents.push({ ts: o.timestamp || lastTs, sub: hint.sub, desc: hint.desc, id: `pseudo-subagent-${agents.length + 1}`, done: false, inferred: true });
          }
          continue;
        }
        if (c.type !== 'tool_use') continue;
        toolCount++;
        if (c.name === 'Agent' || c.name === 'Task') {
          agents.push({ ts: o.timestamp, sub: (c.input && c.input.subagent_type) || '?', desc: (c.input && c.input.description) || '', id: c.id, done: false });
        }
        if (c.name === 'Bash') {
          const input = c.input || {};
          shells.push({
            ts: o.timestamp,
            sub: 'shell',
            desc: input.description || input.command || 'Bash 실행 중',
            command: input.command || '',
            id: c.id,
            done: false,
          });
        }
        if (isAskUserQuestionTool(c.name)) {
          const input = c.input || {};
          askUserQuestions.push({
            ts: o.timestamp,
            id: c.id,
            question: input.question || input.prompt || input.text || lastAssistantText || '사용자 답변이 필요합니다.',
            choices: askUserChoices(input),
            freeText: input.freeText !== false && input.allowText !== false && input.textInput !== false,
            done: false,
          });
        }
        recentTools.push({ ts: o.timestamp, name: c.name, hint: toolHint(c) });
      }
    }
  }
  for (const a of agents) if (doneIds.has(a.id)) a.done = true;
  for (const a of agents) {
    if (!a.inferred || a.done) continue;
    const aTs = a.ts ? Date.parse(a.ts) : 0;
    const laterAssistantTs = lastAssistantTs ? Date.parse(lastAssistantTs) : 0;
    if (aTs && laterAssistantTs && laterAssistantTs - aTs > 30 * 1000 && !subagentHintFromText(lastAssistantText)) {
      a.done = true;
    }
  }
  for (const s of shells) if (doneIds.has(s.id)) s.done = true;
  for (const a of agents) a.sessionId = sessionId;
  for (const s of shells) s.sessionId = sessionId;
  const textDecision = textDecisionQuestionFromAssistant(lastAssistantText, firstUser);
  if (textDecision) {
    textDecision.ts = lastAssistantTs || lastTs;
    askUserQuestions.push(textDecision);
  }
  for (const q of askUserQuestions) {
    const qTs = q.ts ? Date.parse(q.ts) : 0;
    const userTs = lastUserTextTs ? Date.parse(lastUserTextTs) : 0;
    if (doneIds.has(q.id) || (qTs && userTs && userTs > qTs)) q.done = true;
  }

  // 자동 보조 세션: Hermes 메모리 추출 등 (도구 없고 정형 프롬프트로 시작).
  // 큰 파일(tail)은 끝부분만 읽어 firstUser가 부정확하지만, 보조 세션은 항상 작으므로 큰 파일은 aux 아님.
  const aux = !tail && /Extract durable memory candidates|Return ONLY JSON|transcript tail/i.test(firstUser || '');
  const pendingQuestions = askUserQuestions.filter(q => !q.done);
  const pendingQuestion = pendingQuestions[pendingQuestions.length - 1] || null;
  const awaiting = pendingQuestions.length > 0;
  const blocked = looksLikeBlocked(lastAssistantText);
  const awaitingText = pendingQuestions.length > 1
    ? pendingQuestions.map((q, idx) => `${idx + 1}. ${q.question}`).join('\n')
    : (pendingQuestion ? pendingQuestion.question : lastAssistantText);

  return {
    file, sessionId, lastTs, cwd, agents, shells, recentTools, toolCount, userMsgs, aux,
    awaiting, blocked,
    pendingQuestion,
    pendingQuestions,
    firstUser,
    workflowKind: sessionWorkflowKind(firstUser, lastAssistantText),
    tokenUsage,
    modelUsage,
    quotaRemaining,
    lastAssistantText: pendingQuestion ? awaitingText : lastAssistantText,
    lastAssistantTs: pendingQuestion ? pendingQuestion.ts : lastAssistantTs,
  };
}

// 세션의 subagents 폴더에서 가장 최근 .jsonl mtime (서브에이전트 실시간 활동 시각).
function latestSubMtime(dir, sessionId) {
  if (!sessionId) return 0;
  const sub = path.join(dir, sessionId, 'subagents');
  let max = 0;
  for (const f of listDir(sub)) {
    if (f.isFile() && f.name.endsWith('.jsonl')) {
      try { const t = fs.statSync(path.join(sub, f.name)).mtimeMs; if (t > max) max = t; } catch {}
    }
  }
  return max;
}

function latestSubAgent(dir, sessionId, agents) {
  if (!sessionId) return null;
  const sub = path.join(dir, sessionId, 'subagents');
  const byId = new Map((agents || []).map(a => [a.id, a]));
  let latest = null;
  for (const f of listDir(sub)) {
    if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
    const jsonl = path.join(sub, f.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(jsonl).mtimeMs; } catch { continue; }
    const aid = f.name.replace(/\.jsonl$/, '');
    let meta = {};
    try { meta = JSON.parse(readText(path.join(sub, aid + '.meta.json')) || '{}'); } catch {}
    const parent = byId.get(meta.toolUseId) || null;
    const item = {
      sub: (meta && meta.agentType) || (parent && parent.sub) || aid.replace(/^agent-/, ''),
      desc: (meta && meta.description) || (parent && parent.desc) || '',
      id: (meta && meta.toolUseId) || (parent && parent.id) || aid,
      sessionId,
      ts: parent && parent.ts ? parent.ts : null,
      done: parent ? !!parent.done : false,
      mtimeMs,
    };
    if (!latest || item.mtimeMs > latest.mtimeMs) latest = item;
  }
  return latest;
}

// 프로젝트의 세션 중 "실제 작업 세션"을 골라 활동을 추출한다.
// 최신 mtime부터 보되, 자동 보조 세션은 건너뛰고 도구/에이전트 활동이 있는 세션을 택한다.
function scanActivity(projectPath, nowMs) {
  const dirs = activityDirs(projectPath);
  if (!dirs.length) return { hasLog: false };

  const cands = [];
  for (const source of dirs) {
    for (const f of listDir(source.dir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      try { cands.push({ p: path.join(source.dir, f.name), t: fs.statSync(path.join(source.dir, f.name)).mtimeMs, dir: source.dir, hint: source.hint }); } catch {}
    }
  }
  cands.sort((a, b) => b.t - a.t);

  const LIVE_MS = 5 * 60 * 1000;
  const AGENT_LIVE_MS = 2 * 60 * 60 * 1000;
  const INFERRED_AGENT_LIVE_MS = 10 * 60 * 1000;
  const STALE_AGENT_MS = 60 * 60 * 1000;
  const SHELL_LIVE_MS = 30 * 60 * 1000;
  const RECENT_AGENT_MS = 15 * 60 * 1000;
  const AWAITING_MS = 24 * 60 * 60 * 1000;
  let chosen = null, fallback = null, withRunning = null, withAttention = null, skippedAux = 0;
  const parsedSessions = [];
  for (const c of cands.slice(0, 15)) {
    const r = parseSession(c.p);
    if (!r) continue;
    r.mtimeMs = c.t;
    r.logDir = c.dir;
    r.cwdHint = r.cwd || c.hint;
    r.blocked = activeBlocked(r.lastAssistantText, r.lastAssistantTs || r.lastTs, nowMs);
    if (!r.aux) parsedSessions.push(r);
    if (!fallback) fallback = r;
    if (r.aux) { skippedAux++; continue; }
    // 사용자 개입/한도 초과는 "실행중"보다 우선한다. 같은 세션에 미완료
    // 에이전트가 남아 있어도, 마지막 assistant 메시지가 제한/질문이면 멈춘 상태다.
    if (r.awaiting || r.blocked) { withAttention = r; break; }
    if (!chosen && (r.toolCount > 0 || r.agents.length > 0 || r.shells.length > 0 || r.awaiting || r.blocked)) chosen = r;
    // 진행 중(미완료) 에이전트가 있는 세션을 최우선 — 최신 세션 하나만 보고 멈춰
    // 단, 오래 멈춘 실행 세션은 답변 대기 세션을 가리지 않게 우선순위에서 제외한다.
    if (r.agents.some(a => !a.done) || r.shells.some(s => !s.done)) {
      const mainTs = r.lastTs ? Date.parse(r.lastTs) : 0;
      const effTs = Math.max(mainTs, latestSubMtime(r.logDir, r.sessionId));
      const hasShell = r.shells.some(s => !s.done);
      const hasRealAgent = r.agents.some(a => !a.done && !a.inferred);
      const agentLiveMs = hasRealAgent ? AGENT_LIVE_MS : INFERRED_AGENT_LIVE_MS;
      if (effTs && nowMs - effTs < (hasShell ? SHELL_LIVE_MS : agentLiveMs)) { withRunning = r; break; }
    }
  }
  const r = withAttention || withRunning || chosen || fallback;
  if (!r) return { hasLog: false };

  const running = r.agents.filter(a => !a.done);
  const runningShells = r.shells.filter(s => !s.done);
  const recentSub = latestSubAgent(r.logDir, r.sessionId, r.agents);
  // 서브에이전트가 도는 동안 메인 jsonl 은 갱신되지 않고 subagents/*.jsonl 만 갱신된다.
  // 따라서 활동 시각은 메인 lastTs 와 서브에이전트 파일 최신 mtime 중 큰 값으로 본다.
  const mainTs = r.lastTs ? Date.parse(r.lastTs) : 0;
  const subTs = recentSub ? recentSub.mtimeMs : 0;
  const latestShell = runningShells[runningShells.length - 1] || null;
  const shellTs = latestShell && latestShell.ts ? Date.parse(latestShell.ts) : 0;
  const effTs = Math.max(mainTs, subTs, shellTs);
  const ageMs = effTs ? (nowMs - effTs) : Infinity;
  // 활동이 멈춘 지 오래면 끝나지 않은 에이전트가 남아 있어도 "진행 중"으로 보지 않는다.
  const blocked = r.blocked && ageMs < AWAITING_MS;
  const awaiting = !blocked && r.awaiting && ageMs < AWAITING_MS;
  const latestRunning = recentSub && running.some(a => a.id === recentSub.id) ? recentSub : running[running.length - 1];
  const currentAgentLiveMs = latestRunning && latestRunning.inferred ? INFERRED_AGENT_LIVE_MS : AGENT_LIVE_MS;
  const currentAgent = (!blocked && !awaiting && running.length && ageMs < currentAgentLiveMs) ? latestRunning : null;
  const currentShell = (!blocked && !awaiting && !currentAgent && latestShell && shellTs && nowMs - shellTs < SHELL_LIVE_MS) ? latestShell : null;
  const current = currentAgent || (currentShell ? {
    sub: 'shell',
    desc: currentShell.desc || currentShell.command || 'Bash 실행 중',
    command: currentShell.command || '',
    ts: currentShell.ts,
    id: currentShell.id,
    sessionId: currentShell.sessionId || r.sessionId,
    kind: 'shell',
  } : null);
  const recentAgent = (!blocked && !awaiting && !current && recentSub && nowMs - recentSub.mtimeMs < RECENT_AGENT_MS) ? recentSub : null;
  const currentStatus = current && (current.kind || 'agent') === 'agent' && ageMs > STALE_AGENT_MS ? 'stale' : 'running';

  return {
    hasLog: true, sessionId: r.sessionId, file: path.basename(r.file), lastTs: r.lastTs, cwd: r.cwd || '', cwdHint: r.cwdHint || projectPath,
    live: ageMs < LIVE_MS, ageSec: Math.round(ageMs / 1000),
    agentCount: r.agents.length,
    shellCount: r.shells.length,
    agents: r.agents.slice(-40),
    shells: r.shells.slice(-40),
    current: current ? { sub: current.sub, desc: current.desc, command: current.command || '', ts: current.ts, id: current.id, sessionId: current.sessionId || r.sessionId, inferred: !!current.inferred, kind: current.kind || 'agent', status: currentStatus } : null,
    recentAgent: recentAgent ? {
      sub: recentAgent.sub,
      desc: recentAgent.desc,
      ts: recentAgent.ts,
      id: recentAgent.id,
      sessionId: recentAgent.sessionId || r.sessionId,
      inferred: !!recentAgent.inferred,
      status: recentAgent.done ? 'done' : 'recent',
    } : null,
    awaiting,
    awaitingText: awaiting ? r.lastAssistantText : '',
    awaitingTs: awaiting ? r.lastAssistantTs : null,
    awaitingQuestion: awaiting && r.pendingQuestion ? r.pendingQuestion : null,
    awaitingQuestions: awaiting ? (r.pendingQuestions || []) : [],
    blocked,
    blockedText: blocked ? r.lastAssistantText : '',
    tokenUsage: r.tokenUsage || null,
    modelUsage: r.modelUsage || {},
    quotaRemaining: r.quotaRemaining || null,
    sessions: parsedSessions.slice(0, 8).map(s => ({
      sessionId: s.sessionId,
      file: path.basename(s.file),
      lastTs: s.lastTs,
      ageSec: Math.round((nowMs - (s.mtimeMs || 0)) / 1000),
      toolCount: s.toolCount,
      agentCount: s.agents.length,
      shellCount: s.shells.length,
      running: s.agents.some(a => !a.done) || s.shells.some(sh => !sh.done),
      awaiting: s.awaiting,
      blocked: s.blocked,
      awaitingQuestion: s.pendingQuestion || null,
      awaitingQuestions: s.pendingQuestions || [],
      workflowKind: s.workflowKind || 'session',
      firstUser: (s.firstUser || '').slice(0, 600),
      tokenUsage: s.tokenUsage || null,
      modelUsage: s.modelUsage || {},
      quotaRemaining: s.quotaRemaining || null,
      cwd: s.cwd || '',
      cwdHint: s.cwdHint || '',
      excerpt: (s.lastAssistantText || '').slice(-600),
    })),
    recentTools: r.recentTools.slice(-12),
    skippedAux,
  };
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function statMtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function latestTreeMtimeMs(p, depth = 2) {
  let max = statMtimeMs(p);
  if (depth <= 0) return max;
  for (const f of listDir(p)) {
    const fp = path.join(p, f.name);
    if (f.isDirectory()) max = Math.max(max, latestTreeMtimeMs(fp, depth - 1));
    else if (f.isFile()) max = Math.max(max, statMtimeMs(fp));
  }
  return max;
}

function firstHeading(file) {
  const text = readText(file) || '';
  const fm = parseFrontmatter(text) || {};
  if (fm.title) return String(fm.title);
  if (fm.slug) return String(fm.slug);
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

function cleanArtifactTitle(name, fallback = '') {
  return String(name || fallback || '')
    .replace(/\.(md|html)$/i, '')
    .replace(/^\d{6}-[a-z0-9]+-/i, '')
    .replace(/^\d{3}-/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

function planningArtifact(kind, dir, name, opts = {}) {
  const target = opts.file || dir;
  const mtimeMs = opts.mtimeMs || latestTreeMtimeMs(target, opts.depth ?? 2);
  const title = opts.title || firstHeading(target) || cleanArtifactTitle(name);
  return {
    kind,
    name,
    title: title || name,
    status: opts.status || '',
    path: target,
    active: !!opts.active,
    bucket: opts.bucket || (opts.active ? 'current' : 'history'),
    mtimeMs,
    ageSec: mtimeMs ? Math.max(0, Math.round((Date.now() - mtimeMs) / 1000)) : null,
  };
}

function scanQuickArtifacts(planningDir) {
  const root = path.join(planningDir, 'quick');
  const RECENT_MS = 48 * 60 * 60 * 1000;
  const now = Date.now();
  return listDir(root)
    .filter(d => d.isDirectory())
    .map(d => {
      const dir = path.join(root, d.name);
      const summary = listDir(dir).find(f => f.isFile() && /SUMMARY\.md$/i.test(f.name));
      const plan = listDir(dir).find(f => f.isFile() && /PLAN\.md$/i.test(f.name));
      const file = summary ? path.join(dir, summary.name) : (plan ? path.join(dir, plan.name) : dir);
      const item = planningArtifact('quick', dir, d.name, {
        file,
        title: firstHeading(file) || cleanArtifactTitle(d.name),
        status: summary ? 'done' : 'plan',
        active: !summary,
        bucket: summary ? 'history' : 'current',
        mtimeMs: latestTreeMtimeMs(dir, 1),
      });
      return item;
    })
    .filter(x => x.mtimeMs && now - x.mtimeMs <= RECENT_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 2);
}

function scanDebugArtifacts(planningDir) {
  const root = path.join(planningDir, 'debug');
  return listDir(root)
    .filter(f => f.isFile() && f.name.endsWith('.md'))
    .map(f => {
      const file = path.join(root, f.name);
      const text = readText(file) || '';
      const fm = parseFrontmatter(text) || {};
      const status = String(fm.status || '').toLowerCase();
      const active = !!status && !/complete|completed|resolved|abandoned|done/.test(status);
      const focus = (text.match(/next_action:\s*"?([^"\n]+)"?/i) || [])[1] || '';
      return planningArtifact('debug', root, f.name, {
        file,
        title: firstHeading(file) || cleanArtifactTitle(f.name),
        status: status || 'debug',
        active,
        bucket: active ? 'current' : 'history',
        mtimeMs: statMtimeMs(file),
        depth: 0,
        focus,
      });
    })
    .filter(x => x.active || (x.mtimeMs && Date.now() - x.mtimeMs <= 7 * 24 * 60 * 60 * 1000))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.mtimeMs - a.mtimeMs)
    .slice(0, 2);
}

function scanSketchArtifacts(planningDir) {
  const root = path.join(planningDir, 'sketches');
  return listDir(root)
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'themes')
    .map(d => {
      const dir = path.join(root, d.name);
      const readme = path.join(dir, 'README.md');
      return planningArtifact('sketch', dir, d.name, {
        file: exists(readme) ? readme : dir,
        title: firstHeading(readme) || cleanArtifactTitle(d.name),
        bucket: 'history',
        mtimeMs: latestTreeMtimeMs(dir, 1),
      });
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 2);
}

function scanMilestoneArtifacts(planningDir, state) {
  const root = path.join(planningDir, 'milestones');
  const current = state && state.milestone ? String(state.milestone) : '';
  const files = listDir(root)
    .filter(f => f.isFile() && /\.(md)$/i.test(f.name))
    .map(f => planningArtifact('milestone', root, f.name, {
      file: path.join(root, f.name),
      title: cleanArtifactTitle(f.name),
      status: f.name.includes(current) ? 'current' : '',
      active: !!current && f.name.includes(current),
      bucket: !!current && f.name.includes(current) ? 'current' : 'history',
      mtimeMs: statMtimeMs(path.join(root, f.name)),
      depth: 0,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.mtimeMs - a.mtimeMs)
    .slice(0, 2);
  return files;
}

function scanPlanningArtifacts(planningDir, state) {
  const quick = scanQuickArtifacts(planningDir);
  const debug = scanDebugArtifacts(planningDir);
  const sketches = scanSketchArtifacts(planningDir);
  const milestones = scanMilestoneArtifacts(planningDir, state);
  const all = [...debug, ...quick, ...sketches, ...milestones]
    .sort((a, b) => Number(b.active) - Number(a.active) || b.mtimeMs - a.mtimeMs);
  const current = all.filter(x => x.bucket === 'current').slice(0, 6);
  const history = all.filter(x => x.bucket !== 'current').slice(0, 8);
  return {
    quick,
    debug,
    sketches,
    milestones,
    current,
    history,
    events: [...current, ...history].slice(0, 8),
  };
}

// 서브에이전트 상세 실행 내용 읽기 (클릭 시 on-demand).
// <projectsRoot>/<slug>/<sessionId>/subagents/agent-<aid>.{jsonl,meta.json}
//  - meta.json 의 toolUseId 가 메인 세션의 Task tool_use id(agent.id)와 일치하는 파일을 찾는다.
//  - 그 jsonl 에서 프롬프트(첫 user)·도구 호출 타임라인·마지막 출력 텍스트를 추출.
function scanAgentDetail(projectPath, sessionId, toolUseId) {
  if (!sessionId) return { ok: false, error: '세션 정보 없음' };
  const dir = path.join(projectsRoot(), pathToSlug(projectPath), sessionId, 'subagents');
  if (!exists(dir)) return { ok: false, error: '서브에이전트 로그 폴더 없음' };

  // toolUseId 로 meta 매칭 (없으면 가장 최근 agent 파일로 폴백)
  let aid = null, meta = null;
  const metas = listDir(dir).filter(f => f.isFile() && f.name.endsWith('.meta.json'));
  for (const m of metas) {
    try {
      const j = JSON.parse(readText(path.join(dir, m.name)) || '{}');
      if (toolUseId && j.toolUseId === toolUseId) { meta = j; aid = m.name.replace(/\.meta\.json$/, ''); break; }
    } catch {}
  }
  if (!aid) {  // 폴백: 가장 최근 수정된 agent jsonl
    const jl = listDir(dir).filter(f => f.isFile() && f.name.endsWith('.jsonl'))
      .map(f => ({ n: f.name, t: (() => { try { return fs.statSync(path.join(dir, f.name)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.t - a.t);
    if (!jl.length) return { ok: false, error: '서브에이전트 로그 없음' };
    aid = jl[0].n.replace(/\.jsonl$/, '');
    try { meta = JSON.parse(readText(path.join(dir, aid + '.meta.json')) || '{}'); } catch { meta = {}; }
  }

  const jsonl = path.join(dir, aid + '.jsonl');
  const text = readText(jsonl);
  if (text == null) return { ok: false, error: '로그 파일 읽기 실패' };

  let prompt = null, lastText = '', tools = [], firstTs = null, lastTs = null;
  for (const l of text.split(/\r?\n/)) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.timestamp) { if (!firstTs) firstTs = o.timestamp; lastTs = o.timestamp; }
    const m = o.message || {};
    if (o.type === 'user' && prompt == null) {
      const c = m.content;
      prompt = typeof c === 'string' ? c : (Array.isArray(c) ? c.map(x => x.text || '').join('') : '');
    }
    if (o.type === 'assistant' && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'text' && c.text) lastText = c.text;
        else if (c.type === 'tool_use') tools.push({ ts: o.timestamp, name: c.name, hint: toolHint(c) });
      }
    }
  }
  return {
    ok: true,
    agentType: (meta && meta.agentType) || '?',
    description: (meta && meta.description) || '',
    prompt: prompt || '',
    output: lastText || '',
    tools,
    toolCount: tools.length,
    firstTs, lastTs,
  };
}

function scanSessionSubagentSections(projectPath, sessionId) {
  if (!sessionId) return [];
  const dir = path.join(projectsRoot(), pathToSlug(projectPath), sessionId, 'subagents');
  const files = listDir(dir)
    .filter(f => f.isFile() && f.name.endsWith('.jsonl'))
    .map(f => {
      const fp = path.join(dir, f.name);
      return { aid: f.name.replace(/\.jsonl$/, ''), fp, mtimeMs: statMtimeMs(fp) };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(-6);
  const sections = [];
  for (const f of files) {
    let meta = {};
    try { meta = JSON.parse(readText(path.join(dir, f.aid + '.meta.json')) || '{}'); } catch {}
    const text = readText(f.fp);
    if (text == null) continue;
    let prompt = '', output = '', firstTs = null, lastTs = null;
    const tools = [];
    for (const l of text.split(/\r?\n/)) {
      if (!l) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.timestamp) { if (!firstTs) firstTs = o.timestamp; lastTs = o.timestamp; }
      const m = o.message || {};
      if (o.type === 'user' && !prompt) prompt = userTextFromContent(m.content).trim();
      if (o.type === 'assistant' && Array.isArray(m.content)) {
        const assistantText = m.content
          .filter(c => c && c.type === 'text' && c.text)
          .map(c => c.text)
          .join('\n\n')
          .trim();
        if (assistantText) output = assistantText;
        for (const c of m.content) {
          if (c && c.type === 'tool_use') tools.push(`${c.name || 'tool'}${toolHint(c) ? ` · ${toolHint(c)}` : ''}`);
        }
      }
    }
    const title = (meta && meta.agentType) || f.aid.replace(/^agent-/, 'subagent-');
    const desc = (meta && meta.description) || '';
    const body = [
      `### 서브에이전트: ${title}`,
      desc ? `설명: ${desc}` : '',
      prompt ? `지시:\n${prompt.slice(-4000)}` : '',
      output ? `현재까지 출력:\n${output.slice(-12000)}` : '현재까지 출력: 아직 기록된 출력이 없습니다.',
      tools.length ? `도구 호출: ${tools.slice(-12).join(' / ')}` : '',
    ].filter(Boolean).join('\n\n');
    sections.push({ title, desc, prompt, output, tools, firstTs, lastTs, text: body });
  }
  return sections;
}

function scanSessionDetail(projectPath, sessionId) {
  if (!sessionId) return { ok: false, error: '세션 정보 없음' };
  let target = null;
  for (const source of activityDirs(projectPath)) {
    for (const f of listDir(source.dir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const fp = path.join(source.dir, f.name);
      if (f.name.replace(/\.jsonl$/, '') === sessionId) {
        target = fp;
        break;
      }
      try {
        const head = (readText(fp) || '').slice(0, 4000);
        if (head.includes(`"sessionId":"${sessionId}"`) || head.includes(`"sessionId": "${sessionId}"`)) {
          target = fp;
          break;
        }
      } catch {}
    }
    if (target) break;
  }
  if (!target) return { ok: false, error: '세션 로그 없음' };

  const text = readText(target);
  if (text == null) return { ok: false, error: '로그 파일 읽기 실패' };

  let firstUser = '', lastTs = null, tokenUsage = null, quotaRemaining = null;
  const modelUsage = {};
  const turns = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.timestamp) lastTs = o.timestamp;
    const usage = tokenUsageFromEvent(o);
    if (usage) {
      tokenUsage = o.type === 'result' ? usage : mergeTokenUsage(tokenUsage, usage);
      const model = String(o.model || (o.message && o.message.model) || '').toLowerCase();
      if (model) modelUsage[model] = mergeTokenUsage(modelUsage[model], usage);
    }
    const m = o.message || {};
    if (o.type === 'user' && m) {
      const content = userTextFromContent(m.content).trim();
      if (!content) continue;
      quotaRemaining = mergeQuotaRemaining(quotaRemaining, quotaRemainingFromText(content, o.timestamp || lastTs));
      if (!firstUser) firstUser = content;
      turns.push({ role: 'user', text: content, ts: o.timestamp || lastTs });
    } else if (o.type === 'assistant' && Array.isArray(m.content)) {
      const assistantText = m.content
        .filter(c => c && c.type === 'text' && c.text)
        .map(c => c.text)
        .join('\n\n')
        .trim();
      if (assistantText) {
        quotaRemaining = mergeQuotaRemaining(quotaRemaining, quotaRemainingFromText(assistantText, o.timestamp || lastTs));
        turns.push({ role: 'assistant', text: assistantText, ts: o.timestamp || lastTs });
      }
    }
  }
  const transcript = turns.map(t => {
    if (t.role === 'user') return `› ${t.text}`;
    return t.text;
  }).join('\n\n──────────\n\n');
  const subagents = scanSessionSubagentSections(projectPath, sessionId);
  const subagentTranscript = subagents.length
    ? `\n\n──────────\n\n## 서브에이전트 기록\n\n${subagents.map(s => s.text).join('\n\n──────────\n\n')}`
    : '';
  return {
    ok: true,
    sessionId,
    file: path.basename(target),
    firstUser,
    output: `${transcript}${subagentTranscript}`.trim(),
    turns,
    subagents,
    lastTs,
    tokenUsage,
    modelUsage,
    quotaRemaining,
  };
}

function listDir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

// 첫 번째 `---` ... `---` 사이의 YAML frontmatter 파싱
function parseFrontmatter(text) {
  if (!text) return null;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  try {
    return yaml.load(m[1]) || null;
  } catch {
    return null;
  }
}

// ---------- ROADMAP.md phase 목록 파싱 ----------
// 형식 예: - [x] **Phase 5: Agent Builder + ...** - 설명
// 아카이브된 마일스톤(<details> 블록)은 제외하고 활성 phase만 잡는다.
function parseRoadmap(planningDir) {
  const text = readText(path.join(planningDir, 'ROADMAP.md'));
  const out = { phases: [], milestonesLine: null };
  if (!text) return out;

  // ## Phases 섹션만 자르기 (다음 ## 헤딩 전까지)
  const phasesIdx = text.search(/^##\s+Phases/m);
  let scope = phasesIdx >= 0 ? text.slice(phasesIdx) : text;
  const nextHeading = scope.slice(3).search(/^##\s+/m);
  if (nextHeading >= 0) scope = scope.slice(0, nextHeading + 3);

  // <details> 아카이브 블록 제거 → 활성 phase만 남김
  scope = scope.replace(/<details>[\s\S]*?<\/details>/g, '');

  const lineRe = /^[-*]\s*\[(.*?)\]\s*\*\*Phase\s+(\d+)\s*:\s*([^*]+?)\*\*\s*(.*)$/gm;
  let mm;
  while ((mm = lineRe.exec(scope)) !== null) {
    const box = (mm[1] || '').trim();
    const num = parseInt(mm[2], 10);
    const title = mm[3].trim();
    const desc = (mm[4] || '').replace(/^[-—\s]+/, '').trim();
    out.phases.push({ num, title, checkbox: box, desc });
  }
  return out;
}

// ---------- phase 디렉토리 산출물 분석 ----------
// 한 phase 디렉토리(NN-slug) 안의 파일 존재로 GSD 단계를 역산한다.
function analyzePhaseDir(phasesRoot, dirent) {
  const dirName = dirent.name;
  const m = dirName.match(/^(\d+)-(.+)$/);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  const slug = m[2];
  const dirPath = path.join(phasesRoot, dirName);
  const files = listDir(dirPath).filter(f => f.isFile()).map(f => f.name);

  const has = (re) => files.some(f => re.test(f));
  const countPlans = files.filter(f => /^\d+-\d+-PLAN\.md$/i.test(f)).length;
  const countSummaries = files.filter(f => /^\d+-\d+-SUMMARY\.md$/i.test(f)).length;

  const hasContext = has(/^\d+-CONTEXT\.md$/i);
  const hasDiscussionLog = has(/^\d+-DISCUSSION-LOG\.md$/i);
  const hasResearch = has(/^\d+-RESEARCH\.md$/i);
  const hasUiSpec = has(/^\d+-UI-SPEC\.md$/i);
  const hasVerification = has(/^\d+-VERIFICATION\.md$/i);
  const hasValidation = has(/^\d+-VALIDATION\.md$/i);
  const hasInbox = has(/^\d+-DISCUSS-INBOX\.md$/i);

  // 단계 역산 (GSD 라이프사이클: discuss → research → plan → execute → verify)
  // VERIFICATION.md = phase 종료 신호(verifier 산출). VALIDATION.md(nyquist)는
  // 실행 중 일찍 생길 수 있어 단계 판정에 쓰지 않고 플래그로만 둔다.
  let stage, stageLabel;
  if (hasVerification) {
    stage = 'verify'; stageLabel = '검증';
  } else if (countSummaries > 0 && countSummaries >= countPlans) {
    stage = 'execute-done'; stageLabel = '실행 완료';
  } else if (countSummaries > 0) {
    stage = 'execute'; stageLabel = '실행 중';
  } else if (countPlans > 0) {
    stage = 'plan'; stageLabel = '계획 완료';
  } else if (hasResearch) {
    stage = 'research'; stageLabel = '조사 완료';
  } else if (hasContext) {
    stage = 'discuss-done'; stageLabel = '논의 완료';
  } else {
    stage = 'discuss'; stageLabel = '논의 대기';
  }

  return {
    num, slug, dirName, dirPath,
    files,
    plans: { total: countPlans, done: countSummaries },
    hasContext, hasDiscussionLog, hasResearch, hasUiSpec,
    hasVerification, hasValidation, hasInbox,
    stage, stageLabel,
  };
}

// ---------- 논의 질문 추출 ----------
// CONTEXT.md 의 회색지대/Claude's Discretion + DISCUSSION-LOG 의 질문을 모은다.
function extractQuestions(phaseInfo) {
  const questions = [];
  const dir = phaseInfo.dirPath;

  // DISCUSSION-LOG.md 의 ### Q... 헤딩
  const logFile = phaseInfo.files.find(f => /^\d+-DISCUSSION-LOG\.md$/i.test(f));
  if (logFile) {
    const text = readText(path.join(dir, logFile)) || '';
    const qRe = /^###\s+(Q[\d.]*\s*[—\-:]?\s*.+)$/gm;
    let qm;
    while ((qm = qRe.exec(text)) !== null) {
      // 해당 질문 블록에서 선택(✓) 여부 판단
      const start = qm.index;
      const rest = text.slice(start + qm[0].length);
      const nextQ = rest.search(/^###\s+Q/m);
      const block = nextQ >= 0 ? rest.slice(0, nextQ) : rest;
      const answered = /✓|\*\*User's choice:\*\*|선택:/.test(block);
      questions.push({
        source: 'DISCUSSION-LOG',
        text: qm[1].trim(),
        answered,
      });
    }
  }

  // CONTEXT.md 의 회색지대 / Claude's Discretion 섹션 + 결정 개수
  const ctxFile = phaseInfo.files.find(f => /^\d+-CONTEXT\.md$/i.test(f));
  if (ctxFile) {
    const text = readText(path.join(dir, ctxFile)) || '';
    const fm = parseFrontmatter(text) || {};
    const grayNote = fm.gray_areas_discussed || null;

    // "## Claude's Discretion" / "## 회색지대" 섹션 본문 캡처
    const sections = [];
    const secRe = /^##\s+(.*(?:Discretion|회색지대|Open|미결|열린).*)$/gim;
    let sm;
    while ((sm = secRe.exec(text)) !== null) {
      const start = sm.index + sm[0].length;
      const rest = text.slice(start);
      const nextSec = rest.search(/^##\s+/m);
      const body = (nextSec >= 0 ? rest.slice(0, nextSec) : rest).trim();
      // 불릿 항목 우선, 없으면 산문 라인을 항목으로 (회색지대 해소 같은 단락 대응)
      let items = body.split(/\r?\n/)
        .filter(l => /^\s*[-*]\s+/.test(l))
        .map(l => l.replace(/^\s*[-*]\s+/, '').trim())
        .filter(Boolean);
      if (!items.length) {
        items = body.split(/\r?\n/)
          .map(l => l.trim())
          .filter(l => l && !/^[#>]/.test(l) && !/^\*\*/.test(l));
      }
      if (items.length) sections.push({ title: sm[1].trim(), items });
    }

    return { questions, grayNote, sections, hasContext: true };
  }

  return { questions, grayNote: null, sections: [], hasContext: false };
}

// ---------- 현재 phase 판정 ----------
function pickCurrentPhase(state, phaseDirs) {
  // 1) STATE.status 문자열에서 "Phase NN" 추출
  if (state && typeof state.status === 'string') {
    const sm = state.status.match(/Phase\s+(\d+)/i);
    if (sm) {
      const n = parseInt(sm[1], 10);
      if (phaseDirs.some(p => p.num === n)) return n;
    }
  }
  // 2) 완료되지 않은 가장 낮은 번호 phase
  const incomplete = phaseDirs
    .filter(p => p.stage !== 'verify' && p.stage !== 'execute-done')
    .sort((a, b) => a.num - b.num);
  if (incomplete.length) return incomplete[0].num;
  // 3) 가장 높은 번호 phase
  if (phaseDirs.length) return phaseDirs.slice().sort((a, b) => b.num - a.num)[0].num;
  return null;
}

function phaseIsComplete(phase) {
  return !!phase && (phase.stage === 'verify' || phase.stage === 'execute-done');
}

function stateProgressComplete(state) {
  const pr = state && state.progress ? state.progress : {};
  if (Number(pr.percent) >= 100) return true;
  if (pr.totalPhases != null && pr.completedPhases != null && Number(pr.totalPhases) > 0) {
    return Number(pr.completedPhases) >= Number(pr.totalPhases);
  }
  return false;
}

function resolveCurrentPhase(state, phaseDirs) {
  let currentPhaseNum = null;
  if (state && state.currentPhase != null) {
    const n = parseInt(state.currentPhase, 10);
    const pointed = phaseDirs.find(p => p.num === n);
    if (pointed && !phaseIsComplete(pointed)) currentPhaseNum = n;
  }
  if (currentPhaseNum == null && !stateProgressComplete(state)) currentPhaseNum = pickCurrentPhase(state, phaseDirs);
  return currentPhaseNum;
}

function visiblePhaseDirs(state, roadmap, phaseDirs) {
  if (!stateProgressComplete(state)) return phaseDirs;
  const total = state && state.progress && state.progress.totalPhases != null
    ? Number(state.progress.totalPhases)
    : null;
  if (!total || total <= 0) return phaseDirs;
  const roadmapNums = new Set((roadmap.phases || []).map(p => p.num));
  return phaseDirs.filter(p => p.num <= total || roadmapNums.has(p.num));
}

function shouldRenderWorkstream(name, lane) {
  const normalized = String(name || '').trim().toLowerCase();
  const phaseCount = lane && Array.isArray(lane.phases) ? lane.phases.length : 0;
  if (!phaseCount && (normalized === 'milestone' || normalized === 'milestones')) return false;
  return !!(lane && lane.hasContent);
}

// ---------- 메인: 한 프로젝트 스캔 ----------
async function scanProject(projectPath) {
  const result = {
    path: projectPath,
    name: path.basename(projectPath),
    isGsd: false,
    initialized: false,
    state: null,
    config: null,
    phases: [],
    lanes: [],
    currentPhaseNum: null,
    git: null,
    activity: null,
    planning: null,
    error: null,
  };

  // git 상태 + 서브에이전트 활동은 GSD 여부와 무관하게 조회
  try { result.git = await scanGit(projectPath); } catch { result.git = { isRepo: false }; }
  try { result.activity = scanActivity(projectPath, Date.now()); } catch { result.activity = { hasLog: false }; }

  const planningDir = path.join(projectPath, '.planning');
  if (!exists(planningDir)) {
    result.error = '.planning 폴더 없음 — GSD 프로젝트 아님';
    return result;
  }
  result.isGsd = true;

  // config.json
  const cfgText = readText(path.join(planningDir, 'config.json'));
  if (cfgText) { try { result.config = JSON.parse(cfgText); } catch {} }

  // 메인 라인 + 워크스트림 라인들을 각각 레인으로 구성
  const mainLane = buildLane(planningDir, projectPath);
  mainLane.kind = 'main';
  mainLane.name = 'main';
  result.state = mainLane.state;
  result.planning = scanPlanningArtifacts(planningDir, mainLane.state);

  const lanes = [];
  if (mainLane.hasContent) lanes.push(mainLane);

  // 워크스트림 (.planning/workstreams/<name>/)
  const wsRoot = path.join(planningDir, 'workstreams');
  if (exists(wsRoot)) {
    for (const d of listDir(wsRoot)) {
      if (!d.isDirectory()) continue;
      const wlane = buildLane(path.join(wsRoot, d.name), projectPath);
      if (shouldRenderWorkstream(d.name, wlane)) {
        wlane.kind = 'workstream';
        wlane.name = d.name;
        lanes.push(wlane);
      }
    }
  }

  result.lanes = lanes;
  result.initialized = lanes.length > 0 || !!mainLane.state || !!(result.planning && result.planning.events && result.planning.events.length);
  if (!result.initialized) {
    result.error = '초기화 안 됨 (config.json만 존재)';
  }

  // 하위호환: 첫 phase 보유 레인을 result.phases로 노출
  const primary = lanes.find(l => l.phases.length) || mainLane;
  result.phases = primary.phases;
  result.currentPhaseNum = primary.currentPhaseNum;

  return result;
}

// 하나의 planning 디렉토리(.planning 또는 workstreams/<name>)에서
// state·phases·currentPhase를 읽어 한 "레인"으로 구성한다.
function buildLane(planningDir, projectPath) {
  const stateText = readText(path.join(planningDir, 'STATE.md'));
  const fm = parseFrontmatter(stateText);
  let state = null;
  if (fm) {
    const pr = fm.progress || {};
    state = {
      milestone: fm.milestone ?? null,
      milestoneName: fm.milestone_name ?? null,
      status: fm.status ?? null,
      currentPhase: fm.current_phase ?? null,
      lastUpdated: fm.last_updated ?? fm.last_activity ?? null,
      progress: {
        totalPhases: pr.total_phases ?? null,
        completedPhases: pr.completed_phases ?? null,
        totalPlans: pr.total_plans ?? null,
        completedPlans: pr.completed_plans ?? null,
        percent: pr.percent ?? null,
      },
    };
  }

  const roadmap = parseRoadmap(planningDir);
  const roadmapByNum = new Map(roadmap.phases.map(p => [p.num, p]));

  const phasesRoot = path.join(planningDir, 'phases');
  const phaseDirs = [];
  if (exists(phasesRoot)) {
    for (const d of listDir(phasesRoot)) {
      if (!d.isDirectory()) continue;
      const info = analyzePhaseDir(phasesRoot, d);
      if (info) phaseDirs.push(info);
    }
  }
  phaseDirs.sort((a, b) => a.num - b.num);
  const displayPhaseDirs = visiblePhaseDirs(state, roadmap, phaseDirs);

  // current phase: STATE.current_phase 가 완료 phase를 가리키면 다음 미완료/완료 없음으로 보정.
  const currentPhaseNum = resolveCurrentPhase(state, displayPhaseDirs);

  const allNums = new Set([...roadmap.phases.map(p => p.num), ...displayPhaseDirs.map(p => p.num)]);
  const byNumDir = new Map(displayPhaseDirs.map(p => [p.num, p]));

  const phases = [...allNums].sort((a, b) => a - b).map(num => {
    const rd = roadmapByNum.get(num);
    const dir = byNumDir.get(num);
    const isCurrent = num === currentPhaseNum;

    let stage, stageLabel;
    if (dir) {
      stage = dir.stage; stageLabel = dir.stageLabel;
    } else if (rd && rd.checkbox && rd.checkbox.toLowerCase().includes('x')) {
      stage = 'verify'; stageLabel = '완료(로드맵)';
    } else {
      stage = 'pending'; stageLabel = '대기';
    }

    const phase = {
      num,
      title: rd ? rd.title : (dir ? dir.slug.replace(/-/g, ' ') : `Phase ${num}`),
      desc: rd ? rd.desc : '',
      checkbox: rd ? rd.checkbox : null,
      hasDir: !!dir,
      stage, stageLabel, isCurrent,
      plans: dir ? dir.plans : { total: 0, done: 0 },
      hasContext: dir ? dir.hasContext : false,
      hasResearch: dir ? dir.hasResearch : false,
      hasVerification: dir ? dir.hasVerification : false,
      hasInbox: dir ? dir.hasInbox : false,
      dirName: dir ? dir.dirName : null,
    };

    const inDiscuss = ['discuss', 'discuss-done', 'research', 'plan'].includes(stage);
    if (dir && inDiscuss) {
      phase.discuss = extractQuestions(dir);
    } else if (!dir && isCurrent) {
      phase.discuss = { needsDiscuss: true, questions: [], sections: [], grayNote: null };
    }
    return phase;
  });

  return {
    state, phases, currentPhaseNum,
    hasContent: !!(fm || roadmap.phases.length || phaseDirs.length),
  };
}

module.exports = { scanProject, scanActivity, scanAgentDetail, scanSessionDetail, scanPlanningArtifacts };
