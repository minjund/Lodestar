'use strict';

const $ = (sel) => document.querySelector(sel);
const THEME_KEY = 'lodestar.theme';
const params = new URLSearchParams(location.search);
const windowId = params.get('id') || '';
const HISTORY_KEY = 'lodestar.taskPromptHistory.v1';
const TASK_SESSIONS_KEY = 'lodestar.taskSessions.v1';
const MAX_RENDER_CHARS = 120000;
const LIVE_SESSION_STALE_MS = 5 * 60 * 1000;

let payload = null;
let project = null;
let lane = null;
let discuss = null;
let mode = 'new';
let sessionId = null;
let backgroundTaskId = null;
let running = false;
let stopRequested = false;
let canResume = false;
let awaiting = false;
let outputText = '';
let pendingReply = '';
let pollTimer = null;
let livePollTimer = null;
let liveDetailInFlight = false;
let commands = [];
let commandActiveIndex = 0;
let tokenUsage = null;
let outputRenderRaf = 0;
let pendingOutputRender = '';
let commandSuggestRaf = 0;
let quotaRemaining = null;
let runTaskStatus = null;
let runStartedAt = null;
let runUpdatedAt = null;
let outputChangedAt = 0;
let outputLength = 0;
let executionPath = null;
let baseProjectPath = null;
let usingWorktree = false;
let executionBranch = null;
let draftText = '';
let activityKind = 'idle';
let activityLabel = '대기';

function preferredDarkMode() {
  const saved = localStorage.getItem(THEME_KEY) || 'system';
  if (saved === 'dark') return true;
  if (saved === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme() {
  const dark = preferredDarkMode();
  document.documentElement.classList.toggle('dark', dark);
  document.body.classList.toggle('dark', dark);
}

applyTheme();
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function truncate(s, n = 160) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function compactNumber(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return String(n);
}

function shortId(id) {
  return id ? String(id).slice(0, 8) : '';
}

function timeLabel(value) {
  const ts = typeof value === 'number' ? value : Date.parse(value || '');
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ageLabel(value) {
  const ts = typeof value === 'number' ? value : Date.parse(value || '');
  if (!ts) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 10) return '방금';
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.floor(hour / 24)}일 전`;
}

function liveSessionRecent(session, detail = null) {
  if (!session || !session.running) return false;
  if (session.ageSec != null) return Number(session.ageSec) * 1000 < LIVE_SESSION_STALE_MS;
  const ts = Date.parse((detail && (detail.lastTs || detail.updatedAt)) || session.lastTs || session.updatedAt || session.ts || '');
  return !!ts && Date.now() - ts < LIVE_SESSION_STALE_MS;
}

function setTokenUsage(usage) {
  const el = $('#factTokens');
  if (el) el.closest('div').classList.add('hidden');
}

function quotaLabel(item) {
  if (!item || item.pct == null) return '-';
  return `${item.pct}%${item.reset ? ` (${item.reset})` : ''}`;
}

function quotaPct(item) {
  if (!item || item.pct == null || Number.isNaN(Number(item.pct))) return null;
  return Math.max(0, Math.min(100, Math.round(Number(item.pct))));
}

function quotaGauge(label, item) {
  const pct = quotaPct(item);
  const value = pct == null ? '-' : `${pct}%`;
  const reset = item && item.reset ? String(item.reset) : '';
  const title = `${label} 남은 사용량 ${quotaLabel(item)}`;
  const tone = pct == null ? 'unknown' : (pct <= 15 ? 'danger' : (pct <= 35 ? 'warn' : 'ok'));
  const width = pct == null ? 100 : pct;
  const minWidth = pct && pct > 0 ? 8 : 0;
  return `
    <span class="quota-gauge ${tone}" title="${esc(title)}" aria-label="${esc(title)}">
      <span class="quota-gauge-head"><b>${esc(label)}</b><em>${esc(value)}</em></span>
      <span class="quota-gauge-track"><span class="quota-gauge-fill" style="width:${width}%;min-width:${minWidth}px"></span></span>
      ${reset ? `<span class="quota-gauge-reset">${esc(reset)}</span>` : ''}
    </span>`;
}

function setQuotaRemaining(remaining) {
  quotaRemaining = remaining || quotaRemaining || null;
  const el = $('#factQuota');
  if (!el) return;
  const q = quotaRemaining || {};
  el.innerHTML = `
    ${quotaGauge('5시간', q.fiveHour)}
    ${quotaGauge('7일', q.sevenDay)}
    ${quotaGauge('소넷', q.sonnet)}
  `;
}

function stripToolUseMarkers(text) {
  return String(text || '').replace(/^\s*\[🔧[^\]]+\]\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function splitWccCommandSpill(text) {
  const raw = String(text || '').trim();
  const patterns = [
    /^(\/wcc[-:]discuss-phase\s+\d+)(?=Phase\s+\d+|[가-힣])([\s\S]+)$/i,
    /^(\/wcc[-:][\w-]+(?:\s+\d+)?)(?=Phase\s+\d+)([\s\S]+)$/i,
  ];
  for (const pattern of patterns) {
    const m = raw.match(pattern);
    if (m) return { prompt: m[1].trim(), spill: m[2].trim() };
  }
  return { prompt: raw, spill: '' };
}

function inlineMarkdown(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function isMarkdownTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line || '');
}

function splitMarkdownTableRow(line) {
  let raw = String(line || '').trim();
  if (raw.startsWith('|')) raw = raw.slice(1);
  if (raw.endsWith('|')) raw = raw.slice(0, -1);
  return raw.split('|').map(cell => cell.trim());
}

function renderMarkdownTable(headerLine, dividerLine, bodyLines) {
  const headers = splitMarkdownTableRow(headerLine);
  const aligns = splitMarkdownTableRow(dividerLine).map(cell => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
  const rows = bodyLines.map(splitMarkdownTableRow).filter(row => row.length > 1);
  const head = headers.map((h, idx) => `<th style="text-align:${aligns[idx] || 'left'}">${inlineMarkdown(h)}</th>`).join('');
  const body = rows.map(row => `<tr>${headers.map((_h, idx) =>
    `<td style="text-align:${aligns[idx] || 'left'}">${inlineMarkdown(row[idx] || '')}</td>`
  ).join('')}</tr>`).join('');
  return `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function splitReadableParagraph(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length < 180) return [s];
  const pieces = s.match(/[^.!?。！？]+[.!?。！？]+(?:["'”’)]*)?|[^.!?。！？]+$/g) || [s];
  const out = [];
  let cur = '';
  for (const piece of pieces.map(x => x.trim()).filter(Boolean)) {
    if (!cur) cur = piece;
    else if ((cur + ' ' + piece).length <= 170) cur += ' ' + piece;
    else { out.push(cur); cur = piece; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [s];
}

function readableMarkdown(text) {
  let src = stripToolUseMarkers(text).replace(/\r\n/g, '\n');
  src = src
    .replace(/\|\s*(?=\|\s*[^|\n]+\s*\|)/g, '|\n')
    .replace(/([^\n])(\|[^|\n]+\|[^|\n]*\|)/g, '$1\n$2')
    .replace(/([^\n])(\n?#{1,4}\s+)/g, '$1\n\n$2')
    .replace(/([^\n])(\n?\s*(?:[-*]|\d+\.)\s+)/g, '$1\n$2')
    .replace(/\n{3,}/g, '\n\n');
  const lines = src.split('\n');
  const out = [];
  let inCode = false;
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    const joined = paragraph.join(' ').trim();
    for (const part of splitReadableParagraph(joined)) out.push(part);
    paragraph = [];
  };
  for (const line of lines) {
    if (/^```/.test(line.trim())) { flush(); out.push(line); inCode = !inCode; continue; }
    if (inCode) { out.push(line); continue; }
    const trimmed = line.trim();
    const structural = !trimmed
      || trimmed.includes('|')
      || /^(#{1,4}\s+|[-*]\s+|\d+\.\s+|>\s?|---+$)/.test(trimmed);
    if (structural) {
      flush();
      out.push(line);
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function renderMarkdown(text) {
  const lines = readableMarkdown(text).split('\n');
  const html = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.includes('|') && idx + 1 < lines.length && isMarkdownTableDivider(lines[idx + 1])) {
      flushParagraph();
      const bodyLines = [];
      idx += 2;
      while (idx < lines.length && lines[idx].includes('|') && lines[idx].trim()) {
        bodyLines.push(lines[idx]);
        idx++;
      }
      idx--;
      html.push(renderMarkdownTable(line, lines[idx - bodyLines.length], bodyLines));
      continue;
    }
    if (!line.trim()) { flushParagraph(); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      html.push(`<h${heading[1].length}>${inlineMarkdown(heading[2].trim())}</h${heading[1].length}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      html.push(`<ul><li>${inlineMarkdown(bullet[1])}</li></ul>`);
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return html.join('');
}

function userTurn(line) {
  const m = String(line || '').trim().match(/^›\s*(나|내 답변|중간 메시지|WCC 새 세션|이어서 실행|히스토리 세션 이어서 실행)\s*:?\s*(.*)$/);
  if (!m) {
    const rawSplit = splitWccCommandSpill(line);
    return rawSplit.spill ? { label: rawSplit.prompt, spill: rawSplit.spill } : null;
  }
  const raw = m[2] || m[1];
  if (m[1] === 'WCC 새 세션') {
    const split = splitWccCommandSpill(raw);
    return { label: split.prompt || raw, spill: split.spill || '' };
  }
  return { label: raw, spill: '' };
}

function userTurnLabel(line) {
  const turn = userTurn(line);
  return turn && turn.label;
}

function splitUserTail(tail) {
  const lines = String(tail || '').split('\n');
  const blankIdx = lines.findIndex(line => !line.trim());
  if (blankIdx < 0) return { userTail: tail, assistantTail: '' };
  const userTail = lines.slice(0, blankIdx).join('\n').trim();
  const assistantTail = lines.slice(blankIdx + 1).join('\n').trim();
  if (!assistantTail) return { userTail: tail, assistantTail: '' };
  return { userTail, assistantTail };
}

function renderChatTranscript(text) {
  const src = stripToolUseMarkers(renderableTranscript(text)).replace(/\r\n/g, '\n');
  if (!src.trim()) return '';
  const parts = src.split(/\n{0,2}──────────\n{0,2}/);
  const html = [];
  const pushUserBubble = (body) => {
    const clean = String(body || '').trim();
    if (!clean) return;
    html.push(`<div class="chat-row user"><div class="chat-bubble">${renderMarkdown(clean)}</div></div>`);
  };
  const pushAssistantText = (body) => {
    const clean = String(body || '').trim();
    if (!clean) return;
    html.push(`<div class="chat-assistant">${renderMarkdown(clean)}</div>`);
  };
  for (const part of parts) {
    const lines = String(part || '').split('\n');
    const firstIdx = lines.findIndex(line => line.trim());
    if (firstIdx < 0) continue;
    const turn = userTurn(lines[firstIdx]);
    if (!turn) {
      pushAssistantText(part);
      continue;
    }
    const tail = lines.slice(firstIdx + 1).join('\n');
    if (turn.spill) {
      pushUserBubble(turn.label);
      pushAssistantText([turn.spill, tail].filter(Boolean).join('\n'));
    } else {
      const split = splitUserTail(tail);
      pushUserBubble([turn.label, split.userTail].filter(Boolean).join('\n'));
      pushAssistantText(split.assistantTail);
    }
  }
  return html.length ? `<div class="chat-transcript">${html.join('')}</div>` : '';
}

function renderableTranscript(text) {
  const value = String(text || '');
  if (value.length <= MAX_RENDER_CHARS) return value;
  return `... 이전 출력 ${value.length - MAX_RENDER_CHARS}자 생략 ...\n\n${value.slice(-MAX_RENDER_CHARS)}`;
}

function renderOutputNow(text, opts = {}) {
  const el = $('#output');
  const distanceFromBottom = el.scrollHeight - el.scrollTop;
  const stickToBottom = opts.forceScroll || distanceFromBottom <= el.clientHeight + 56;
  el.innerHTML = text.trim() ? renderChatTranscript(text) : '';
  if (stickToBottom) el.scrollTop = el.scrollHeight;
  else el.scrollTop = Math.max(0, el.scrollHeight - distanceFromBottom);
}

function setOutput(text, opts = {}) {
  outputText = stripToolUseMarkers(text);
  noteOutputChange(outputText);
  renderOutputNow(outputText, opts);
  updateRunFacts();
}

function scheduleOutput(text, opts = {}) {
  outputText = stripToolUseMarkers(text);
  noteOutputChange(outputText);
  pendingOutputRender = outputText;
  if (outputRenderRaf) return;
  outputRenderRaf = requestAnimationFrame(() => {
    outputRenderRaf = 0;
    renderOutputNow(pendingOutputRender, opts);
    updateRunFacts();
  });
}

function noteOutputChange(text, changedAt = Date.now()) {
  const len = String(text || '').length;
  if (len !== outputLength) {
    outputLength = len;
    outputChangedAt = typeof changedAt === 'number' ? changedAt : (Date.parse(changedAt || '') || Date.now());
  }
}

function projectBranchKey(p) {
  if (payload && payload.branch) return payload.branch;
  const git = p && p.git && p.git.isRepo ? p.git : null;
  return git ? (git.branch || 'detached') : 'no-git';
}

function taskLaneId() {
  if (lane && lane.kind === 'workstream') return `workstream:${lane.name || ''}`;
  if (!lane || !lane.kind || lane.kind === 'main') return 'main';
  return `${lane.kind}:${lane.name || ''}`;
}

function taskSessionKey() {
  if (!project || !project.path) return '';
  return `${project.path}|branch:${projectBranchKey(project)}::${taskLaneId()}`;
}

function readTaskSessions() {
  try { return JSON.parse(localStorage.getItem(TASK_SESSIONS_KEY) || '{}'); } catch { return {}; }
}

function writeTaskSessions(all) {
  localStorage.setItem(TASK_SESSIONS_KEY, JSON.stringify(all || {}));
}

function persistSessionState(extra = {}) {
  const key = taskSessionKey();
  if (!key || !project || !project.path) return;
  const all = readTaskSessions();
  const prev = all[key] || {};
  const promptValue = $('#prompt') ? $('#prompt').value : '';
  const draft = extra.draft !== undefined ? extra.draft : (running ? (prev.draft || '') : promptValue);
  const hasConversation = !!(sessionId || backgroundTaskId || outputText || draft || running || awaiting || canResume);
  if (!hasConversation && !prev.draftOpen) return;
  all[key] = {
    ...prev,
    key,
    projectPath: project.path,
    executionPath: executionPath || project.path,
    baseProjectPath: baseProjectPath || project.path,
    usingWorktree: !!usingWorktree,
    branch: projectBranchKey(project),
    laneId: taskLaneId(),
    laneKind: lane && lane.kind ? lane.kind : 'main',
    laneName: lane && lane.name ? lane.name : 'main',
    discuss: discuss || null,
    sessionId: sessionId || null,
    backgroundTaskId: backgroundTaskId || null,
    tokenUsage: tokenUsage || null,
    draftOpen: !!(extra.draftOpen !== undefined ? extra.draftOpen : (!sessionId && !backgroundTaskId && !outputText && !!draft)),
    draft: draft || '',
    excerpt: String(outputText || '').trim().slice(-1800),
    statusText: extra.statusText || $('#status')?.textContent || prev.statusText || '',
    lastPrompt: extra.lastPrompt || prev.lastPrompt || draft || '',
    awaiting: !!awaiting,
    asked: !!awaiting,
    canResume: !!(sessionId || canResume),
    savedAt: new Date().toISOString(),
  };
  writeTaskSessions(all);
}

async function ensureExecutionWorkspace(opts) {
  if (!project || !opts) return opts;
  const branch = opts.branch || projectBranchKey(project);
  opts.baseProjectPath = project.path;
  if (!project.git || !project.git.isRepo || !branch || branch === 'no-git' || !window.lodestar.ensureBranchWorktree) {
    opts.projectPath = project.path;
    executionPath = project.path;
    baseProjectPath = project.path;
    usingWorktree = false;
    return opts;
  }
  if (executionPath && executionBranch === branch) {
    opts.projectPath = executionPath;
    opts.baseProjectPath = baseProjectPath || project.path;
    opts.branch = executionBranch || branch;
    return opts;
  }
  $('#status').textContent = `${branch} 브랜치 작업 공간을 준비하는 중…`;
  const res = await window.lodestar.ensureBranchWorktree(project.path, branch);
  if (!res || !res.ok) {
    const msg = (res && (res.stderr || res.error)) || 'unknown error';
    throw new Error(`브랜치 작업 공간 준비 실패: ${msg}`);
  }
  executionPath = res.projectPath || project.path;
  baseProjectPath = res.baseProjectPath || project.path;
  usingWorktree = !!res.usingWorktree;
  executionBranch = res.branch || branch;
  opts.projectPath = executionPath;
  opts.baseProjectPath = baseProjectPath;
  opts.branch = executionBranch;
  return opts;
}

function laneLabel(l) {
  if (!l || !l.kind || l.kind === 'main') return '마일스톤';
  if (l.kind === 'workstream') return `워크스트림 ${l.name}`;
  return l.name || l.kind || '세션';
}

function isBgTaskRunning(task) {
  return task && (task.status === 'queued' || task.status === 'running');
}

function backgroundStatusText(task) {
  if (!task) return '작업 상태를 읽을 수 없습니다';
  if (task.status === 'running' || task.status === 'queued') return '실행 중입니다';
  if (task.status === 'completed') return '작업 완료';
  if (task.status === 'timeout') return '작업 시간 초과';
  if (task.status === 'stopped') return '대화를 중단했습니다';
  return '작업이 멈췄습니다';
}

function backgroundTaskTranscript(task, fallback = '') {
  const recorded = String((task && (task.output || task.stderr)) || '').trim();
  const prompt = splitWccCommandSpill((task && (task.historyPrompt || task.prompt)) || '').prompt;
  const label = prompt ? (isWccCommandText(prompt) ? `› WCC 새 세션: ${prompt}` : `› 나: ${prompt}`) : '';
  if (recorded) {
    if (!label || recorded.includes(prompt)) return recorded;
    const existing = String(fallback || '').trim();
    const idx = existing.lastIndexOf(label);
    const prefix = idx >= 0 ? existing.slice(0, idx) : '';
    return `${prefix}${label}\n\n──────────\n\n${recorded}`.trim();
  }
  const existing = String(fallback || '').trim();
  if (existing && !/아직 기록된 출력이 없습니다|아직 출력이 없습니다/.test(existing)) return existing;
  if (!prompt) return '실행 중입니다. Claude 출력이 기록되면 여기에 표시됩니다.';
  return `${label}\n\n──────────\n\n실행 중입니다. Claude 출력이 기록되면 여기에 이어서 표시됩니다.`;
}

function claudeFactLabel() {
  if (sessionId) return `Claude 세션 ${shortId(sessionId)}`;
  if (mode === 'phase-running') return '실행 중인 phase';
  if (running && backgroundTaskId) return '실행 중 · 세션 ID 감지 대기';
  if (running) return '실행 시작 중';
  if (backgroundTaskId) return `작업 ${shortId(backgroundTaskId)}`;
  return '새 세션';
}

function taskFactLabel() {
  const status = runTaskStatus || (running ? 'running' : '');
  const statusText = status
    ? backgroundStatusText({ status })
    : (awaiting ? '답변 필요' : (sessionId ? '대기' : '작성 전'));
  const bits = [statusText];
  if (backgroundTaskId) bits.push(`작업 ${shortId(backgroundTaskId)}`);
  const ts = runUpdatedAt || runStartedAt;
  if (ts) bits.push(`갱신 ${ageLabel(ts) || timeLabel(ts)}`);
  return bits.filter(Boolean).join(' · ');
}

function logFactLabel() {
  const len = String(outputText || '').length;
  if (!len) return running ? '로그 수신 대기' : '저장된 로그 없음';
  const bits = [`로그 ${compactNumber(len)}자`];
  const ts = runUpdatedAt || outputChangedAt;
  if (ts) bits.push(`최근 ${ageLabel(ts) || timeLabel(ts)}`);
  return bits.join(' · ');
}

function updateRunFacts(task = null) {
  if (task) {
    runTaskStatus = task.status || runTaskStatus;
    runStartedAt = task.startedAt || runStartedAt;
    runUpdatedAt = task.updatedAt || runUpdatedAt;
    if (task.output || task.stderr) noteOutputChange(task.output || task.stderr, task.updatedAt || Date.now());
  }
  const factClaude = $('#factClaude');
  const factTask = $('#factTask');
  const factLog = $('#factLog');
  if (factClaude) factClaude.textContent = claudeFactLabel();
  if (factTask) factTask.textContent = taskFactLabel();
  if (factLog) factLog.textContent = logFactLabel();
}

function state(text, kind = 'idle') {
  $('#sessionState').textContent = text;
  $('#sessionState').className = `session-state ${kind}`;
  setActivity(kind, text);
}

function normalizeActivityKind(kind = '') {
  if (kind === 'running' && running) return 'thinking';
  if (kind === 'done') return 'done';
  if (kind === 'awaiting') return 'awaiting';
  if (kind === 'blocked') return stopRequested ? 'stopping' : 'blocked';
  if (kind === 'idle') return 'idle';
  return kind || 'idle';
}

function setActivity(kind = 'idle', label = '', detail = null) {
  const strip = $('#activityStrip');
  if (!strip) return;
  activityKind = normalizeActivityKind(kind);
  activityLabel = label || activityLabel || '대기';
  const statusText = detail == null ? ($('#status') ? $('#status').textContent : '') : detail;
  strip.className = `activity-strip ${activityKind}`;
  const labelEl = $('#activityLabel');
  const detailEl = $('#activityDetail');
  if (labelEl) labelEl.textContent = activityLabelFor(activityKind, activityLabel);
  if (detailEl) detailEl.textContent = activityDetailFor(activityKind, statusText);
}

function activityLabelFor(kind, fallback) {
  if (kind === 'thinking') return '생각 중';
  if (kind === 'working') return '작업 중';
  if (kind === 'stopping') return '중단 중';
  if (kind === 'awaiting') return '답변 필요';
  if (kind === 'blocked') return fallback || '멈춤';
  if (kind === 'done') return '완료';
  return fallback || '대기';
}

function activityDetailFor(kind, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean) return clean;
  if (kind === 'thinking') return 'Claude가 요청을 해석하고 실행을 준비하고 있습니다.';
  if (kind === 'working') return 'Claude 출력이 들어오고 있습니다.';
  if (kind === 'stopping') return '현재 실행 프로세스를 중단하는 중입니다.';
  if (kind === 'awaiting') return 'Claude가 사용자 답변을 기다리고 있습니다.';
  if (kind === 'done') return '같은 세션으로 이어서 말할 수 있습니다.';
  return '메시지를 보내면 Claude 세션이 시작됩니다.';
}

function refreshActivityFromStatus() {
  if (stopRequested) return setActivity('stopping', '중단 중');
  if (running) {
    const text = $('#status') ? $('#status').textContent : '';
    return setActivity(activityKind === 'working' ? 'working' : 'thinking', activityLabel, text);
  }
  if (awaiting) return setActivity('awaiting', '답변 필요');
  const stateEl = $('#sessionState');
  const cls = stateEl ? Array.from(stateEl.classList).find(c => c !== 'session-state') : 'idle';
  setActivity(cls || 'idle', stateEl ? stateEl.textContent : '대기');
}

function updateWindowAttention() {
  if (!window.lodestar || !window.lodestar.updateAttention) return;
  const items = awaiting && !running ? [{
    key: `${project && project.path || 'session'}|${sessionId || backgroundTaskId || windowId}|awaiting`,
    title: `${project && project.name || 'Claude'} 답변 필요`,
    body: outputText || 'Claude가 사용자 답변을 기다리고 있습니다.',
  }] : [];
  window.lodestar.updateAttention({ source: `session:${windowId}`, items }).catch(() => {});
}

function bindActivityStatusObserver() {
  const status = $('#status');
  if (!status || status.dataset.activityBound) return;
  status.dataset.activityBound = '1';
  const observer = new MutationObserver(() => refreshActivityFromStatus());
  observer.observe(status, { childList: true, characterData: true, subtree: true });
  refreshActivityFromStatus();
}

function setLocked(locked) {
  $('#prompt').readOnly = false;
  $('#prompt').classList.toggle('pending-mode', !!locked);
  $('#runBtn').disabled = false;
  $('#runBtn').textContent = locked ? '끝나면 보내기 ↵' : '보내기 ↵';
  if (locked) hideCommandSuggest();
}

function setRunVisible(visible) {
  $('#runBtn').classList.toggle('hidden', !visible);
}

function setStopVisible(visible, enabled = visible) {
  for (const btn of [$('#stopBtn'), $('#stopInlineBtn')]) {
    if (!btn) continue;
    btn.classList.toggle('hidden', !visible);
    btn.disabled = !enabled;
  }
}

function isWccCommandText(text) {
  const s = String(text || '').trim();
  return /^\/wcc(?::[\w-]+)?(?:\s|$)/i.test(s)
    || /^\/wcc-[\w-]+(?:\s|$)/i.test(s)
    || /^wcc(?::|-|\s+)(quick|debug|review|phase|workstreams?|autonomous|help|config|profile-user)\b/i.test(s);
}

function workstreamPromptPrefix() {
  if (!lane || lane.kind !== 'workstream') return '';
  return [
    '[Lodestar 작업 범위]',
    `프로젝트: ${project.name}`,
    `워크스트림: ${lane.name}`,
    `우선 참조 경로: .planning/workstreams/${lane.name}`,
    '',
    '이 작업은 메인 .planning 이 아니라 위 워크스트림의 STATE.md, ROADMAP.md, phases/ 산출물을 우선 기준으로 진행하세요.',
    '필요한 경우에만 메인 .planning 을 참고하고, 계획/상태 산출물을 갱신할 때도 해당 워크스트림 아래 파일을 우선 갱신하세요.',
    '',
    '[사용자 지시]',
  ].join('\n');
}

function scopedPrompt(prompt) {
  if (isWccCommandText(prompt)) return prompt;
  const prefix = workstreamPromptPrefix();
  return prefix ? `${prefix}\n${prompt}` : prompt;
}

function buildDiscussPrompt(opinion) {
  const question = (discuss && (discuss.pickedQuestion || discuss.question)) || '';
  return [
    `이 프로젝트는 GSD/WCC 워크플로우의 Phase ${discuss.num} (${discuss.title}) 논의 단계입니다.`,
    '',
    '[논의 질문/맥락]',
    question || '(질문 미지정 — 자유 의견)',
    '',
    '[내 의견]',
    opinion,
    '',
    '위 내 의견을 이 phase의 논의 결정으로 반영해 진행해줘. 필요한 경우 .planning 의 CONTEXT 등에 반영하고, 무엇을 했는지 간단히 한국어로 요약해줘. 소스 코드 변경이 꼭 필요한 단계가 아니면 변경하지 마.',
  ].join('\n');
}

function taskOpts(promptText, explicitSessionId = sessionId) {
  const raw = String(promptText || '').trim() || (explicitSessionId ? '이전 작업을 이어서 진행해줘.' : '');
  const startsFresh = isWccCommandText(raw);
  const nextSessionId = startsFresh ? null : (canResume && explicitSessionId ? explicitSessionId : null);
  const opts = {
    projectPath: executionPath || project.path,
    baseProjectPath: project.path,
    prompt: discuss && !startsFresh ? scopedPrompt(buildDiscussPrompt(raw)) : scopedPrompt(raw),
    historyPrompt: raw,
    branch: projectBranchKey(project),
    sessionId: nextSessionId,
    clearContext: startsFresh,
    workstream: lane && lane.kind === 'workstream' ? { name: lane.name } : null,
  };
  if (discuss && !startsFresh) {
    opts.inbox = {
      phaseNum: discuss.num,
      phaseTitle: discuss.title,
      question: discuss.question || '',
      answer: raw,
    };
  }
  return opts;
}

function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}'); } catch { return {}; }
}

function writeHistory(all) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
}

function historyScopeKey(item = null) {
  const branch = (item && item.branch) || projectBranchKey(project);
  const laneId = lane && lane.kind === 'workstream' ? `workstream:${lane.name || 'workstream'}` : 'main';
  const session = (item && (item.sessionId || item.backgroundTaskId || item.historyKey)) || sessionId || backgroundTaskId || windowId || 'draft';
  return `${project.path}|branch:${branch}|lane:${laneId}|session:${session}`;
}

function promptHistory() {
  const all = readHistory();
  const scope = historyScopeKey();
  return Array.isArray(all[scope]) ? all[scope] : [];
}

function removeHistoryItem(item) {
  if (!project || !item) return;
  const all = readHistory();
  const scope = item.scopeKey || historyScopeKey(item);
  const list = Array.isArray(all[scope]) ? all[scope] : [];
  const prompt = historyPromptText(item);
  const key = item.historyKey || historySessionKey(item, prompt);
  all[scope] = list.filter(x => !sameHistorySession(x, key, item, prompt));
  writeHistory(all);
}

function compactTranscript(text) {
  return stripToolUseMarkers(text).slice(-60000);
}

function historyConversation(item) {
  return compactTranscript(item && (item.conversation || item.transcript || item.output || item.excerpt));
}

function historyPromptText(item) {
  return splitWccCommandSpill(item && item.prompt || '').prompt;
}

function historySessionKey(item, prompt) {
  if (item && item.sessionId) return `session:${item.sessionId}`;
  if (item && item.backgroundTaskId) return `background:${item.backgroundTaskId}`;
  return `prompt:${String(prompt || '').trim()}`;
}

function sameHistorySession(existing, key, item, prompt) {
  if (!existing) return false;
  if (key && existing.historyKey === key) return true;
  if (item && item.sessionId && existing.sessionId === item.sessionId) return true;
  if (item && item.backgroundTaskId && existing.backgroundTaskId === item.backgroundTaskId) return true;
  const existingPromptOnly = !existing.sessionId && !existing.backgroundTaskId;
  const samePrompt = String(existing.prompt || '').trim() === String(prompt || '').trim();
  return samePrompt && (existingPromptOnly || !existing.sessionId || !(item && item.sessionId));
}

function saveHistory(label, prompt, extra = {}) {
  prompt = splitWccCommandSpill(prompt).prompt;
  if (!prompt) return;
  const all = readHistory();
  const scope = historyScopeKey(extra);
  const list = Array.isArray(all[scope]) ? all[scope] : [];
  const key = historySessionKey(extra, prompt);
  const prev = list.find(x => sameHistorySession(x, key, extra, prompt)) || {};
  const conversation = compactTranscript(extra.conversation ?? extra.transcript ?? prev.conversation ?? prev.transcript ?? '');
  const nextItem = {
    ...prev,
    ...extra,
    label,
    historyKey: key,
    scopeKey: scope,
    branch: extra.branch || projectBranchKey(project),
    laneId: extra.laneId || (lane && lane.kind === 'workstream' ? `workstream:${lane.name || 'workstream'}` : 'main'),
    prompt,
    ts: extra.ts || prev.ts || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    conversation,
    transcript: conversation,
  };
  all[scope] = [
    nextItem,
    ...list.filter(x => !sameHistorySession(x, key, extra, prompt)),
  ].slice(0, 12);
  writeHistory(all);
  renderHistory();
}

function renderHistory() {
  const box = $('#history');
  const items = promptHistory().slice(0, 8);
  if (!items.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = `<div class="task-history-head">세션 히스토리</div>` + items.map((it, idx) => `
    <div class="task-history-item" data-hidx="${idx}" role="button" tabindex="0" title="클릭하면 실행 화면에서 이전 대화를 봅니다">
      <div class="task-history-main">
        <b>${esc(it.sessionId ? `Claude 세션 ${it.sessionId.slice(0, 8)}` : (it.backgroundTaskId ? `작업 세션 ${it.backgroundTaskId.slice(0, 8)}` : (it.label || '작업 세션')))}</b>
        <span>${esc(it.ts ? it.ts.slice(5, 16).replace('T', ' ') : '')}</span>
        <p>${esc(truncate(historyPromptText(it), 180))}</p>
      </div>
      <button class="task-history-delete" type="button" data-hidx="${idx}" title="히스토리에서 삭제">×</button>
    </div>
  `).join('');
  const showHistoryInWorkbench = (idx) => {
    const item = items[idx];
    if (!item) return;
    const conversation = historyConversation(item);
    const body = conversation || `[내 메시지]\n${historyPromptText(item)}\n\n이전 버전에서 저장된 항목이라 대화 내용 스냅샷은 없습니다. 앞으로 실행한 세션부터 저장됩니다.`;
    sessionId = item.sessionId || sessionId;
    canResume = !!sessionId;
    awaiting = item.status === 'awaiting';
    $('#runPanel').classList.remove('hidden');
    $('#status').textContent = canResume
      ? '히스토리 대화를 열었습니다. 아래 입력창에서 같은 세션으로 이어서 말할 수 있습니다.'
      : '히스토리 대화를 열었습니다.';
    setOutput(body);
    $('#replyRow').classList.add('hidden');
    setRunVisible(false);
    $('#prompt').value = '';
    $('#prompt').placeholder = canResume
      ? '이전 대화에 이어서 메시지를 입력하세요. Enter로 보냅니다.'
      : '새 메시지를 입력하면 새 Claude 세션으로 시작합니다.';
    runTaskStatus = awaiting ? 'awaiting' : 'completed';
    runUpdatedAt = item.updatedAt || item.ts || runUpdatedAt;
    updateRunFacts();
    state('히스토리', 'idle');
    box.querySelectorAll('.task-history-item').forEach(row => row.classList.toggle('selected', +row.dataset.hidx === idx));
    $('#prompt').focus();
  };
  box.querySelectorAll('.task-history-item').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.task-history-delete')) return;
      showHistoryInWorkbench(+row.dataset.hidx);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      showHistoryInWorkbench(+row.dataset.hidx);
    });
  });
  box.querySelectorAll('.task-history-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const item = items[+btn.dataset.hidx];
      removeHistoryItem(item);
      renderHistory();
    });
  });
}

function activeTextArea() {
  return document.activeElement && document.activeElement.id === 'reply' ? $('#reply') : $('#prompt');
}

function commandMatches() {
  const ta = activeTextArea();
  const value = ta.value || '';
  const pos = ta.selectionStart == null ? value.length : ta.selectionStart;
  const before = value.slice(Math.max(0, pos - 96), pos);
  const m = before.match(/(?:^|\s)(\/[^\s]*)$/);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return commands.filter(c => c.name && c.name.toLowerCase().startsWith(q)).slice(0, 8);
}

function renderCommandSuggest() {
  const ta = activeTextArea();
  const box = ta.id === 'reply' ? $('#replySuggest') : $('#commandSuggest');
  const other = ta.id === 'reply' ? $('#commandSuggest') : $('#replySuggest');
  other.classList.add('hidden');
  const matches = commandMatches();
  if (running || !matches.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `<div class="skill-title">Claude 명령어</div>` + matches.map((c, idx) => `
    <button class="skill-chip command-chip ${idx === commandActiveIndex ? 'active' : ''}" data-cidx="${idx}">
      <b>${esc(c.name)}</b><span>${esc(c.summary || c.source || '')}</span>
    </button>
  `).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.command-chip').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      insertCommand(matches[+btn.dataset.cidx].name);
    });
  });
}

function scheduleCommandSuggest() {
  if (!commandMatches().length) {
    hideCommandSuggest();
    return;
  }
  if (commandSuggestRaf) return;
  commandSuggestRaf = requestAnimationFrame(() => {
    commandSuggestRaf = 0;
    renderCommandSuggest();
  });
}

function hideCommandSuggest() {
  for (const box of [$('#commandSuggest'), $('#replySuggest')]) {
    if (!box || box.classList.contains('hidden')) continue;
    box.classList.add('hidden');
    box.innerHTML = '';
  }
}

function insertCommand(name) {
  const ta = activeTextArea();
  ta.value = (ta.value || '').replace(/(?:^|\s)(\/[^\s]*)$/, (m) => (m.startsWith(' ') ? ' ' : '') + name + ' ');
  hideCommandSuggest();
  ta.focus();
}

function handleCommandKeys(e) {
  if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) return false;
  const matches = commandMatches();
  if (!matches.length) return false;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    commandActiveIndex = (commandActiveIndex + 1) % matches.length;
    renderCommandSuggest();
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    commandActiveIndex = (commandActiveIndex - 1 + matches.length) % matches.length;
    renderCommandSuggest();
    return true;
  }
  if (e.key === 'Escape') {
    hideCommandSuggest();
    return true;
  }
  return false;
}

function insertTextareaNewline(ta) {
  const start = ta.selectionStart || 0;
  const end = ta.selectionEnd || 0;
  const value = ta.value || '';
  ta.value = value.slice(0, start) + '\n' + value.slice(end);
  ta.setSelectionRange(start + 1, start + 1);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function isQuestion(text) {
  const tail = String(text || '').slice(-400);
  if (/[?？]\s*$/.test(tail.trim())) return true;
  return /(어느 것|어떤 (걸|것|쪽|방향)|선택해|골라|할까요|하시겠|하실래|알려주세요|진행할까|맞나요|괜찮(을까|나요)|1\)|①|\[1\])/.test(tail);
}

function needsUserDecision(text) {
  const s = String(text || '');
  const tail = s.slice(-4000);
  return isQuestion(s)
    || /(필요한\s*결정|어느\s*쪽으로\s*할까요|번호로\s*(알려|선택)|사용자\s*결정|확인.*필요|확인받|진행해도\s*(될까요|되나요)|선택(?:해|하세요)|권장:\s*\d|되돌릴 수 없는|비가역)/i.test(tail);
}

function latestAssistantTurnText(detail) {
  const turns = Array.isArray(detail && detail.turns) ? detail.turns : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn && turn.role === 'assistant' && String(turn.text || '').trim()) return String(turn.text || '');
    if (turn && turn.role === 'user' && String(turn.text || '').trim()) return '';
  }
  return '';
}

function liveSessionNeedsUserDecision(detail, session) {
  if (session && session.awaiting) return true;
  const latestAssistant = latestAssistantTurnText(detail);
  return !!latestAssistant && needsUserDecision(latestAssistant);
}

function stageMsg(res) {
  const m = { 'write-raw': '인박스 쓰기 실패', spawn: 'claude 실행 불가', exec: 'claude 오류', timeout: 'claude 시간 초과', stopped: '대화 중단됨', stale: '실행 상태 확인 불가' };
  return (m[res.stage] || 'claude 실패') + (res.error ? `: ${truncate(res.error, 120)}` : '');
}

async function runTurn(opts, label = null) {
  if (running) return;
  try {
    opts = await ensureExecutionWorkspace(opts);
  } catch (e) {
    running = false;
    state('멈춤', 'blocked');
    $('#status').textContent = `⚠ ${String(e && e.message || e)}`;
    updateRunFacts();
    return;
  }
  const clientRunId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  opts = { ...opts, clientRunId, backgroundOnly: true };
  running = true;
  runTaskStatus = 'running';
  runStartedAt = new Date().toISOString();
  runUpdatedAt = runStartedAt;
  stopRequested = false;
  awaiting = false;
  state('실행 중', 'running');
  setLocked(true);
  setRunVisible(true);
  setStopVisible(true, true);
  $('#runPanel').classList.remove('hidden');
  $('#replyRow').classList.add('hidden');
  $('#reply').value = pendingReply;
  $('#reply').placeholder = '실행 중 전달할 메시지를 적어두세요. 현재 턴이 끝나면 같은 세션에 자동으로 보냅니다.';
  $('#replyBtn').textContent = pendingReply ? '예약됨' : '끝나면 보내기 ↵';
  $('#prompt').value = '';
  $('#prompt').placeholder = 'Claude가 처리 중입니다. 지금 적으면 현재 턴이 끝난 뒤 같은 세션에 이어서 보냅니다.';
  $('#status').textContent = '실행 중… (claude 작업 시작)';
  tokenUsage = null;
  quotaRemaining = null;
  setTokenUsage(tokenUsage);
  setQuotaRemaining(null);
  if (label) outputText += (outputText ? '\n\n──────────\n' : '') + label + '\n\n──────────\n\n';
  setOutput(outputText, { forceScroll: true });
  updateRunFacts();
  const historyLabel = label ? label.replace(/^›\s*/, '') : '작업 실행';
  const historyPrompt = opts.historyPrompt || opts.prompt;
  persistSessionState({ draftOpen: false, lastPrompt: historyPrompt, statusText: '실행 중…' });
  saveHistory(historyLabel, historyPrompt, {
    conversation: outputText,
    sessionId,
    backgroundTaskId,
    status: 'running',
  });

  const startedAt = Date.now();
  let lastChunkAt = startedAt;
  const ticker = setInterval(() => {
    const idle = Date.now() - lastChunkAt;
    $('#status').textContent = `실행 중… (${Math.floor((Date.now() - startedAt) / 1000)}초 경과)` + (idle > 4000 ? ' — claude 처리 중…' : '');
    setActivity(idle > 4000 ? 'thinking' : activityKind, activityLabel);
  }, 1000);

  const off = window.lodestar.onTaskProgress((payload) => {
    if (payload && typeof payload === 'object' && payload.clientRunId !== clientRunId) return;
    const chunk = payload && payload.chunk !== undefined ? payload.chunk : payload;
    if (chunk && typeof chunk === 'object') {
      if (chunk.type === 'started') {
        backgroundTaskId = chunk.taskId;
        runTaskStatus = 'running';
        runUpdatedAt = new Date().toISOString();
        updateRunFacts();
        setStopVisible(true, true);
        if (stopRequested) stopCurrentTask();
        persistSessionState({ draftOpen: false, lastPrompt: historyPrompt, statusText: '실행 중입니다. 이 창이나 앱을 닫아도 작업은 계속 진행됩니다.' });
        saveHistory(historyLabel, historyPrompt, {
          conversation: outputText,
          sessionId,
          backgroundTaskId,
          status: 'running',
        });
      }
      if (chunk.type === 'usage') {
        tokenUsage = chunk.usage || null;
        setTokenUsage(tokenUsage);
      }
      return;
    }
    lastChunkAt = Date.now();
    runUpdatedAt = new Date().toISOString();
    outputText += String(chunk || '');
    setActivity('working', '작업 중', 'Claude 출력이 들어오고 있습니다.');
    scheduleOutput(outputText);
  });

  const res = await window.lodestar.runTask(opts);
  clearInterval(ticker);
  if (off) off();
  if (res && res.background && res.taskId && (res.running || res.stage === 'started')) {
    backgroundTaskId = res.taskId;
    running = true;
    stopRequested = false;
    awaiting = false;
    $('#status').textContent = '실행 중입니다. 이 창이나 앱을 닫아도 작업은 계속 진행됩니다.';
    persistSessionState({ draftOpen: false, lastPrompt: historyPrompt, statusText: $('#status').textContent });
    saveHistory(historyLabel, historyPrompt, {
      conversation: outputText,
      sessionId,
      backgroundTaskId,
      status: 'running',
    });
    if (window.lodestar.getTask) {
      const task = await window.lodestar.getTask(backgroundTaskId);
      if (task) renderBackgroundTask(task);
    }
    pollBackgroundTask(backgroundTaskId);
    return;
  }
  if (res && res.sessionId) sessionId = res.sessionId;
  runTaskStatus = res && res.ok ? 'completed' : ((res && res.stage) || 'failed');
  runUpdatedAt = new Date().toISOString();
  if (res && res.tokenUsage) {
    tokenUsage = res.tokenUsage;
    setTokenUsage(tokenUsage);
  }
  const asked = !!(res && res.ok && isQuestion(res.output || ''));
  canResume = !!(sessionId && res && res.ok);
  awaiting = asked;
  running = false;
  stopRequested = false;
  setLocked(false);
  setStopVisible(false);
  $('#prompt').placeholder = '메시지를 입력하세요. Enter로 보냅니다. Shift+Tab은 줄바꿈입니다.';
  updateRunFacts();
  if (!res || !res.ok) {
    state('멈춤', 'blocked');
    $('#status').textContent = `⚠ ${stageMsg(res || {})}`;
  } else if (asked) {
    state('답변 필요', 'awaiting');
    $('#status').textContent = 'Claude가 질문했어요. 아래에 답하면 같은 세션으로 이어집니다.';
  } else {
    state('완료', 'done');
    $('#status').textContent = '응답 완료. 아래 입력창에서 같은 세션으로 계속 말할 수 있습니다.';
  }
  updateWindowAttention();
  persistSessionState({ draftOpen: false, lastPrompt: historyPrompt, statusText: $('#status').textContent });
  saveHistory(historyLabel, historyPrompt, {
    conversation: outputText,
    sessionId,
    backgroundTaskId,
    status: running ? 'running' : (asked ? 'awaiting' : (!res || !res.ok ? 'blocked' : 'completed')),
  });

  const pending = pendingReply.trim();
  pendingReply = '';
  if (pending && sessionId) {
    $('#reply').value = '';
    await runTurn({ projectPath: executionPath || project.path, baseProjectPath: project.path, prompt: pending, historyPrompt: pending, branch: projectBranchKey(project), sessionId }, `› 중간 메시지: ${pending}`);
    return;
  }
  $('#replyRow').classList.add('hidden');
  $('#replyBtn').textContent = '보내기 ↵';
  $('#reply').placeholder = '이 대화에 이어서 보낼 메시지를 입력하세요.';
}

async function runFromPrompt() {
  const text = $('#prompt').value.trim();
  if (running) {
    if (!text) { $('#prompt').focus(); return; }
    pendingReply = text;
    $('#prompt').value = '';
    $('#runBtn').textContent = '예약됨';
    $('#status').textContent = '실행 중… 현재 턴이 끝나면 방금 메시지를 이어서 보냅니다';
    persistSessionState({ draftOpen: false, statusText: $('#status').textContent });
    return;
  }
  if (!text && !(canResume && sessionId)) {
    $('#prompt').focus();
    return;
  }
  await runTurn(taskOpts(text), text ? `› 나: ${text}` : '› 이어서 진행');
}

async function sendReply() {
  const text = $('#reply').value.trim();
  if (!text) {
    $('#reply').focus();
    return;
  }
  if (running) {
    pendingReply = text;
    $('#replyBtn').textContent = '예약됨';
    $('#status').textContent = '실행 중… 현재 턴이 끝나면 같은 세션에 이어서 보냅니다';
    persistSessionState({ draftOpen: false, statusText: $('#status').textContent });
    return;
  }
  if (!sessionId) {
    $('#status').textContent = '이어갈 Claude 세션 ID를 찾지 못했습니다.';
    return;
  }
  $('#reply').value = '';
  const startsFresh = isWccCommandText(text);
  await runTurn({
    projectPath: executionPath || project.path,
    baseProjectPath: project.path,
    prompt: text,
    historyPrompt: text,
    branch: projectBranchKey(project),
    sessionId: startsFresh ? null : sessionId,
    clearContext: startsFresh,
    workstream: lane && lane.kind === 'workstream' ? { name: lane.name } : null,
  }, startsFresh ? `› WCC 새 세션: ${text}` : `› 내 답변: ${text}`);
}

async function stopCurrentTask() {
  if (!window.lodestar.stopTask) return;
  stopRequested = true;
  setActivity('stopping', '중단 중', '현재 Claude 작업을 중단하고 있습니다.');
  for (const btn of [$('#stopBtn'), $('#stopInlineBtn')]) {
    if (btn) btn.disabled = true;
  }
  $('#status').textContent = backgroundTaskId ? '중단 중…' : '중단 예약됨 — 실행 프로세스가 연결되는 즉시 중단합니다.';
  persistSessionState({ draftOpen: false, statusText: $('#status').textContent });
  if (!backgroundTaskId) {
    setStopVisible(true, false);
    return;
  }
  const res = await window.lodestar.stopTask(backgroundTaskId);
  running = false;
  stopRequested = false;
  setLocked(false);
  setStopVisible(false);
  if (!res || !res.ok) {
    state('멈춤', 'blocked');
    $('#status').textContent = `중지 실패${res && res.error ? ': ' + truncate(res.error, 120) : ''}`;
  } else {
    state('중지됨', 'blocked');
    $('#status').textContent = '중단했습니다.';
  }
  persistSessionState({ draftOpen: false, statusText: $('#status').textContent });
}

function renderBackgroundTask(task) {
  stopLiveSessionPoll();
  backgroundTaskId = task.id || backgroundTaskId;
  sessionId = task.sessionId || sessionId;
  runTaskStatus = task.status || runTaskStatus;
  runStartedAt = task.startedAt || runStartedAt;
  runUpdatedAt = task.updatedAt || runUpdatedAt;
  tokenUsage = task.tokenUsage || tokenUsage || null;
  setTokenUsage(tokenUsage);
  setQuotaRemaining(task.quotaRemaining || null);
  const transcript = backgroundTaskTranscript(task, outputText);
  const decisionQuestion = decisionQuestionFromText(transcript);
  canResume = !!sessionId && (!isBgTaskRunning(task) || !!decisionQuestion);
  awaiting = !!(decisionQuestion && sessionId);
  running = !!isBgTaskRunning(task) && !awaiting;
  setLocked(running);
  $('#runPanel').classList.remove('hidden');
  $('#status').textContent = awaiting ? 'Claude가 결정을 기다리고 있습니다. 선택하거나 직접 답변하세요.' : backgroundStatusText(task);
  setOutput(transcript);
  renderAwaitingQuestion(decisionQuestion ? [decisionQuestion] : null);
  updateRunFacts(task);
  if (task.prompt) {
    saveHistory('작업 실행', task.prompt, {
      conversation: transcript,
      sessionId: task.sessionId || sessionId,
      backgroundTaskId: task.id,
      status: task.status,
    });
  }
  setRunVisible(!running && !!sessionId);
  setStopVisible(running, running);
  $('#replyRow').classList.toggle('hidden', !awaiting);
  $('#prompt').placeholder = running
    ? '이 작업이 끝난 뒤 이어서 보낼 메시지를 준비할 수 있습니다.'
    : (awaiting ? '결정 답변을 입력하세요. 선택지를 눌러도 됩니다.' : '이 세션에 이어서 보낼 메시지를 입력하세요.');
  updateRunFacts(task);
  state(awaiting ? '답변 필요' : (running ? '실행 중' : (task.status === 'completed' ? '완료' : '멈춤')), awaiting ? 'awaiting' : (running ? 'running' : (task.status === 'completed' ? 'done' : 'blocked')));
  updateWindowAttention();
}

async function renderHistorySession(session, opts = {}) {
  stopLiveSessionPoll();
  const live = !!opts.live;
  sessionId = session.sessionId || null;
  canResume = !!sessionId;
  awaiting = !!session.awaiting;
  running = !!liveSessionRecent(session) && !awaiting;
  tokenUsage = session.tokenUsage || tokenUsage || null;
  quotaRemaining = session.quotaRemaining || quotaRemaining || null;
  runTaskStatus = running ? 'running' : (awaiting ? 'awaiting' : 'completed');
  runUpdatedAt = session.updatedAt || session.lastTs || session.ts || runUpdatedAt;
  $('#sessionTitle').textContent = live ? `실시간 세션 · ${project.name}` : `세션 히스토리 · ${project.name}`;
  $('#sessionSub').textContent = `${sessionId ? `Claude 세션 ${sessionId.slice(0, 8)} · ` : ''}${project.path}`;
  $('#note').innerHTML = live
    ? (running
      ? '지금 실행 중인 Claude 세션입니다. 이 창은 실시간 대화 흐름을 보는 창이며, 작업이 끝나면 같은 세션으로 이어서 말할 수 있습니다.'
      : '최근 실행 증거가 없는 Claude 세션입니다. 저장된 로그를 보여주며, 아래 입력창에서 같은 세션으로 이어서 말할 수 있습니다.')
    : '완료되었거나 과거에 열었던 Claude 세션입니다. 아래 입력창에서 같은 세션으로 이어서 말할 수 있습니다.';
  $('#runPanel').classList.remove('hidden');
  $('#status').textContent = sessionId
    ? (live ? '실시간 Claude 세션을 불러오는 중…' : (running ? '실행 중인 Claude 세션을 불러오는 중…' : '세션 히스토리를 불러오는 중…'))
    : '세션 ID가 없어 이어서 대화할 수 없습니다.';
  setOutput(session.excerpt || '이 세션의 마지막 출력이 비어 있습니다.');
  setTokenUsage(tokenUsage);
  setQuotaRemaining(quotaRemaining);
  updateRunFacts();
  $('#replyRow').classList.add('hidden');
  setRunVisible(!!sessionId && !running);
  $('#runBtn').textContent = '보내기 ↵';
  $('#prompt').value = '';
  $('#prompt').placeholder = sessionId
    ? (running
      ? '외부 Claude가 아직 실행 중입니다. 완료 후 이 세션에 이어서 메시지를 보낼 수 있습니다.'
      : (awaiting ? 'Claude가 결정을 기다리고 있습니다. 답변을 입력하고 Enter로 보내세요.' : '이 세션에 이어서 메시지를 입력하세요. Enter로 보냅니다.'))
    : '새 메시지를 입력하면 새 Claude 세션으로 시작합니다.';
  $('#prompt').readOnly = running;
  state(live ? (awaiting ? '답변 필요' : (running ? '실시간 세션' : '히스토리')) : (running ? '실행 중' : (awaiting ? '답변 필요' : '히스토리')), running ? 'running' : (awaiting ? 'awaiting' : 'idle'));
  updateWindowAttention();

  await refreshHistorySessionDetail(session, live);
  if (live && running && sessionId) pollLiveSessionDetail(session);
  updateWindowAttention();
  if (!running) $('#prompt').focus();
}

async function refreshHistorySessionDetail(session, live) {
  if (sessionId && window.lodestar.sessionDetail) {
    const detail = await window.lodestar.sessionDetail({ projectPath: project.path, sessionId });
    if (detail && detail.ok) {
      tokenUsage = detail.tokenUsage || tokenUsage || null;
      setTokenUsage(tokenUsage);
      quotaRemaining = detail.quotaRemaining || quotaRemaining || null;
      setQuotaRemaining(quotaRemaining);
      const nextOutput = detail.output || session.excerpt || '';
      if (nextOutput !== outputText) setOutput(nextOutput || '이 세션의 대화 내용이 비어 있습니다.');
      const decisionQuestion = decisionQuestionFromText(nextOutput);
      runTaskStatus = running ? 'running' : (awaiting ? 'awaiting' : 'completed');
      runUpdatedAt = detail.lastTs || detail.updatedAt || runUpdatedAt;
      updateRunFacts();
      const decisionGate = live && (liveSessionNeedsUserDecision(detail, session) || !!decisionQuestion);
      if (decisionGate) {
        awaiting = true;
        running = false;
        canResume = !!sessionId;
        renderAwaitingQuestion(decisionQuestion || session.awaitingQuestions || session.awaitingQuestion || null);
        setRunVisible(!!sessionId);
        $('#prompt').readOnly = false;
        $('#prompt').placeholder = 'Claude가 결정을 기다리고 있습니다. 답변을 입력하고 Enter로 보내세요.';
        state('답변 필요', 'awaiting');
        updateRunFacts();
      } else if (live && liveSessionRecent(session, detail)) {
        awaiting = false;
        running = true;
        runTaskStatus = 'running';
        $('#prompt').readOnly = true;
        setRunVisible(false);
        setStopVisible(false);
        $('#prompt').placeholder = '외부 Claude가 아직 실행 중입니다. 이 창은 기록을 실시간으로 보여줍니다.';
        state('실시간 세션', 'running');
        updateRunFacts();
      } else if (live) {
        awaiting = false;
        running = false;
        runTaskStatus = 'completed';
        canResume = !!sessionId;
        $('#prompt').readOnly = false;
        setRunVisible(!!sessionId);
        setStopVisible(false);
        $('#prompt').placeholder = '이 세션에 이어서 메시지를 입력하세요. Enter로 보냅니다.';
        state('히스토리', 'idle');
        updateRunFacts();
      }
      $('#status').textContent = live
        ? (decisionGate
          ? 'Claude가 사용자 결정을 기다리고 있습니다. 아래 입력창에 답하면 같은 세션으로 이어집니다.'
          : (running
            ? '실시간 Claude 세션 기록을 갱신 중입니다. 메인 출력과 서브에이전트 로그를 함께 보여줍니다.'
            : '최근 실행 증거가 없어 히스토리 세션으로 전환했습니다. 같은 세션으로 이어서 말할 수 있습니다.'))
        : running
        ? '실행 중인 Claude 세션을 열었습니다. 전체 로그를 확인할 수 있고, 완료 후 이어서 대화할 수 있습니다.'
        : '히스토리 세션을 열었습니다. 아래 입력창에서 같은 세션으로 이어서 말할 수 있습니다.';
      if (!live && detail.firstUser) {
        saveHistory('히스토리 세션', detail.firstUser, {
          conversation: outputText,
          sessionId,
          status: awaiting ? 'awaiting' : 'completed',
          tokenUsage,
        });
      }
    } else {
      $('#status').textContent = `세션 로그를 불러오지 못했습니다${detail && detail.error ? ': ' + truncate(detail.error, 120) : ''}. 그래도 같은 세션으로 메시지를 보낼 수 있습니다.`;
    }
  }
}

function stopLiveSessionPoll() {
  if (livePollTimer) clearInterval(livePollTimer);
  livePollTimer = null;
  liveDetailInFlight = false;
}

function pollLiveSessionDetail(session) {
  if (!sessionId || !window.lodestar.sessionDetail) return;
  stopLiveSessionPoll();
  livePollTimer = setInterval(async () => {
    if (liveDetailInFlight) return;
    liveDetailInFlight = true;
    try {
      await refreshHistorySessionDetail(session, true);
      updateWindowAttention();
    } finally {
      liveDetailInFlight = false;
    }
  }, 1200);
}

function pollBackgroundTask(id) {
  if (!id || !window.lodestar.getTask) return;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const next = await window.lodestar.getTask(id);
    if (!next) return;
    renderBackgroundTask(next);
    if (!isBgTaskRunning(next)) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 1200);
}

function renderQuestions() {
  const box = $('#questions');
  if (!discuss) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const items = [];
  for (const q of (discuss.questions || []).slice(0, 8)) items.push(q.text || q);
  for (const sec of (discuss.sections || [])) for (const it of (sec.items || []).slice(0, 4)) items.push(it);
  box.innerHTML = items.map(text => `<button class="dq" type="button">${esc(truncate(text, 180))}</button>`).join('');
  box.classList.toggle('hidden', !items.length);
  box.querySelectorAll('.dq').forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      discuss.pickedQuestion = items[idx];
      $('#prompt').focus();
    });
  });
}

function normalizedAwaitingQuestions(input) {
  if (Array.isArray(input)) return input.filter(Boolean);
  return input ? [input] : [];
}

function numberedDecisionChoices(text) {
  const s = String(text || '').replace(/\r/g, '\n');
  const choices = [];
  const re = /(?:^|\n)\s*(?:[-*]\s*)?(?:옵션\s*)?(\d{1,2})(?:번|[.)])\s+([\s\S]*?)(?=(?:\n)\s*(?:[-*]\s*)?(?:옵션\s*)?\d{1,2}(?:번|[.)])\s+|$)/g;
  for (const m of s.matchAll(re)) {
    const num = m[1];
    const raw = String(m[2] || '').trim();
    if (!raw) continue;
    const first = raw.split(/\n/).map(x => x.trim()).find(Boolean) || raw;
    const clean = first.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 2) continue;
    choices.push({
      label: `${num}. ${clean.slice(0, 88)}`,
      value: num,
      description: raw.replace(first, '').replace(/\s+/g, ' ').trim().slice(0, 180),
    });
  }
  return choices.slice(0, 8);
}

function decisionQuestionFromText(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const tail = s.slice(-7000);
  const cue = /(방향\s*결정\s*필요|결정\s*필요|필요한\s*결정|사용자\s*결정|진짜\s*갈림길|상충\s*상황|어느\s*쪽으로\s*할까요|번호로\s*(알려|선택)|선택(?:해|하세요)|확인받)/i.test(tail);
  if (!cue) return null;
  const idx = Math.max(
    tail.search(/방향\s*결정\s*필요/i),
    tail.search(/필요한\s*결정/i),
    tail.search(/사용자\s*결정/i),
    tail.search(/진짜\s*갈림길/i),
    tail.search(/상충\s*상황/i),
  );
  const segment = (idx >= 0 ? tail.slice(idx) : tail).trim();
  let choices = numberedDecisionChoices(segment);
  if (choices.length < 2 && /옵션\s*1|옵션1/i.test(segment) && /08-02-PLAN|PLAN|플랜/i.test(segment)) {
    choices = [
      { label: '1. 승인된 옵션1로 진행', value: '1', description: 'RefundTarget 6필드와 UI 확장까지 반영해서 진행' },
      { label: '2. 현재 08-02-PLAN 경계 유지', value: '2', description: '어댑터 본문 범위만 유지하고 환불 잔여는 보류' },
    ];
  }
  const firstChoice = segment.search(/(?:^|\n)\s*(?:[-*]\s*)?(?:옵션\s*)?\d{1,2}(?:번|[.)])\s+/);
  const head = firstChoice >= 0 ? segment.slice(0, firstChoice) : segment;
  const lines = head.split(/\n/).map(x => x.replace(/^[-*#>\s]+/, '').trim()).filter(Boolean);
  const question = lines.find(line => /(방향\s*결정\s*필요|결정\s*필요|필요한\s*결정|어느\s*쪽|상충\s*상황|갈림길)/i.test(line))
    || '사용자 결정이 필요합니다. 선택하거나 직접 답변하세요.';
  return {
    id: `text-decision-${Date.now()}`,
    question,
    choices,
    freeText: true,
    inferred: true,
  };
}

function awaitingQuestionAnswerText(box, questions) {
  const cards = Array.from(box.querySelectorAll('.await-question'));
  return cards.map((card, idx) => {
    const question = questions[idx] || {};
    const input = card.querySelector('.await-answer-input');
    const answer = input ? input.value.trim() : '';
    if (!answer) return '';
    const label = questions.length > 1 ? `Q${idx + 1}. ${question.question || '사용자 답변'}\nA${idx + 1}. ` : '';
    return `${label}${answer}`;
  }).filter(Boolean).join('\n\n');
}

function sendAwaitingQuestionAnswers(box, questions) {
  const answer = awaitingQuestionAnswerText(box, questions);
  if (!answer) {
    const first = box.querySelector('.await-answer-input');
    if (first) first.focus();
    return;
  }
  $('#prompt').value = answer;
  runFromPrompt();
}

function renderAwaitingQuestion(question) {
  const box = $('#questions');
  const questions = normalizedAwaitingQuestions(question);
  if (!questions.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="await-choice-head">${questions.length > 1 ? `질문 ${questions.length}개에 답한 뒤 보내세요.` : '선택하거나 직접 답변하세요.'}</div>
    ${questions.map((q, qidx) => {
      const choices = Array.isArray(q && q.choices) ? q.choices : [];
      return `
        <div class="await-question" data-question-idx="${qidx}">
          <div class="await-question-text">${questions.length > 1 ? `<b>${qidx + 1}</b>` : ''}<span>${esc(q.question || '사용자 답변이 필요합니다.')}</span></div>
          ${choices.length ? `<div class="await-choice-list">${choices.map((choice, idx) => `
            <button class="dq await-choice" type="button" data-question-idx="${qidx}" data-choice-idx="${idx}">
              <b>${esc(choice.label || choice.value || `선택 ${idx + 1}`)}</b>
              ${choice.description ? `<span>${esc(choice.description)}</span>` : ''}
            </button>
          `).join('')}</div>` : ''}
          <textarea class="await-answer-input" rows="2" placeholder="직접 답변"></textarea>
        </div>
      `;
    }).join('')}
    <div class="await-send-row"><button class="btn primary await-send-all" type="button">답변 보내기</button></div>`;
  box.querySelectorAll('.await-choice').forEach(btn => {
    btn.addEventListener('click', () => {
      const qidx = +btn.dataset.questionIdx;
      const choices = Array.isArray(questions[qidx] && questions[qidx].choices) ? questions[qidx].choices : [];
      const choice = choices[+btn.dataset.choiceIdx];
      const value = choice && (choice.value || choice.label);
      if (!value) return;
      const card = box.querySelector(`.await-question[data-question-idx="${qidx}"]`);
      const input = card && card.querySelector('.await-answer-input');
      if (input) input.value = value;
      if (questions.length === 1) sendAwaitingQuestionAnswers(box, questions);
    });
  });
  const send = box.querySelector('.await-send-all');
  if (send) send.addEventListener('click', () => sendAwaitingQuestionAnswers(box, questions));
}

function renderShell() {
  const scope = laneLabel(lane);
  const isDiscuss = !!discuss;
  $('#sessionTitle').textContent = isDiscuss ? `논의 의견 · ${project.name}` : `작업 세션 · ${project.name}`;
  $('#sessionSub').textContent = `${scope} · ${project.path}`;
  $('#factProject').textContent = project.name || project.path;
  $('#factBranch').textContent = projectBranchKey(project);
  $('#factLane').textContent = scope;
  updateRunFacts();
  setTokenUsage(tokenUsage);
  setQuotaRemaining(quotaRemaining);
  $('#note').innerHTML = lane && lane.kind === 'workstream'
    ? `이 창은 <b>${esc(scope)}</b> 범위의 독립 Claude 세션입니다. 작업 산출물은 <code>.planning/workstreams/${esc(lane.name)}</code> 기준으로 우선 처리됩니다.`
    : '이 창은 현재 브랜치에서 새 터미널을 하나 띄운 것처럼 동작하는 독립 Claude 세션입니다.';
  $('#promptLabel').textContent = '메시지';
  $('#prompt').placeholder = isDiscuss
    ? '이 논의에 대한 의견을 자연스럽게 적어주세요. Enter로 보냅니다. Shift+Tab은 줄바꿈입니다.'
    : (lane && lane.kind === 'workstream'
      ? `${lane.name} 워크스트림에 대해 지시하거나 질문하세요. /wcc-quick도 사용할 수 있습니다.`
      : '무엇을 할지 대화하듯이 적어주세요. 예: 테스트 실패 원인 찾아줘 /wcc-quick ...');
  renderQuestions();
  renderHistory();
}

async function loadCommands() {
  try {
    commands = await window.lodestar.listCommands({ projectPath: project && project.path });
  } catch {
    commands = [];
  }
}

function hydrateFromPayload() {
  project = payload.project || {};
  lane = payload.lane || null;
  discuss = payload.discuss || null;
  mode = payload.mode || 'new';
  if (!lane && payload.session && payload.session.laneId) {
    lane = payload.session.laneId === 'main'
      ? { kind: 'main', name: 'main', state: project.state, phases: project.phases }
      : { kind: 'workstream', name: String(payload.session.laneId).replace(/^workstream:/, '') };
  }
  if (payload.task) {
    sessionId = payload.task.sessionId || null;
    backgroundTaskId = payload.task.backgroundTaskId || null;
    draftText = payload.task.draft || '';
    executionPath = payload.task.executionPath || payload.task.projectPath || project.path;
    baseProjectPath = payload.task.baseProjectPath || project.path;
    usingWorktree = !!payload.task.usingWorktree;
    executionBranch = payload.task.executionBranch || payload.task.branch || payload.branch || null;
    canResume = !!(payload.task.canResume || sessionId);
    outputText = payload.task.output || payload.task.excerpt || '';
    tokenUsage = payload.task.tokenUsage || null;
    quotaRemaining = payload.task.quotaRemaining || null;
    awaiting = !!payload.task.awaiting;
    lane = payload.lane || payload.task.lane || lane;
    discuss = payload.discuss || payload.task.discuss || discuss;
  }
  renderShell();
  if (draftText && mode === 'new' && !sessionId && !backgroundTaskId && !outputText) {
    $('#prompt').value = draftText;
    persistSessionState({ draft: draftText, draftOpen: true, statusText: '새 세션 작성 중' });
  }

  if (mode === 'background' && payload.backgroundTask) {
    renderBackgroundTask(payload.backgroundTask);
    if (isBgTaskRunning(payload.backgroundTask)) pollBackgroundTask(payload.backgroundTask.id);
    return;
  }
  if (mode === 'history' && payload.session) {
    renderHistorySession(payload.session);
    return;
  }
  if (mode === 'live-session' && payload.session) {
    renderHistorySession(payload.session, { live: true });
    return;
  }
  if (mode === 'phase-running') {
    const phase = payload.phase || {};
    running = true;
    runTaskStatus = 'running';
    runUpdatedAt = payload.openedAt || new Date().toISOString();
    $('#sessionTitle').textContent = `에이전트 실행 중 · ${project.name}`;
    $('#sessionSub').textContent = `${laneLabel(lane)}${phase.num ? ` · Phase ${phase.num} — ${phase.title || phase.stageLabel || ''}` : ''}`;
    $('#note').innerHTML = '현재 phase가 이미 실행 중입니다. 이 창은 새 세션 작성 화면이 아니라 실행 상태 확인 화면입니다.';
    $('#runPanel').classList.remove('hidden');
    $('#status').textContent = '실행 중인 phase입니다. 새 세션이 아닙니다.';
    setOutput([
      `${laneLabel(lane)} phase가 실행 중입니다.`,
      phase.num ? `Phase ${phase.num} — ${phase.title || phase.stageLabel || '실행 중'}` : '실행 중인 phase 정보를 확인하는 중입니다.',
      'Claude 세션 ID가 감지되면 실시간 세션으로 열립니다.',
    ].join('\n\n'));
    $('#replyRow').classList.add('hidden');
    setRunVisible(false);
    setStopVisible(false);
    $('#prompt').readOnly = true;
    state('실행 중', 'running');
    updateRunFacts();
    updateWindowAttention();
    return;
  }
  if (mode === 'awaiting' && payload.activity) {
    sessionId = payload.activity.sessionId || null;
    canResume = !!sessionId;
    awaiting = true;
    running = false;
    runTaskStatus = 'awaiting';
    runUpdatedAt = payload.activity.lastTs || payload.activity.updatedAt || runUpdatedAt;
    $('#runPanel').classList.remove('hidden');
    $('#status').textContent = sessionId ? 'Claude가 답변을 기다리는 중입니다.' : '답변 대기 상태지만 세션 ID를 찾지 못했습니다.';
    setOutput(payload.activity.awaitingText || 'Claude가 사용자 답변을 기다리고 있습니다.');
    renderAwaitingQuestion(payload.activity.awaitingQuestions || payload.activity.awaitingQuestion || null);
    $('#replyRow').classList.add('hidden');
    setRunVisible(!!sessionId);
    state('답변 필요', 'awaiting');
    updateRunFacts();
    return;
  }
  if (mode === 'blocked' && payload.activity) {
    sessionId = payload.activity.sessionId || null;
    canResume = !!sessionId;
    running = false;
    runTaskStatus = 'blocked';
    runUpdatedAt = payload.activity.lastTs || payload.activity.updatedAt || runUpdatedAt;
    const pause = payload.pause || { label: '멈춤', detail: payload.activity.blockedText || '' };
    $('#runPanel').classList.remove('hidden');
    $('#status').textContent = sessionId ? `${pause.label} — 같은 세션으로 이어서 실행할 수 있습니다.` : `${pause.label} — 이어갈 세션 ID를 찾지 못했습니다.`;
    setOutput(pause.detail || 'Claude가 제한 또는 오류로 중단되었습니다.');
    $('#runBtn').textContent = '▶ 이어서 실행';
    $('#runBtn').disabled = !sessionId;
    $('#replyRow').classList.add('hidden');
    state(pause.label, 'blocked');
    updateRunFacts();
    return;
  }
  if (mode === 'task-session') {
    $('#runPanel').classList.remove('hidden');
    setOutput(outputText);
    $('#status').textContent = payload.task && payload.task.statusText ? payload.task.statusText : '세션을 열었습니다.';
    $('#replyRow').classList.add('hidden');
    if (backgroundTaskId) pollBackgroundTask(backgroundTaskId);
    state(payload.task && payload.task.running ? '실행 중' : (awaiting ? '답변 필요' : '대기'), payload.task && payload.task.running ? 'running' : (awaiting ? 'awaiting' : 'idle'));
    runTaskStatus = payload.task && payload.task.running ? 'running' : (awaiting ? 'awaiting' : (backgroundTaskId ? 'completed' : null));
    runUpdatedAt = payload.task && (payload.task.updatedAt || payload.task.savedAt) || runUpdatedAt;
    updateRunFacts();
    updateWindowAttention();
    return;
  }
  state('대기', 'idle');
  updateRunFacts();
  persistSessionState({ draftOpen: false, lastPrompt: task.prompt || '', statusText: $('#status').textContent });
  updateWindowAttention();
}

async function init() {
  payload = await window.lodestar.taskWindowInit(windowId);
  if (!payload || !payload.project) {
    $('#sessionTitle').textContent = '세션을 열 수 없습니다';
    $('#sessionSub').textContent = '초기 컨텍스트를 찾지 못했습니다.';
    setRunVisible(false);
    return;
  }
  bindActivityStatusObserver();
  hydrateFromPayload();
  await loadCommands();
}

$('#runBtn').addEventListener('click', () => {
  if (mode === 'blocked' && sessionId && !$('#prompt').value.trim()) {
    runTurn({ projectPath: executionPath || project.path, baseProjectPath: project.path, prompt: '이전 작업을 이어서 진행해줘.', historyPrompt: '이전 작업을 이어서 진행해줘.', branch: projectBranchKey(project), sessionId }, '› 이어서 실행');
  } else {
    runFromPrompt();
  }
});
$('#stopBtn').addEventListener('click', stopCurrentTask);
const stopInlineBtn = $('#stopInlineBtn');
if (stopInlineBtn) stopInlineBtn.addEventListener('click', stopCurrentTask);
$('#replyBtn').addEventListener('click', sendReply);
for (const el of [$('#prompt'), $('#reply')]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      insertTextareaNewline(el);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (el.id === 'reply') sendReply();
      else runFromPrompt();
      return;
    }
    if (handleCommandKeys(e)) return;
  });
  el.addEventListener('input', () => {
    commandActiveIndex = 0;
    scheduleCommandSuggest();
    if (el.id === 'prompt' && !running && mode !== 'history' && mode !== 'live-session' && mode !== 'phase-running') {
      persistSessionState({ draft: el.value, draftOpen: !sessionId && !backgroundTaskId && !outputText, statusText: el.value.trim() ? '새 세션 작성 중' : '작성 전' });
    }
  });
  el.addEventListener('focus', renderCommandSuggest);
}

window.addEventListener('beforeunload', () => {
  persistSessionState({ draft: $('#prompt') ? $('#prompt').value : '', draftOpen: !sessionId && !backgroundTaskId && !outputText, statusText: $('#status') ? $('#status').textContent : '' });
  if (pollTimer) clearInterval(pollTimer);
  stopLiveSessionPoll();
  if (window.lodestar && window.lodestar.updateAttention) {
    window.lodestar.updateAttention({ source: `session:${windowId}`, items: [] }).catch(() => {});
  }
});

init();
