'use strict';

const $ = (s) => document.querySelector(s);
const THEME_KEY = 'lodestar.theme';

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

// ---------- 상태 ----------
let projects = [];          // 스캔 결과
let activeProject = null;    // 사이드바에서 선택된 프로젝트 path (null = 전체)
const view = { x: 40, y: 40, scale: 1 }; // 캔버스 팬/줌
let gitCtx = null;
let branchSessionCtx = null;

const STAGE_COLOR = {
  discuss: 'var(--s-discuss)', 'discuss-done': 'var(--s-discuss)',
  research: 'var(--s-research)', plan: 'var(--s-plan)',
  execute: 'var(--s-execute)', 'execute-done': 'var(--s-verify)',
  verify: 'var(--s-verify)', pending: 'var(--s-pending)',
};
const STAGE_ICON = {
  discuss: '💬', 'discuss-done': '💬', research: '🔍', plan: '📋',
  execute: '⚙', 'execute-done': '✓', verify: '✓', pending: '·',
};
const STAGE_KEY = { // 범례 dot 클래스
  discuss: 's-discuss', 'discuss-done': 's-discuss', research: 's-research',
  plan: 's-plan', execute: 's-execute', 'execute-done': 's-verify',
  verify: 's-verify', pending: 's-pending',
};

const NODE_W = 220, NODE_GAP_X = 90, LANE_GAP_Y = 200, LANE_TOP = 112, LANE_LEFT = 30;
const SESSION_BOARD_H = 172;
const SESSION_FRAME_MIN_W = 520;
const WORKSTREAM_GROUP_FRAME_W = 680;
const PROJECT_MIN_W = 720;
const BRANCH_CARD_MIN_W = 300;
const BRANCH_FLOW_NODE_W = 218;
const BRANCH_FLOW_COLLAPSE_W = 152;
const BRANCH_FLOW_EDGE_W = 44;
const NODE_BASE_H = 128, AGENT_DY = 152;
const COLLAPSE_W = 150;                 // 완료 묶음/접기 노드 폭
const POST_INTERACTION_REFRESH_MS = 1200;
const MAX_RENDER_CHARS = 120000;
const expandedLanes = new Set();        // 펼쳐둔 레인키(기본은 접힘)
let focusNext = true;                    // 다음 layout에서 현재 phase로 자동 포커스(초기·새로고침 1회)
let focusBranchKey = null;
let suppressSessionFrameClickUntil = 0;
let refreshBusy = false;
let refreshQueuedAuto = false;
let autoRefreshTimer = null;
let lastTextInputAt = 0;
let lastInteractionAt = 0;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

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

function compactNumber(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return String(n);
}

function relativeTime(value) {
  const ts = Date.parse(value || '');
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

function setTaskTokenUsage(usage, remaining = null) {
  const el = $('#taskTokenUsage');
  if (!el) return;
  const quota = remaining ? `
    <span class="task-quota-gauges">
      ${quotaGauge('5시간', remaining.fiveHour)}
      ${quotaGauge('7일', remaining.sevenDay)}
      ${quotaGauge('소넷', remaining.sonnet)}
    </span>` : '';
  el.innerHTML = quota;
  el.classList.toggle('hidden', !remaining);
}

function usageTotal(usage) {
  return Number(usage && usage.total) || 0;
}

function addUsage(a, b) {
  if (!b) return a || null;
  if (!a) return { ...b };
  return {
    input: (a.input || 0) + (b.input || 0),
    output: (a.output || 0) + (b.output || 0),
    cacheCreate: (a.cacheCreate || 0) + (b.cacheCreate || 0),
    cacheRead: (a.cacheRead || 0) + (b.cacheRead || 0),
    total: (a.total || 0) + (b.total || 0),
  };
}

function mergeRemainingQuota(a, b) {
  if (!b) return a || null;
  if (!a) return { ...b };
  const at = a.ts ? Date.parse(a.ts) : 0;
  const bt = b.ts ? Date.parse(b.ts) : 0;
  const newer = bt && (!at || bt >= at);
  const out = { ...a };
  for (const key of ['fiveHour', 'sevenDay', 'sonnet']) {
    if (newer) {
      if (b[key]) out[key] = b[key];
    } else if (!out[key] && b[key]) {
      out[key] = b[key];
    }
  }
  out.ts = newer ? (b.ts || a.ts || null) : (a.ts || b.ts || null);
  return out;
}

function collectProjectTokenRemaining(projectList) {
  let remaining = null;
  for (const p of projectList || []) {
    const act = p.activity || {};
    remaining = mergeRemainingQuota(remaining, act.quotaRemaining || null);
    for (const s of act.sessions || []) {
      remaining = mergeRemainingQuota(remaining, s.quotaRemaining || null);
    }
    for (const t of p.backgroundTasks || []) {
      remaining = mergeRemainingQuota(remaining, t.quotaRemaining || null);
    }
  }
  return remaining || {};
}

function readTokenRemainingCache() {
  try { return JSON.parse(localStorage.getItem(TOKEN_REMAINING_CACHE_KEY) || 'null'); } catch { return null; }
}

function writeTokenRemainingCache(remaining) {
  if (!remaining || (!remaining.fiveHour && !remaining.sevenDay && !remaining.sonnet)) return;
  localStorage.setItem(TOKEN_REMAINING_CACHE_KEY, JSON.stringify(remaining));
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

function updateTopTokenSummary(projectList) {
  const el = $('#topTokenSummary');
  if (!el) return;
  const detected = collectProjectTokenRemaining(projectList);
  const remaining = mergeRemainingQuota(readTokenRemainingCache(), detected) || {};
  writeTokenRemainingCache(remaining);
  el.innerHTML = `
    <span class="top-token-label">남은 사용량</span>
    ${quotaGauge('5시간', remaining.fiveHour)}
    ${quotaGauge('7일', remaining.sevenDay)}
    ${quotaGauge('소넷', remaining.sonnet)}
  `;
  el.title = 'Claude 상태줄에서 감지한 남은 사용량만 표시합니다. 감지되지 않은 항목은 - 로 표시합니다.';
}

function inlineMarkdown(text) {
  let s = esc(text);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) =>
    `<a href="${esc(url)}" target="_blank" rel="noreferrer">${label}</a>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return s;
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
  const src = readableMarkdown(text);
  if (!src.trim()) return '<div class="md-empty">아직 출력이 없습니다.</div>';
  const lines = src.split('\n');
  const html = [];
  let paragraph = [];
  let listType = null;
  let inCode = false;
  let code = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  };
  const openList = (type) => {
    flushParagraph();
    if (listType && listType !== type) closeList();
    if (!listType) {
      html.push(`<${type}>`);
      listType = type;
    }
  };
  const flushCode = () => {
    html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    code = [];
    inCode = false;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const fence = line.match(/^```[\w.-]*\s*$/);
    if (fence) {
      if (inCode) flushCode();
      else {
        flushParagraph(); closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { code.push(line); continue; }
    if (line.includes('|') && idx + 1 < lines.length && isMarkdownTableDivider(lines[idx + 1])) {
      flushParagraph(); closeList();
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
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph(); closeList();
      html.push(`<h${heading[1].length}>${inlineMarkdown(heading[2].trim())}</h${heading[1].length}>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushParagraph(); closeList(); html.push('<hr>'); continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph(); closeList();
      html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      openList('ul');
      html.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    const numbered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (numbered) {
      openList('ol');
      html.push(`<li>${inlineMarkdown(numbered[1])}</li>`);
      continue;
    }
    paragraph.push(line.trim());
  }
  if (inCode) flushCode();
  flushParagraph();
  closeList();
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
  if (!src.trim()) return '<div class="md-empty">아직 출력이 없습니다.</div>';
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
  return html.length ? `<div class="chat-transcript">${html.join('')}</div>` : '<div class="md-empty">아직 출력이 없습니다.</div>';
}

function renderableTranscript(text) {
  const value = String(text || '');
  if (value.length <= MAX_RENDER_CHARS) return value;
  return `... 이전 출력 ${value.length - MAX_RENDER_CHARS}자 생략 ...\n\n${value.slice(-MAX_RENDER_CHARS)}`;
}

const markdownRenderJobs = new WeakMap();

function setMarkdownOutput(elOrSelector, text, opts = {}) {
  const el = typeof elOrSelector === 'string' ? $(elOrSelector) : elOrSelector;
  if (!el) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop;
  const stickToBottom = opts.forceScroll || distanceFromBottom <= el.clientHeight + 56;
  el.innerHTML = renderChatTranscript(text);
  if (stickToBottom) el.scrollTop = el.scrollHeight;
  else el.scrollTop = Math.max(0, el.scrollHeight - distanceFromBottom);
}

function scheduleMarkdownOutput(elOrSelector, text, opts = {}) {
  const el = typeof elOrSelector === 'string' ? $(elOrSelector) : elOrSelector;
  if (!el) return;
  const job = markdownRenderJobs.get(el) || { raf: 0, text: '', opts: {} };
  job.text = text;
  job.opts = opts;
  if (!job.raf) {
    job.raf = requestAnimationFrame(() => {
      job.raf = 0;
      setMarkdownOutput(el, job.text, job.opts);
    });
  }
  markdownRenderJobs.set(el, job);
}

function projectCurrentPhase(project) {
  return (project.phases || []).find(ph => ph.isCurrent) || null;
}

function projectBranchKey(project) {
  const git = project && project.git && project.git.isRepo ? project.git : null;
  return git ? (git.branch || 'detached') : 'no-git';
}

function projectScopeKey(project) {
  return `${project && project.path ? project.path : ''}|branch:${projectBranchKey(project)}`;
}

function projectScopeKeyForBranch(project, branch) {
  return `${project && project.path ? project.path : ''}|branch:${branch || 'no-git'}`;
}

function workstreamGroupKey(project) {
  return `${projectScopeKey(project)}|__workstreams`;
}

function taskKeyForBranch(project, lane, branch) {
  return `${projectScopeKeyForBranch(project, branch)}::${taskLaneId(lane)}`;
}

const SESSION_MARKS_KEY = 'lodestar.sessionMarks.v1';
const PROJECT_OFFSETS_KEY = 'lodestar.projectOffsets.v1';
const SESSION_FRAME_OFFSETS_KEY = 'lodestar.sessionFrameOffsets.v1';
const TASK_PROMPT_HISTORY_KEY = 'lodestar.taskPromptHistory.v1';
const TASK_SESSIONS_KEY = 'lodestar.taskSessions.v1';
const PLANNING_TABS_KEY = 'lodestar.planningTabs.v1';
const AGENT_HISTORY_HIDDEN_KEY = 'lodestar.agentHistoryHidden.v1';
const TOKEN_REMAINING_CACHE_KEY = 'lodestar.tokenRemaining.v1';
const PROJECT_BRANCH_VIEW_KEY = 'lodestar.projectBranchView.v1';
const PROJECT_BRANCH_VISIBLE_KEY = 'lodestar.projectBranchVisible.v1';
const PROJECT_BRANCH_EXPANDED_KEY = 'lodestar.projectBranchExpanded.v1';
const ATTENTION_ACK_KEY = 'lodestar.attentionAck.v1';
let projectOffsetsCache = null;
let sessionFrameOffsetsCache = null;
let planningTabsCache = null;
let agentHistoryHiddenCache = null;
let projectBranchViewCache = null;
let projectBranchVisibleCache = null;
let projectBranchExpandedCache = null;

function readSessionMarks() {
  try { return JSON.parse(localStorage.getItem(SESSION_MARKS_KEY) || '{}'); } catch { return {}; }
}

function writeSessionMarks(marks) {
  localStorage.setItem(SESSION_MARKS_KEY, JSON.stringify(marks));
}

function readPlanningTabs() {
  if (planningTabsCache) return planningTabsCache;
  try { planningTabsCache = JSON.parse(localStorage.getItem(PLANNING_TABS_KEY) || '{}'); }
  catch { planningTabsCache = {}; }
  return planningTabsCache;
}

function planningTab(project) {
  return readPlanningTabs()[project.path] || 'current';
}

function setPlanningTab(project, tab) {
  const tabs = readPlanningTabs();
  tabs[project.path] = tab;
  planningTabsCache = tabs;
  localStorage.setItem(PLANNING_TABS_KEY, JSON.stringify(tabs));
  layout();
}

function readProjectBranchViews() {
  if (projectBranchViewCache) return projectBranchViewCache;
  try { projectBranchViewCache = JSON.parse(localStorage.getItem(PROJECT_BRANCH_VIEW_KEY) || '{}'); }
  catch { projectBranchViewCache = {}; }
  return projectBranchViewCache;
}

function selectedProjectBranch(project) {
  const views = readProjectBranchViews();
  return (project && views[project.path]) || projectBranchKey(project);
}

function readProjectBranchVisible() {
  if (projectBranchVisibleCache) return projectBranchVisibleCache;
  try { projectBranchVisibleCache = JSON.parse(localStorage.getItem(PROJECT_BRANCH_VISIBLE_KEY) || '{}'); }
  catch { projectBranchVisibleCache = {}; }
  return projectBranchVisibleCache;
}

function visibleProjectBranches(project) {
  if (!project) return [];
  const all = readProjectBranchVisible();
  const list = Array.isArray(all[project.path]) ? all[project.path] : [];
  return list.filter(Boolean);
}

function addVisibleProjectBranch(project, branch) {
  if (!project || !branch) return;
  const all = readProjectBranchVisible();
  const list = Array.isArray(all[project.path]) ? all[project.path] : [];
  if (!list.includes(branch)) list.push(branch);
  all[project.path] = list.slice(-12);
  projectBranchVisibleCache = all;
  localStorage.setItem(PROJECT_BRANCH_VISIBLE_KEY, JSON.stringify(all));
}

function setSelectedProjectBranch(project, branch) {
  if (!project || !branch) return;
  addVisibleProjectBranch(project, branch);
  const views = readProjectBranchViews();
  views[project.path] = branch;
  projectBranchViewCache = views;
  localStorage.setItem(PROJECT_BRANCH_VIEW_KEY, JSON.stringify(views));
  focusBranchKey = branchAreaKey(project, branch);
  focusNext = true;
  layout();
}

function readProjectBranchExpanded() {
  if (projectBranchExpandedCache) return projectBranchExpandedCache;
  try { projectBranchExpandedCache = JSON.parse(localStorage.getItem(PROJECT_BRANCH_EXPANDED_KEY) || '{}'); }
  catch { projectBranchExpandedCache = {}; }
  return projectBranchExpandedCache;
}

function branchExpandedKey(project, branch) {
  return `${project && project.path || ''}|${branch || 'no-git'}`;
}

function isProjectBranchExpanded(project, branch) {
  const all = readProjectBranchExpanded();
  const key = branchExpandedKey(project, branch);
  if (all[key] == null) return selectedProjectBranch(project) === branch;
  return !!all[key];
}

function toggleProjectBranchExpanded(project, branch) {
  const all = readProjectBranchExpanded();
  const key = branchExpandedKey(project, branch);
  all[key] = !isProjectBranchExpanded(project, branch);
  projectBranchExpandedCache = all;
  localStorage.setItem(PROJECT_BRANCH_EXPANDED_KEY, JSON.stringify(all));
  layout();
}

function readAgentHistoryHidden() {
  if (agentHistoryHiddenCache) return agentHistoryHiddenCache;
  try { agentHistoryHiddenCache = JSON.parse(localStorage.getItem(AGENT_HISTORY_HIDDEN_KEY) || '{}'); }
  catch { agentHistoryHiddenCache = {}; }
  return agentHistoryHiddenCache;
}

function agentHistoryKey(project, agent) {
  const sid = project && project.activity && project.activity.sessionId ? project.activity.sessionId : 'no-session';
  return `${project.path}|${sid}|${agent && agent.id ? agent.id : 'no-agent'}`;
}

function isAgentHistoryHidden(project, agent) {
  return !!readAgentHistoryHidden()[agentHistoryKey(project, agent)];
}

function hideAgentHistory(project, agent) {
  const hidden = readAgentHistoryHidden();
  hidden[agentHistoryKey(project, agent)] = { ts: Date.now(), sub: agent.sub || '', desc: agent.desc || '' };
  agentHistoryHiddenCache = hidden;
  localStorage.setItem(AGENT_HISTORY_HIDDEN_KEY, JSON.stringify(hidden));
  layout();
}

function sessionKey(project, sessionId) {
  return `${project.path}|${sessionId || 'no-session'}`;
}

function sessionMark(project, sessionId) {
  return readSessionMarks()[sessionKey(project, sessionId)] || null;
}

function setSessionMark(project, sessionId, state) {
  const marks = readSessionMarks();
  marks[sessionKey(project, sessionId)] = { state, ts: Date.now() };
  writeSessionMarks(marks);
  renderAttention();
  layout();
}

function isSessionHidden(project, sessionId) {
  const m = sessionMark(project, sessionId);
  return m && (m.state === 'ignored' || m.state === 'done');
}

function readAttentionAcks() {
  try { return JSON.parse(localStorage.getItem(ATTENTION_ACK_KEY) || '{}'); } catch { return {}; }
}

function writeAttentionAcks(acks) {
  localStorage.setItem(ATTENTION_ACK_KEY, JSON.stringify(acks || {}));
}

function attentionSignature(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 260);
}

function attentionKeyFor(project, kind, sessionId) {
  return `${project && project.path || ''}|${sessionId || 'no-session'}|${kind || 'attention'}`;
}

function attentionAcked(item) {
  if (!item || !item.key) return false;
  const ack = readAttentionAcks()[item.key];
  return !!(ack && ack.sig === item.sig);
}

function ackAttentionItem(item) {
  if (!item || !item.key) return;
  const acks = readAttentionAcks();
  acks[item.key] = { sig: item.sig || '', ts: Date.now(), label: item.label || '' };
  writeAttentionAcks(acks);
}

function ackProjectAttention(project) {
  for (const item of attentionItems({ includeAcked: true }).filter(it => it.project && project && it.project.path === project.path)) {
    ackAttentionItem(item);
  }
  updateAttentionBadges(projects);
  renderAttention();
  if (interacting) pendingRefresh = true;
  else layout();
}

function backgroundSessionKey(task) {
  return task && (task.sessionId || (task.id ? `bg:${task.id}` : ''));
}

function isBackgroundTaskHidden(project, task) {
  const key = backgroundSessionKey(task);
  return !!(key && isSessionHidden(project, key));
}

function readProjectOffsets() {
  if (projectOffsetsCache) return projectOffsetsCache;
  try { projectOffsetsCache = JSON.parse(localStorage.getItem(PROJECT_OFFSETS_KEY) || '{}'); }
  catch { projectOffsetsCache = {}; }
  return projectOffsetsCache;
}

function writeProjectOffsets(offsets) {
  projectOffsetsCache = offsets;
  localStorage.setItem(PROJECT_OFFSETS_KEY, JSON.stringify(offsets));
}

function projectOffset(project) {
  const o = readProjectOffsets()[project.path] || {};
  return { x: Number(o.x) || 0, y: Number(o.y) || 0 };
}

function setProjectOffset(project, x, y, persist = true) {
  const offsets = readProjectOffsets();
  offsets[project.path] = { x: Math.round(x), y: Math.round(y) };
  projectOffsetsCache = offsets;
  if (persist) writeProjectOffsets(offsets);
}

function readSessionFrameOffsets() {
  if (sessionFrameOffsetsCache) return sessionFrameOffsetsCache;
  try { sessionFrameOffsetsCache = JSON.parse(localStorage.getItem(SESSION_FRAME_OFFSETS_KEY) || '{}'); }
  catch { sessionFrameOffsetsCache = {}; }
  return sessionFrameOffsetsCache;
}

function writeSessionFrameOffsets(offsets) {
  sessionFrameOffsetsCache = offsets;
  localStorage.setItem(SESSION_FRAME_OFFSETS_KEY, JSON.stringify(offsets));
}

function sessionFrameKey(project, lane) {
  const kind = lane && lane.kind ? lane.kind : 'main';
  const name = lane && lane.name ? lane.name : 'main';
  return `${projectScopeKey(project)}|${kind}|${name}`;
}

function sessionFrameOffset(project, lane) {
  const o = readSessionFrameOffsets()[sessionFrameKey(project, lane)] || {};
  return { x: Number(o.x) || 0, y: Number(o.y) || 0 };
}

function setSessionFrameOffset(project, lane, x, y, persist = true) {
  const offsets = readSessionFrameOffsets();
  offsets[sessionFrameKey(project, lane)] = { x: Math.round(x), y: Math.round(y) };
  sessionFrameOffsetsCache = offsets;
  if (persist) writeSessionFrameOffsets(offsets);
}

// git 배지 (브랜치 · 변경 · ahead/behind · 최근 커밋 해시만)
function gitBadge(git) {
  if (!git || !git.isRepo) return '';
  let h = `<span class="git-badge" title="${esc(git.upstream || 'no upstream')}">`;
  h += `<span class="git-branch">⎇ ${esc(git.branch || '?')}</span>`;
  if (git.dirty > 0) h += `<span class="git-dirty">●${git.dirty}</span>`;
  else h += `<span class="git-clean">clean</span>`;
  if (git.ahead != null && (git.ahead || git.behind)) {
    h += `<span class="git-ab">↑${git.ahead} ↓${git.behind}</span>`;
  }
  h += `</span>`;
  if (git.lastCommit) {
    h += `<span class="git-commit muted" title="${esc(git.lastCommit.subject || '')}">`
      + `${esc(git.lastCommit.hash)} · ${esc(git.lastCommit.rel)}</span>`;
  }
  return h;
}

// ---------- 사이드바 ----------
function renderSidebar() {
  const list = $('#projList');
  list.innerHTML = '';
  if (!projects.length) {
    list.innerHTML = '<div class="muted-xs" style="padding:12px">프로젝트 없음</div>';
    return;
  }
  for (const p of projects) {
    const el = document.createElement('div');
    el.className = 'proj-item' + (activeProject === p.path ? ' active' : '');
    let color = 'var(--s-pending)', badge = '';
    if (!p.isGsd) { color = 'var(--destructive)'; badge = 'GSD 아님'; }
    else if (!p.initialized) { color = 'var(--s-execute)'; badge = '미초기화'; }
    else {
      const cur = (p.phases || []).find(ph => ph.isCurrent);
      if (cur) { color = STAGE_COLOR[cur.stage] || color; }
      badge = p.state && p.state.milestone ? esc(p.state.milestone) : '';
    }
    el.innerHTML = `<span class="proj-dot" style="background:${color}"></span>
      <span class="proj-name">${esc(p.name)}</span>
      <span class="proj-badge">${badge}</span>
      <button class="proj-remove" title="제거" data-remove="${esc(p.path)}">✕</button>`;
    el.addEventListener('click', (e) => {
      if (e.target.dataset.remove) return;
      activeProject = (activeProject === p.path) ? null : p.path;
      renderSidebar(); layout();
    });
    const rm = el.querySelector('[data-remove]');
    rm.addEventListener('click', async (e) => {
      e.stopPropagation();
      projects = await window.lodestar.removeProject(rm.dataset.remove);
      await refresh();
    });
    list.appendChild(el);
  }
}

function attentionItems(opts = {}) {
  const includeAcked = opts.includeAcked !== false;
  const items = [];
  const seen = new Set();
  const addItem = (item) => {
    if (!item || !item.key || seen.has(item.key)) return;
    seen.add(item.key);
    item.acked = attentionAcked(item);
    if (includeAcked || !item.acked) items.push(item);
  };
  for (const p of projects) {
    const act = p.activity || {};
    const cur = projectCurrentPhase(p);
    if (isSessionHidden(p, act.sessionId)) continue;
    if (act.awaiting) {
      const detail = act.awaitingText || 'Claude가 사용자 답변을 기다리고 있습니다.';
      const item = {
        key: attentionKeyFor(p, 'awaiting', act.sessionId),
        sig: attentionSignature(detail),
        kind: 'awaiting',
        project: p,
        label: '답변 필요',
        detail,
        phase: cur,
      };
      addItem(item);
    } else if (act.blocked) {
      const info = pauseInfo(p);
      const detail = info.detail || 'Claude가 제한 또는 오류로 중단되었습니다.';
      const item = {
        key: attentionKeyFor(p, 'blocked', act.sessionId),
        sig: attentionSignature(detail),
        kind: 'blocked',
        project: p,
        label: info.label,
        detail,
        phase: cur,
      };
      addItem(item);
    }
  }
  for (const ctx of taskSessions.values()) {
    if (!ctx || !ctx.project || (!ctx.awaiting && !ctx.blocked)) continue;
    const blocked = !!ctx.blocked;
    const detail = ctx.statusText || ctx.excerpt || (blocked ? 'Claude가 제한 또는 오류로 중단되었습니다.' : 'Claude가 사용자 답변을 기다리고 있습니다.');
    const label = blocked ? (looksLikeUsageLimitText(detail) ? '한도 초과' : '멈춤') : '답변 필요';
    addItem({
      key: attentionKeyFor(ctx.project, blocked ? 'blocked' : 'awaiting', ctx.sessionId || ctx.backgroundTaskId || ctx.key || 'local'),
      sig: attentionSignature(detail),
      kind: blocked ? 'blocked' : 'awaiting',
      project: ctx.project,
      label,
      detail,
      phase: laneCurrentPhase(ctx.lane, ctx.project),
    });
  }
  return items;
}

function projectAttentionSummary(project) {
  const item = attentionItems({ includeAcked: true }).find(it => it.project && project && it.project.path === project.path);
  if (!item) return null;
  return {
    label: item.label,
    detail: item.detail || item.label,
    kind: item.kind,
    acked: !!item.acked,
  };
}

function renderAttention() {
  const section = $('#attentionSection');
  const list = $('#attentionList');
  if (!section || !list) return;
  const items = attentionItems();
  section.classList.toggle('hidden', items.length === 0);
  list.innerHTML = '';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = `attention-item ${item.kind}${item.acked ? ' acked' : ''}`;
    const phase = item.phase ? `Phase ${item.phase.num}` : '세션';
    el.innerHTML = `
      <button class="attention-open" title="세션 열기">
        <span class="attention-dot"></span>
        <span class="attention-main">
          <span class="attention-row"><b>${esc(item.project.name)}</b><em>${esc(item.acked ? item.label + ' 확인됨' : item.label)}</em></span>
          <span class="attention-sub">${esc(phase)} · ${esc(truncate(item.detail, 54))}</span>
        </span>
      </button>
      <span class="attention-actions">
        <button class="attention-mark" data-mark="done" title="완료 처리">✓</button>
        <button class="attention-mark" data-mark="ignored" title="무시">×</button>
      </span>`;
    el.title = item.detail || item.label;
    el.querySelector('.attention-open').addEventListener('click', () => {
      ackAttentionItem(item);
      activeProject = item.project.path;
      renderSidebar();
      layout();
      updateAttentionBadges(projects);
      if (item.kind === 'awaiting') openAwaitingTask(item.project);
      else if (item.kind === 'blocked') openBlockedTask(item.project);
      else openActivity(item.project);
    });
    el.querySelectorAll('.attention-mark').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        ackAttentionItem(item);
        setSessionMark(item.project, item.project.activity && item.project.activity.sessionId, btn.dataset.mark);
        updateAttentionBadges(projects);
      });
    });
    list.appendChild(el);
  }
}

// ---------- 캔버스 레이아웃 ----------
function visibleProjects() {
  return activeProject ? projects.filter(p => p.path === activeProject) : projects;
}

function layout(opts = {}) {
  const fast = !!opts.fast;
  const nodesEl = $('#nodes');
  const edgesEl = $('#edges');
  const layersEl = $('#projectLayers');
  nodesEl.innerHTML = '';
  if (!fast) edgesEl.innerHTML = '';
  if (layersEl) layersEl.innerHTML = '';
  const vis = visibleProjects();

  $('#emptyState').style.display = vis.length ? 'none' : 'flex';
  $('#canvasTitle').textContent = activeProject ? (vis[0] ? vis[0].name : '캔버스') : '워크플로우 캔버스';

  const edges = [];
  let laneY = LANE_TOP;
  let totalNodes = 0;
  let focusCurX = null, focusCurY = null;  // 자동 포커스용 현재 phase 위치

  for (const p of vis) {
    const offset = projectOffset(p);
    const xBase = LANE_LEFT + offset.x;
    const projectTop = laneY + offset.y - 102;
    const projectBounds = { left: xBase - 22, top: projectTop + 28, right: Infinity, bottom: Infinity };
    let projectBottom = projectTop + 178;
    let projectRight = xBase + PROJECT_MIN_W;
    const projectStartLaneY = laneY;

    // 비-GSD / 미초기화 → 레인 라벨 + 정보 노드 1개
    if (!p.isGsd || !p.initialized) {
      const y = laneY + offset.y;
      addLaneLabel(nodesEl, p, null, y, xBase);
      nodesEl.appendChild(infoNode(p, xBase, y));
      totalNodes += 1;
      laneY += LANE_GAP_Y;
      addProjectLayer(layersEl || nodesEl, p, xBase, projectTop, 980, Math.max(190, laneY - projectStartLaneY + 66), offset);
      continue;
    }

    // 활성 에이전트만 현재 캔버스에 표시한다. 완료된 외부 세션은 히스토리로만 보관한다.
    const activeAgent = (p.activity && !p.activity.awaiting && !p.activity.blocked)
      ? (p.activity.current || null)
      : null;

    // 각 레인(메인 + 워크스트림)을 행으로 렌더.
    // 워크스트림은 기본 접힘: 큰 프로젝트를 넣었을 때 화면이 레인으로 폭증하지 않게 한다.
    const lanes = (p.lanes && p.lanes.length) ? p.lanes : [{ kind: 'main', name: 'main', state: p.state, phases: p.phases }];
    const mainLanes = lanes.filter(l => !l.kind || l.kind === 'main');
    const workstreamLanes = lanes.filter(l => l.kind === 'workstream');
    const viewBranch = selectedProjectBranch(p);
    const currentBranchView = viewBranch === projectBranchKey(p);
    const visibleMainLanes = currentBranchView
      ? mainLanes
      : mainLanes.filter(l => laneHasBranchSession(p, l, viewBranch));
    const visibleWorkstreamLanes = currentBranchView
      ? workstreamLanes
      : workstreamLanes.filter(l => laneHasBranchSession(p, l, viewBranch));
    const projectContentWidth = estimateProjectContentWidth(
      visibleMainLanes.length ? visibleMainLanes : mainLanes,
      visibleWorkstreamLanes.length ? visibleWorkstreamLanes : workstreamLanes,
    );
    projectRight = Math.max(projectRight, xBase + projectContentWidth);

    const branchBoard = addProjectBranchBoard(nodesEl, p, xBase, laneY + offset.y - 64, projectContentWidth);
    totalNodes += branchBoard.nodes;
    projectRight = Math.max(projectRight, branchBoard.right);
    projectBottom = Math.max(projectBottom, branchBoard.bottom);
    if (branchBoard.focusX != null) { focusCurX = branchBoard.focusX; focusCurY = branchBoard.focusY; focusNext = true; }
    const flowXBase = branchBoard.nodes ? branchBoard.right + 42 : xBase;
    const flowBounds = { ...projectBounds, left: flowXBase - 22 };

    const sessionBoard = addProjectSessionBoard(nodesEl, p, lanes, flowXBase, laneY + offset.y - 64);
    totalNodes += sessionBoard.nodes;
    projectRight = Math.max(projectRight, sessionBoard.right);
    projectBottom = Math.max(projectBottom, sessionBoard.bottom);
    laneY += sessionBoard.height ? sessionBoard.height + 28 : 0;
    if (planningTab(p) === 'history') {
      addProjectLayer(layersEl || nodesEl, p, xBase, projectTop, Math.max(PROJECT_MIN_W, projectRight - xBase + 70), Math.max(190, projectBottom - projectTop + 34), offset);
      laneY = Math.max(laneY, projectBottom - offset.y + 72);
      continue;
    }

    const renderMainLanes = visibleMainLanes.length ? visibleMainLanes : (!visibleWorkstreamLanes.length && currentBranchView && lanes[0] ? [lanes[0]] : []);
    for (const lane of renderMainLanes) {
      const r = renderLane(nodesEl, edges, p, lane, laneY + offset.y, activeAgent, flowXBase, { projectBounds: flowBounds, branch: viewBranch });
      totalNodes += r.nodes;
      if (r.focusX != null) { focusCurX = r.focusX; focusCurY = r.focusY; }
      laneY += LANE_GAP_Y + r.extra;
      projectBottom = Math.max(projectBottom, laneY + offset.y);
      if (r.bottom != null) projectBottom = Math.max(projectBottom, r.bottom);
      projectRight = Math.max(projectRight, r.right || projectRight);
    }

    if (currentBranchView && projectExternalActivityVisible(p, renderMainLanes)) {
      const y = laneY + offset.y;
      nodesEl.appendChild(externalActivityNode(p, flowXBase, y));
      totalNodes++;
      projectRight = Math.max(projectRight, flowXBase + 390);
      projectBottom = Math.max(projectBottom, y + 118);
      laneY += 142;
    }

    if (visibleWorkstreamLanes.length && !branchBoard.nodes) {
      const groupKey = workstreamGroupKey(p);
      const expanded = expandedLanes.has(groupKey) || visibleWorkstreamLanes.some(l => workstreamHasActiveSession(p, l, viewBranch));
      const groupLane = { kind: 'workstream-group', name: `${visibleWorkstreamLanes.length}개`, phases: [] };
      const groupInfo = workstreamGroupSessionInfo(p, visibleWorkstreamLanes, expanded);
      const groupBaseY = laneY + offset.y;
      const groupOffset = clampSessionFrameOffset({
        baseLeft: flowXBase - 16,
        baseTop: groupBaseY - 80,
        width: WORKSTREAM_GROUP_FRAME_W,
        height: 172,
        bounds: flowBounds,
      }, sessionFrameOffset(p, groupLane).x, sessionFrameOffset(p, groupLane).y);
      const groupX = flowXBase + groupOffset.x;
      const groupY = groupBaseY + groupOffset.y + 24;
      const groupTop = groupBaseY - 80 + groupOffset.y;
      addLaneLabel(nodesEl, p, groupLane, groupY, groupX, { sessionFramed: !!groupInfo });
      nodesEl.appendChild(workstreamGroupNode(p, visibleWorkstreamLanes, groupX, groupY, expanded));
      totalNodes++;
      let groupLeft = groupX;
      let groupTopBound = groupTop;
      let groupRight = groupX + WORKSTREAM_GROUP_FRAME_W;
      let groupBottom = groupY + 132;
      projectRight = Math.max(projectRight, groupRight);
      laneY += expanded ? 176 : LANE_GAP_Y + (groupInfo ? 56 : 0);
      projectBottom = Math.max(projectBottom, laneY + offset.y);

      if (expanded) {
        for (const lane of visibleWorkstreamLanes) {
          const childXBase = flowXBase + 36 + groupOffset.x;
          const childY = laneY + offset.y + groupOffset.y;
          const workstreamChildBounds = {
            ...flowBounds,
            left: childXBase - 16,
            top: groupBaseY + 76 + groupOffset.y,
          };
          const r = renderLane(nodesEl, edges, p, lane, childY, null, childXBase, { projectBounds: workstreamChildBounds, branch: viewBranch });
          totalNodes += r.nodes;
          if (r.focusX != null && focusCurX == null) { focusCurX = r.focusX; focusCurY = r.focusY; }
          laneY += LANE_GAP_Y + r.extra;
          projectBottom = Math.max(projectBottom, laneY + offset.y);
          if (r.top != null) groupTopBound = Math.min(groupTopBound, r.top);
          if (r.bottom != null) projectBottom = Math.max(projectBottom, r.bottom);
          if (r.left != null) groupLeft = Math.min(groupLeft, r.left);
          projectRight = Math.max(projectRight, r.right || projectRight);
          groupRight = Math.max(groupRight, r.right || groupRight);
          if (r.bottom != null) groupBottom = Math.max(groupBottom, r.bottom);
        }
      }
      if (groupInfo) {
        const groupFrameLeft = groupLeft - 16;
        const groupWidth = Math.max(WORKSTREAM_GROUP_FRAME_W, groupRight - groupFrameLeft + 28);
        const groupFrameTop = groupTopBound;
        const groupHeight = Math.max(172, groupBottom - groupFrameTop + 44);
        const groupRect = {
          baseLeft: groupFrameLeft - groupOffset.x,
          baseTop: groupFrameTop - groupOffset.y,
          width: Math.round(groupWidth),
          height: Math.round(groupHeight),
          bounds: flowBounds,
          left: groupFrameLeft,
          top: groupFrameTop,
        };
        nodesEl.appendChild(laneSessionFrame(p, groupLane, groupRect, groupInfo));
        totalNodes++;
        projectRight = Math.max(projectRight, groupRect.left + groupRect.width);
        projectBottom = Math.max(projectBottom, groupRect.top + groupRect.height + 42);
      }
    }
    addProjectLayer(layersEl || nodesEl, p, xBase, projectTop, Math.max(PROJECT_MIN_W, projectRight - xBase + 70), Math.max(190, projectBottom - projectTop + 34), offset);
    laneY = Math.max(laneY, projectBottom - offset.y + 72);
  }
  $('#canvasMeta').textContent = vis.length ? `${vis.length} projects · ${totalNodes} nodes` : '';
  updateTopTokenSummary(vis);

  // 드래그 중에는 엣지를 숨긴 상태라 재생성하지 않는다. 드롭 시 전체 레이아웃에서 갱신된다.
  if (!fast) for (const e of edges) edgesEl.appendChild(bezier(e));

  // 현재 진행 phase를 화면 중앙으로 자동 포커스 (초기 로드·새로고침 시 1회)
  if (!fast && focusNext && focusCurX != null) {
    const vp = $('#viewport');
    const w = vp.clientWidth || 900, h = vp.clientHeight || 600;
    view.x = Math.round(w / 2 - (focusCurX + NODE_W / 2) * view.scale);
    view.y = Math.round(h / 2 - (focusCurY + NODE_BASE_H / 2) * view.scale);
  }
  focusNext = false;
  applyTransform();
}

function flushDragLayout() {
  layout();
}

function dragVisualApplier(items) {
  let raf = null;
  let lastDx = 0;
  let lastDy = 0;
  const apply = () => {
    raf = null;
    applySessionDragVisual(items, lastDx, lastDy);
  };
  return {
    move(dx, dy) {
      lastDx = dx;
      lastDy = dy;
      if (raf == null) raf = requestAnimationFrame(apply);
    },
    flush() {
      if (raf != null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      applySessionDragVisual(items, lastDx, lastDy);
    },
  };
}

function projectDragVisualElements(rect, layerEl) {
  const nodesEl = $('#nodes');
  const layersEl = $('#projectLayers');
  const items = [];
  const pad = 16;
  const left = rect.left - pad;
  const top = rect.top - pad;
  const right = rect.left + rect.width + pad;
  const bottom = rect.top + rect.height + pad;
  const collect = (parent) => {
    if (!parent) return;
    for (const el of Array.from(parent.children)) {
      if (el === layerEl) {
        items.push({ el, transform: el.style.transform || '' });
        continue;
      }
      const box = elementCanvasBox(el);
      if (!box || box.cx < left || box.cx > right || box.cy < top || box.cy > bottom) continue;
      items.push({ el, transform: el.style.transform || '' });
    }
  };
  collect(layersEl);
  collect(nodesEl);
  if (!items.some(item => item.el === layerEl)) items.push({ el: layerEl, transform: layerEl.style.transform || '' });
  for (const item of items) item.el.classList.add('session-drag-visual', 'project-drag-visual');
  return items;
}

function clearProjectDragVisual(items) {
  for (const item of items) item.el.classList.remove('project-drag-visual');
  clearSessionDragVisual(items);
}

function addProjectLayer(nodesEl, project, x, y, width, height, offset) {
  const layer = document.createElement('div');
  layer.className = 'project-layer';
  const layerLeft = x - 22;
  layer.style.left = layerLeft + 'px';
  layer.style.top = y + 'px';
  layer.style.width = width + 'px';
  layer.style.height = height + 'px';
  const git = project.git && project.git.isRepo ? project.git : null;
  const state = git
    ? `${git.branch || 'no branch'} · ${git.dirty ? `변경 ${git.dirty}` : 'clean'}${git.ahead || git.behind ? ` · ↑${git.ahead || 0} ↓${git.behind || 0}` : ''}`
    : project.path;
  const tab = planningTab(project);
  const historyCount = projectHistoryItems(project).length;
  const attention = projectAttentionSummary(project);
  const attentionHtml = attention
    ? `<button class="project-attention-pill ${attention.kind}${attention.acked ? ' acked' : ''}" type="button" title="${esc(attention.detail)}">
        <span class="project-attention-count">${attention.acked ? '확인됨' : '1'}</span>
        <span class="project-attention-label">${esc(attention.label)}</span>
        <span class="project-attention-detail">${esc(truncate(attention.detail, 70))}</span>
      </button>`
    : '';
  layer.innerHTML = `
    <div class="project-layer-head" title="드래그해서 프로젝트 영역 이동">
      <span class="project-layer-title">${esc(project.name)}</span>
      <span class="project-layer-sub">${esc(state)}</span>
      ${attentionHtml}
      <button class="project-session-add-btn" type="button" title="현재 브랜치에서 새 Claude 세션 열기">+ 세션</button>
      ${git ? '<button class="project-git-btn" type="button" title="Git 브랜치 작업 공간">Git</button>' : ''}
      <span class="project-layer-tabs" title="프로젝트 세션 표시 전환">
        <button class="project-layer-tab ${tab === 'current' ? 'active' : ''}" data-plan-tab="current">현재</button>
        <button class="project-layer-tab ${tab === 'history' ? 'active' : ''}" data-plan-tab="history">히스토리${historyCount ? ` ${historyCount}` : ''}</button>
      </span>
      <span class="project-layer-handle" title="프로젝트 이동"></span>
    </div>`;
  layer.querySelectorAll('.project-layer-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPlanningTab(project, btn.dataset.planTab || 'current');
    });
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
  });
  const addSessionBtn = layer.querySelector('.project-session-add-btn');
  if (addSessionBtn) {
    addSessionBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openProjectSession(project);
    });
    addSessionBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  }
  const gitBtn = layer.querySelector('.project-git-btn');
  if (gitBtn) {
    gitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openGitSwitch(project);
    });
    gitBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  }
  const attentionBtn = layer.querySelector('.project-attention-pill');
  if (attentionBtn) {
    attentionBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ackProjectAttention(project);
      const item = attentionItems({ includeAcked: true }).find(it => it.project && it.project.path === project.path);
      if (item && item.kind === 'awaiting') openAwaitingTask(project);
      else if (item && item.kind === 'blocked') openBlockedTask(project);
      else openActivity(project);
    });
    attentionBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  }
  layer.querySelector('.project-layer-head').addEventListener('mousedown', (e) => {
    if (e.target.closest('.project-layer-tab') || e.target.closest('.project-git-btn') || e.target.closest('.project-session-add-btn') || e.target.closest('.project-attention-pill')) return;
    e.preventDefault();
    e.stopPropagation();
    beginInteract();
    const sx = e.clientX, sy = e.clientY;
    const start = { ...offset };
    const visualItems = projectDragVisualElements({ left: layerLeft, top: y, width, height }, layer);
    const visual = dragVisualApplier(visualItems);
    let nextX = start.x, nextY = start.y;
    const move = (ev) => {
      nextX = start.x + (ev.clientX - sx) / view.scale;
      nextY = start.y + (ev.clientY - sy) / view.scale;
      visual.move(nextX - start.x, nextY - start.y);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      visual.flush();
      setProjectOffset(project, nextX, nextY, true);
      clearProjectDragVisual(visualItems);
      flushDragLayout();
      endInteractSoon();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  nodesEl.appendChild(layer);
}

async function openGitSwitch(project) {
  if (!project || !project.git || !project.git.isRepo || !window.lodestar.listGitRefs) return;
  gitCtx = { project, current: (project.git && project.git.branch) || '', refs: [] };
  $('#gitDrawer').classList.remove('hidden');
  $('#gitTitle').textContent = `Git 브랜치 작업 공간 · ${project.name}`;
  $('#gitSub').textContent = `체크아웃: ${gitCtx.current || 'unknown'} · ${project.path}`;
  $('#gitFilter').value = '';
  $('#gitStatus').classList.remove('hidden');
  $('#gitStatus').textContent = '브랜치 목록을 불러오는 중…';
  $('#gitBranchList').innerHTML = '';
  let info;
  try {
    info = await window.lodestar.listGitRefs(project.path);
  } catch (e) {
    showGitStatus(`Git 정보를 읽지 못했습니다. ${String(e && e.message || e)}`, true);
    return;
  }
  if (!info || !info.ok) {
    showGitStatus(`Git 정보를 읽지 못했습니다. ${(info && info.error) || 'unknown error'}`, true);
    return;
  }
  gitCtx.current = info.current || gitCtx.current || '';
  gitCtx.refs = (info.branches || []).filter(Boolean);
  $('#gitSub').textContent = `체크아웃: ${gitCtx.current || 'unknown'} · ${project.path}`;
  showGitStatus(gitCtx.refs.length ? '' : '표시할 브랜치가 없습니다. 직접 입력해서 브랜치 보기만 전환할 수 있습니다.', !gitCtx.refs.length);
  renderGitBranches();
  $('#gitFilter').focus();
}

function closeGitSwitch() {
  gitCtx = null;
  $('#gitDrawer').classList.add('hidden');
}

function showGitStatus(text, visible = false) {
  const el = $('#gitStatus');
  el.textContent = text || '';
  el.classList.toggle('hidden', !visible && !text);
  el.classList.toggle('error', !!visible && /실패|못했습니다|없습니다|유효하지/i.test(text || ''));
}

function renderGitBranches() {
  const list = $('#gitBranchList');
  if (!gitCtx) { list.innerHTML = ''; return; }
  const q = ($('#gitFilter').value || '').trim().toLowerCase();
  const refs = gitCtx.refs
    .filter(ref => !q || ref.toLowerCase().includes(q))
    .slice(0, 80);
  if (!refs.length) {
    list.innerHTML = '<div class="git-empty">일치하는 브랜치가 없습니다. 입력값으로 브랜치 작업 공간을 볼 수 있습니다.</div>';
    return;
  }
  list.innerHTML = refs.map(ref => `
    <button class="git-branch-item ${ref === gitCtx.current ? 'current' : ''}" data-ref="${esc(ref)}">
      <span class="git-branch-name">${esc(ref)}</span>
      ${ref === gitCtx.current ? '<span class="git-current">체크아웃</span>' : '<span class="git-current">보기</span>'}
    </button>`).join('');
  list.querySelectorAll('.git-branch-item').forEach(btn => {
    btn.addEventListener('click', () => switchGitTo(btn.dataset.ref || ''));
  });
}

async function switchGitTo(ref) {
  if (!gitCtx) return;
  const target = String(ref || '').trim();
  if (!target) return;
  if (!/^[A-Za-z0-9._/-]+$/.test(target) || target.includes('..') || target.startsWith('-') || target.startsWith('/')) {
    showGitStatus('유효하지 않은 브랜치 이름입니다.', true);
    return;
  }
  focusBranchKey = branchAreaKey(gitCtx.project, target);
  setSelectedProjectBranch(gitCtx.project, target);
  closeGitSwitch();
  layout();
}

async function openBranchSessionPicker(project, opts = {}) {
  if (!project) return;
  const lane = opts.lane || projectMainLane(project);
  const discuss = opts.discuss || null;
  if (!project.git || !project.git.isRepo || !window.lodestar.listGitRefs) {
    openTask(project, discuss, lane, { branch: selectedProjectBranch(project), forceNewDraft: true });
    return;
  }
  branchSessionCtx = {
    project,
    lane,
    discuss,
    current: (project.git && project.git.branch) || '',
    refs: [],
  };
  $('#branchSessionDrawer').classList.remove('hidden');
  $('#branchSessionTitle').textContent = `새 세션 브랜치 선택 · ${project.name}`;
  $('#branchSessionSub').textContent = `${laneLabelText(lane)} · ${project.path}`;
  $('#branchSessionFilter').value = '';
  $('#branchSessionNewName').value = '';
  showBranchSessionStatus('브랜치 목록을 불러오는 중…', true);
  $('#branchSessionList').innerHTML = '';
  let info;
  try {
    info = await window.lodestar.listGitRefs(project.path);
  } catch (e) {
    showBranchSessionStatus(`Git 정보를 읽지 못했습니다. ${String(e && e.message || e)}`, true);
    return;
  }
  if (!info || !info.ok) {
    showBranchSessionStatus(`Git 정보를 읽지 못했습니다. ${(info && info.error) || 'unknown error'}`, true);
    return;
  }
  branchSessionCtx.current = info.current || branchSessionCtx.current || '';
  branchSessionCtx.refs = (info.branches || []).filter(Boolean);
  showBranchSessionStatus('', false);
  renderBranchSessionBranches();
  $('#branchSessionFilter').focus();
}

function closeBranchSessionPicker() {
  branchSessionCtx = null;
  $('#branchSessionDrawer').classList.add('hidden');
}

function showBranchSessionStatus(text, visible = false) {
  const el = $('#branchSessionStatus');
  el.textContent = text || '';
  el.classList.toggle('hidden', !visible && !text);
  el.classList.toggle('error', !!visible && /실패|못했습니다|없습니다|유효하지/i.test(text || ''));
}

function renderBranchSessionBranches() {
  const list = $('#branchSessionList');
  if (!branchSessionCtx) { list.innerHTML = ''; return; }
  const q = ($('#branchSessionFilter').value || '').trim().toLowerCase();
  const refs = branchSessionCtx.refs
    .filter(ref => !q || ref.toLowerCase().includes(q))
    .slice(0, 80);
  if (!refs.length) {
    list.innerHTML = '<div class="git-empty">일치하는 브랜치가 없습니다. 새 브랜치 이름을 입력해서 시작하세요.</div>';
    return;
  }
  list.innerHTML = refs.map(ref => `
    <button class="git-branch-item branch-session-item ${ref === branchSessionCtx.current ? 'current' : ''}" data-ref="${esc(ref)}">
      <span class="git-branch-name">${esc(ref)}</span>
      <span class="branch-session-action">${ref === branchSessionCtx.current ? '현재 브랜치에서 시작' : '이 브랜치에서 시작'}</span>
    </button>`).join('');
  list.querySelectorAll('.branch-session-item').forEach(btn => {
    btn.addEventListener('click', () => startBranchSession(btn.dataset.ref || ''));
  });
}

async function startBranchSession(ref) {
  if (!branchSessionCtx) return;
  const target = String(ref || '').trim();
  if (!target) {
    $('#branchSessionNewName').focus();
    return;
  }
  const ctx = branchSessionCtx;
  const project = ctx.project;
  showBranchSessionStatus(`${target} 브랜치 작업 공간을 준비하는 중…`, true);
  $('#branchSessionCreate').disabled = true;
  const exists = (ctx.refs || []).includes(target);
  const res = exists || target === (ctx.current || projectBranchKey(project))
    ? { ok: true }
    : (window.lodestar.createGitBranch
      ? await window.lodestar.createGitBranch(project.path, target)
      : { ok: false, error: '브랜치 생성 API를 찾지 못했습니다.' });
  $('#branchSessionCreate').disabled = false;
  if (!res || !res.ok) {
    showBranchSessionStatus(`브랜치 준비 실패: ${(res && (res.stderr || res.error)) || 'unknown error'}`, true);
    return;
  }
  setSelectedProjectBranch(project, target);
  focusBranchKey = branchAreaKey(project, target);
  focusNext = true;
  closeBranchSessionPicker();
  await refresh();
  const nextProject = projects.find(p => p.path === project.path) || project;
  openTask(nextProject, ctx.discuss, ctx.lane, { branch: target, forceNewDraft: true });
}

function laneLabelText(lane) {
  if (!lane || lane.kind === 'main') return '마일스톤';
  if (lane.kind === 'workstream') return lane.name || '워크스트림';
  return lane.name || lane.kind || '세션';
}

function laneProgressText(lane) {
  const st = lane && lane.state ? lane.state : {};
  const pr = st.progress || {};
  if (pr.totalPhases) {
    const pct = pr.percent != null ? pr.percent : Math.round((pr.completedPhases || 0) / pr.totalPhases * 100);
    return `${pr.completedPhases ?? 0}/${pr.totalPhases} phase · ${pct}%`;
  }
  const phs = lane && Array.isArray(lane.phases) ? lane.phases : [];
  if (phs.length) {
    const done = phs.filter(p => p.stage === 'verify' || p.stage === 'execute-done').length;
    return `${done}/${phs.length} phase`;
  }
  return 'phase 없음';
}

function laneSessionTone(project, lane) {
  const st = taskButtonState(project, lane);
  if (st.awaiting || st.externalBlocked) return 'awaiting';
  if (st.busy) return 'running';
  const pr = lane && lane.state && lane.state.progress ? lane.state.progress : {};
  if (Number(pr.percent) >= 100) return 'done';
  return 'ready';
}

function sessionBox(project, lane, opts = {}) {
  const tone = opts.tone || laneSessionTone(project, lane);
  const ph = laneCurrentPhase(lane, project);
  const title = opts.title || laneLabelText(lane);
  const subtitle = opts.subtitle || (lane && lane.state && lane.state.milestoneName) || (ph ? `Phase ${ph.num} · ${ph.title}` : laneProgressText(lane));
  const desc = opts.desc || (ph ? ph.stageLabel : laneProgressText(lane));
  const kind = opts.kind || ((lane && lane.kind) || 'main');
  const laneName = lane && lane.name ? lane.name : 'main';
  const action = opts.action === false ? '' : taskActionButtonHtml(project, lane, 'session-box-task');
  return `<div class="project-session-box ${esc(tone)}" data-session-kind="${esc(kind)}" data-lane-name="${esc(laneName)}" title="${esc(subtitle)}">
    <div class="psb-top">
      <span class="psb-dot"></span>
      <b>${esc(title)}</b>
      <small>${esc(laneProgressText(lane))}</small>
    </div>
    <div class="psb-title">${esc(truncate(subtitle, 58))}</div>
    <div class="psb-desc">${esc(truncate(desc, 68))}</div>
    <div class="psb-actions">${action}</div>
  </div>`;
}

function projectHistoryItems(project) {
  const bySession = new Map();
  const merged = [];
  for (const item of [...externalSessionHistoryItems(project), ...backgroundHistoryItems(project)]) {
    if (!item || !item.sessionId) {
      merged.push(item);
      continue;
    }
    const prev = bySession.get(item.sessionId);
    if (!prev) {
      bySession.set(item.sessionId, item);
      merged.push(item);
      continue;
    }
    Object.assign(prev, {
      ...prev,
      ...item,
      kind: item.kind === 'quick' || item.kind === 'debug' || item.kind === 'sketch' ? item.kind : prev.kind,
      title: prev.title || item.title,
      status: prev.status || item.status,
      session: prev.session || item.session,
      task: item.task || prev.task,
      backgroundTaskId: item.backgroundTaskId || prev.backgroundTaskId,
      mtimeMs: Math.max(prev.mtimeMs || 0, item.mtimeMs || 0),
    });
  }
  return merged
    .filter(it => it && !it.active && it.bucket !== 'current')
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .slice(0, 12);
}

function externalSessionHistoryItems(project) {
  const sessions = project && project.activity && Array.isArray(project.activity.sessions) ? project.activity.sessions : [];
  return sessions
    .filter(s => s && s.sessionId && !s.running && !s.awaiting && !s.blocked && !isSessionHidden(project, s.sessionId))
    .map(s => ({
      kind: s.workflowKind || 'session',
      title: sessionTitleText(s),
      status: `${relTime(s.ageSec)} 전 · 도구 ${s.toolCount || 0} · shell ${s.shellCount || 0}`,
      active: false,
      bucket: 'history',
      sessionId: s.sessionId,
      session: s,
      mtimeMs: s.lastTs ? Date.parse(s.lastTs) : 0,
    }));
}

function taskSessionVisible(task) {
  return !!(task && (task.draftOpen || taskSessionRunning(task) || task.awaiting || (task.restored && task.canResume && task.sessionId)));
}

function currentTaskSessionVisible(task) {
  return taskSessionVisible(task) && !!(task.running || task.awaiting);
}

function currentPlanningSessions(project) {
  const planning = project && project.planning ? project.planning : null;
  const current = planning && Array.isArray(planning.current) ? planning.current : [];
  return current
    .filter(it => it && (it.active || it.kind === 'quick' || it.kind === 'debug'))
    .slice(0, 4);
}

function planningSessionBox(item) {
  const kind = planningKindLabel(item.kind);
  const title = item.title || item.name || kind;
  const tone = item.kind === 'debug' ? 'awaiting' : 'running';
  return `<div class="project-session-box ${esc(tone)} planning-session" data-session-kind="planning" title="${esc(item.path || title)}">
    <div class="psb-top">
      <span class="psb-dot"></span>
      <b>${esc(kind)} 세션</b>
      <small>${esc(item.status || 'active')}</small>
    </div>
    <div class="psb-title">${esc(truncate(title, 58))}</div>
    <div class="psb-desc">${esc(truncate(item.path || '플래닝 세션 진행 중', 68))}</div>
  </div>`;
}

function currentSessionBoxes(project, lanes) {
  const mainLane = lanes.find(l => !l.kind || l.kind === 'main') || { kind: 'main', name: 'main', state: project.state, phases: project.phases };
  const boxes = [];
  for (const lane of lanes) {
    if (!lane || lane.kind === 'workstream-group') continue;
    const task = taskSession(project, lane);
    const bg = backgroundTaskForLane(project, lane);
    if (currentTaskSessionVisible(task) || isBgTaskRunning(bg)) {
      const running = (task && task.running) || isBgTaskRunning(bg);
      const awaiting = task && task.awaiting;
      boxes.push(sessionBox(project, lane, {
        kind: (lane && lane.kind) || 'main',
        title: `${laneLabelText(lane)} 세션`,
        subtitle: (task && (task.statusText || task.lastPrompt)) || (bg && (bg.prompt || backgroundStatusText(bg))) || laneProgressText(lane),
        desc: (task && task.output) || (bg && (bg.output || bg.stderr)) || 'Lodestar에서 실행한 Claude 세션',
        tone: awaiting ? 'awaiting' : (running ? 'running' : 'ready'),
      }));
    }
  }

  const act = project && project.activity ? project.activity : null;
  if (act && !isSessionHidden(project, act.sessionId) && (act.current || act.awaiting || act.blocked)) {
    const stale = act.current && act.current.status === 'stale';
    const tone = act.awaiting || act.blocked || stale ? 'awaiting' : 'running';
    boxes.push(sessionBox(project, mainLane, {
      kind: 'external',
      title: act.sessionId ? `Claude ${act.sessionId.slice(0, 8)}` : 'Claude 세션',
      subtitle: (act.current && act.current.sub) || (act.awaiting ? '답변 대기' : '외부 실행 감지'),
      desc: (act.current && act.current.desc) || act.awaitingText || act.blockedText || '터미널에서 감지된 세션',
      tone,
    }));
  }

  for (const item of currentPlanningSessions(project)) boxes.push(planningSessionBox(item));
  return boxes;
}

function branchAreaAddLane(area, project, lane, opts = {}) {
  if (!area || !project || !lane) return;
  if (!area.lanes) area.lanes = new Map();
  const laneId = taskLaneId(lane);
  const ph = laneCurrentPhase(lane, project);
  const prev = area.lanes.get(laneId) || {
    id: laneId,
    label: laneLabelText(lane),
    laneKind: lane.kind || 'main',
    phases: (lane.phases || []).map(ph => ({
      num: ph.num,
      title: ph.title,
      stage: ph.stage,
      stageLabel: ph.stageLabel,
      isCurrent: !!ph.isCurrent,
      plans: ph.plans || null,
      steps: stepStates(ph),
    })),
    phaseNum: ph && ph.num,
    phaseTitle: ph && ph.title,
    stage: ph && ph.stage,
    stageLabel: ph && ph.stageLabel,
    steps: ph ? stepStates(ph) : STEP_ORDER.map(([key, label]) => ({ key, label, state: 'pending' })),
    running: false,
    awaiting: false,
    touched: false,
    currentPhase: !!(ph && ph.isCurrent),
  };
  prev.running = !!(prev.running || opts.running);
  prev.awaiting = !!(prev.awaiting || opts.awaiting);
  prev.touched = !!(prev.touched || opts.touched);
  prev.currentPhase = !!(prev.currentPhase || (ph && ph.isCurrent));
  if ((!prev.phases || !prev.phases.length) && lane.phases && lane.phases.length) {
    prev.phases = lane.phases.map(item => ({
      num: item.num,
      title: item.title,
      stage: item.stage,
      stageLabel: item.stageLabel,
      isCurrent: !!item.isCurrent,
      plans: item.plans || null,
      steps: stepStates(item),
    }));
  }
  area.lanes.set(laneId, prev);
}

function branchAreaAddSession(area, item = {}) {
  if (!area || !item.key) return;
  if (!Array.isArray(area.sessionNodes)) area.sessionNodes = [];
  item.branch = item.branch || area.branch;
  item.laneId = item.laneId || 'main';
  item.logicalKey = item.logicalKey || `${item.branch || area.branch}|${item.laneId}`;
  const existing = area.sessionNodes.find(x => x.logicalKey === item.logicalKey);
  if (existing) {
    if (existing.keys && existing.keys.includes(item.key)) return;
    const prevCount = existing.count || (existing.keys ? existing.keys.length : 1);
    existing.keys = [...(existing.keys || [existing.key]), item.key];
    existing.count = prevCount + 1;
    existing.running = !!(existing.running || item.running);
    existing.awaiting = !!(existing.awaiting || item.awaiting);
    existing.done = !existing.running && !existing.awaiting && !!(item.done || existing.done);
    existing.title = item.running || item.awaiting ? item.title : (existing.title || item.title);
    existing.meta = logicalSessionMeta(item, existing);
    existing.latest = item;
    if (item.running || item.awaiting || !existing.sessionId) {
      Object.assign(existing, {
        key: item.key,
        bgId: item.bgId || existing.bgId || null,
        sessionKey: item.sessionKey || existing.sessionKey || null,
        sessionId: item.sessionId || existing.sessionId || null,
      });
    }
    return;
  }
  area.sessionNodes.push({
    ...item,
    keys: [item.key],
    count: 1,
    meta: logicalSessionMeta(item, null),
    latest: item,
  });
}

function logicalSessionMeta(item, existing) {
  const label = String((item && item.laneLabel) || (item && item.meta ? String(item.meta).split('·')[0].trim() : '') || '작업');
  const count = (existing && existing.count ? existing.count : 0) + 1;
  const state = item && item.running ? '실행 중' : (item && item.awaiting ? '답변 필요' : (item && item.done ? '완료' : '세션'));
  return count > 1 ? `${label} · ${count}개 세션 · ${state}` : `${label} · ${state}`;
}

function branchAreaLaneRows(area) {
  const lanes = [...((area && area.lanes) ? area.lanes.values() : [])];
  return lanes
    .sort((a, b) => Number(b.running) - Number(a.running) || Number(b.awaiting) - Number(a.awaiting) || Number(b.currentPhase) - Number(a.currentPhase) || a.label.localeCompare(b.label))
    .slice(0, 8);
}

function branchAreaFlowHtml(area) {
  const rows = branchAreaLaneRows(area);
  if (!rows.length) return '';
  return `<div class="pba-flow" title="이 브랜치에서 동기화된 WCC 프로세스 흐름">
    ${rows.map(row => `
      <div class="pba-flow-row ${row.running ? 'running' : ''}${row.awaiting ? ' awaiting' : ''}">
        <div class="pba-flow-head">
          <b>${esc(truncate(row.label, 28))}</b>
          <span>${row.phaseNum ? `Phase ${esc(row.phaseNum)} · ` : ''}${esc(row.stageLabel || '대기')}</span>
        </div>
        <div class="pba-step-track">
          ${row.steps.map(step => `<span class="pba-step ${esc(step.state)}" title="${esc(step.label)}"></span>`).join('')}
        </div>
      </div>
    `).join('')}
  </div>`;
}

function branchAreaStepTrackHtml(row) {
  const steps = Array.isArray(row && row.steps) && row.steps.length
    ? row.steps
    : STEP_ORDER.map(([key, label]) => ({ key, label, state: 'pending' }));
  return `<span class="pba-step-track" aria-label="WCC 단계 흐름">
    ${steps.map(step => `<span class="pba-step ${esc(step.state)}" title="${esc(step.label)}"></span>`).join('')}
  </span>`;
}

function branchPhaseFoldKey(project, area, row) {
  return `${projectScopeKeyForBranch(project, area.branch)}|branch-flow:${row.id || 'main'}`;
}

function branchPhaseCollapseNodeHtml(project, area, row, foldedCount, expanded) {
  const key = branchPhaseFoldKey(project, area, row);
  const title = expanded ? '완료 접기' : `완료 ${foldedCount}개 펼치기`;
  const desc = expanded ? '완료된 phase 숨기기' : '완료된 phase 보기';
  return `<button class="pba-phase-collapse branch-flow-node ${expanded ? 'is-expanded' : ''}" type="button" data-fold-key="${esc(key)}" title="${esc(desc)}">
    <span class="pba-node-port in"></span><span class="pba-node-port out"></span>
    <span class="pba-collapse-mark">${expanded ? '◂' : '✓'}</span>
    <span class="pba-collapse-text">
      <b>${esc(title)}</b>
      <small>${esc(row.label || '워크플로우')}</small>
    </span>
  </button>`;
}

function branchAreaPhaseNodesHtml(project, area, row) {
  const phases = Array.isArray(row && row.phases) && row.phases.length
    ? row.phases
    : [{
      num: row.phaseNum || '',
      title: row.phaseTitle || row.label || '대기',
      stage: row.stage || 'pending',
      stageLabel: row.stageLabel || '대기',
      isCurrent: !!row.currentPhase,
      plans: null,
      steps: row.steps || [],
    }];
  const curIdx = phases.findIndex(ph => ph.isCurrent);
  const foldedCount = curIdx >= 0 ? curIdx : completedPrefixCount(phases);
  const collapsible = foldedCount > 0;
  const expanded = expandedLanes.has(branchPhaseFoldKey(project, area, row));
  const startIdx = (collapsible && !expanded) ? foldedCount : 0;
  const visiblePhases = phases.slice(startIdx, startIdx + (collapsible && !expanded ? 11 : 12));
  const items = [];
  if (collapsible) {
    items.push({ type: 'collapse', html: branchPhaseCollapseNodeHtml(project, area, row, foldedCount, expanded) });
  }
  visiblePhases.forEach((ph, idx) => {
    items.push({ type: 'phase', ph, idx: startIdx + idx });
  });
  return `<div class="pba-phase-flow" title="${esc(row.label)} phase 흐름">
    ${items.map((item, itemIdx) => {
      if (item.type === 'collapse') {
        return `${item.html}${itemIdx < items.length - 1 ? '<span class="pba-phase-edge" aria-hidden="true"></span>' : ''}`;
      }
      const ph = item.ph;
      const idx = item.idx;
      const done = ph.stage === 'verify' || ph.stage === 'execute-done';
      const plans = ph.plans && ph.plans.total ? `${ph.plans.done || 0}/${ph.plans.total}` : '';
      const pct = ph.plans && ph.plans.total > 0 ? Math.round((ph.plans.done || 0) / ph.plans.total * 100)
        : (done ? 100 : (ph.stage === 'pending' ? 0 : 50));
      const color = STAGE_COLOR[ph.stage] || 'var(--s-pending)';
      const icon = STAGE_ICON[ph.stage] || '·';
      const steps = Array.isArray(ph.steps) && ph.steps.length
        ? ph.steps
        : STEP_ORDER.map(([key, label]) => ({ key, label, state: 'pending' }));
      const running = !!(ph.isCurrent && row.running);
      const awaiting = !!(ph.isCurrent && row.awaiting);
      const statusBadge = running ? '<span class="pba-node-status running">실행중</span>'
        : awaiting ? '<span class="pba-node-status wait">답변 필요</span>'
        : done ? '<span class="pba-node-status done">완료</span>'
        : ph.isCurrent ? '<span class="pba-node-status wait">현재</span>' : '';
      return `
        <button class="pba-phase-node branch-flow-node stage-${esc(ph.stage || 'pending')} ${ph.isCurrent ? 'current' : ''}${done ? ' done' : ''}${running ? ' running' : ''}${awaiting ? ' awaiting' : ''}" type="button" data-branch="${esc(area.branch)}" data-lane-id="${esc(row.id)}">
          <span class="pba-node-port in"></span><span class="pba-node-port out"></span>
          <span class="pba-node-top">
            <span class="pba-node-icon" style="background:${color}">${esc(icon)}</span>
            <span class="pba-node-head">
              <span class="pba-node-phase">PHASE ${ph.num ? esc(ph.num) : idx + 1}${ph.isCurrent ? ' · 현재' : ''}</span>
              <b>${esc(truncate(ph.title || row.label || 'Phase', 42))}</b>
            </span>
            ${statusBadge}
          </span>
          <span class="pba-node-steps">
            ${steps.map(step => `<span class="pba-node-step ${esc(step.state)}" title="${esc(step.label)}"><span></span></span>`).join('')}
          </span>
          <span class="pba-node-foot">
            <span><i style="background:${color}"></i>${esc(ph.stageLabel || '대기')}</span>
            <em>${plans ? `${esc(plans)} plans` : ''}</em>
          </span>
          <span class="pba-node-progress"><span style="width:${pct}%"></span></span>
        </button>
        ${itemIdx < items.length - 1 ? '<span class="pba-phase-edge" aria-hidden="true"></span>' : ''}
      `;
    }).join('')}
  </div>`;
}

function branchAreaLaneNodesHtml(project, area) {
  const rows = branchAreaLaneRows(area);
  if (!rows.length) return '';
  return `<div class="pba-lane-nodes pba-lane-flow" title="이 브랜치 안에서 펼쳐진 마일스톤/워크스트림 흐름">
    ${rows.map(row => `
      <div class="pba-workstream-lane ${esc(row.laneKind || 'main')}">
        <button class="pba-lane-node ${row.running ? 'running' : ''}${row.awaiting ? ' awaiting' : ''}" type="button" data-branch="${esc(area.branch)}" data-lane-id="${esc(row.id)}">
          <span class="pba-lane-dot"></span>
          <span class="pba-lane-text">
            <b>${esc(truncate(row.label, 30))}</b>
            <small>${row.laneKind === 'workstream' ? '워크스트림' : '마일스톤'}${row.phaseNum ? ` · Phase ${esc(row.phaseNum)}` : ''} · ${esc(row.stageLabel || '대기')}</small>
          </span>
          ${branchAreaStepTrackHtml(row)}
        </button>
        ${branchAreaPhaseNodesHtml(project, area, row)}
      </div>
    `).join('')}
  </div>`;
}

function branchAreaSessionNodesHtml(area) {
  const rows = Array.isArray(area && area.sessionNodes) ? area.sessionNodes.slice(0, 4) : [];
  if (!rows.length) return '';
  return `<div class="pba-session-nodes logical" title="이 브랜치의 작업 세션은 워크스트림/마일스톤 단위로 묶어 표시합니다">
    ${rows.map(row => `
      <button class="pba-session-node ${row.running ? 'running' : ''}${row.awaiting ? ' awaiting' : ''}${row.done ? ' done' : ''}" type="button"
        data-branch="${esc(row.branch || (area && area.branch) || '')}"
        data-lane-id="${esc(row.laneId || 'main')}"
        ${row.bgId ? `data-bg-id="${esc(row.bgId)}"` : ''}
        ${row.sessionKey ? `data-session-key="${esc(row.sessionKey)}"` : ''}
        ${row.sessionId ? `data-session-id="${esc(row.sessionId)}"` : ''}>
        <span class="pba-session-dot"></span>
        <b>${esc(truncate(row.title || '작업 세션', 34))}</b>
        <small>${esc(row.meta || 'Claude 세션')}</small>
        ${row.count > 1 ? `<em>${esc(row.count)}개</em>` : ''}
        <span class="pba-session-close" data-bg-id="${esc(row.bgId || '')}" data-session-key="${esc(row.sessionKey || '')}" data-session-id="${esc(row.sessionId || '')}" title="${row.running ? '실행 중지 후 세션 닫기' : '세션 닫기'}">×</span>
      </button>
    `).join('')}
  </div>`;
}

function projectBranchAreas(project) {
  const current = projectBranchKey(project);
  const selected = selectedProjectBranch(project);
  const byBranch = new Map();
  const ensure = (branch) => {
    const name = branch || 'no-git';
    if (!byBranch.has(name)) {
      byBranch.set(name, {
        branch: name,
        current: name === current,
        selected: name === selected,
        visible: visibleProjectBranches(project).includes(name),
        running: 0,
        awaiting: 0,
        sessions: 0,
        labels: [],
        updatedAt: 0,
        lanes: new Map(),
        sessionNodes: [],
      });
    }
    return byBranch.get(name);
  };
  if (selected) ensure(selected);
  for (const branch of visibleProjectBranches(project)) ensure(branch);
  for (const area of byBranch.values()) {
    if (!(area.current || area.selected || area.visible)) continue;
    for (const lane of (project.lanes || []).filter(l => !l.kind || l.kind === 'main' || l.kind === 'workstream')) {
      branchAreaAddLane(area, project, lane, {
        touched: true,
        running: lanePhaseRunning(project, lane, area.branch),
        awaiting: taskAwaitingForLane(project, lane, area.branch),
      });
    }
  }
  for (const ctx of taskSessions.values()) {
    if (!ctx || !ctx.project || ctx.project.path !== project.path) continue;
    if (!taskSessionVisible(ctx)) continue;
    const area = ensure(ctx.branch || (ctx.key && (ctx.key.match(/\|branch:([^:]+)::/) || [])[1]) || current);
    const ctxRunning = taskSessionRunning(ctx);
    area.sessions++;
    if (ctxRunning) area.running++;
    if (ctx.awaiting) area.awaiting++;
    area.labels.push(ctx.lastPrompt || ctx.statusText || laneLabelText(ctx.lane));
    branchAreaAddLane(area, project, ctx.lane || projectMainLane(project), { running: ctxRunning, awaiting: ctx.awaiting, touched: true });
    branchAreaAddSession(area, {
      key: `ctx:${ctx.key}`,
      sessionKey: ctx.key,
      sessionId: ctx.sessionId || null,
      branch: area.branch,
      laneId: taskLaneId(ctx.lane || projectMainLane(project)),
      laneLabel: laneLabelText(ctx.lane || projectMainLane(project)),
      title: `${laneLabelText(ctx.lane || projectMainLane(project))} 작업`,
      meta: `${laneLabelText(ctx.lane)} · ${ctxRunning ? '실행 중' : (ctx.awaiting ? '답변 필요' : '세션')}`,
      running: ctxRunning,
      awaiting: ctx.awaiting,
      done: !ctxRunning && !ctx.awaiting && !!ctx.sessionId,
    });
    area.updatedAt = Math.max(area.updatedAt, ctx.savedAt ? Date.parse(ctx.savedAt) : 0);
  }
  const saved = readPersistedTaskSessions();
  for (const raw of Object.values(saved || {})) {
    if (!raw || raw.projectPath !== project.path) continue;
    const hasState = raw.draftOpen || raw.sessionId || raw.backgroundTaskId || raw.lastPrompt || raw.awaiting || raw.canResume;
    if (!hasState) continue;
    if (raw.key && taskSessions.has(raw.key)) continue;
    const area = ensure(raw.branch || current);
    const rawBg = backgroundTaskById(project, raw.backgroundTaskId);
    if ((raw.sessionId && isSessionHidden(project, raw.sessionId)) || (rawBg && isBackgroundTaskHidden(project, rawBg)) || (!raw.sessionId && raw.backgroundTaskId && isSessionHidden(project, `bg:${raw.backgroundTaskId}`))) continue;
    const rawRunning = isBgTaskRunning(rawBg);
    const rawDone = rawBg ? rawBg.status === 'completed' : !!(raw.sessionId && !raw.awaiting && !rawRunning);
    area.sessions++;
    if (rawRunning) area.running++;
    if (raw.awaiting) area.awaiting++;
    area.labels.push(raw.lastPrompt || raw.statusText || raw.laneName || '세션');
    const rawLane = laneForTaskId(project, raw.laneId) || projectMainLane(project);
    branchAreaAddLane(area, project, rawLane, { running: rawRunning, awaiting: raw.awaiting, touched: true });
    branchAreaAddSession(area, {
      key: `saved:${raw.key || raw.sessionId || raw.backgroundTaskId || raw.savedAt || raw.laneId}`,
      bgId: raw.backgroundTaskId || null,
      sessionKey: raw.key || null,
      sessionId: raw.sessionId || null,
      branch: area.branch,
      laneId: raw.laneId || taskLaneId(rawLane),
      laneLabel: laneLabelText(rawLane),
      title: `${laneLabelText(rawLane)} 작업`,
      meta: `${laneLabelText(rawLane)} · ${rawRunning ? '실행 중' : (raw.awaiting ? '답변 필요' : (rawDone ? '완료' : '이전 세션'))}`,
      running: rawRunning,
      awaiting: !!raw.awaiting,
      done: !!rawDone,
    });
    area.updatedAt = Math.max(area.updatedAt, raw.savedAt ? Date.parse(raw.savedAt) : 0);
  }
  for (const task of project.backgroundTasks || []) {
    if (!task || !task.branch) continue;
    if (isBackgroundTaskHidden(project, task)) continue;
    const area = ensure(task.branch);
    area.sessions++;
    if (isBgTaskRunning(task)) area.running++;
    area.labels.push(task.historyPrompt || task.prompt || backgroundStatusText(task));
    const taskLane = task.workstream && task.workstream.name
      ? laneForTaskId(project, `workstream:${task.workstream.name}`)
      : projectMainLane(project);
    branchAreaAddLane(area, project, taskLane, { running: isBgTaskRunning(task), touched: true });
    branchAreaAddSession(area, {
      key: `bg:${task.id}`,
      bgId: task.id,
      sessionId: task.sessionId || null,
      branch: area.branch,
      laneId: taskLane ? taskLaneId(taskLane) : 'main',
      laneLabel: taskLane ? laneLabelText(taskLane) : '마일스톤',
      title: `${taskLane ? laneLabelText(taskLane) : '마일스톤'} 작업`,
      meta: `${taskLane ? laneLabelText(taskLane) : '마일스톤'} · ${backgroundStatusText(task).replace(/^[^\s]+\s*/, '')}`,
      running: isBgTaskRunning(task),
      awaiting: false,
      done: task.status === 'completed',
    });
    area.updatedAt = Math.max(area.updatedAt, task.updatedAt ? Date.parse(task.updatedAt) : 0);
  }
  const act = project.activity || null;
  if (act && (act.current || act.awaiting || act.blocked) && !isSessionHidden(project, act.sessionId)) {
    const area = ensure(current);
    area.sessions++;
    if (act.current) area.running++;
    if (act.awaiting) area.awaiting++;
    area.labels.push((act.current && act.current.desc) || act.awaitingText || act.blockedText || '외부 Claude 세션');
    branchAreaAddLane(area, project, projectMainLane(project), { running: act.current, awaiting: act.awaiting, touched: true });
    area.updatedAt = Math.max(area.updatedAt, act.lastTs ? Date.parse(act.lastTs) : 0);
  }
  return [...byBranch.values()]
    .filter(area => area.sessions > 0 || area.current || area.selected || area.visible)
    .sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.current) - Number(a.current) || (b.running - a.running) || (b.updatedAt - a.updatedAt));
}

function branchAreaKey(project, branch) {
  return `${project.path}|branch-area:${branch || 'no-git'}`;
}

function branchAreaBox(project, area) {
  const tone = area.awaiting ? 'awaiting' : (area.running ? 'running' : (area.current ? 'current' : 'ready'));
  const label = area.selected ? '보기 중' : (area.current ? '현재 체크아웃' : '브랜치 세션');
  const logicalSessions = Array.isArray(area.sessionNodes) ? area.sessionNodes.length : 0;
  const summary = area.running
    ? `${area.running} 실행 중 · ${logicalSessions || area.sessions} 작업`
    : `${logicalSessions || area.sessions} 작업 · ${area.sessions} Claude 세션`;
  const prompt = area.labels.find(Boolean) || '이 브랜치 안에서 새 세션을 시작하면 워크스트림과 마일스톤 작업이 함께 묶입니다.';
  const expanded = isProjectBranchExpanded(project, area.branch);
  return `<div class="project-branch-area ${tone}${area.selected ? ' selected' : ''}${expanded ? ' expanded' : ' collapsed'}" data-branch="${esc(area.branch)}">
    <div class="pba-head">
      <span class="pba-dot"></span>
      <b>${esc(area.branch)}</b>
      <span class="pba-head-actions">
        <small>${esc(label)}</small>
        <button class="pba-head-toggle branch-toggle" type="button" data-branch="${esc(area.branch)}" title="${expanded ? '브랜치 접기' : '브랜치 펼치기'}">${expanded ? '접기' : '펼치기'}</button>
        <button class="pba-head-session branch-new-session" type="button" data-branch="${esc(area.branch)}" title="${esc(area.branch)} 브랜치에서 새 세션 시작">+ 세션</button>
      </span>
    </div>
    <div class="pba-meta">${esc(summary)}${area.awaiting ? ' · 답변 필요' : ''}</div>
    <div class="pba-desc">${esc(truncate(prompt, 86))}</div>
    ${expanded ? branchAreaLaneNodesHtml(project, area) : ''}
    ${expanded ? branchAreaSessionNodesHtml(area) : ''}
    <div class="pba-scope">브랜치 작업 공간</div>
    <div class="pba-actions">
      ${area.selected ? '' : `<button class="btn btn-ghost branch-view" type="button" data-branch="${esc(area.branch)}">보기</button>`}
    </div>
  </div>`;
}

async function checkoutBranch(project, branch, opts = {}) {
  if (!project || !branch || branch === projectBranchKey(project)) {
    if (opts.openSession) openTask(project, null, projectMainLane(project), { branch: branch || projectBranchKey(project) });
    return;
  }
  focusBranchKey = branchAreaKey(project, branch);
  const res = await window.lodestar.switchGitRef(project.path, branch);
  if (!res || !res.ok) {
    showGitStatus(`Git 전환 실패: ${(res && (res.stderr || res.error)) || 'unknown error'}`, true);
    return;
  }
  await refresh();
  const nextProject = projects.find(p => p.path === project.path) || project;
  if (opts.openSession) openTask(nextProject, null, projectMainLane(nextProject), { branch });
}

function branchBoardColumnCount(width, count) {
  return 1;
}

function branchAreaEstimatedHeight(area, cardWidth = BRANCH_CARD_MIN_W) {
  const expanded = !!(area && area.expandedForLayout);
  if (!expanded) return 188;
  const laneCount = area && area.lanes ? Math.min(8, area.lanes.size || 0) : 0;
  const sessionCount = Array.isArray(area.sessionNodes) ? Math.min(8, area.sessionNodes.length) : 0;
  const sessionCols = Math.max(1, Math.floor((Math.max(180, cardWidth) - 20) / 132));
  const sessionRows = sessionCount ? Math.max(1, Math.ceil(sessionCount / sessionCols)) : 0;
  return Math.max(340, 146 + Math.max(1, laneCount) * 212 + sessionRows * 62);
}

function branchPhaseFlowEstimatedWidth(project, area, row) {
  const phases = Array.isArray(row && row.phases) && row.phases.length
    ? row.phases
    : [{ stage: row && row.stage || 'pending', isCurrent: !!(row && row.currentPhase) }];
  const curIdx = phases.findIndex(ph => ph.isCurrent);
  const foldedCount = curIdx >= 0 ? curIdx : completedPrefixCount(phases);
  const collapsible = foldedCount > 0;
  const expanded = expandedLanes.has(branchPhaseFoldKey(project, area, row));
  const startIdx = (collapsible && !expanded) ? foldedCount : 0;
  const phaseCount = Math.min(phases.length - startIdx, collapsible && !expanded ? 11 : 12);
  const itemCount = Math.max(0, phaseCount) + (collapsible ? 1 : 0);
  if (!itemCount) return BRANCH_FLOW_NODE_W;
  const nodeWidth = Math.max(0, phaseCount) * BRANCH_FLOW_NODE_W + (collapsible ? BRANCH_FLOW_COLLAPSE_W : 0);
  return 16 + nodeWidth + Math.max(0, itemCount - 1) * BRANCH_FLOW_EDGE_W;
}

function branchAreaEstimatedWidth(project, area, minWidth = BRANCH_CARD_MIN_W) {
  if (!area || !isProjectBranchExpanded(project, area.branch)) return minWidth;
  const rows = branchAreaLaneRows(area);
  const widestFlow = rows.reduce((max, row) => Math.max(max, branchPhaseFlowEstimatedWidth(project, area, row)), 0);
  return Math.max(minWidth, widestFlow + 72);
}

function addProjectBranchBoard(nodesEl, project, x, y, width = PROJECT_MIN_W) {
  const areas = projectBranchAreas(project);
  if (!areas.length) return { nodes: 0, right: x, bottom: y, height: 0 };
  const baseBoardWidth = Math.max(PROJECT_MIN_W, Math.round(width));
  const boardWidth = Math.max(
    baseBoardWidth,
    ...areas.map(area => branchAreaEstimatedWidth(project, area, baseBoardWidth - 24) + 24),
  );
  const columns = branchBoardColumnCount(boardWidth, areas.length);
  const cardWidth = Math.max(BRANCH_CARD_MIN_W, boardWidth - 24);
  const areaHeights = areas.map(area => branchAreaEstimatedHeight({ ...area, expandedForLayout: isProjectBranchExpanded(project, area.branch) }, cardWidth));
  const gridHeight = areaHeights.reduce((sum, h) => sum + h, 0) + Math.max(0, areaHeights.length - 1) * 10;
  const height = Math.max(186, 42 + gridHeight);
  const board = document.createElement('div');
  board.className = 'project-branch-board';
  board.style.left = x + 'px';
  board.style.top = y + 'px';
  board.style.width = boardWidth + 'px';
  board.style.minHeight = height + 'px';
  board.innerHTML = `<div class="project-branch-title"><b>Git 브랜치 작업 공간</b><span>선택한 브랜치의 마일스톤·워크스트림·Claude 세션만 아래에 표시됩니다</span></div><div class="project-branch-grid">${areas.map(area => branchAreaBox(project, area)).join('')}</div>`;
  const grid = board.querySelector('.project-branch-grid');
  if (grid) {
    grid.style.setProperty('--branch-card-width', `${cardWidth}px`);
    grid.style.setProperty('--branch-card-count', String(columns));
    grid.style.display = 'flex';
    grid.style.flexDirection = 'column';
    grid.style.flexWrap = 'nowrap';
    grid.style.overflowX = 'hidden';
    grid.style.overflowY = 'visible';
    grid.querySelectorAll('.project-branch-area').forEach(card => {
      card.style.flex = '0 0 auto';
      card.style.width = `${cardWidth}px`;
      card.style.maxWidth = `${cardWidth}px`;
    });
  }
  board.querySelectorAll('.branch-view').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setSelectedProjectBranch(project, btn.dataset.branch || projectBranchKey(project));
    });
  });
  board.querySelectorAll('.branch-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleProjectBranchExpanded(project, btn.dataset.branch || projectBranchKey(project));
    });
  });
  board.querySelectorAll('.pba-phase-collapse').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = btn.dataset.foldKey || '';
      if (!key) return;
      if (expandedLanes.has(key)) expandedLanes.delete(key);
      else expandedLanes.add(key);
      layout();
    });
  });
  board.querySelectorAll('.pba-lane-node, .pba-phase-node').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const branch = btn.dataset.branch || projectBranchKey(project);
      const lane = laneForTaskId(project, btn.dataset.laneId || 'main') || projectMainLane(project);
      setSelectedProjectBranch(project, branch);
      openTask(project, null, lane, { branch });
    });
  });
  board.querySelectorAll('.pba-session-node').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const branch = btn.dataset.branch || projectBranchKey(project);
      const lane = laneForTaskId(project, btn.dataset.laneId || 'main') || projectMainLane(project);
      setSelectedProjectBranch(project, branch);
      if (lane && lane.kind === 'workstream') expandedLanes.add(workstreamGroupKey(project));
      if (btn.dataset.bgId) {
        const task = backgroundTaskById(project, btn.dataset.bgId) || historyBackgroundTaskById(project, btn.dataset.bgId);
        if (task) openBackgroundTask(project, task);
        return;
      }
      if (btn.dataset.sessionKey) {
        const ctx = taskSessions.get(btn.dataset.sessionKey);
        if (ctx) {
          ctx.branch = ctx.branch || branch;
          ctx.lane = ctx.lane || lane;
          showTaskSession(ctx);
          return;
        }
      }
      if (btn.dataset.sessionId) {
        openHistorySessionTask(project, {
          sessionId: btn.dataset.sessionId,
          branch,
          laneId: taskLaneId(lane),
          laneName: laneLabelText(lane),
          workflowKind: 'session',
          excerpt: '저장된 세션 기록을 여는 중입니다.',
          awaiting: false,
          blocked: false,
          running: false,
        });
      }
    });
  });
  board.querySelectorAll('.pba-session-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeBranchSession(project, btn);
    });
  });
  board.querySelectorAll('.branch-new-session').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const branch = btn.dataset.branch || projectBranchKey(project);
      setSelectedProjectBranch(project, branch);
      openTask(project, null, projectMainLane(project), { branch, forceNewDraft: true });
    });
  });
  nodesEl.appendChild(board);
  const actualWidth = Math.max(boardWidth, Math.ceil(board.scrollWidth || board.offsetWidth || 0));
  const actualHeight = Math.max(height, Math.ceil(board.scrollHeight || board.offsetHeight || 0));
  board.style.width = actualWidth + 'px';
  board.style.minHeight = actualHeight + 'px';
  let focusX = null, focusY = null;
  for (const area of areas) {
    if (focusBranchKey === branchAreaKey(project, area.branch)) {
      focusX = x;
      focusY = y + 40;
      focusBranchKey = null;
    }
  }
  return { nodes: 1, right: x + actualWidth, bottom: y + actualHeight, height: actualHeight, focusX, focusY };
}

function addProjectSessionBoard(nodesEl, project, lanes, x, y) {
  const tab = planningTab(project);
  let boxes = [];
  if (tab === 'history') {
    boxes = projectHistoryItems(project).map(it => historySessionBox(it));
    if (!boxes.length) boxes = [emptyHistorySessionBox()];
  } else {
    return { nodes: 0, right: x, bottom: y, height: 0 };
  }

  const board = document.createElement('div');
  board.className = 'project-session-board';
  board.style.left = x + 'px';
  board.style.top = y + 'px';
  const rows = Math.max(1, Math.ceil(boxes.length / 4));
  const height = Math.max(SESSION_BOARD_H, 24 + rows * 102 + (rows - 1) * 10);
  board.style.minHeight = height + 'px';
  board.innerHTML = `<div class="project-session-grid">${boxes.join('')}</div>`;

  board.querySelectorAll('.session-box-task').forEach(btn => {
    const box = btn.closest('.project-session-box');
    const lane = sessionLaneForBox(project, lanes, box);
    wireTaskActionButton(btn, project, lane);
  });
  board.querySelectorAll('.project-session-box.history[data-bg-id]').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const task = historyBackgroundTaskById(project, chip.dataset.bgId);
      if (task) {
        openBackgroundTask(project, task);
        return;
      }
      if (chip.dataset.sessionId) {
        const session = historySessionById(project, chip.dataset.sessionId);
        if (session) openHistorySessionTask(project, session);
      }
    });
  });
  board.querySelectorAll('.project-session-box.history[data-session-id]').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const session = historySessionById(project, chip.dataset.sessionId);
      if (session) openHistorySessionTask(project, session);
    });
  });
  board.querySelectorAll('.psh-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.sessionId) {
        closeSession(project, btn.dataset.sessionId);
      }
    });
  });
  nodesEl.appendChild(board);
  return { nodes: boxes.length, right: x + 1110, bottom: y + height, height };
}

function historySessionBox(item) {
  const isSession = !!item.sessionId;
  const title = isSession ? `${planningKindLabel(item.kind)} 세션` : planningKindLabel(item.kind);
  const subtitle = item.title || item.name || '히스토리';
  const desc = item.status || (isSession ? '완료된 Claude 세션' : (item.kind || 'history'));
  const bgData = item.backgroundTaskId ? ` data-bg-id="${esc(item.backgroundTaskId)}"` : '';
  const sessionData = item.sessionId ? ` data-session-id="${esc(item.sessionId)}"` : '';
  const action = item.sessionId
    ? `<button class="psh-delete" data-session-id="${esc(item.sessionId)}" title="세션 닫기">×</button>`
    : '';
  return `<div class="project-session-box history" data-session-kind="history" data-history-kind="${esc(item.kind || '')}"${bgData}${sessionData} title="${esc(subtitle)}">
    <div class="psb-top">
      <span class="psb-dot"></span>
      <b>${esc(title)}</b>
      <small>${esc(item.kind || 'history')}</small>
    </div>
    <div class="psb-title">${esc(truncate(subtitle, 58))}</div>
    <div class="psb-desc">${esc(truncate(desc, 68))}</div>
    <div class="psb-actions">${action}</div>
  </div>`;
}

function emptyHistorySessionBox() {
  return `<div class="project-session-box history empty" data-session-kind="history">
    <div class="psb-top"><span class="psb-dot"></span><b>히스토리 없음</b></div>
    <div class="psb-title">완료된 에이전트가 없습니다</div>
    <div class="psb-desc">현재 탭으로 전환해 세션을 확인하세요</div>
  </div>`;
}

function sessionLaneForBox(project, lanes, box) {
  const kind = box && box.dataset ? box.dataset.sessionKind : 'main';
  const name = box && box.dataset ? box.dataset.laneName : 'main';
  if (kind === 'workstream') return lanes.find(l => l.kind === 'workstream' && l.name === name) || null;
  return lanes.find(l => !l.kind || l.kind === 'main') || { kind: 'main', name: 'main', state: project.state, phases: project.phases };
}

function phaseAutoFolded(ph) {
  return !!ph && (ph.stage === 'verify' || ph.stage === 'execute-done');
}

function completedPrefixCount(phs) {
  let n = 0;
  for (const ph of phs || []) {
    if (!phaseAutoFolded(ph)) break;
    n++;
  }
  return n;
}

function estimateLaneWidth(lane) {
  const phs = lane && Array.isArray(lane.phases) ? lane.phases : [];
  if (!phs.length) return NODE_W;
  const collapsed = completedPrefixCount(phs) >= 2 ? 1 : 0;
  const visible = phs.length - (collapsed ? completedPrefixCount(phs) : 0);
  const itemCount = Math.max(1, visible + collapsed);
  const nodeWidth = collapsed ? COLLAPSE_W : NODE_W;
  return (itemCount * NODE_W) + Math.max(0, itemCount - 1) * NODE_GAP_X + (collapsed ? nodeWidth - NODE_W : 0);
}

function estimateProjectContentWidth(mainLanes, workstreamLanes) {
  const laneWidths = [...(mainLanes || []), ...(workstreamLanes || [])].map(estimateLaneWidth);
  const maxLane = laneWidths.length ? Math.max(...laneWidths) : PROJECT_MIN_W;
  const workstreamWidth = workstreamLanes && workstreamLanes.length ? WORKSTREAM_GROUP_FRAME_W + 72 : 0;
  return Math.max(PROJECT_MIN_W, maxLane + 70, workstreamWidth);
}

function renderLane(nodesEl, edges, p, lane, laneY, activeAgent, xBase = LANE_LEFT, opts = {}) {
  const branch = opts.branch || selectedProjectBranch(p);
  const currentBranchView = branch === projectBranchKey(p);
  const sessionInfo = laneSessionInfo(p, lane, branch);
  activeAgent = currentBranchView ? activeAgent : null;
  const phs = lane.phases || [];
  if (!phs.length) {
    const frameWidth = SESSION_FRAME_MIN_W;
    const hasAgent = !!(activeAgent && (!lane || lane.kind === 'main'));
    const frameHeight = NODE_BASE_H + (hasAgent ? 96 : 0) + 122;
    const frameOffset = sessionInfo ? sessionFrameContentOffset(p, lane, xBase, laneY, opts.projectBounds, frameWidth, frameHeight) : { x: 0, y: 0 };
    const contentXBase = xBase + frameOffset.x;
    const contentLaneY = laneY + frameOffset.y;
    addLaneLabel(nodesEl, p, lane, contentLaneY, contentXBase, { sessionFramed: !!sessionInfo, branch });
    nodesEl.appendChild(emptyLaneNode(lane, contentXBase, contentLaneY));
    let nodeCount = 1;
    let left = contentXBase;
    let top = contentLaneY;
    let right = contentXBase + 260;
    let bottom = contentLaneY + NODE_BASE_H;
    if (hasAgent) {
      const ay = contentLaneY + AGENT_DY;
      nodesEl.appendChild(agentNode(activeAgent, contentXBase + 10, ay, p));
      nodeCount++;
      right = Math.max(right, contentXBase + 210);
      bottom = Math.max(bottom, ay + 70);
      edges.push({ vertical: true, x1: contentXBase + 130, y1: contentLaneY + NODE_BASE_H, x2: contentXBase + 110, y2: ay });
    }
    if (sessionInfo) {
      const rect = sessionFrameRect(p, lane, xBase - 16, laneY - 80, frameWidth, frameHeight, opts.projectBounds);
      nodesEl.appendChild(laneSessionFrame(p, lane, rect, sessionInfo));
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.left + rect.width);
      bottom = Math.max(bottom, rect.top + rect.height);
      nodeCount++;
    }
    return { nodes: nodeCount, extra: (sessionInfo ? 56 : 0) + (hasAgent ? 96 : 0), focusX: null, focusY: null, left, top, right, bottom };
  }

  const laneKey = projectScopeKey(p) + '|' + (lane.name || 'main');
  const curIdx = phs.findIndex(ph => ph.isCurrent);
  const foldedCount = curIdx >= 0 ? curIdx : completedPrefixCount(phs);
  const collapsible = foldedCount > 0;
  const expanded = expandedLanes.has(laneKey);
  const startIdx = (collapsible && !expanded) ? foldedCount : 0;
  const frameMetrics = laneFrameMetrics(phs, startIdx, collapsible, activeAgent, lane);
  const frameOffset = sessionInfo
    ? sessionFrameContentOffset(p, lane, xBase, laneY, opts.projectBounds, frameMetrics.width, frameMetrics.height)
    : { x: 0, y: 0 };
  const contentXBase = xBase + frameOffset.x;
  const contentLaneY = laneY + frameOffset.y;
  addLaneLabel(nodesEl, p, lane, contentLaneY, contentXBase, { sessionFramed: !!sessionInfo, branch });

  let x = contentXBase;
  let prevX = null, prevW = NODE_W;
  let curX = null;
  let nodes = 0;
  let focusX = null, focusY = null;
  let left = contentXBase;
  let top = contentLaneY;
  let right = contentXBase + NODE_W;
  let bottom = contentLaneY + NODE_BASE_H;

  if (collapsible) {
    nodesEl.appendChild(collapseNode(phs, foldedCount, x, contentLaneY, laneKey, !expanded));
    nodes++;
    right = Math.max(right, x + COLLAPSE_W);
    prevX = x; prevW = COLLAPSE_W;
    x += COLLAPSE_W + NODE_GAP_X;
  }
  for (let i = startIdx; i < phs.length; i++) {
    nodesEl.appendChild(phaseNode(p, phs[i], x, contentLaneY, lane, branch));
    nodes++;
    right = Math.max(right, x + NODE_W);
    if (phs[i].isCurrent) {
      curX = x;
      if (focusNext) { focusX = x; focusY = contentLaneY; }
    }
    if (prevX != null) {
      edges.push({
        x1: prevX + prevW, y1: contentLaneY + 38, x2: x, y2: contentLaneY + 38,
        active: phs[i].isCurrent || phs[i - 1]?.stage === 'verify' || phs[i - 1]?.stage === 'execute-done',
      });
    }
    prevX = x; prevW = NODE_W;
    x += NODE_W + NODE_GAP_X;
  }

  let extra = 0;
  const agentAnchorX = curX != null ? curX : (prevX != null ? prevX : null);
  const showAgent = activeAgent && agentAnchorX != null && (!lane || lane.kind === 'main');
  if (showAgent) {
    const ay = contentLaneY + AGENT_DY;
    nodesEl.appendChild(agentNode(activeAgent, agentAnchorX + 10, ay, p));
    nodes++;
    right = Math.max(right, agentAnchorX + 10 + 200);
    edges.push({ vertical: true, x1: agentAnchorX + NODE_W / 2, y1: contentLaneY + NODE_BASE_H, x2: agentAnchorX + 10 + 100, y2: ay });
    extra = 96;
    bottom = Math.max(bottom, ay + 70);
  }
  if (sessionInfo) {
    const rect = sessionFrameRect(p, lane, xBase - 16, laneY - 80, Math.max(frameMetrics.width, right - contentXBase + 36), Math.max(frameMetrics.height, NODE_BASE_H + extra + 122), opts.projectBounds);
    nodesEl.appendChild(laneSessionFrame(p, lane, rect, sessionInfo));
    nodes++;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.left + rect.width);
    bottom = Math.max(bottom, rect.top + rect.height);
    extra += 56;
  }
  return { nodes, extra, focusX, focusY, left, top, right, bottom };
}

function laneFrameMetrics(phs, startIdx, collapsible, activeAgent, lane) {
  let x = 0;
  let right = NODE_W;
  let curX = null;
  if (collapsible) {
    right = Math.max(right, COLLAPSE_W);
    x += COLLAPSE_W + NODE_GAP_X;
  }
  for (let i = startIdx; i < phs.length; i++) {
    right = Math.max(right, x + NODE_W);
    if (phs[i].isCurrent) curX = x;
    x += NODE_W + NODE_GAP_X;
  }
  const agentAnchorX = curX != null ? curX : (x > 0 ? Math.max(0, x - NODE_GAP_X - NODE_W) : null);
  const showAgent = activeAgent && agentAnchorX != null && (!lane || lane.kind === 'main');
  const extra = showAgent ? 96 : 0;
  if (showAgent) right = Math.max(right, agentAnchorX + 10 + 200);
  return {
    width: Math.max(SESSION_FRAME_MIN_W, right + 36),
    height: Math.max(168, NODE_BASE_H + extra + 122),
  };
}

function sessionFrameRect(project, lane, x, y, width, height, bounds = null) {
  const offset = sessionFrameOffset(project, lane);
  const rect = {
    baseLeft: x,
    baseTop: y,
    width: Math.max(SESSION_FRAME_MIN_W, Math.round(width)),
    height: Math.max(168, Math.round(height)),
    bounds,
  };
  const clamped = clampSessionFrameOffset(rect, offset.x, offset.y);
  return {
    ...rect,
    left: x + clamped.x,
    top: y + clamped.y,
  };
}

function sessionFrameContentOffset(project, lane, xBase, laneY, bounds = null, width = SESSION_FRAME_MIN_W, height = 168) {
  const offset = sessionFrameOffset(project, lane);
  const rect = {
    baseLeft: xBase - 16,
    baseTop: laneY - 80,
    width: Math.max(SESSION_FRAME_MIN_W, Math.round(width)),
    height: Math.max(168, Math.round(height)),
    bounds,
  };
  return clampSessionFrameOffset(rect, offset.x, offset.y);
}

function clampSessionFrameOffset(rect, x, y) {
  const b = rect && rect.bounds;
  if (!b) return { x, y };
  let nx = Number(x) || 0;
  let ny = Number(y) || 0;
  const minX = Number.isFinite(b.left) ? b.left - rect.baseLeft : -Infinity;
  const maxX = Number.isFinite(b.right) ? b.right - rect.baseLeft - rect.width : Infinity;
  const minY = Number.isFinite(b.top) ? b.top - rect.baseTop : -Infinity;
  const maxY = Number.isFinite(b.bottom) ? b.bottom - rect.baseTop - rect.height : Infinity;
  nx = Math.max(minX, Math.min(nx, Math.max(minX, maxX)));
  ny = Math.max(minY, Math.min(ny, Math.max(minY, maxY)));
  return { x: nx, y: ny };
}

function laneProgressSummary(lane) {
  const pr = lane && lane.state && lane.state.progress ? lane.state.progress : {};
  if (pr.totalPhases) {
    const pct = pr.percent != null ? pr.percent : Math.round((pr.completedPhases || 0) / pr.totalPhases * 100);
    return `${pr.completedPhases ?? 0}/${pr.totalPhases} phase · ${pct}%`;
  }
  return laneProgressText(lane);
}

function dormantLaneSessionInfo(project, lane) {
  if (!lane || lane.kind === 'workstream-group') return null;
  const st = lane.state || {};
  const hasScope = !!(st.milestone || st.milestoneName || (lane.phases && lane.phases.length) || (project.activity && project.activity.hasLog));
  if (!hasScope) return null;
  const progress = laneProgressSummary(lane);
  const done = Number(st.progress && st.progress.percent) >= 100;
  const milestone = st.milestone ? `${st.milestone}${st.milestoneName ? ' · ' + st.milestoneName : ''}` : '';
  return {
    tone: done ? 'done' : 'ready',
    title: lane.kind === 'workstream' ? `워크스트림 · ${lane.name || '세션'}` : '마일스톤 세션',
    meta: st.milestone || (done ? '완료' : '대기'),
    desc: milestone ? `${milestone} · ${progress}` : progress,
    action: project.activity && project.activity.hasLog ? 'activity' : 'none',
  };
}

function workstreamGroupSessionInfo(project, workstreams, expanded) {
  if (!workstreams || !workstreams.length) return null;
  const phaseCount = workstreams.reduce((n, l) => n + ((l.phases || []).length), 0);
  const activeCount = workstreams.filter(l => (l.phases || []).some(ph => ph.isCurrent)).length;
  const names = workstreams.map(l => l.name).filter(Boolean).slice(0, 5).join(', ');
  const desc = expanded
    ? `phase ${phaseCount} · 활성 ${activeCount} · 펼침`
    : `${names}${workstreams.length > 5 ? ' 외' : ''} · phase ${phaseCount} · 활성 ${activeCount} · 접힘`;
  return {
    tone: activeCount ? 'running' : 'ready',
    title: '워크스트림 영역',
    meta: `${workstreams.length}개`,
    desc,
    action: 'toggle-workstreams',
    toggleLabel: expanded ? '접기' : '펼치기',
  };
}

function laneSessionInfo(project, lane, branch = selectedProjectBranch(project)) {
  if (!lane || lane.kind === 'workstream-group') return null;
  const task = taskSession(project, lane, branch);
  const bg = backgroundTaskForLane(project, lane, branch);
  const st = taskButtonState(project, lane, branch);
  const isMainLane = !lane.kind || lane.kind === 'main';
  const isCurrentBranchView = branch === projectBranchKey(project);
  const visibleAgent = isCurrentBranchView && isMainLane && project.activity && project.activity.current && project.activity.current.kind !== 'shell'
    ? project.activity.current
    : null;

  if (isBgTaskRunning(bg)) {
    return {
      tone: 'running',
      title: `${laneLabelText(lane)} 세션`,
      meta: bg.sessionId ? bg.sessionId.slice(0, 8) : backgroundStatusText(bg),
      desc: bg.prompt || bg.output || '백그라운드 Claude 작업 진행 중',
      action: 'background',
      task: bg,
      agent: visibleAgent,
      branch,
    };
  }
  if (taskSessionVisible(task)) {
    const isDraft = !!(task.draftOpen && !task.running && !task.awaiting && !task.sessionId && !task.backgroundTaskId);
    return {
      tone: isDraft ? 'draft' : (task.awaiting ? 'awaiting' : (task.running ? 'running' : 'ready')),
      title: isDraft ? `새 세션 · ${laneLabelText(lane)}` : `${laneLabelText(lane)} 세션`,
      meta: isDraft ? '작성 중' : (task.sessionId ? task.sessionId.slice(0, 8) : 'Lodestar'),
      desc: isDraft ? (task.draft || task.statusText || '작업 지시 작성 중') : (task.statusText || task.lastPrompt || 'Claude 작업 세션'),
      action: 'task',
      task,
      agent: visibleAgent,
      branch,
    };
  }
  if (st.phaseRunning || (isCurrentBranchView && isMainLane && project.activity && project.activity.current)) {
    const act = project.activity || {};
    return {
      tone: act.current && act.current.status === 'stale' ? 'awaiting' : 'running',
      title: `${laneLabelText(lane)} 세션`,
      meta: act.sessionId ? act.sessionId.slice(0, 8) : 'phase',
      desc: (act.current && (act.current.desc || act.current.sub)) || (laneCurrentPhase(lane, project) || {}).title || '에이전트 실행 중',
      action: 'activity',
      agent: visibleAgent,
      branch,
    };
  }
  if (isCurrentBranchView && isMainLane && project.activity && (project.activity.awaiting || project.activity.blocked)) {
    const info = pauseInfo(project);
    return {
      tone: 'awaiting',
      title: `${laneLabelText(lane)} 세션`,
      meta: info.label,
      desc: info.detail || 'Claude 세션이 멈춰 있습니다',
      action: project.activity.awaiting ? 'awaiting' : 'blocked',
      branch,
    };
  }
  if (isCurrentBranchView && isMainLane) {
    const planning = currentPlanningSessions(project);
    if (planning.length) {
      const item = planning[0];
      return {
        tone: item.kind === 'debug' ? 'awaiting' : 'running',
        title: `${planningKindLabel(item.kind)} 세션`,
        meta: item.status || 'active',
        desc: item.title || item.name || item.path || '플래닝 작업 진행 중',
        action: 'activity',
        branch,
      };
    }
  }
  return isCurrentBranchView ? dormantLaneSessionInfo(project, lane) : null;
}

function elementCanvasBox(el) {
  const left = parseFloat(el.style.left);
  const top = parseFloat(el.style.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  const width = parseFloat(el.style.width) || el.offsetWidth || 0;
  const height = parseFloat(el.style.height) || el.offsetHeight || 0;
  return { left, top, width, height, cx: left + width / 2, cy: top + height / 2 };
}

function sessionDragVisualElements(rect, frameEl) {
  const nodesEl = $('#nodes');
  if (!nodesEl) return [{ el: frameEl, transform: frameEl.style.transform || '' }];
  const pad = 8;
  const left = rect.left - pad;
  const top = rect.top - pad;
  const right = rect.left + rect.width + pad;
  const bottom = rect.top + rect.height + pad;
  const items = [];
  for (const el of Array.from(nodesEl.children)) {
    const draggablePart = el === frameEl
      || el.classList.contains('node')
      || el.classList.contains('agent-node')
      || el.classList.contains('lane-label')
      || el.classList.contains('lane-session-frame');
    if (!draggablePart) continue;
    if (el !== frameEl) {
      const box = elementCanvasBox(el);
      if (!box || box.cx < left || box.cx > right || box.cy < top || box.cy > bottom) continue;
    }
    items.push({ el, transform: el.style.transform || '' });
  }
  if (!items.some(item => item.el === frameEl)) items.push({ el: frameEl, transform: frameEl.style.transform || '' });
  for (const item of items) item.el.classList.add('session-drag-visual');
  return items;
}

function applySessionDragVisual(items, dx, dy) {
  const t = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
  for (const item of items) item.el.style.transform = item.transform ? `${item.transform} ${t}` : t;
}

function clearSessionDragVisual(items) {
  for (const item of items) {
    item.el.style.transform = item.transform;
    item.el.classList.remove('session-drag-visual');
  }
}

function sessionFrameTaskButtonHtml(project, lane, branch = selectedProjectBranch(project)) {
  const canRequestTask = lane && (!lane.kind || lane.kind === 'main' || lane.kind === 'workstream');
  if (!canRequestTask) return '';
  return taskActionButtonHtml(project, lane, 'session-frame-task-btn', branch);
}

function sessionFrameAgentBadge(info) {
  const agent = info && info.agent;
  if (!agent || agent.kind === 'shell') return '';
  const running = agent.status === 'running' || !agent.done;
  const label = running ? 'Agent 사용중' : '최근 Agent';
  const detail = agent.sub || 'agent';
  return `<button class="lsf-agent-badge ${running ? 'running' : 'recent'}" type="button" title="에이전트 지시와 결과 보기">${esc(label)} · ${esc(detail)}</button>`;
}

function laneSessionFrame(project, lane, rect, info) {
  const el = document.createElement('div');
  el.className = `lane-session-frame ${esc(info.tone || 'running')}${info.action === 'toggle-workstreams' ? ' workstream-container' : ''}`;
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
  el.title = '클릭하면 이 세션의 실행 내용을 봅니다';
  el.innerHTML = `
    <div class="lsf-head">
      <span class="lsf-dot"></span>
      <b>${esc(info.title || '세션')}</b>
      <small>${esc(info.meta || '')}</small>
      <span class="lsf-desc">${esc(truncate(info.desc || '', 84))}</span>
      ${sessionFrameAgentBadge(info)}
      ${info.action === 'toggle-workstreams' ? `<button class="lsf-toggle" type="button">${esc(info.toggleLabel || '펼치기')}</button>` : ''}
      ${sessionFrameTaskButtonHtml(project, lane, info.branch || selectedProjectBranch(project))}
      <em title="세션 이동"></em>
    </div>`;
  let suppressClick = false;
  const head = el.querySelector('.lsf-head');
  const toggleBtn = el.querySelector('.lsf-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });
    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = workstreamGroupKey(project);
      if (expandedLanes.has(key)) expandedLanes.delete(key);
      else expandedLanes.add(key);
      layout();
    });
  }
  const agentBadge = el.querySelector('.lsf-agent-badge');
  if (agentBadge) {
    agentBadge.addEventListener('mousedown', (e) => e.stopPropagation());
    agentBadge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openAgentDetail(project, info.agent);
    });
  }
  const frameTaskBtn = el.querySelector('.session-frame-task-btn');
  if (frameTaskBtn) {
    frameTaskBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    wireTaskActionButton(frameTaskBtn, project, lane, info.branch || selectedProjectBranch(project));
  }
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('.lsf-toggle') || e.target.closest('.session-frame-task-btn') || e.target.closest('.lsf-agent-badge')) return;
    e.preventDefault();
    e.stopPropagation();
    beginInteract();
    const sx = e.clientX, sy = e.clientY;
    const start = sessionFrameOffset(project, lane);
    const visualItems = sessionDragVisualElements(rect, el);
    const visual = dragVisualApplier(visualItems);
    let nextX = start.x, nextY = start.y, moved = false;
    const move = (ev) => {
      const dx = (ev.clientX - sx) / view.scale;
      const dy = (ev.clientY - sy) / view.scale;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      nextX = start.x + dx;
      nextY = start.y + dy;
      const clamped = clampSessionFrameOffset(rect, nextX, nextY);
      visual.move(clamped.x - start.x, clamped.y - start.y);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const clamped = clampSessionFrameOffset(rect, nextX, nextY);
      visual.flush();
      setSessionFrameOffset(project, lane, clamped.x, clamped.y, true);
      suppressClick = moved;
      if (moved) suppressSessionFrameClickUntil = Date.now() + 180;
      clearSessionDragVisual(visualItems);
      flushDragLayout();
      endInteractSoon();
      setTimeout(() => { suppressClick = false; }, 120);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  el.addEventListener('click', (e) => {
    if (suppressClick || Date.now() < suppressSessionFrameClickUntil) {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    if (info.action === 'task') showTaskSession(info.task);
    else if (info.action === 'background') openBackgroundTask(project, info.task);
    else if (info.action === 'awaiting') openAwaitingTask(project);
    else if (info.action === 'blocked') openBlockedTask(project);
    else if (info.action === 'activity') openActivitySession(project, { phase: laneCurrentPhase(lane, project), lane });
  });
  return el;
}

function bezier(e) {
  const { x1, y1, x2, y2, active, vertical } = e;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  if (vertical) {
    const dy = Math.max(20, (y2 - y1) * 0.5);
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`);
    path.setAttribute('class', 'edge-vert');
  } else {
    const dx = Math.max(40, (x2 - x1) * 0.5);
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', 'edge-path' + (active ? ' active' : ''));
  }
  return path;
}

// 완료 묶음 / 접기 토글 노드. collapsedMode=true면 "✓ N개 펼치기", false면 "◂ 접기".
function collapseNode(phs, curIdx, x, y, laneKey, collapsedMode) {
  const el = document.createElement('div');
  el.className = 'node collapse-node' + (collapsedMode ? '' : ' is-expanded');
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  if (collapsedMode) {
    const from = phs[0].num, to = phs[curIdx - 1].num;
    el.innerHTML = `
      <div class="cn-body">
        <span class="cn-mark">✓</span>
        <div class="cn-text">
          <div class="cn-title">Phase ${from}~${to}</div>
          <div class="cn-sub">${curIdx}개 완료 · 펼치기 ▸</div>
        </div>
      </div>`;
    el.title = '클릭하면 완료된 단계 펼치기';
    el.addEventListener('click', (e) => { e.stopPropagation(); expandedLanes.add(laneKey); layout(); });
  } else {
    el.innerHTML = `
      <div class="cn-body">
        <span class="cn-mark">◂</span>
        <div class="cn-text">
          <div class="cn-title">완료 접기</div>
          <div class="cn-sub">${curIdx}개 숨기기</div>
        </div>
      </div>`;
    el.title = '클릭하면 완료된 단계 다시 접기';
    el.addEventListener('click', (e) => { e.stopPropagation(); expandedLanes.delete(laneKey); layout(); });
  }
  return el;
}

// 활성 에이전트 자식 노드 (현재 phase 아래, 진행 중인 동안만 존재)
// 클릭하면 그 에이전트의 실행 내용(지시·도구 호출·출력)을 상세 패널로 보여준다.
function agentNode(agent, x, y, project) {
  const el = document.createElement('div');
  const stale = agent.status === 'stale';
  const running = !stale && (agent.status === 'running' || !agent.status);
  const tag = stale ? '확인 필요' : (agent.kind === 'shell' ? 'shell 실행중' : (running ? '실행중' : (agent.status === 'done' ? '최근 완료' : '최근 활동')));
  el.className = 'agent-node' + (running ? '' : ' recent') + (stale ? ' stale' : '');
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.title = '클릭하면 이 에이전트의 실행 내용 보기';
  el.innerHTML = `
    <div class="an-head">
      <span class="an-spin"></span>
      <span class="an-sub">${esc(agent.sub || 'agent')}</span>
      <span class="an-tag">${esc(tag)}</span>
    </div>
    <div class="an-desc">${esc(truncate(agent.desc || '서브에이전트 작업 중…', 70))}</div>`;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (agent.kind === 'shell') openActivity(project);
    else openAgentDetail(project, agent);
  });
  return el;
}

// GSD 5단계 스텝 상태 (산출물 기반 역산)
const STEP_ORDER = [['discuss', '논의'], ['research', '조사'], ['plan', '계획'], ['execute', '실행'], ['verify', '검증']];

function hasPendingDiscussion(ph) {
  const d = ph.discuss;
  if (!d) return false;
  if (d.needsDiscuss) return ph.isCurrent;
  return (d.questions || []).some(q => !q.answered);
}

function canOpenDiscussion(ph) {
  if (!ph || !ph.isCurrent || !ph.discuss || !hasPendingDiscussion(ph)) return false;
  return ph.stage === 'discuss' || ph.discuss.needsDiscuss;
}

function projectAwaiting(project) {
  if (project && project.activity && project.activity.awaiting) return true;
  return false;
}

function updateAttentionBadges(projectList) {
  if (!window.lodestar || !window.lodestar.updateAttention) return;
  const items = [];
  for (const p of projectList || []) {
    const act = p && p.activity ? p.activity : null;
    if (!act || isSessionHidden(p, act.sessionId)) continue;
    if (act.awaiting && !act.blocked) {
      const body = act.awaitingText || 'Claude가 사용자 답변을 기다리고 있습니다.';
      const localItem = {
        key: attentionKeyFor(p, 'awaiting', act.sessionId),
        sig: attentionSignature(body),
        label: '답변 필요',
      };
      if (!attentionAcked(localItem)) {
        items.push({
          key: localItem.key,
          title: `${p.name || '프로젝트'} 답변 필요`,
          body,
        });
      }
    } else if (act.blocked) {
      const info = pauseInfo(p);
      const body = info.detail || 'Claude가 제한 또는 오류로 중단되었습니다.';
      const localItem = {
        key: attentionKeyFor(p, 'blocked', act.sessionId),
        sig: attentionSignature(body),
        label: info.label,
      };
      if (!attentionAcked(localItem)) {
        items.push({
          key: localItem.key,
          title: `${p.name || '프로젝트'} ${info.label}`,
          body,
        });
      }
    }
  }
  for (const ctx of taskSessions.values()) {
    if (!ctx || !ctx.awaiting || !ctx.project) continue;
    const body = ctx.statusText || ctx.excerpt || 'Claude가 사용자 답변을 기다리고 있습니다.';
    const key = attentionKeyFor(ctx.project, 'awaiting', ctx.sessionId || ctx.backgroundTaskId || ctx.key || 'local');
    const localItem = { key, sig: attentionSignature(body), label: '답변 필요' };
    if (attentionAcked(localItem)) continue;
    items.push({
      key,
      title: `${ctx.project.name || '프로젝트'} 답변 필요`,
      body,
    });
  }
  window.lodestar.updateAttention({ source: 'renderer', items }).catch(() => {});
}

function taskRunningForLane(project, lane, branch = selectedProjectBranch(project)) {
  const s = taskSession(project, lane, branch);
  return !!(s && taskSessionRunning(s));
}

function taskAwaitingForLane(project, lane, branch = selectedProjectBranch(project)) {
  const s = taskSession(project, lane, branch);
  return !!(s && s.awaiting && !s.running);
}

function lanePaused(project, lane, branch = selectedProjectBranch(project)) {
  const current = branch === projectBranchKey(project);
  return taskAwaitingForLane(project, lane, branch) || (current && (projectAwaiting(project) || !!(project && project.activity && project.activity.blocked)));
}

function projectPaused(project) {
  return projectAwaiting(project) || !!(project && project.activity && project.activity.blocked);
}

function laneCurrentPhase(lane, project) {
  const phases = (lane && lane.phases) || (project && project.phases) || [];
  return phases.find(ph => ph.isCurrent) || null;
}

function lanePhaseRunning(project, lane, branch = selectedProjectBranch(project)) {
  const ph = laneCurrentPhase(lane, project);
  if (!ph || lanePaused(project, lane, branch)) return false;
  if (branch !== projectBranchKey(project)) return false;
  return ph.stage === 'execute' || ph.stage === 'plan' || ph.stage === 'research';
}

function pauseInfo(project) {
  const act = (project && project.activity) || {};
  if (projectAwaiting(project)) {
    return { label: '답변 필요', detail: act.awaitingText || 'Claude가 사용자 답변을 기다리고 있습니다.' };
  }
  if (act.blocked) {
    const text = act.blockedText || 'Claude가 제한 또는 오류로 중단되었습니다.';
    const label = looksLikeUsageLimitText(text) ? '한도 초과' : '멈춤';
    return { label, detail: text };
  }
  return { label: '멈춤', detail: '' };
}


function stepStates(ph) {
  const s = ph.stage, pl = ph.plans || { total: 0, done: 0 };
  const past = (arr) => arr.includes(s);
  const done = {
    discuss: ph.hasContext || past(['research', 'plan', 'execute', 'execute-done', 'verify']),
    research: ph.hasResearch || past(['plan', 'execute', 'execute-done', 'verify']),
    plan: pl.total > 0 || past(['execute', 'execute-done', 'verify']),
    execute: (pl.total > 0 && pl.done >= pl.total) || s === 'execute-done' || s === 'verify',
    verify: ph.hasVerification || s === 'execute-done' || s === 'verify',
  };
  let currentKey = null;
  if (ph.isCurrent && s !== 'verify') {
    for (const [k] of STEP_ORDER) { if (!done[k]) { currentKey = k; break; } }
  }
  return STEP_ORDER.map(([key, label]) => ({
    key, label, state: done[key] ? 'done' : (key === currentKey ? 'current' : 'pending'),
  }));
}

function phaseNode(project, ph, x, y, lane, branch = selectedProjectBranch(project)) {
  const el = document.createElement('div');
  const currentBranchView = branch === projectBranchKey(project);
  const paused = currentBranchView && ph.isCurrent && lanePaused(project, lane, branch);
  const discussionPending = currentBranchView && !paused && ph.isCurrent && ph.stage === 'discuss';
  const running = currentBranchView && !paused && ph.isCurrent && (ph.stage === 'execute' || ph.stage === 'plan' || ph.stage === 'research');
  const flashed = flashKeys.has(`${project.path}|${ph.num}`);
  const laneClass = lane && lane.kind === 'workstream' ? ' lane-workstream' : ' lane-main';
  el.className = `node stage-${ph.stage}` + (ph.isCurrent ? ' current' : '') +
    (running ? ' running' : '') + (paused ? ' paused' : '') + (canOpenDiscussion(ph) ? ' has-discuss' : '') + (flashed ? ' flashed' : '') + laneClass;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  const color = STAGE_COLOR[ph.stage] || 'var(--s-pending)';
  const icon = STAGE_ICON[ph.stage] || '·';
  const plans = ph.plans && ph.plans.total > 0 ? `${ph.plans.done}/${ph.plans.total} plans` : '';
  const pct = ph.plans && ph.plans.total > 0 ? Math.round(ph.plans.done / ph.plans.total * 100)
    : (ph.stage === 'verify' ? 100 : (ph.stage === 'pending' ? 0 : 50));

  const pi = paused ? pauseInfo(project) : null;
  const statusBadge = paused ? `<span class="node-status paused" title="${esc(pi.detail)}">⏸ ${esc(pi.label)}</span>`
    : running ? '<span class="node-status running">▶ 실행중</span>'
    : discussionPending ? '<span class="node-status wait">논의 필요</span>'
    : (ph.stage === 'verify' || ph.stage === 'execute-done' ? '<span class="node-status done">✓ 완료</span>'
    : (ph.isCurrent ? '<span class="node-status wait">진행 예정</span>' : ''));

  // 단계별 스텝 트랙
  const steps = stepStates(ph).map(s =>
    `<div class="step-seg ${s.state}"><span class="step-bar"></span><span class="step-label">${s.label}</span></div>`).join('');

  el.innerHTML = `
    <span class="port in"></span><span class="port out"></span>
    <div class="node-top">
      <div class="node-icon" style="background:${color}">${icon}</div>
      <div class="node-head-text">
        <div class="node-phase">PHASE ${ph.num}${ph.isCurrent ? ' · 현재' : ''}</div>
        <div class="node-title">${esc(ph.title)}</div>
      </div>
      ${statusBadge}
    </div>
    <div class="node-steps">${steps}</div>
    <div class="node-foot">
      <span class="node-stage"><span class="sdot" style="background:${color}"></span>${esc(ph.stageLabel)}</span>
      <span class="node-plans">${plans}</span>
    </div>
    <div class="node-progress"><span style="width:${pct}%"></span></div>`;

  el.addEventListener('click', () => {
    if (paused) {
      if (taskAwaitingForLane(project, lane, branch)) showTaskSession(taskSession(project, lane, branch));
      else if (projectAwaiting(project)) openAwaitingTask(project);
      else openBlockedTask(project);
      return;
    }
    if (canOpenDiscussion(ph)) {
      if (taskRunningForLane(project, lane, branch) || (currentBranchView && (!lane || lane.kind === 'main') && project.activity && project.activity.current)) return;
      openTask(project, {
        num: ph.num, title: ph.title,
        question: (ph.discuss.questions && ph.discuss.questions[0] && ph.discuss.questions[0].text) || '',
        questions: ph.discuss.questions || [],
        sections: ph.discuss.sections || [],
        grayNote: ph.discuss.grayNote || null,
      }, lane, { branch });
      return;
    }
    if (currentBranchView && ph.isCurrent && project.activity && project.activity.current) {
      openActivitySession(project, { phase: ph, lane });
      return;
    }
    if (currentBranchView && ph.isCurrent && project.activity && project.activity.hasLog) {
      openActivity(project, { phase: ph, lane });
      return;
    }
    if (ph.isCurrent && !taskRunningForLane(project, lane, branch)) openTask(project, null, lane, { branch });
  });
  return el;
}

function workstreamGroupNode(project, workstreams, x, y, expanded) {
  const el = document.createElement('div');
  el.className = 'node workstream-group-node' + (expanded ? ' is-expanded' : '');
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  const phaseCount = workstreams.reduce((n, l) => n + ((l.phases || []).length), 0);
  const activeCount = workstreams.filter(l => (l.phases || []).some(ph => ph.isCurrent)).length;
  const names = workstreams.map(l => l.name).slice(0, 4).join(', ');
  const summary = expanded
    ? `phase ${phaseCount} · 활성 ${activeCount}`
    : `${names}${workstreams.length > 4 ? ' 외' : ''} · phase ${phaseCount} · 활성 ${activeCount}`;
  el.title = expanded ? '클릭하면 워크스트림 접기' : '클릭하면 워크스트림 펼치기';
  el.innerHTML = `
    <div class="wg-body">
      <div class="wg-mark">${expanded ? '▴' : '▾'}</div>
      <div class="wg-main">
        <div class="wg-title">워크스트림 ${workstreams.length}개 ${expanded ? '접기' : '펼치기'}</div>
        <div class="wg-sub">${esc(summary)}</div>
      </div>
    </div>`;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const key = workstreamGroupKey(project);
    if (expanded) expandedLanes.delete(key);
    else expandedLanes.add(key);
    layout();
  });
  return el;
}

function projectExternalActivityVisible(project, renderedMainLanes) {
  const act = project && project.activity ? project.activity : null;
  return !!(act && !isSessionHidden(project, act.sessionId) && !renderedMainLanes.length && (act.current || act.awaiting || act.blocked));
}

function externalActivityNode(project, x, y) {
  const act = project.activity || {};
  const current = act.current || null;
  const latestSession = Array.isArray(act.sessions) && act.sessions.length ? act.sessions[0] : null;
  const paused = !!(act.awaiting || act.blocked);
  const stale = current && current.status === 'stale';
  const running = !!current && !paused;
  const tone = paused ? 'paused' : (stale ? 'stale' : (running ? 'running' : 'recent'));
  const isSubagent = running && current && current.kind !== 'shell';
  const title = paused ? (act.awaiting ? '외부 터미널 답변 필요' : '외부 터미널 멈춤') : (isSubagent ? '서브에이전트 실행 중' : '외부 터미널 세션');
  const sub = current ? (current.sub || current.kind || 'Claude') : (act.awaiting ? '답변 대기' : `도구 ${latestSession ? latestSession.toolCount || 0 : 0} · shell ${latestSession ? latestSession.shellCount || 0 : 0}`);
  const desc = (current && (current.desc || current.command)) || act.awaitingText || act.blockedText || (latestSession && latestSession.excerpt) || '다른 터미널에서 감지된 Claude 작업';
  const where = act.cwd || act.cwdHint || (latestSession && (latestSession.cwd || latestSession.cwdHint)) || project.path;
  const el = document.createElement('div');
  el.className = `node external-activity-node ${tone}`;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.title = `${where}\n${desc}`;
  el.innerHTML = `
    <div class="ea-body">
      <span class="ea-dot"></span>
      <div class="ea-main">
        <div class="ea-title">${esc(title)}</div>
        <div class="ea-sub">${esc(sub)} · 세션 ${esc(act.sessionId ? act.sessionId.slice(0, 8) : '?')}</div>
        <div class="ea-desc">${esc(truncate(desc, 88))}</div>
        <div class="ea-path">${esc(truncate(where, 74))}</div>
      </div>
    </div>`;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (act.awaiting) openAwaitingTask(project);
    else if (act.blocked) openBlockedTask(project);
    else openActivitySession(project);
  });
  return el;
}

function infoNode(p, x, y) {
  const el = document.createElement('div');
  el.className = 'node info';
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  const isErr = !p.isGsd;
  const color = isErr ? 'var(--destructive)' : 'var(--s-execute)';
  const label = isErr ? 'GSD 아님' : '미초기화';
  el.innerHTML = `
    <div class="node-top">
      <div class="node-icon" style="background:${color}">${isErr ? '✕' : '!'}</div>
      <div class="node-head-text">
        <div class="node-phase">${esc(p.name)}</div>
        <div class="node-title">${esc(p.error || label)}</div>
      </div>
    </div>
    <div class="node-foot"><span class="node-stage">${label}</span></div>`;
  return el;
}

// 레인 라벨 (프로젝트/워크스트림 + git + 진행도 + 실시간 서브에이전트)
function addLaneLabel(nodesEl, p, lane, laneY, xBase = LANE_LEFT, opts = {}) {
  const branch = opts.branch || selectedProjectBranch(p);
  const label = document.createElement('div');
  const laneKind = lane && lane.kind ? lane.kind : 'main';
  const sessionFramed = !!opts.sessionFramed;
  label.className = `lane-label lane-${laneKind}${sessionFramed ? ' session-framed' : ''}`;
  label.style.left = xBase + 'px';
  label.style.top = (laneY - 26) + 'px';
  let laneTag = '';
  if (lane && lane.kind === 'workstream') laneTag = `<span class="lane-ws">워크스트림 · ${esc(lane.name)}</span>`;
  if (lane && lane.kind === 'workstream-group') laneTag = `<span class="lane-ws-group">워크스트림 묶음 · ${esc(lane.name)}</span>`;
  let html = sessionFramed ? '' : (laneKind === 'main'
    ? '<span class="lane-name">마일스톤 phase</span>'
    : `<span class="lane-name">${esc(p.name)}</span>${laneTag}`);
  const st = lane ? lane.state : p.state;
  if (st && !sessionFramed) {
    const pr = st.progress || {};
    if (st.milestone) html += `<span class="lane-ms">${esc(st.milestone)}${st.milestoneName ? ' · ' + esc(truncate(st.milestoneName, 22)) : ''}</span>`;
    if (pr.totalPhases) {
      const pct = pr.percent != null ? pr.percent : Math.round((pr.completedPhases || 0) / pr.totalPhases * 100);
      html += `<span class="lane-pct muted">phase ${pr.completedPhases ?? 0}/${pr.totalPhases} · ${pct}%</span>`;
    }
  }
  // 세션 프레임이 레인 제목/상태/액션을 소유하면 바깥 보조 라벨을 렌더하지 않는다.
  if (sessionFramed && !html.trim()) return;
  // git 배지는 메인 레인에만
  if (!sessionFramed && (!lane || lane.kind === 'main')) html += gitBadge(p.git);
  // 실시간 서브에이전트 (활동 로그) — 외부 터미널 로그는 레인 정보가 없으므로 메인에만 표시.
  if (!sessionFramed && (!lane || lane.kind === 'main')) html += activityBadge(p.activity);
  // 작업 요청 버튼 (claude -p 로 직접 작업) — 메인/워크스트림 레인.
  // 작업/에이전트 진행 중이면 비활성화 (중복 실행 방지)
  const myTask = taskSession(p, lane, branch);
  const myTaskRunning = taskRunningForLane(p, lane, branch);
  const runningStoredTask = backgroundTaskForLane(p, lane, branch);
  const phaseRunning = lanePhaseRunning(p, lane, branch);
  const isMainLane = !lane || lane.kind === 'main';
  const externalCurrent = branch === projectBranchKey(p) && isMainLane && p.activity && p.activity.current;
  const busy = myTaskRunning || !!runningStoredTask || phaseRunning || externalCurrent;
  // 이 레인이 답변 대기(claude가 멈춰 사용자 답을 기다림) 상태인지
  const myAwaiting = taskAwaitingForLane(p, lane, branch);
  const hiddenSession = p.activity && isSessionHidden(p, p.activity.sessionId);
  const externalAwaiting = branch === projectBranchKey(p) && isMainLane && !hiddenSession && !myAwaiting && p.activity && p.activity.awaiting;
  const externalBlocked = branch === projectBranchKey(p) && isMainLane && !hiddenSession && !externalAwaiting && p.activity && p.activity.blocked;
  const pausedInfo = (externalAwaiting || externalBlocked || myAwaiting) ? pauseInfo(p) : null;
  const canRequestTask = !lane || lane.kind === 'main' || lane.kind === 'workstream';
  if (!sessionFramed && canRequestTask) html += taskActionButtonHtml(p, lane, '', branch);
  if (!html.trim()) return;
  label.innerHTML = html;
  const taskBtn = label.querySelector('.lane-task-btn');
  label.querySelectorAll('.plan-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPlanningTab(p, btn.dataset.planTab || 'current');
    });
  });
  if (taskBtn) wireTaskActionButton(taskBtn, p, lane, branch);
  nodesEl.appendChild(label);
}

function taskButtonState(p, lane, branch = selectedProjectBranch(p)) {
  const myTask = taskSession(p, lane, branch);
  const myTaskRunning = taskRunningForLane(p, lane, branch);
  const runningStoredTask = backgroundTaskForLane(p, lane, branch);
  const myTaskDraft = !!(myTask && myTask.draftOpen && !runningStoredTask && !myTask.running && !myTask.awaiting);
  const myTaskRestored = !!(myTask && myTask.restored && !runningStoredTask && !myTaskDraft && !myTask.running && !myTask.awaiting && myTask.sessionId && myTask.canResume);
  const phaseRunning = lanePhaseRunning(p, lane, branch);
  const isMainLane = !lane || lane.kind === 'main';
  const isCurrentBranchView = branch === projectBranchKey(p);
  const externalCurrent = isCurrentBranchView && isMainLane && p.activity && p.activity.current;
  const busy = myTaskDraft || myTaskRestored || myTaskRunning || !!runningStoredTask || phaseRunning || externalCurrent;
  const myAwaiting = taskAwaitingForLane(p, lane, branch);
  const hiddenSession = p.activity && isSessionHidden(p, p.activity.sessionId);
  const externalAwaiting = isCurrentBranchView && isMainLane && !hiddenSession && !myAwaiting && p.activity && p.activity.awaiting;
  const externalBlocked = isCurrentBranchView && isMainLane && !hiddenSession && !externalAwaiting && p.activity && p.activity.blocked;
  const pausedInfo = (externalAwaiting || externalBlocked || myAwaiting) ? pauseInfo(p) : null;
  let text = busy ? '진행 보기' : '작업 요청';
  let mode = busy ? 'busy' : 'request';
  let awaiting = false;
  if (myTaskDraft) { text = '세션 열기'; mode = 'draft'; }
  if (myTaskRestored) { text = '세션 열기'; mode = 'session'; }
  if (phaseRunning) { text = '에이전트 실행 중'; mode = 'phase'; }
  if (externalBlocked) { text = pausedInfo ? pausedInfo.label : '멈춤'; mode = 'blocked'; awaiting = true; }
  if (myAwaiting || externalAwaiting) { text = '답변 필요'; mode = myAwaiting ? 'my-awaiting' : 'awaiting'; awaiting = true; }
  return { text, mode, awaiting, myTask, myTaskDraft, myTaskRestored, myTaskRunning, runningStoredTask, phaseRunning, externalCurrent, externalBlocked, externalAwaiting, busy };
}

function taskActionButtonHtml(p, lane, extraClass = '', branch = selectedProjectBranch(p)) {
  const st = taskButtonState(p, lane, branch);
  const cls = `lane-task-btn${extraClass ? ' ' + extraClass : ''}${st.awaiting ? ' awaiting' : ''}`;
  return `<button class="${cls}" data-task-action="${esc(st.mode)}">${esc(st.text)}</button>`;
}

function wireTaskActionButton(taskBtn, p, lane, branch = selectedProjectBranch(p)) {
  const st = taskButtonState(p, lane, branch);
  if (st.myTask && (st.myTaskDraft || st.myTaskRestored)) {
    taskBtn.title = st.myTaskDraft
      ? '작성 중인 새 세션 — 클릭하면 작업 지시를 계속 씁니다'
      : '복원된 Claude 세션 — 클릭하면 출력 확인·이어서 실행';
    taskBtn.addEventListener('click', (e) => { e.stopPropagation(); showTaskSession(st.myTask); });
  } else if (st.myTask && taskAwaitingForLane(p, lane, branch)) {
    taskBtn.title = 'claude가 답을 기다리는 중 — 클릭하면 질문 확인·답변';
    taskBtn.addEventListener('click', (e) => { e.stopPropagation(); showTaskSession(st.myTask); });
  } else if (st.externalAwaiting) {
    taskBtn.title = '터미널의 claude가 답을 기다리는 중 — 클릭하면 답변 보내기';
    taskBtn.addEventListener('click', (e) => { e.stopPropagation(); openAwaitingTask(p); });
  } else if (st.externalBlocked) {
    taskBtn.title = '터미널의 claude가 제한/오류로 멈춘 상태 — 클릭하면 이어서 실행';
    taskBtn.addEventListener('click', (e) => { e.stopPropagation(); openBlockedTask(p); });
  } else if (!st.busy) {
    taskBtn.title = '이 세션 영역에서 새 Claude 작업을 시작합니다';
    taskBtn.addEventListener('click', (e) => { e.stopPropagation(); openTask(p, null, lane, { branch }); });
  } else if (st.runningStoredTask) {
    taskBtn.title = '진행 중 — 클릭하면 현황 보기';
    taskBtn.addEventListener('click', (e) => { e.stopPropagation(); openBackgroundTask(p, st.runningStoredTask); });
  } else if (st.phaseRunning) {
    taskBtn.title = p.activity && (p.activity.sessionId || p.activity.hasLog)
      ? '실행 단계 — 클릭하면 현재 세션/활동 보기'
      : '실행 단계 — 클릭하면 새 세션 없이 phase 실행 상태 보기';
    taskBtn.addEventListener('click', (e) => { e.stopPropagation(); openPhaseRunningTask(p, lane, branch); });
  } else if (st.myTaskRunning) {
    taskBtn.title = '진행 중 — 클릭하면 현황 보기';
    taskBtn.addEventListener('click', (e) => { e.stopPropagation(); showTaskSession(st.myTask); });
  } else if (p.activity && p.activity.current) {
    taskBtn.title = '에이전트 진행 중 — 클릭하면 세션 채팅창 열기';
    taskBtn.addEventListener('click', (e) => { e.stopPropagation(); openActivitySession(p, { phase: laneCurrentPhase(lane, p), lane }); });
  } else {
    taskBtn.disabled = true;
    taskBtn.title = '진행 중 — 완료 후 가능';
  }
}

function addPlanningPanel(nodesEl, project, x, y) {
  const planning = project && project.planning ? project.planning : null;
  const current = planning && Array.isArray(planning.current) ? planning.current : [];
  const history = planning && Array.isArray(planning.history) ? planning.history : [];
  const hasActivity = !!(project && project.activity && (project.activity.sessionId || project.activity.current || project.activity.awaiting || project.activity.blocked));
  if (!current.length && !history.length && !hasActivity) return null;
  const panel = document.createElement('div');
  panel.className = 'planning-panel';
  panel.style.left = x + 'px';
  panel.style.top = (y - 82) + 'px';
  panel.innerHTML = planningChips(project);
  panel.querySelectorAll('.plan-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPlanningTab(project, btn.dataset.planTab || 'current');
    });
  });
  panel.querySelectorAll('.plan-chip.agent').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const agent = historyAgentById(project, chip.dataset.agentId);
      if (agent) openAgentDetail(project, agent);
    });
  });
  panel.querySelectorAll('.plan-chip-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const agent = historyAgentById(project, btn.dataset.agentId);
      if (agent) hideAgentHistory(project, agent);
    });
  });
  const sessionTaskBtn = panel.querySelector('.session-task-btn');
  if (sessionTaskBtn) wireTaskActionButton(sessionTaskBtn, project, { kind: 'main', name: 'main', state: project.state, phases: project.phases });
  nodesEl.appendChild(panel);
  return panel;
}

function planningKindLabel(kind) {
  const map = { quick: 'quick', debug: 'debug', sketch: 'sketch', milestone: 'milestone', process: 'process' };
  return map[kind] || kind || 'planning';
}

function historyAgents(project) {
  const agents = project && project.activity && Array.isArray(project.activity.agents) ? project.activity.agents : [];
  return agents
    .filter(a => a && a.done && !isAgentHistoryHidden(project, a))
    .slice(-8)
    .reverse()
    .map(a => ({
      kind: 'agent',
      title: `${a.sub || 'agent'} · ${a.desc || '완료된 에이전트'}`,
      status: 'done',
      active: false,
      agentId: a.id,
      agent: a,
      mtimeMs: a.ts ? Date.parse(a.ts) : 0,
    }));
}

function backgroundHistoryItems(project) {
  const tasks = (project && project.backgroundTasks) || [];
  return tasks
    .filter(t => t && !isBgTaskRunning(t) && t.status === 'completed' && !isBackgroundTaskHidden(project, t))
    .map(t => {
      const rawPrompt = String(t.prompt || '');
      const userPart = rawPrompt.split('[사용자 지시]').pop() || rawPrompt;
      const isQuick = /\/wcc[:-]quick/i.test(rawPrompt) || /WCC\s*▸\s*QUICK|Quick Task/i.test(t.output || '');
      return {
        kind: isQuick ? 'quick' : 'process',
        title: truncate((userPart || rawPrompt || '완료된 작업').trim().replace(/\s+/g, ' '), 80),
        status: backgroundStatusText(t),
        active: false,
        backgroundTaskId: t.id,
        sessionId: t.sessionId || null,
        task: t,
        mtimeMs: t.updatedAt ? Date.parse(t.updatedAt) : 0,
      };
    });
}

function historyBackgroundTaskById(project, id) {
  return backgroundHistoryItems(project).map(x => x.task).find(t => t && t.id === id) || null;
}

function historySessionById(project, id) {
  return externalSessionHistoryItems(project).map(x => x.session).find(s => s && s.sessionId === id) || null;
}

function activitySessionSnapshot(project) {
  const act = project && project.activity ? project.activity : {};
  const current = act.current || act.recentAgent || {};
  const sessionId = current.sessionId || act.sessionId || null;
  if (!sessionId) return null;
  return {
    sessionId,
    running: !!act.current,
    awaiting: !!act.awaiting,
    blocked: !!act.blocked,
    workflowKind: current.workflowKind || 'session',
    firstUser: act.firstUser || current.desc || act.lastExcerpt || '',
    excerpt: act.lastExcerpt || act.awaitingText || act.blockedText || current.desc || current.sub || '실행 중인 Claude 세션입니다.',
    ageSec: act.ageSec || current.ageSec || 0,
    toolCount: act.toolCount || 0,
    shellCount: act.shellCount || 0,
    agentCount: act.agentCount || 0,
    lastTs: current.ts || act.lastTs || new Date().toISOString(),
  };
}

function openActivitySession(project, scope = null) {
  const session = activitySessionSnapshot(project);
  if (session) {
    const mode = (session.running || session.awaiting) ? 'live-session' : 'history';
    if (openTaskWindowPayload(taskWindowPayload(mode, project, { session, scope }))) return;
    openHistorySessionTask(project, session);
    return;
  }
  openActivity(project, scope);
}

function phaseRunningText(project, lane) {
  const ph = laneCurrentPhase(lane, project);
  const scope = laneLabel(lane);
  const lines = [
    `현재 ${scope}의 phase가 실행 중입니다.`,
    ph ? `Phase ${ph.num} — ${ph.title || ph.stageLabel || '실행 중'}` : '실행 중인 phase 정보를 확인하는 중입니다.',
    '이 화면은 새 세션 작성 화면이 아니라 현재 실행 상태 확인 화면입니다.',
  ];
  const act = project && project.activity;
  if (act && act.current) lines.push(`감지된 활동: ${(act.current.desc || act.current.sub || 'Claude 실행 중')}`);
  return lines.join('\n\n');
}

function openPhaseRunningTask(project, lane, branch = selectedProjectBranch(project)) {
  if (project && project.activity && (project.activity.sessionId || project.activity.current || project.activity.hasLog)) {
    openActivitySession(project, { phase: laneCurrentPhase(lane, project), lane });
    return;
  }
  const phase = laneCurrentPhase(lane, project);
  if (openTaskWindowPayload(taskWindowPayload('phase-running', project, { lane, branch, phase }))) return;
  renderSessionMini(project);
  taskCtx = {
    project,
    branch,
    lane,
    discuss: null,
    running: true,
    awaiting: false,
    external: true,
    canResume: false,
    statusText: '에이전트 실행 중',
    output: phaseRunningText(project, lane),
  };
  setTaskNote('현재 phase가 이미 실행 중입니다. 새 세션을 만들지 않고 실행 상태만 표시합니다.');
  $('#taskTitle').textContent = `에이전트 실행 중 · ${project.name}`;
  $('#taskSub').textContent = `${laneLabel(lane)}${phase ? ` · Phase ${phase.num} — ${phase.title || phase.stageLabel || ''}` : ''}`;
  $('#taskQuestions').style.display = 'none';
  $('#taskQuestions').innerHTML = '';
  setTaskPromptVisible(false);
  $('#taskRun').classList.remove('hidden');
  $('#taskStatus').textContent = '실행 중인 phase입니다. 새 세션이 아닙니다.';
  setMarkdownOutput('#taskOut', taskCtx.output);
  setTaskTokenUsage(null);
  $('#taskReplyRow').classList.add('hidden');
  $('#taskRunBtn').classList.add('hidden');
  $('#taskRunBtn').disabled = true;
  setTaskStopVisible(false);
  setTaskInputsLocked(true);
  renderTaskPromptHistory(project);
  $('#taskDrawer').classList.remove('hidden');
}

function currentSessionCard(project) {
  const lane = { kind: 'main', name: 'main', state: project.state, phases: project.phases };
  const act = project && project.activity ? project.activity : null;
  const task = taskSession(project, lane);
  const bg = backgroundTaskForLane(project, lane);
  const planning = project && project.planning ? project.planning : null;
  const current = planning && Array.isArray(planning.current) ? planning.current : [];
  let state = '새 세션';
  let title = 'Claude 세션 없음';
  let desc = current.length
    ? current.map(it => `${planningKindLabel(it.kind)} ${it.title || it.name || ''}`.trim()).join(' · ')
    : '작업 요청을 누르면 이 프로젝트 안에 새 세션이 생깁니다';
  let tone = 'ready';
  let sid = '';

  if (task) {
    state = task.awaiting ? '답변 필요' : (task.running ? '실행 중' : '작성 중');
    title = task.sessionId ? `Claude 세션 ${task.sessionId.slice(0, 8)}` : 'Lodestar 작업 세션';
    desc = task.statusText || task.lastPrompt || desc;
    sid = task.sessionId || '';
    tone = task.awaiting ? 'awaiting' : (task.running ? 'running' : 'ready');
  } else if (bg) {
    state = isBgTaskRunning(bg) ? '실행 중' : backgroundStatusText(bg).replace(/^[^\s]+\s*/, '');
    title = bg.sessionId ? `Claude 세션 ${bg.sessionId.slice(0, 8)}` : '저장된 작업 세션';
    desc = bg.prompt || bg.output || desc;
    sid = bg.sessionId || '';
    tone = isBgTaskRunning(bg) ? 'running' : 'ready';
  } else if (act && (act.sessionId || act.current || act.awaiting || act.blocked)) {
    const stale = act.current && act.current.status === 'stale';
    state = act.awaiting ? '답변 필요' : (act.blocked ? '멈춤' : (stale ? '확인 필요' : (act.current ? '실시간 대화 중' : '최근 세션')));
    title = act.sessionId ? `Claude 세션 ${act.sessionId.slice(0, 8)}` : '외부 Claude 세션';
    desc = (act.current && act.current.desc) || act.awaitingText || act.blockedText || act.lastExcerpt || desc;
    sid = act.sessionId || '';
    tone = act.awaiting || act.blocked || stale ? 'awaiting' : (act.current ? 'running' : 'ready');
  }

  const chips = current.slice(0, 3).map(it => `<span>${esc(planningKindLabel(it.kind))}</span>`).join('');
  return `<div class="project-session-card ${tone}" title="${esc(desc)}">
    <div class="psc-main">
      <div class="psc-top"><b>${esc(state)}</b>${sid ? `<small>${esc(sid.slice(0, 8))}</small>` : ''}</div>
      <div class="psc-title">${esc(title)}</div>
      <div class="psc-desc">${esc(truncate(desc, 92))}</div>
      ${chips ? `<div class="psc-chips">${chips}</div>` : ''}
    </div>
    ${taskActionButtonHtml(project, lane, 'session-task-btn')}
  </div>`;
}

function historyAgentById(project, id) {
  return historyAgents(project).map(x => x.agent).find(a => a && a.id === id) || null;
}

function planningChips(project) {
  const planning = project && project.planning ? project.planning : null;
  const current = planning && Array.isArray(planning.current) ? planning.current : [];
  const history = projectHistoryItems(project);
  if (!current.length && !history.length) return '';
  const tab = planningTab(project);
  const items = tab === 'history' ? history.slice(0, 14) : current.slice(0, 5);
  const tabs = `<div class="planning-panel-head">
    <span class="plan-tabs" title="플래닝 표시 전환">
    <button class="plan-tab-btn ${tab === 'current' ? 'active' : ''}" data-plan-tab="current">현재 ${current.length || ''}</button>
    <button class="plan-tab-btn ${tab === 'history' ? 'active' : ''}" data-plan-tab="history">히스토리 ${history.length || ''}</button>
    </span>
  </div>`;
  if (tab === 'current') return tabs + `<div class="planning-panel-items session-items">${currentSessionCard(project)}</div>`;
  const chips = items.length ? items.map(it => {
    const kind = planningKindLabel(it.kind);
    const title = truncate(it.title || it.name || '', it.kind === 'milestone' ? 24 : 42);
    const active = it.active ? ' active' : '';
    const status = it.status ? ` · ${it.status}` : '';
    const tip = `${kind}${status}${it.path ? `\n${it.path}` : ''}`;
    const agentData = it.kind === 'agent' ? ` data-agent-id="${esc(it.agentId || '')}"` : '';
    const del = tab === 'history' && it.kind === 'agent'
      ? `<button class="plan-chip-delete" data-agent-id="${esc(it.agentId || '')}" title="히스토리에서 숨김">×</button>`
      : '';
    return `<span class="plan-chip ${esc(it.kind || 'planning')}${active}"${agentData} title="${esc(tip)}">${title ? `<span>${esc(title)}</span>` : `<span>${esc(kind)}</span>`}${del}</span>`;
  }).join('') : `<span class="plan-empty">${tab === 'history' ? '히스토리 없음' : '현재 없음'}</span>`;
  return tabs + `<div class="planning-panel-items history-items">${chips}</div>`;
}

// phase 없는 레인(완료된 메인 등) 안내 노드
function emptyLaneNode(lane, x, y) {
  const el = document.createElement('div');
  el.className = 'node info';
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  const st = lane.state || {};
  const done = st.progress && st.progress.percent === 100;
  const color = done ? 'var(--s-verify)' : 'var(--s-pending)';
  el.innerHTML = `
    <div class="node-top">
      <div class="node-icon" style="background:${color}">${done ? '✓' : '·'}</div>
      <div class="node-head-text">
        <div class="node-phase">${esc(lane.name)}${st.milestone ? ' · ' + esc(st.milestone) : ''}</div>
        <div class="node-title">${esc(truncate(st.status || '활성 phase 없음', 60))}</div>
      </div>
    </div>
    <div class="node-foot"><span class="node-stage muted">phase 디렉토리 없음</span></div>`;
  return el;
}

// 실시간 서브에이전트 배지 (활동 로그 기반)
function activityBadge(act) {
  if (!act || !act.hasLog) return '';
  if (act.awaiting || act.blocked) return '';
  if (act.current) {
    const label = act.current.kind === 'shell' ? 'shell 실행중' : `${act.current.sub} 실행중`;
    return `<span class="act-badge running" title="${esc(act.current.desc)}">▶ ${esc(label)}</span>`;
  }
  if (act.live) {
    const last = act.recentTools && act.recentTools.length ? act.recentTools[act.recentTools.length - 1] : null;
    const lastTxt = last ? ` · ${esc(last.name)}${last.hint ? ' ' + esc(truncate(last.hint, 22)) : ''}` : '';
    return `<span class="act-badge live" title="최근 도구 활동">⚡ 세션 활성${lastTxt}</span>`;
  }
  return `<span class="act-badge idle">유휴 · ${relTime(act.ageSec)} 전</span>`;
}

function isBgTaskRunning(task) {
  return task && (task.status === 'queued' || task.status === 'running');
}

function backgroundTaskById(project, id) {
  const tasks = (project && project.backgroundTasks) || [];
  return id ? tasks.find(t => t && t.id === id) || null : null;
}

function comparablePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function activityMatchesBackgroundTask(project) {
  const act = project && project.activity ? project.activity : null;
  if (!act) return false;
  const tasks = (project.backgroundTasks || []).filter(Boolean);
  if (!tasks.length) return false;
  const bgSessionIds = new Set(tasks.map(t => t.sessionId).filter(Boolean));
  if (act.sessionId && bgSessionIds.has(act.sessionId)) return true;
  const activityPaths = [act.cwd, act.cwdHint]
    .concat((act.sessions || []).flatMap(s => [s && s.cwd, s && s.cwdHint]))
    .map(comparablePath)
    .filter(Boolean);
  if (!activityPaths.length) return false;
  return tasks.some(t => {
    if (!isBgTaskRunning(t)) return false;
    const taskPath = comparablePath(t.projectPath);
    return taskPath && activityPaths.some(p => p === taskPath || p.startsWith(taskPath + '/'));
  });
}

function normalizeProjectActivity(project) {
  if (!activityMatchesBackgroundTask(project)) return project;
  const taskSessionIds = new Set((project.backgroundTasks || []).map(t => t && t.sessionId).filter(Boolean));
  const activity = { ...(project.activity || {}) };
  activity.sessions = (activity.sessions || []).filter(s => !(s && s.sessionId && taskSessionIds.has(s.sessionId)));
  activity.current = null;
  activity.recentAgent = null;
  activity.awaiting = false;
  activity.awaitingText = '';
  activity.awaitingQuestion = null;
  activity.awaitingQuestions = [];
  activity.blocked = false;
  activity.blockedText = '';
  activity.live = false;
  activity.hasLog = activity.sessions.length > 0;
  activity.internalLodestarTask = true;
  return { ...project, activity };
}

function taskSessionRunning(ctx) {
  if (!ctx) return false;
  if (!ctx.backgroundTaskId || ctx.awaiting) return false;
  const bg = backgroundTaskById(ctx.project, ctx.backgroundTaskId);
  return bg ? isBgTaskRunning(bg) : false;
}

function latestBackgroundTask(project) {
  const tasks = (project && project.backgroundTasks) || [];
  if (!tasks.length) return null;
  return tasks.find(isBgTaskRunning) || tasks[0];
}

function backgroundTaskForLane(project, lane, branch = projectBranchKey(project)) {
  const tasks = (project && project.backgroundTasks) || [];
  const laneName = lane && lane.kind === 'workstream' ? lane.name : null;
  return tasks.find(t => {
    if (!isBgTaskRunning(t)) return false;
    if (t.branch && branch && t.branch !== branch) return false;
    const taskLane = t.workstream && t.workstream.name ? t.workstream.name : null;
    return laneName ? taskLane === laneName : !taskLane;
  }) || null;
}

function laneHasBranchSession(project, lane, branch = selectedProjectBranch(project)) {
  return taskSessionVisible(taskSession(project, lane, branch)) || isBgTaskRunning(backgroundTaskForLane(project, lane, branch));
}

function workstreamHasActiveSession(project, lane, branch = selectedProjectBranch(project)) {
  if (!lane || lane.kind !== 'workstream') return false;
  return laneHasBranchSession(project, lane, branch);
}

function relTime(sec) {
  if (sec == null) return '?';
  if (sec < 60) return sec + '초';
  if (sec < 3600) return Math.round(sec / 60) + '분';
  if (sec < 86400) return Math.round(sec / 3600) + '시간';
  return Math.round(sec / 86400) + '일';
}

function looksLikeUsageLimitText(text) {
  return /(session limit|usage limit|rate limit|quota|resets\s+\d|too many requests|hit your .*limit|사용량\s*한도|요청\s*한도|한도\s*초과|제한에\s*도달)/i.test(String(text || ''));
}

// ---------- 팬 / 줌 ----------
let worldEl = null, zoomLevelEl = null;
let rafPending = false;
let interactTimer = null;

function applyTransform() {
  if (!worldEl) { worldEl = $('#world'); zoomLevelEl = $('#zoomLevel'); }
  const scale = Math.abs(view.scale - 1) < 0.015 ? 1 : Number(view.scale.toFixed(3));
  worldEl.style.transform = `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px) scale(${scale})`;
  if (zoomLevelEl) zoomLevelEl.textContent = Math.round(view.scale * 100) + '%';
}
// rAF로 프레임당 1회만 transform 적용 (mousemove/wheel 폭주 방지)
function scheduleTransform() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; applyTransform(); });
}
// 상호작용 중에는 노드/엣지 애니메이션을 멈춰 페인트 부담 제거
let interacting = false;
let pendingRefresh = false;
function beginInteract() {
  lastInteractionAt = Date.now();
  interacting = true;
  document.body.classList.add('interacting');
}
function endInteractSoon() {
  lastInteractionAt = Date.now();
  if (interactTimer) clearTimeout(interactTimer);
  interactTimer = setTimeout(() => {
    interacting = false;
    document.body.classList.remove('interacting');
    // 드래그 중 보류했던 자동 갱신을 한 번 처리
    if (pendingRefresh) { pendingRefresh = false; scheduleAutoRefresh(); }
  }, POST_INTERACTION_REFRESH_MS);
}

function setupPanZoom() {
  const vp = $('#viewport');
  let panning = false, sx = 0, sy = 0, ox = 0, oy = 0;
  vp.addEventListener('mousedown', (e) => {
    const frame = e.target.closest('.lane-session-frame');
    const blocksFramePan = frame && (!frame.classList.contains('workstream-container') || e.target.closest('.lsf-head'));
    if (e.target.closest('.node') || e.target.closest('.agent-node') || blocksFramePan || e.target.closest('.project-layer-head')) return;
    panning = true; sx = e.clientX; sy = e.clientY; ox = view.x; oy = view.y;
    vp.classList.add('panning'); beginInteract();
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    view.x = ox + (e.clientX - sx); view.y = oy + (e.clientY - sy);
    scheduleTransform();
  });
  window.addEventListener('mouseup', () => {
    if (!panning) return;
    panning = false; vp.classList.remove('panning'); endInteractSoon();
  });
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = vp.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const ns = Math.min(2.5, Math.max(0.25, view.scale * factor));
    view.x = mx - (mx - view.x) * (ns / view.scale);
    view.y = my - (my - view.y) * (ns / view.scale);
    view.scale = ns;
    beginInteract(); scheduleTransform(); endInteractSoon();
  }, { passive: false });
}
function zoomBy(f) {
  const vp = $('#viewport').getBoundingClientRect();
  const cx = vp.width / 2, cy = vp.height / 2;
  const ns = Math.min(2.5, Math.max(0.25, view.scale * f));
  view.x = cx - (cx - view.x) * (ns / view.scale);
  view.y = cy - (cy - view.y) * (ns / view.scale);
  view.scale = ns; applyTransform();
}
function zoomFit() {
  // 현재 진행 phase로 포커스(없으면 기본 위치). focusNext=true면 layout이 현재로 중앙 정렬.
  view.x = 40; view.y = 40; view.scale = 1; focusNext = true; layout();
}

// ---------- 의견 주입 드로어 ----------
let drawerCtx = null;

function openDrawer(project, ph) {
  drawerCtx = { project, phase: ph };
  $('#drawerTitle').textContent = `의견 주입 · ${project.name}`;
  $('#drawerSub').textContent = `Phase ${ph.num} — ${ph.title} (${ph.stageLabel})`;
  $('#injQuestion').value = '';
  $('#injAnswer').value = '';
  $('#confirmPanel').classList.add('hidden');
  $('#runPanel').classList.add('hidden');
  setMarkdownOutput('#runOut', '');
  $('#btnConfirmRun').classList.add('hidden');
  $('#btnPreview').classList.remove('hidden');
  $('#btnPreview').disabled = false;

  // 논의 질문 칩
  const box = $('#drawerQuestions');
  box.innerHTML = '';
  const d = ph.discuss || {};
  if (d.needsDiscuss) {
    box.innerHTML = `<div class="dq-note">아직 논의(CONTEXT.md) 없음 — 의견을 미리 남길 수 있습니다.</div>`;
  }
  if (d.grayNote) {
    const n = document.createElement('div'); n.className = 'dq-note';
    n.textContent = truncate(d.grayNote, 200); box.appendChild(n);
  }
  const items = [];
  for (const q of (d.questions || []).slice(0, 8)) items.push({ text: q.text, unanswered: !q.answered });
  for (const sec of (d.sections || [])) for (const it of sec.items.slice(0, 6)) items.push({ text: it, unanswered: false });
  for (const it of items) {
    const dq = document.createElement('div');
    dq.className = 'dq' + (it.unanswered ? ' unanswered' : '');
    dq.textContent = truncate(it.text, 180);
    dq.addEventListener('click', () => { $('#injQuestion').value = it.text; $('#injAnswer').focus(); });
    box.appendChild(dq);
  }
  $('#drawer').classList.remove('hidden');
}
function closeDrawer() { $('#drawer').classList.add('hidden'); drawerCtx = null; }

// ---------- 활동 피드 (서브에이전트 진행) ----------
let activityCtx = null;

function activityScopeLabel(scope) {
  if (!scope || !scope.phase) return '프로젝트 전체';
  const lane = scope.lane && scope.lane.kind === 'workstream' ? `워크스트림 ${scope.lane.name} · ` : '';
  return `${lane}Phase ${scope.phase.num} — ${scope.phase.title}`;
}

function activityScopeTerms(scope) {
  if (!scope || !scope.phase) return [];
  const ph = scope.phase;
  const terms = [
    `phase ${ph.num}`,
    `phase ${String(ph.num).padStart(2, '0')}`,
    `${String(ph.num).padStart(2, '0')}-`,
    `${ph.num}-`,
    ph.dirName || '',
    ph.title || '',
  ];
  if (scope.lane && scope.lane.kind === 'workstream') {
    terms.push(scope.lane.name, `.planning/workstreams/${scope.lane.name}`);
  }
  return terms.map(t => String(t || '').trim().toLowerCase()).filter(Boolean);
}

function scopedActivityItems(items, scope) {
  if (!scope || !scope.phase) return items || [];
  const terms = activityScopeTerms(scope);
  return (items || []).filter(item => {
    const hay = [
      item.sub || '',
      item.desc || '',
      item.command || '',
      item.id || '',
    ].join(' ').toLowerCase();
    return terms.some(t => hay.includes(t));
  });
}

function openActivity(project, scope = null) {
  activityCtx = { path: project.path, scope };
  const act = project.activity || {};
  const scoped = !!(scope && scope.phase);
  $('#actTitle').textContent = `${scoped ? '노드 활동' : '활동 피드'} · ${project.name}`;
  let liveTxt = act.live ? '⚡ 세션 활성' : `유휴 (${relTime(act.ageSec)} 전)`;
  if (act.current) liveTxt = act.current.kind === 'shell' ? '▶ shell 실행 중' : `▶ ${act.current.sub} 실행 중`;
  if (act.blocked) liveTxt = '⏸ 멈춤';
  if (act.awaiting) liveTxt = '⏸ 답변 필요';
  $('#actSub').textContent = `${activityScopeLabel(scope)} · ${liveTxt} · 세션 ${act.sessionId ? act.sessionId.slice(0, 8) : '?'} · 서브에이전트 ${act.agentCount || 0}회 · shell ${act.shellCount || 0}회`;

  const body = $('#actBody');
  body.innerHTML = '';
  if (!act.hasLog) {
    body.innerHTML = '<div class="muted">Claude 세션 로그가 없습니다.</div>';
    $('#actDrawer').classList.remove('hidden');
    return;
  }
  if (act.awaiting) {
    const pause = document.createElement('div');
    pause.className = 'await-box';
    pause.innerHTML = `<div class="await-title">답변 대기 중</div><div class="await-text">${esc(act.awaitingText || 'Claude가 사용자 답변을 기다리고 있습니다.')}</div><button class="btn btn-primary await-reply-btn">답변 보내기</button>`;
    body.appendChild(pause);
    pause.querySelector('.await-reply-btn').addEventListener('click', () => openAwaitingTask(project));
  } else if (act.blocked) {
    const pause = document.createElement('div');
    pause.className = 'await-box';
    pause.innerHTML = `<div class="await-title">Claude 실행이 멈췄습니다</div><div class="await-text">${esc(act.blockedText || 'Claude가 제한 또는 오류로 중단되었습니다.')}</div><button class="btn btn-primary await-reply-btn">이어서 실행</button>`;
    body.appendChild(pause);
    pause.querySelector('.await-reply-btn').addEventListener('click', () => openBlockedTask(project));
  }

  // 서브에이전트 타임라인
  const tl = document.createElement('div');
  tl.className = 'timeline';
  tl.innerHTML = '<div class="tl-head">서브에이전트 타임라인</div>';
  const agents = scopedActivityItems(act.agents || [], scope);
  if (!agents.length) tl.innerHTML += `<div class="muted">${scoped ? '이 노드와 직접 연결된 서브에이전트 기록이 없습니다.' : '아직 spawn된 서브에이전트가 없습니다.'}</div>`;
  for (let ai = 0; ai < agents.length; ai++) {
    const a = agents[ai];
    const running = !a.done;
    tl.innerHTML += `
      <div class="tl-item clickable ${running ? 'running' : 'done'}" data-ai="${ai}" title="클릭하면 이 에이전트의 실행 내용 보기">
        <span class="tl-dot"></span>
        <div class="tl-body">
          <div class="tl-row"><span class="tl-sub">${esc(a.sub)}</span>
            <span class="tl-time">${(a.ts || '').slice(11, 19)}</span></div>
          <div class="tl-desc">${esc(truncate(a.desc, 80))}</div>
          ${running ? '<div class="tl-status">▶ 실행 중…</div>' : '<div class="tl-status done">✓ 완료</div>'}
        </div>
      </div>`;
  }
  body.appendChild(tl);
  tl.querySelectorAll('.tl-item.clickable').forEach(el => {
    el.addEventListener('click', () => {
      const agent = agents[+el.dataset.ai];
      if (agent) openAgentDetail(project, agent);
    });
  });

  const shells = scopedActivityItems(act.shells || [], scope);
  if (shells.length) {
    const sl = document.createElement('div');
    sl.className = 'timeline';
    sl.innerHTML = '<div class="tl-head">Shell 타임라인</div>';
    for (const s of shells) {
      const running = !s.done;
      sl.innerHTML += `
        <div class="tl-item ${running ? 'running' : 'done'}">
          <span class="tl-dot"></span>
          <div class="tl-body">
            <div class="tl-row"><span class="tl-sub">Bash</span>
              <span class="tl-time">${(s.ts || '').slice(11, 19)}</span></div>
            <div class="tl-desc">${esc(truncate(s.desc || s.command || 'Bash 실행', 90))}</div>
            ${running ? '<div class="tl-status">▶ shell 실행 중…</div>' : '<div class="tl-status done">✓ 완료</div>'}
          </div>
        </div>`;
    }
    body.appendChild(sl);
  } else if (scoped) {
    const sl = document.createElement('div');
    sl.className = 'timeline';
    sl.innerHTML = '<div class="tl-head">Shell 타임라인</div><div class="muted">이 노드와 직접 연결된 shell 기록이 없습니다.</div>';
    body.appendChild(sl);
  }

  $('#actDrawer').classList.remove('hidden');
}
function closeActivity() { $('#actDrawer').classList.add('hidden'); activityCtx = null; }

// ---------- 서브에이전트 상세 (실행 내용) ----------
// 에이전트 노드/타임라인 항목 클릭 → 그 에이전트의 지시·도구 호출·출력을 보여준다.
async function openAgentDetail(project, agent) {
  const sid = agent.sessionId || (project.activity && project.activity.sessionId);
  $('#agTitle').textContent = `🤖 ${agent.sub || '서브에이전트'}`;
  $('#agSub').textContent = `${project.name}${sid ? ' · ' + sid.slice(0, 8) : ''}${agent.desc ? ' · ' + truncate(agent.desc, 60) : ''}`;
  $('#agBody').innerHTML = '<div class="muted">실행 내용 불러오는 중…</div>';
  $('#agDrawer').classList.remove('hidden');

  const r = await window.lodestar.agentDetail({ projectPath: project.path, sessionId: sid, toolUseId: agent.id });
  if (!r || !r.ok) {
    const fallbackPrompt = agent.desc || agent.sub || '에이전트 지시를 아직 로그에서 찾지 못했습니다.';
    const fallbackOut = agent.inferred
      ? '텍스트 상태 출력에서 추정한 에이전트입니다. 별도 subagents 로그가 없어서 현재 보이는 지시만 표시합니다.'
      : `아직 결과물 로그가 기록되지 않았습니다${r && r.error ? ` (${esc(r.error)})` : ''}.`;
    $('#agBody').innerHTML = [
      '<div class="ag-meta">상세 로그 대기 중</div>',
      `<div class="tl-head">📋 에이전트 지시</div><pre class="ag-pre ag-prompt">${esc(fallbackPrompt)}</pre>`,
      `<div class="tl-head">💬 현재까지 출력</div><div class="ag-pre md-output">${renderMarkdown(fallbackOut)}</div>`,
    ].join('');
    return;
  }
  let h = `<div class="ag-meta">유형 <b>${esc(r.agentType)}</b>${r.firstTs ? ' · 시작 ' + (r.firstTs).slice(11, 19) : ''}</div>`;
  if (r.prompt) h += `<div class="tl-head">📋 에이전트 지시</div><pre class="ag-pre ag-prompt">${esc(r.prompt)}</pre>`;
  if (r.output) h += `<div class="tl-head">💬 현재까지 출력</div><div class="ag-pre md-output">${renderMarkdown(r.output)}</div>`;
  $('#agBody').innerHTML = h;
}
function closeAgentDetail() { $('#agDrawer').classList.add('hidden'); }

// ---------- 작업 요청 (claude -p 로 직접 작업) ----------
let taskCtx = null;          // 현재 드로어에 표시 중인 작업 세션
let taskRunning = false;     // 하나 이상의 Lodestar 작업 실행 중 (하위 호환 표시용)
const taskSessions = new Map(); // project path + lane 별 독립 세션
let claudeSkills = [];
let claudeCommands = [];
let commandActiveIndex = 0;
let bgTaskPoll = null;
let taskDraftPersistTimer = null;
let skillSuggestRaf = 0;

function taskLaneId(lane) {
  if (!lane || !lane.kind || lane.kind === 'main') return 'main';
  if (lane.kind === 'workstream') return `workstream:${lane.name || ''}`;
  return `${lane.kind}:${lane.name || ''}`;
}

function taskKey(project, lane) {
  return taskKeyForBranch(project, lane, projectBranchKey(project));
}

function taskNodeKey(project, lane, branch = null) {
  return taskKeyForBranch(project, lane, branch || projectBranchKey(project));
}

function taskSessionSortTime(ctx) {
  const values = [ctx && ctx.savedAt, ctx && ctx.createdAt, ctx && ctx.startedAt, ctx && ctx.updatedAt]
    .map(v => v ? Date.parse(v) : 0)
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

function laneForTaskId(project, laneId) {
  const id = String(laneId || 'main');
  const lanes = (project && project.lanes && project.lanes.length)
    ? project.lanes
    : [{ kind: 'main', name: 'main', state: project && project.state, phases: project && project.phases }];
  if (id.startsWith('workstream:')) {
    const name = id.slice('workstream:'.length);
    return lanes.find(l => l.kind === 'workstream' && l.name === name) || null;
  }
  if (id === 'main') return lanes.find(l => !l.kind || l.kind === 'main') || { kind: 'main', name: 'main', state: project.state, phases: project.phases };
  const [kind, ...rest] = id.split(':');
  const name = rest.join(':');
  return lanes.find(l => l.kind === kind && l.name === name) || null;
}

function taskSession(project, lane, branch = null) {
  const nodeKey = taskNodeKey(project, lane, branch || projectBranchKey(project));
  const exact = taskSessions.get(nodeKey);
  if (exact && taskSessionVisible(exact)) return exact;
  const candidates = [...taskSessions.values()]
    .filter(ctx => ctx && ctx.project && ctx.project.path === project.path)
    .filter(ctx => (ctx.nodeKey || ctx.key) === nodeKey)
    .filter(taskSessionVisible)
    .sort((a, b) => taskSessionSortTime(b) - taskSessionSortTime(a));
  return candidates[0] || exact || null;
}

function readPersistedTaskSessions() {
  try { return JSON.parse(localStorage.getItem(TASK_SESSIONS_KEY) || '{}'); } catch { return {}; }
}

function writePersistedTaskSessions(all) {
  localStorage.setItem(TASK_SESSIONS_KEY, JSON.stringify(all));
}

function serializeTaskSession(ctx) {
  const laneId = taskLaneId(ctx.lane);
  const canResume = !!(ctx.sessionId || ctx.canResume);
  const excerpt = String(ctx.excerpt || ctx.output || ctx.statusText || ctx.lastPrompt || '').trim().slice(-1800);
  const statusText = taskSessionRunning(ctx)
    ? '백그라운드에서 계속 진행 중입니다'
    : (ctx.statusText || '');
  return {
    key: ctx.key || taskKeyForBranch(ctx.project, ctx.lane, ctx.branch || projectBranchKey(ctx.project)),
    nodeKey: ctx.nodeKey || taskNodeKey(ctx.project, ctx.lane, ctx.branch || projectBranchKey(ctx.project)),
    projectPath: ctx.project.path,
    executionPath: ctx.executionPath || ctx.project.path,
    baseProjectPath: ctx.baseProjectPath || ctx.project.path,
    usingWorktree: !!ctx.usingWorktree,
    branch: ctx.branch || projectBranchKey(ctx.project),
    laneId,
    laneKind: ctx.lane && ctx.lane.kind ? ctx.lane.kind : 'main',
    laneName: ctx.lane && ctx.lane.name ? ctx.lane.name : 'main',
    discuss: ctx.discuss || null,
    sessionId: ctx.sessionId || null,
    backgroundTaskId: ctx.backgroundTaskId || null,
    tokenUsage: ctx.tokenUsage || null,
    draftOpen: !!ctx.draftOpen,
    draft: ctx.draft || '',
    excerpt,
    statusText,
    lastPrompt: ctx.lastPrompt || '',
    awaiting: !!ctx.awaiting,
    asked: !!ctx.asked,
    canResume,
    savedAt: new Date().toISOString(),
  };
}

function persistTaskSessions() {
  const previous = readPersistedTaskSessions();
  const all = {};
  for (const [key, raw] of Object.entries(previous || {})) {
    if (!raw) continue;
    const historical = !raw.draftOpen && !raw.running && !raw.awaiting && (raw.sessionId || raw.backgroundTaskId);
    if (historical) all[key] = raw;
  }
  for (const [key, ctx] of taskSessions.entries()) {
    if (!ctx || !ctx.project || ctx.external) continue;
    const hasState = ctx.draftOpen || ctx.sessionId || ctx.backgroundTaskId || ctx.lastPrompt || ctx.awaiting || ctx.running || ctx.canResume;
    if (hasState) all[key] = serializeTaskSession(ctx);
  }
  writePersistedTaskSessions(all);
}

function restoreTaskSessionsForProjects(projectList) {
  const saved = readPersistedTaskSessions();
  const next = new Map();
  const byPath = new Map((projectList || []).map(p => [p.path, p]));
  const restoreOne = (src, keyHint, existing) => {
    if (!src) return;
    const projectPath = src.projectPath || (src.project && src.project.path);
    const project = byPath.get(projectPath);
    if (!project) return;
    const branchFromKey = keyHint && (String(keyHint).match(/\|branch:([^:]+)::/) || [])[1];
    const branch = src.branch || branchFromKey || projectBranchKey(project);
    const restoredLane = laneForTaskId(project, src.laneId || taskLaneId(src.lane)) || projectMainLane(project);
    const nodeKey = src.nodeKey || taskNodeKey(project, restoredLane, branch);
    const key = src.key || nodeKey;
    if (!existing && next.has(key)) return;
    const bg = backgroundTaskById(project, src.backgroundTaskId);
    const bgRunning = isBgTaskRunning(bg);
    if (bg && !bgRunning && !existing) return;
    const ctx = {
      ...src,
      key,
      nodeKey,
      project,
      branch,
      executionPath: src.executionPath || src.projectPath || project.path,
      baseProjectPath: src.baseProjectPath || project.path,
      usingWorktree: !!src.usingWorktree,
      lane: restoredLane,
      running: !!bgRunning,
      output: existing ? (src.output || '') : '',
      excerpt: src.excerpt || '',
      awaiting: !!src.awaiting,
      canResume: !!(src.sessionId || src.canResume),
      restored: !existing,
    };
    if (bg) {
      ctx.sessionId = bg.sessionId || ctx.sessionId || null;
      ctx.tokenUsage = bg.tokenUsage || ctx.tokenUsage || null;
      ctx.excerpt = String(bg.output || bg.stderr || ctx.excerpt || '').trim().slice(-1800);
      ctx.statusText = bgRunning ? '백그라운드에서 계속 진행 중입니다' : backgroundStatusText(bg);
      ctx.canResume = false;
      ctx.restored = false;
    }
    if (!bg && src.backgroundTaskId) {
      ctx.backgroundTaskId = null;
      ctx.statusText = src.statusText && !/계속 진행 중/.test(src.statusText)
        ? src.statusText
        : '이전 실행 상태를 찾지 못해 실행 중 표시를 정리했습니다.';
    }
    if (!bg && !existing && src.sessionId && !src.awaiting && !src.draftOpen) {
      ctx.statusText = src.statusText || '이전 세션을 이어서 실행할 수 있습니다';
    }
    next.set(key, ctx);
    if (ctx.lane && ctx.lane.kind === 'workstream' && taskSessionVisible(ctx)) expandedLanes.add(workstreamGroupKey(project));
  };
  for (const [key, ctx] of taskSessions.entries()) restoreOne(ctx, key, true);
  for (const [key, raw] of Object.entries(saved || {})) restoreOne(raw, key, false);
  taskSessions.clear();
  for (const [key, ctx] of next.entries()) taskSessions.set(key, ctx);
  if (taskCtx && taskCtx.key) taskCtx = taskSessions.get(taskCtx.key) || taskCtx;
  syncTaskRunning();
  persistTaskSessions();
}

function registerTaskSession(ctx) {
  if (!ctx || !ctx.project) return ctx;
  ctx.key = ctx.key || taskKeyForBranch(ctx.project, ctx.lane, ctx.branch || projectBranchKey(ctx.project));
  ctx.nodeKey = ctx.nodeKey || taskNodeKey(ctx.project, ctx.lane, ctx.branch || projectBranchKey(ctx.project));
  taskSessions.set(ctx.key, ctx);
  taskCtx = ctx;
  taskRunning = [...taskSessions.values()].some(s => s.running);
  persistTaskSessions();
  return ctx;
}

function removeTaskSession(ctx) {
  if (ctx && ctx.key) taskSessions.delete(ctx.key);
  if (taskCtx === ctx) taskCtx = null;
  taskRunning = [...taskSessions.values()].some(s => s.running);
  persistTaskSessions();
}

function syncTaskRunning() {
  taskRunning = [...taskSessions.values()].some(s => s.running);
  persistTaskSessions();
}

function queueTaskDraftPersist() {
  if (taskDraftPersistTimer) clearTimeout(taskDraftPersistTimer);
  taskDraftPersistTimer = setTimeout(() => {
    taskDraftPersistTimer = null;
    persistTaskSessions();
  }, 220);
}

function activeTaskRunning() {
  return !!(taskCtx && taskSessionRunning(taskCtx));
}

function newClientRunId(ctx) {
  return `${ctx.key}::${Date.now()}::${Math.random().toString(16).slice(2)}`;
}

function setTaskStopVisible(visible, enabled = visible) {
  for (const btn of [$('#taskStopBtn'), $('#taskStopInlineBtn')]) {
    if (!btn) continue;
    btn.classList.toggle('hidden', !visible);
    btn.disabled = !enabled;
  }
}

function taskActivityKind() {
  if (taskCtx && taskCtx.stopRequested) return 'stopping';
  if (activeTaskRunning()) {
    const text = $('#taskStatus') ? $('#taskStatus').textContent : '';
    return /처리 중|시작|대기|경과/.test(text) ? 'thinking' : 'working';
  }
  if (taskCtx && taskCtx.awaiting) return 'awaiting';
  const text = $('#taskStatus') ? $('#taskStatus').textContent : '';
  if (/완료|응답 완료/.test(text)) return 'done';
  if (/멈|실패|오류|중단|한도/.test(text)) return 'blocked';
  return 'idle';
}

function taskActivityLabel(kind) {
  if (kind === 'thinking') return '생각 중';
  if (kind === 'working') return '작업 중';
  if (kind === 'stopping') return '중단 중';
  if (kind === 'awaiting') return '답변 필요';
  if (kind === 'done') return '완료';
  if (kind === 'blocked') return '멈춤';
  return '대기';
}

function updateTaskActivity(kind = taskActivityKind(), detail = null) {
  const strip = $('#taskActivityStrip');
  if (!strip) return;
  const status = detail == null ? ($('#taskStatus') ? $('#taskStatus').textContent : '') : detail;
  strip.className = `activity-strip ${kind}`;
  const label = $('#taskActivityLabel');
  const text = $('#taskActivityDetail');
  if (label) label.textContent = taskActivityLabel(kind);
  if (text) text.textContent = String(status || '작업을 실행하면 Claude 상태가 여기에 표시됩니다.').replace(/\s+/g, ' ').trim();
}

function bindTaskActivityStatusObserver() {
  const status = $('#taskStatus');
  if (!status || status.dataset.activityBound) return;
  status.dataset.activityBound = '1';
  const observer = new MutationObserver(() => updateTaskActivity());
  observer.observe(status, { childList: true, characterData: true, subtree: true });
  updateTaskActivity();
}

function readTaskPromptHistory() {
  try { return JSON.parse(localStorage.getItem(TASK_PROMPT_HISTORY_KEY) || '{}'); } catch { return {}; }
}

function writeTaskPromptHistory(all) {
  localStorage.setItem(TASK_PROMPT_HISTORY_KEY, JSON.stringify(all));
}

function promptHistoryScopeKey(project, item = null) {
  const branch = (item && item.branch) || (taskCtx && taskCtx.project && taskCtx.project.path === project.path && taskCtx.branch) || projectBranchKey(project);
  const laneId = (item && item.laneId)
    || (taskCtx && taskCtx.project && taskCtx.project.path === project.path ? taskLaneId(taskCtx.lane) : 'main');
  const session = (item && (item.sessionId || item.backgroundTaskId || item.historyKey))
    || (taskCtx && taskCtx.project && taskCtx.project.path === project.path && (taskCtx.sessionId || taskCtx.backgroundTaskId || taskCtx.key))
    || 'draft';
  return `${project.path}|branch:${branch}|lane:${laneId}|session:${session}`;
}

function projectPromptHistory(project) {
  if (!project) return [];
  const all = readTaskPromptHistory();
  const scope = promptHistoryScopeKey(project);
  return Array.isArray(all[scope]) ? all[scope] : [];
}

function removePromptHistoryItem(project, item) {
  if (!project || !item) return;
  const all = readTaskPromptHistory();
  const scope = item.scopeKey || promptHistoryScopeKey(project, item);
  const list = Array.isArray(all[scope]) ? all[scope] : [];
  const prompt = promptHistoryPrompt(item);
  const key = item.historyKey || promptHistoryKey(item, prompt);
  all[scope] = list.filter(x => !samePromptHistorySession(x, key, item, prompt));
  writeTaskPromptHistory(all);
}

function compactHistoryTranscript(text) {
  return stripToolUseMarkers(text).slice(-60000);
}

function promptHistoryConversation(item) {
  return compactHistoryTranscript(item && (item.conversation || item.transcript || item.output || item.excerpt));
}

function promptHistoryPrompt(item) {
  return splitWccCommandSpill(item && item.prompt || '').prompt;
}

function promptHistoryKey(item, prompt) {
  if (item && item.sessionId) return `session:${item.sessionId}`;
  if (item && item.backgroundTaskId) return `background:${item.backgroundTaskId}`;
  return `prompt:${String(prompt || '').trim()}`;
}

function samePromptHistorySession(existing, key, item, prompt) {
  if (!existing) return false;
  if (key && existing.historyKey === key) return true;
  if (item && item.sessionId && existing.sessionId === item.sessionId) return true;
  if (item && item.backgroundTaskId && existing.backgroundTaskId === item.backgroundTaskId) return true;
  const existingPromptOnly = !existing.sessionId && !existing.backgroundTaskId;
  const samePrompt = String(existing.prompt || '').trim() === String(prompt || '').trim();
  return samePrompt && (existingPromptOnly || !existing.sessionId || !(item && item.sessionId));
}

function savePromptHistoryItem(project, item) {
  if (!project || !item || !String(item.prompt || '').trim()) return;
  const all = readTaskPromptHistory();
  const scope = promptHistoryScopeKey(project, item);
  const list = Array.isArray(all[scope]) ? all[scope] : [];
  const prompt = splitWccCommandSpill(item.prompt).prompt;
  const key = promptHistoryKey(item, prompt);
  const prev = list.find(x => samePromptHistorySession(x, key, item, prompt)) || {};
  const conversation = compactHistoryTranscript(item.conversation ?? item.transcript ?? prev.conversation ?? prev.transcript ?? '');
  const next = [
    {
      ...prev,
      ...item,
      historyKey: key,
      scopeKey: scope,
      branch: item.branch || prev.branch || (taskCtx && taskCtx.branch) || projectBranchKey(project),
      laneId: item.laneId || prev.laneId || (taskCtx ? taskLaneId(taskCtx.lane) : 'main'),
      prompt,
      ts: item.ts || prev.ts || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      conversation,
      transcript: conversation,
    },
    ...list.filter(x => !samePromptHistorySession(x, key, item, prompt)),
  ].slice(0, 12);
  all[scope] = next;
  writeTaskPromptHistory(all);
}

function renderTaskPromptHistory(project) {
  const box = $('#taskPromptHistory');
  if (!box) return;
  const items = projectPromptHistory(project).slice(0, 8);
  if (!items.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `<div class="task-history-head">세션 히스토리</div>` + items.map((it, idx) => `
    <div class="task-history-item" data-hidx="${idx}" role="button" tabindex="0" title="클릭하면 실행 화면에서 이전 대화를 봅니다">
      <div class="task-history-main">
        <b>${esc(it.sessionId ? `Claude 세션 ${it.sessionId.slice(0, 8)}` : (it.backgroundTaskId ? `작업 세션 ${it.backgroundTaskId.slice(0, 8)}` : (it.label || '작업 세션')))}</b>
        <span>${esc(it.ts ? it.ts.slice(5, 16).replace('T', ' ') : '')}</span>
        <p>${esc(truncate(promptHistoryPrompt(it), 180))}</p>
      </div>
      <button class="task-history-delete" type="button" data-hidx="${idx}" title="히스토리에서 삭제">×</button>
    </div>
  `).join('');
  box.classList.remove('hidden');
  const showHistoryInWorkbench = (idx) => {
    const item = items[idx];
    if (!item) return;
    const conversation = promptHistoryConversation(item);
    const body = conversation || `[내 메시지]\n${promptHistoryPrompt(item)}\n\n이전 버전에서 저장된 항목이라 대화 내용 스냅샷은 없습니다. 앞으로 실행한 세션부터 저장됩니다.`;
    if (taskCtx && taskCtx.project && taskCtx.project.path === project.path) {
      taskCtx.sessionId = item.sessionId || taskCtx.sessionId || null;
      taskCtx.historySessionId = item.sessionId || taskCtx.historySessionId || null;
      taskCtx.canResume = !!taskCtx.sessionId;
      taskCtx.awaiting = item.status === 'awaiting';
      taskCtx.lastPrompt = promptHistoryPrompt(item) || taskCtx.lastPrompt || '';
    }
    setTaskPromptVisible(false);
    $('#taskRun').classList.remove('hidden');
    $('#taskStatus').textContent = item.sessionId
      ? '히스토리 대화를 열었습니다. 아래 입력창에서 같은 세션으로 이어서 말할 수 있습니다.'
      : '히스토리 대화를 열었습니다.';
    setMarkdownOutput('#taskOut', body);
    $('#taskReplyRow').classList.toggle('hidden', !item.sessionId);
    $('#taskReply').value = '';
    $('#taskReply').placeholder = '이전 대화에 이어서 보낼 메시지를 입력하세요. (Ctrl+Enter)';
    $('#taskReplyBtn').textContent = '보내기 ↵';
    $('#taskRunBtn').classList.add('hidden');
    $('#taskRunBtn').disabled = true;
    box.querySelectorAll('.task-history-item').forEach(row => row.classList.toggle('selected', +row.dataset.hidx === idx));
    if (item.sessionId) $('#taskReply').focus();
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
      removePromptHistoryItem(project, item);
      renderTaskPromptHistory(project);
    });
  });
}

function laneLabel(lane) {
  if (!lane || !lane.kind || lane.kind === 'main') return '마일스톤';
  if (lane.kind === 'workstream') return `워크스트림 ${lane.name}`;
  return lane.name || '';
}

function workstreamPromptPrefix(project, lane) {
  if (!lane || lane.kind !== 'workstream') return '';
  return [
    `[Lodestar 작업 범위]`,
    `프로젝트: ${project.name}`,
    `워크스트림: ${lane.name}`,
    `우선 참조 경로: .planning/workstreams/${lane.name}`,
    ``,
    `이 작업은 메인 .planning 이 아니라 위 워크스트림의 STATE.md, ROADMAP.md, phases/ 산출물을 우선 기준으로 진행하세요.`,
    `필요한 경우에만 메인 .planning 을 참고하고, 계획/상태 산출물을 갱신할 때도 해당 워크스트림 아래 파일을 우선 갱신하세요.`,
    ``,
    `[사용자 지시]`,
  ].join('\n');
}

function taskPromptWithScope(project, lane, prompt) {
  const prefix = workstreamPromptPrefix(project, lane);
  return prefix ? `${prefix}\n${prompt}` : prompt;
}

function isWccCommandText(text) {
  const s = String(text || '').trim();
  return /^\/wcc(?::[\w-]+)?(?:\s|$)/i.test(s)
    || /^\/wcc-[\w-]+(?:\s|$)/i.test(s)
    || /^wcc(?::|-|\s+)(quick|debug|review|phase|workstreams?|autonomous|help|config|profile-user)\b/i.test(s);
}

function promptWithMaybeClearedContext(project, lane, prompt) {
  return isWccCommandText(prompt) ? prompt : taskPromptWithScope(project, lane, prompt);
}

function setTaskPromptVisible(visible) {
  $('#taskPromptLabel').style.display = visible ? '' : 'none';
  $('#taskPrompt').style.display = visible ? '' : 'none';
  hideCommandPalettes();
}

function setTaskInputsLocked(locked) {
  const prompt = $('#taskPrompt');
  const reply = $('#taskReply');
  if (prompt) {
    prompt.readOnly = !!locked;
    prompt.classList.toggle('locked', !!locked);
    prompt.title = locked ? 'Claude 작업 실행 중에는 작업 지시를 수정할 수 없습니다.' : '';
  }
  if (reply) {
    const lockReply = !!locked && !(taskCtx && taskCtx.running);
    reply.readOnly = lockReply;
    reply.classList.toggle('locked', lockReply);
    reply.title = taskCtx && taskCtx.running ? '현재 실행이 끝나면 같은 Claude 세션에 이어서 보낼 메시지입니다.' : '';
  }
  if (locked) hideCommandPalettes();
}

function setTaskNote(html) {
  const el = $('#taskNote');
  if (el) el.innerHTML = html;
}

function resetInfo(text) {
  const m = String(text || '').match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const minute = parseInt(m[2] || '00', 10);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return { label: `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, hour: h, minute, zone: m[4] || '' };
}

function resetReady(ri) {
  if (!ri) return true;
  const now = new Date();
  const resetAt = new Date(now);
  resetAt.setHours(ri.hour, ri.minute, 0, 0);
  return now >= resetAt;
}

function sessionStateLabel(s) {
  if (s.awaiting) return '답변 필요';
  if (s.blocked) return looksLikeUsageLimitText(s.excerpt || '') ? '한도 초과' : '멈춤';
  if (s.workflowKind && s.workflowKind !== 'session') return `${planningKindLabel(s.workflowKind)} 세션`;
  if (s.agentCount > 0 || s.toolCount > 0) return '작업 세션';
  return '세션';
}

function sessionTitleText(s) {
  return truncate((s.firstUser || s.excerpt || s.file || 'Claude 세션').replace(/\s+/g, ' ').trim(), 80);
}

function closeSession(project, sessionId) {
  if (!sessionId) return;
  setSessionMark(project, sessionId, 'ignored');
  if (taskCtx && taskCtx.project && taskCtx.project.path === project.path && taskCtx.historySessionId === sessionId) {
    closeTaskDrawer();
  } else if (taskCtx && taskCtx.project && taskCtx.project.path === project.path) {
    renderSessionMini(project);
  }
}

async function closeBranchSession(project, btn) {
  if (!project || !btn) return;
  const bgId = btn.dataset.bgId || '';
  const sessionKey = btn.dataset.sessionKey || '';
  const sessionId = btn.dataset.sessionId || '';
  const ctx = sessionKey ? taskSessions.get(sessionKey) : null;
  const bg = bgId ? (backgroundTaskById(project, bgId) || historyBackgroundTaskById(project, bgId)) : null;
  const running = (ctx && taskSessionRunning(ctx)) || isBgTaskRunning(bg);
  btn.textContent = running ? '…' : '×';
  btn.classList.add('closing');
  if (running && bgId && window.lodestar.stopTask) {
    const res = await window.lodestar.stopTask(bgId);
    if (!res || !res.ok) {
      btn.textContent = '!';
      btn.title = `중지 실패${res && res.error ? ': ' + truncate(res.error, 80) : ''}`;
      btn.classList.remove('closing');
      return;
    }
  }
  const closingActiveTask = !!(ctx && taskCtx === ctx);
  if (ctx) {
    ctx.running = false;
    ctx.awaiting = false;
    ctx.canResume = false;
    ctx.statusText = running ? '⏹ 세션을 중지하고 닫았습니다' : '세션을 닫았습니다';
    removeTaskSession(ctx);
  }
  if (closingActiveTask) closeTaskDrawer();
  const hiddenKey = sessionId || (bg ? backgroundSessionKey(bg) : '') || (bgId ? `bg:${bgId}` : '');
  if (hiddenKey) closeSession(project, hiddenKey);
  syncTaskRunning();
  await refresh();
}

function renderSessionMini(project, selectedSessionId = null) {
  const box = $('#sessionMini');
  if (!box) return;
  const act = project && project.activity;
  if (!act || !act.hasLog) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const selectedId = selectedSessionId || (taskCtx && taskCtx.project && taskCtx.project.path === project.path && (taskCtx.historySessionId || taskCtx.sessionId)) || '';
  if (!selectedId) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const sessions = (act && act.sessions || [])
    .filter(s => s && s.sessionId === selectedId && !isSessionHidden(project, s.sessionId))
    .slice(0, 1);
  let html = '';
  if (sessions.length) {
    html += '<div class="session-section"><div class="session-head">세션 히스토리</div>';
    for (const s of sessions) {
      const state = sessionStateLabel(s);
      const active = !!(selectedId && s.sessionId === selectedId);
      html += `<button class="session-history ${s.awaiting ? 'awaiting' : (s.blocked ? 'blocked' : '')}${active ? ' active' : ''}" data-sidx="${sessions.indexOf(s)}" ${active ? 'aria-current="true"' : ''}>
        <span class="session-dot"></span>
        <span class="session-info"><b>${esc(state)}</b><em>${esc(relTime(s.ageSec))} 전 · 도구 ${s.toolCount || 0}</em><small>${esc(sessionTitleText(s))}</small></span>
        <span class="session-close" data-session-id="${esc(s.sessionId || '')}" title="세션 닫기">×</span>
      </button>`;
    }
    html += '</div>';
  }
  box.innerHTML = html;
  box.classList.toggle('hidden', !html);
  box.querySelectorAll('.session-history').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = sessions[+btn.dataset.sidx];
      if (s) openHistorySessionTask(project, s);
    });
  });
  box.querySelectorAll('.session-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeSession(project, btn.dataset.sessionId || '');
    });
  });
}

function commandInputEl() {
  return document.activeElement && document.activeElement.id === 'taskReply' ? $('#taskReply') : $('#taskPrompt');
}

function commandBoxForInput(ta) {
  return ta && ta.id === 'taskReply' ? $('#replySuggest') : $('#skillSuggest');
}

function hideCommandPalettes() {
  const a = $('#skillSuggest'), b = $('#replySuggest');
  for (const box of [a, b]) {
    if (!box || box.classList.contains('hidden')) continue;
    box.classList.add('hidden');
    box.innerHTML = '';
  }
}

function slashTokenInfo() {
  const ta = commandInputEl();
  if (!ta || ta.style.display === 'none') return null;
  const pos = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const before = ta.value.slice(Math.max(0, pos - 96), pos);
  const m = before.match(/(^|\s)(\/[^\s]*)$/);
  if (!m) return null;
  const token = m[2];
  return { token, start: pos - token.length, end: pos, input: ta };
}

function commandScore(command, token) {
  const q = String(token || '').toLowerCase();
  const name = command.name.toLowerCase();
  const hay = `${command.name} ${command.summary || ''}`.toLowerCase();
  if (q === '/') return 1;
  if (name.startsWith(q)) return 30 - Math.min(name.length, 20);
  if (name.includes(q)) return 12;
  const bare = q.replace(/^\//, '');
  if (bare && hay.includes(bare)) return 4;
  return 0;
}

function slashCommandMatches() {
  const info = slashTokenInfo();
  if (!info || !claudeCommands.length) return [];
  return claudeCommands
    .map(c => ({ ...c, score: commandScore(c, info.token) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function renderSkillSuggest() {
  const info = slashTokenInfo();
  const box = commandBoxForInput(info && info.input);
  const other = box && box.id === 'replySuggest' ? $('#skillSuggest') : $('#replySuggest');
  if (other) { other.classList.add('hidden'); other.innerHTML = ''; }
  if (!box) return;
  const matches = slashCommandMatches();
  if (!taskCtx || activeTaskRunning() || !matches.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  commandActiveIndex = Math.min(commandActiveIndex, matches.length - 1);
  const active = matches[commandActiveIndex] || matches[0];
  box.innerHTML = `<div class="skill-head">Claude Slash Commands</div>` +
    `<div class="skill-list">` + matches.map((c, idx) =>
      `<button class="skill-chip command-chip ${idx === commandActiveIndex ? 'active' : ''}" data-command="${esc(c.name)}" title="${esc(c.summary || c.name)}">
        <b>${esc(c.name)}</b>${c.summary ? `<span>${esc(truncate(c.summary, 92))}</span>` : ''}
      </button>`
    ).join('') + `</div>` +
    (active ? `<div class="command-preview">
      <div class="command-preview-title"><b>${esc(active.name)}</b><span>${esc(active.source || '')}</span></div>
      <pre>${esc(active.detail || active.summary || '커맨드 설명이 비어 있습니다.')}</pre>
    </div>` : '');
  box.classList.remove('hidden');
  box.querySelectorAll('.command-chip').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      insertSkillHint(btn.dataset.command);
    });
  });
}

function scheduleSkillSuggest() {
  const info = slashTokenInfo();
  if (!info) {
    hideCommandPalettes();
    return;
  }
  if (skillSuggestRaf) return;
  skillSuggestRaf = requestAnimationFrame(() => {
    skillSuggestRaf = 0;
    renderSkillSuggest();
  });
}

function insertSkillHint(commandName) {
  const info = slashTokenInfo();
  if (!info) return;
  const ta = info.input;
  ta.value = ta.value.slice(0, info.start) + commandName + ' ' + ta.value.slice(info.end);
  const next = info.start + commandName.length + 1;
  ta.setSelectionRange(next, next);
  ta.focus();
  renderSkillSuggest();
}

function handleCommandPaletteKey(e) {
  if (!['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(e.key)) return false;
  const info = slashTokenInfo();
  const box = commandBoxForInput(info && info.input);
  const open = box && !box.classList.contains('hidden');
  if (!open) return false;
  const matches = slashCommandMatches();
  if (!matches.length) return false;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    commandActiveIndex = (commandActiveIndex + 1) % matches.length;
    renderSkillSuggest();
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    commandActiveIndex = (commandActiveIndex - 1 + matches.length) % matches.length;
    renderSkillSuggest();
    return true;
  }
  if (e.key === 'Tab' || e.key === 'Enter') {
    e.preventDefault();
    insertSkillHint(matches[commandActiveIndex].name);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    box.classList.add('hidden');
    return true;
  }
  return false;
}

async function loadClaudeSkills() {
  try {
    if (window.lodestar.listSkills) claudeSkills = await window.lodestar.listSkills();
    if (window.lodestar.listCommands) claudeCommands = await window.lodestar.listCommands({ projectPath: taskCtx && taskCtx.project && taskCtx.project.path });
    renderSkillSuggest();
  } catch {
    claudeSkills = [];
    claudeCommands = [];
  }
}

function stopBackgroundTaskPoll() {
  if (bgTaskPoll) clearInterval(bgTaskPoll);
  bgTaskPoll = null;
}

function backgroundStatusText(task) {
  if (!task) return '작업 상태를 읽을 수 없습니다';
  if (task.status === 'running' || task.status === 'queued') return '◌ 실행 중입니다';
  if (task.status === 'completed') return '✓ 작업 완료';
  if (task.status === 'timeout') return '⚠ 작업 시간 초과';
  if (task.status === 'stopped') return '⏹ 대화를 중단했습니다';
  return '⚠ 작업이 멈췄습니다';
}

function backgroundRuntimeText(task) {
  if (!task) return backgroundStatusText(task);
  const bits = [backgroundStatusText(task)];
  if (task.sessionId) bits.push(`세션 ${String(task.sessionId).slice(0, 8)}`);
  else if (isBgTaskRunning(task) && task.id) bits.push('세션 ID 감지 대기');
  if (task.id) bits.push(`작업 ${String(task.id).slice(0, 8)}`);
  const outLen = String(task.output || task.stderr || '').length;
  bits.push(outLen ? `로그 ${compactNumber(outLen)}자` : '로그 수신 대기');
  if (task.updatedAt) bits.push(`갱신 ${relativeTime(task.updatedAt)}`);
  return bits.filter(Boolean).join(' · ');
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

function cloneForTaskWindow(value) {
  try { return JSON.parse(JSON.stringify(value || null)); } catch { return null; }
}

function openTaskWindowPayload(payload) {
  if (!window.lodestar || !window.lodestar.openTaskWindow) return false;
  window.lodestar.openTaskWindow(cloneForTaskWindow(payload));
  return true;
}

function taskWindowPayload(mode, project, extra = {}) {
  const branch = extra.branch
    || (extra.task && extra.task.branch)
    || (extra.backgroundTask && extra.backgroundTask.branch)
    || (extra.session && extra.session.branch)
    || projectBranchKey(project);
  return {
    mode,
    project: cloneForTaskWindow(project),
    branch,
    openedAt: new Date().toISOString(),
    ...cloneForTaskWindow(extra),
  };
}

function renderBackgroundTask(project, task) {
  if (!task) return;
  setTaskTokenUsage(task.tokenUsage || null, task.quotaRemaining || null);
  const bgRunning = isBgTaskRunning(task);
  const transcript = backgroundTaskTranscript(task, taskCtx && taskCtx.output);
  const decisionQuestion = decisionQuestionFromText(transcript);
  const bgAwaiting = !!(decisionQuestion && task.sessionId);
  taskCtx = {
    project,
    discuss: null,
    branch: task.branch || projectBranchKey(project),
    lane: task.workstream && task.workstream.name ? { kind: 'workstream', name: task.workstream.name } : projectMainLane(project),
    sessionId: task.sessionId || null,
    external: true,
    canResume: !!task.sessionId,
    resumeMode: 'history',
    resumePrompt: '이 세션을 이어서 진행해줘.',
    backgroundTaskId: task.id,
    lastPrompt: task.prompt || '',
    tokenUsage: task.tokenUsage || null,
    quotaRemaining: task.quotaRemaining || null,
    awaiting: bgAwaiting,
    asked: bgAwaiting,
    awaitingQuestion: decisionQuestion,
    awaitingQuestions: decisionQuestion ? [decisionQuestion] : [],
    running: bgRunning && !bgAwaiting,
  };
  $('#taskTitle').textContent = `작업 진행 · ${project.name}`;
  $('#taskSub').textContent = `${task.sessionId ? `Claude 세션 ${task.sessionId.slice(0, 8)} · ` : ''}${project.path}`;
  renderAwaitingQuestionControls(decisionQuestion ? [decisionQuestion] : null);
  setTaskPromptVisible(false);
  $('#taskRun').classList.remove('hidden');
  $('#taskStatus').textContent = bgAwaiting ? 'Claude가 결정을 기다리고 있습니다. 선택하거나 직접 답변하세요.' : backgroundRuntimeText(task);
  taskCtx.output = transcript;
  setMarkdownOutput('#taskOut', transcript);
  if (task.prompt) {
    savePromptHistoryItem(project, {
      label: '작업 실행',
      prompt: task.historyPrompt || task.prompt,
      conversation: transcript,
      sessionId: task.sessionId || null,
      backgroundTaskId: task.id || null,
      branch: task.branch || projectBranchKey(project),
      laneId: task.workstream && task.workstream.name ? `workstream:${task.workstream.name}` : 'main',
      status: task.status || null,
    });
  }
  const canChat = !!(task.sessionId && (!bgRunning || bgAwaiting));
  $('#taskReplyRow').classList.toggle('hidden', !canChat);
  $('#taskReply').value = '';
  $('#taskReply').placeholder = bgAwaiting ? '결정 답변을 입력하세요. 선택지를 눌러도 됩니다. (Ctrl+Enter)' : '과거 세션에 이어서 보낼 메시지를 입력하세요. (Ctrl+Enter)';
  $('#taskReplyBtn').textContent = '보내기 ↵';
  $('#taskRunBtn').classList.add('hidden');
  $('#taskRunBtn').disabled = true;
  setTaskInputsLocked(bgRunning && !bgAwaiting);
  setTaskStopVisible(bgRunning && !bgAwaiting, bgRunning && !bgAwaiting);
  renderTaskPromptHistory(project);
  setTaskNote('Lodestar 창이 닫혀도 이 작업은 계속 실행됩니다. 앱을 다시 켜면 같은 진행 상황을 다시 볼 수 있습니다.');
}

function openBackgroundTask(project, task) {
  if (task && task.workstream && task.workstream.name) expandedLanes.add(workstreamGroupKey(project));
  if (task && task.branch) { focusBranchKey = branchAreaKey(project, task.branch); focusNext = true; }
  if (openTaskWindowPayload(taskWindowPayload('background', project, { backgroundTask: task }))) return;
  stopBackgroundTaskPoll();
  renderSessionMini(project);
  renderBackgroundTask(project, task);
  $('#taskDrawer').classList.remove('hidden');
  if (isBgTaskRunning(task) && window.lodestar.getTask) {
    bgTaskPoll = setInterval(async () => {
      const next = await window.lodestar.getTask(task.id);
      if (!next) return;
      renderBackgroundTask(project, next);
      if (!isBgTaskRunning(next)) stopBackgroundTaskPoll();
    }, 1200);
  }
}

function applyBackgroundTaskToContext(ctx, task) {
  if (!ctx || !task) return;
  const bgRunning = isBgTaskRunning(task);
  const transcript = backgroundTaskTranscript(task, ctx.output);
  const decisionQuestion = decisionQuestionFromText(transcript);
  const nextSessionId = task.sessionId || ctx.sessionId || null;
  const asked = !!(decisionQuestion && nextSessionId) || (!bgRunning && task.status === 'completed' && isQuestion(task.output || ''));
  ctx.backgroundTaskId = task.id || ctx.backgroundTaskId || null;
  ctx.sessionId = nextSessionId;
  ctx.tokenUsage = task.tokenUsage || ctx.tokenUsage || null;
  ctx.quotaRemaining = task.quotaRemaining || ctx.quotaRemaining || null;
  ctx.output = transcript;
  ctx.excerpt = String(ctx.output || '').trim().slice(-1800);
  ctx.running = bgRunning && !decisionQuestion;
  ctx.awaiting = asked;
  ctx.asked = asked;
  ctx.awaitingQuestion = decisionQuestion || null;
  ctx.awaitingQuestions = decisionQuestion ? [decisionQuestion] : [];
  ctx.canResume = !!(ctx.sessionId && (!bgRunning || decisionQuestion));
  ctx.statusText = bgRunning
    ? (decisionQuestion ? 'Claude가 결정을 기다리고 있습니다. 선택하거나 직접 답변하세요.' : backgroundRuntimeText(task))
    : (asked ? '⏸ claude가 질문했어요 — 아래에 답하면 이어서 진행합니다' : backgroundRuntimeText(task));
  if (!bgRunning && !asked) ctx.backgroundTaskId = null;
}

function renderTaskContextFromBackground(ctx, task) {
  if (!ctx || !task || taskCtx !== ctx) return;
  setTaskTokenUsage(ctx.tokenUsage || null, ctx.quotaRemaining || null);
  $('#taskStatus').textContent = ctx.statusText || backgroundRuntimeText(task);
  setMarkdownOutput('#taskOut', backgroundTaskTranscript(task, ctx.output));
  renderAwaitingQuestionControls(ctx.awaitingQuestions || ctx.awaitingQuestion || null);
  $('#taskReplyRow').classList.toggle('hidden', !(ctx.running || (ctx.canResume && !ctx.running)));
  $('#taskReplyBtn').textContent = ctx.running ? (ctx.pendingInterjection ? '예약됨' : '끝나면 보내기 ↵') : '보내기 ↵';
  $('#taskReply').placeholder = ctx.running
    ? '실행 중 전달할 메시지를 적어두세요. 현재 턴이 끝나면 같은 세션에 자동으로 보냅니다. (Ctrl+Enter)'
    : '이 대화에 이어서 보낼 메시지를 입력하세요. (Ctrl+Enter)';
  $('#taskRunBtn').disabled = !!ctx.running;
  $('#taskRunBtn').textContent = ctx.running ? '실행 중…' : '▶ 같은 세션 이어서 실행';
  setTaskInputsLocked(!!ctx.running);
  setTaskStopVisible(!!ctx.running, !!(ctx.running && ctx.backgroundTaskId));
}

function pollTaskContextBackground(ctx) {
  if (!ctx || !ctx.backgroundTaskId || !window.lodestar.getTask) return;
  stopBackgroundTaskPoll();
  const id = ctx.backgroundTaskId;
  const tick = async () => {
    const next = await window.lodestar.getTask(id);
    if (!next) return;
    applyBackgroundTaskToContext(ctx, next);
    renderTaskContextFromBackground(ctx, next);
    persistTaskSessions();
    if (!isBgTaskRunning(next)) {
      stopBackgroundTaskPoll();
      renderTaskPromptHistory(ctx.project);
      await refresh();
    }
  };
  tick();
  bgTaskPoll = setInterval(tick, 1200);
}

async function openHistorySessionTask(project, session) {
  const lane = laneForTaskId(project, session && session.laneId) || (session && session.lane) || projectMainLane(project);
  const branch = (session && session.branch) || selectedProjectBranch(project);
  if (lane && lane.kind === 'workstream') expandedLanes.add(workstreamGroupKey(project));
  focusBranchKey = branchAreaKey(project, branch);
  focusNext = true;
  if (openTaskWindowPayload(taskWindowPayload('history', project, { session: { ...session, laneId: taskLaneId(lane), laneName: laneLabelText(lane), branch }, lane, branch }))) return;
  const state = sessionStateLabel(session);
  const canReply = !!session.awaiting;
  taskCtx = {
    project,
    discuss: null,
    branch,
    lane,
    sessionId: session.sessionId || null,
    historySessionId: session.sessionId || null,
    awaiting: canReply,
    asked: canReply,
    canResume: !!session.sessionId,
    external: true,
    resumeMode: canReply ? null : 'history',
    resumePrompt: '이 세션을 이어서 진행해줘.',
  };
  renderSessionMini(project, session.sessionId || null);
  $('#taskTitle').textContent = `${state} · ${project.name}`;
  $('#taskSub').textContent = `${session.sessionId ? `Claude 세션 ${session.sessionId.slice(0, 8)} · ` : ''}${laneLabelText(lane)} · ${project.path}`;
  $('#taskQuestions').style.display = 'none';
  $('#taskQuestions').innerHTML = '';
  setTaskPromptVisible(false);
  $('#taskRun').classList.remove('hidden');
  $('#taskStatus').textContent = canReply ? '⏸ 이 세션이 답변을 기다리고 있습니다' : '세션 히스토리에서 선택됨';
  setMarkdownOutput('#taskOut', session.excerpt || '이 세션의 마지막 출력이 비어 있습니다.');
  $('#taskReplyRow').classList.toggle('hidden', !session.sessionId);
  $('#taskReply').value = '';
  $('#taskReply').placeholder = canReply
    ? 'Claude가 기다리는 답변을 입력하세요. (Ctrl+Enter)'
    : '과거 세션에 이어서 보낼 메시지를 입력하세요. (Ctrl+Enter)';
  $('#taskReplyBtn').textContent = canReply ? '답변 보내기 ↵' : '보내기 ↵';
  $('#taskRunBtn').classList.add('hidden');
  $('#taskRunBtn').disabled = true;
  setTaskStopVisible(false);
  renderTaskPromptHistory(project);
  setTaskNote(canReply
    ? '선택한 과거 세션이 사용자 입력을 기다리고 있습니다. 답변을 보내면 해당 세션에 <code>--resume</code>으로 전달합니다.'
    : '선택한 과거 세션에 메시지를 보내면 같은 세션 ID로 <code>--resume</code> 전달합니다.');
  $('#taskDrawer').classList.remove('hidden');
  if (session.sessionId && window.lodestar.sessionDetail) {
    const detail = await window.lodestar.sessionDetail({ projectPath: project.path, sessionId: session.sessionId });
    if (detail && detail.ok) {
      taskCtx.output = detail.output || session.excerpt || '';
      taskCtx.tokenUsage = detail.tokenUsage || null;
      taskCtx.quotaRemaining = detail.quotaRemaining || taskCtx.quotaRemaining || null;
      setTaskTokenUsage(taskCtx.tokenUsage, taskCtx.quotaRemaining);
      setMarkdownOutput('#taskOut', taskCtx.output || '이 세션의 대화 내용이 비어 있습니다.');
      $('#taskStatus').textContent = '히스토리 세션을 열었습니다. 아래 입력창에서 같은 세션으로 이어서 말할 수 있습니다.';
    }
  }
}

function refreshSessionPanelTimeState() {
  if (!taskCtx || !taskCtx.project || $('#taskDrawer').classList.contains('hidden')) return;
  if (taskCtx.resumeMode !== 'blocked') return;
  const info = pauseInfo(taskCtx.project);
  const ri = resetInfo(info.detail);
  if (!ri) return;
  const ready = resetReady(ri);
  $('#taskRunBtn').disabled = !taskCtx.sessionId || !ready;
  $('#taskRunBtn').textContent = ready ? '▶ 이어서 실행' : `▶ ${ri.label} 이후 이어서 실행`;
  if (ready && info.label === '한도 초과') {
    $('#taskStatus').textContent = `⏸ ${info.label} · ${ri.label} 리셋 지남 — 이어서 실행할 수 있습니다`;
  }
}

setInterval(refreshSessionPanelTimeState, 30000);

// 논의 모드 프롬프트 빌드 (질문 맥락 + 내 의견 → GSD 반영 지시)
function buildDiscussPrompt(d, opinion) {
  return [
    `이 프로젝트는 GSD/WCC 워크플로우의 Phase ${d.num} (${d.title}) 논의 단계입니다.`,
    ``,
    `[논의 질문/맥락]`,
    d.question || '(질문 미지정 — 자유 의견)',
    ``,
    `[내 의견]`,
    opinion,
    ``,
    `위 내 의견을 이 phase의 논의 결정으로 반영해 진행해줘. 필요한 경우 .planning 의 CONTEXT 등에 반영하고, 무엇을 했는지 간단히 한국어로 요약해줘. 소스 코드 변경이 꼭 필요한 단계가 아니면 변경하지 마.`,
  ].join('\n');
}

function taskNoteForLane(project, lane) {
  const scope = laneLabel(lane);
  return lane && lane.kind === 'workstream'
    ? `이 프로젝트 폴더에서 <code>claude -p</code>를 실행하되, <b>${esc(scope)}</b> 산출물(<code>.planning/workstreams/${esc(lane.name)}</code>)을 우선 기준으로 작업시킵니다.`
    : '이 프로젝트 폴더에서 <code>claude -p</code> 를 실행해 작업을 시킵니다. 터미널을 따로 찾지 않아도 됩니다. <b>파일이 실제로 수정될 수 있는</b> 동작입니다.';
}

function renderTaskSession(ctx) {
  if (!ctx) return;
  if (!ctx.running && !ctx.awaiting && !ctx.sessionId && !ctx.backgroundTaskId && !ctx.output) {
    ctx.draftOpen = true;
    ctx.statusText = ctx.statusText || '새 세션 작성 중';
  }
  registerTaskSession(ctx);
  loadClaudeSkills();
  const project = ctx.project;
  const lane = ctx.lane || null;
  const scope = laneLabel(lane);
  const isDiscuss = !!ctx.discuss;
  const sessionRunning = taskSessionRunning(ctx);
  renderSessionMini(project);
  setTaskNote(taskNoteForLane(project, lane));
  $('#taskTitle').textContent = isDiscuss ? `논의 의견 → claude 작업 · ${project.name}` : `작업 요청 · ${project.name}`;
  $('#taskSub').textContent = isDiscuss && ctx.discuss
    ? `${scope} · Phase ${ctx.discuss.num} — ${ctx.discuss.title}`
    : `${scope} · ${project.path}`;
  $('#taskQuestions').style.display = 'none';
  $('#taskQuestions').innerHTML = '';
  setTaskPromptVisible(!sessionRunning && !ctx.awaiting);
  $('#taskPrompt').value = ctx.draft || '';
  $('#taskPrompt').placeholder = isDiscuss
    ? '이 논의에 대한 내 의견을 적으세요. claude가 맥락에 반영해 진행합니다.'
    : (lane && lane.kind === 'workstream'
      ? `예) ${lane.name} 워크스트림의 현재 phase PLAN.md를 읽고 다음 plan을 실행해줘`
      : '예) 현재 phase의 PLAN.md를 읽고 다음 plan을 실행해줘 / 테스트 돌려서 실패 원인 찾아줘');
  $('#taskPromptLabel').textContent = isDiscuss ? '내 의견' : '작업 지시 (claude 에게 시킬 내용)';
  $('#taskRun').classList.toggle('hidden', !(ctx.output || ctx.excerpt || ctx.statusText || sessionRunning || ctx.awaiting || ctx.canResume));
  setMarkdownOutput('#taskOut', ctx.output || ctx.excerpt || '');
  $('#taskStatus').textContent = ctx.statusText || (sessionRunning ? '실행 중…' : '');
  setTaskTokenUsage(ctx.tokenUsage || null, ctx.quotaRemaining || null);
  $('#taskReplyRow').classList.toggle('hidden', !(sessionRunning || (ctx.canResume && !sessionRunning)));
  $('#taskReply').value = sessionRunning ? (ctx.pendingInterjection || '') : '';
  $('#taskReply').placeholder = sessionRunning
    ? '실행 중 전달할 메시지를 적어두세요. 현재 턴이 끝나면 같은 세션에 자동으로 보냅니다. (Ctrl+Enter)'
    : 'claude가 물어보면 여기에 답하고 ‘이어서 보내기’를 누르세요. (Ctrl+Enter)';
  $('#taskReplyBtn').textContent = sessionRunning
    ? (ctx.pendingInterjection ? '예약됨' : '끝나면 보내기 ↵')
    : '이어서 보내기 ↵';
  $('#taskRunBtn').classList.toggle('hidden', !!ctx.awaiting);
  $('#taskRunBtn').disabled = !!sessionRunning;
  $('#taskRunBtn').textContent = sessionRunning ? '실행 중…' : (ctx.canResume && ctx.sessionId ? '▶ 같은 세션 이어서 실행' : '▶ 작업 실행 (claude)');
  setTaskStopVisible(!!sessionRunning, !!(sessionRunning && ctx.backgroundTaskId));
  setTaskInputsLocked(!!sessionRunning);
  renderTaskPromptHistory(project);
  $('#taskDrawer').classList.remove('hidden');
  renderSkillSuggest();
}

function projectMainLane(project) {
  const lanes = (project && project.lanes && project.lanes.length)
    ? project.lanes
    : [{ kind: 'main', name: 'main', state: project && project.state, phases: project && project.phases }];
  return lanes.find(l => !l.kind || l.kind === 'main') || { kind: 'main', name: 'main', state: project.state, phases: project.phases };
}

function createDraftTaskSession(project, discuss, lane, branch = null, opts = {}) {
  const actualLane = lane || projectMainLane(project);
  const actualBranch = branch || projectBranchKey(project);
  const nodeKey = taskNodeKey(project, actualLane, actualBranch);
  const previous = taskSessions.get(nodeKey);
  if (previous && !opts.forceNewDraft) {
    previous.project = project;
    previous.branch = previous.branch || actualBranch;
    previous.lane = previous.lane || actualLane;
    previous.nodeKey = previous.nodeKey || nodeKey;
    previous.discuss = discuss || previous.discuss || null;
    registerTaskSession(previous);
    return previous;
  }
  const key = opts.forceNewDraft && previous && taskSessionVisible(previous)
    ? `${nodeKey}::manual:${Date.now()}`
    : nodeKey;
  const ctx = registerTaskSession({
    key,
    nodeKey,
    project,
    branch: actualBranch,
    executionPath: project.path,
    baseProjectPath: project.path,
    usingWorktree: false,
    discuss: discuss || null,
    lane: actualLane,
    sessionId: null,
    running: false,
    awaiting: false,
    draftOpen: true,
    draft: '',
    createdAt: new Date().toISOString(),
    output: '',
    statusText: '새 세션 작성 중',
  });
  focusBranchKey = branchAreaKey(project, actualBranch);
  focusNext = true;
  return ctx;
}

function openProjectSession(project) {
  openBranchSessionPicker(project, { lane: projectMainLane(project) });
}

function openTask(project, discuss, lane, opts = {}) {
  const branch = opts.branch || selectedProjectBranch(project);
  restoreTaskSessionsForProjects(projects);
  if (lane && lane.kind === 'workstream') expandedLanes.add(workstreamGroupKey(project));
  const existing = taskSession(project, lane, branch);
  if (existing && !opts.forceNewDraft) {
    existing.project = project;
    existing.branch = existing.branch || branch;
    existing.lane = existing.lane || lane || projectMainLane(project);
    showTaskSession(existing);
    return;
  }
  taskCtx = createDraftTaskSession(project, discuss, lane, branch, { forceNewDraft: !!opts.forceNewDraft });
  layout();
  if (openTaskWindowPayload(taskWindowPayload('new', project, { task: taskCtx, lane: taskCtx.lane || lane, discuss: discuss || null, branch }))) {
    layout();
    return;
  }
  loadClaudeSkills();
  const isDiscuss = !!discuss;
  const scope = laneLabel(taskCtx.lane || lane);
  renderSessionMini(project);
  setTaskNote(taskNoteForLane(project, taskCtx.lane || lane));
  setTaskPromptVisible(true);
  $('#taskTitle').textContent = isDiscuss ? `논의 의견 → claude 작업 · ${project.name}` : `작업 요청 · ${project.name}`;
  $('#taskSub').textContent = isDiscuss ? `${scope} · Phase ${discuss.num} — ${discuss.title}` : `${scope} · ${project.path}`;
  $('#taskPrompt').value = '';
  $('#taskPrompt').placeholder = isDiscuss
    ? '이 논의에 대한 내 의견을 적으세요. claude가 맥락에 반영해 진행합니다.'
    : (taskCtx.lane && taskCtx.lane.kind === 'workstream'
      ? `예) ${taskCtx.lane.name} 워크스트림의 현재 phase PLAN.md를 읽고 다음 plan을 실행해줘`
      : '예) 현재 phase의 PLAN.md를 읽고 다음 plan을 실행해줘 / 테스트 돌려서 실패 원인 찾아줘');
  $('#taskPromptLabel').textContent = isDiscuss ? '내 의견' : '작업 지시 (claude 에게 시킬 내용)';

  // 논의 질문 칩
  const qbox = $('#taskQuestions');
  qbox.innerHTML = '';
  if (isDiscuss) {
    const items = [];
    for (const q of (discuss.questions || []).slice(0, 8)) items.push({ text: q.text, un: !q.answered });
    for (const sec of (discuss.sections || [])) for (const it of sec.items.slice(0, 6)) items.push({ text: it, un: false });
    if (discuss.grayNote) { const n = document.createElement('div'); n.className = 'dq-note'; n.textContent = truncate(discuss.grayNote, 200); qbox.appendChild(n); }
    for (const it of items) {
      const dq = document.createElement('div');
      dq.className = 'dq' + (it.un ? ' unanswered' : '');
      dq.textContent = truncate(it.text, 180);
      dq.title = '클릭 → 이 질문을 의견 맥락으로';
      dq.addEventListener('click', () => { taskCtx.pickedQuestion = it.text; $('#taskPrompt').focus(); });
      qbox.appendChild(dq);
    }
    qbox.style.display = '';
  } else {
    qbox.style.display = 'none';
  }

  $('#taskRun').classList.add('hidden');
  setMarkdownOutput('#taskOut', '');
  setTaskTokenUsage(null);
  $('#taskReplyRow').classList.add('hidden');
  $('#taskReply').value = '';
  $('#taskRunBtn').classList.remove('hidden');
  $('#taskRunBtn').disabled = false;
  $('#taskRunBtn').textContent = '▶ 작업 실행 (claude)';
  setTaskStopVisible(false);
  setTaskInputsLocked(false);
  renderTaskPromptHistory(project);
  $('#taskDrawer').classList.remove('hidden');
  layout();
  renderSkillSuggest();
  setTimeout(() => $('#taskPrompt').focus(), 50);
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
  $('#taskReply').value = answer;
  doTaskReply();
}

function renderAwaitingQuestionControls(question) {
  const box = $('#taskQuestions');
  if (!box) return;
  const questions = normalizedAwaitingQuestions(question);
  if (!questions.length) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  box.style.display = '';
  box.innerHTML = `
    <div class="await-choice-head">${questions.length > 1 ? `질문 ${questions.length}개에 답한 뒤 보내세요.` : '선택하거나 직접 답변하세요.'}</div>
    ${questions.map((q, qidx) => {
      const choices = Array.isArray(q && q.choices) ? q.choices : [];
      return `
        <div class="await-question" data-question-idx="${qidx}">
          <div class="await-question-text">${questions.length > 1 ? `<b>${qidx + 1}</b>` : ''}<span>${esc(q.question || '사용자 답변이 필요합니다.')}</span></div>
          ${choices.length ? `<div class="await-choice-list">${choices.map((choice, idx) => `
            <button class="await-choice" type="button" data-question-idx="${qidx}" data-choice-idx="${idx}">
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

function openAwaitingTask(project) {
  ackProjectAttention(project);
  if (openTaskWindowPayload(taskWindowPayload('awaiting', project, { activity: project.activity || {} }))) return;
  const act = project.activity || {};
  renderSessionMini(project);
  setTaskNote('Claude가 사용자 입력을 기다리고 있습니다. 아래 답변을 보내면 같은 세션에 <code>--resume</code>으로 이어서 전달합니다.');
  taskCtx = {
    project,
    discuss: null,
    sessionId: act.sessionId || null,
    awaiting: true,
    asked: true,
    canResume: !!act.sessionId,
    external: true,
    awaitingQuestion: act.awaitingQuestion || null,
    awaitingQuestions: act.awaitingQuestions || (act.awaitingQuestion ? [act.awaitingQuestion] : []),
  };
  $('#taskTitle').textContent = `답변 보내기 · ${project.name}`;
  $('#taskSub').textContent = act.sessionId ? `Claude 세션 ${act.sessionId.slice(0, 8)} · ${project.path}` : project.path;
  renderAwaitingQuestionControls(act.awaitingQuestions || act.awaitingQuestion || null);
  setTaskPromptVisible(false);
  $('#taskRun').classList.remove('hidden');
  $('#taskStatus').textContent = act.sessionId
    ? '⏸ Claude가 답변을 기다리는 중입니다'
    : '⏸ 답변 대기 상태지만 세션 ID를 찾지 못했습니다';
  setMarkdownOutput('#taskOut', act.awaitingText || 'Claude가 사용자 답변을 기다리고 있습니다.');
  setTaskTokenUsage(null);
  $('#taskReplyRow').classList.remove('hidden');
  $('#taskReply').value = '';
  $('#taskRunBtn').classList.add('hidden');
  $('#taskRunBtn').disabled = true;
  setTaskStopVisible(false);
  setTaskInputsLocked(false);
  renderTaskPromptHistory(project);
  $('#taskDrawer').classList.remove('hidden');
  $('#actDrawer').classList.add('hidden');
  setTimeout(() => $('#taskReply').focus(), 50);
}

function openBlockedTask(project) {
  ackProjectAttention(project);
  if (openTaskWindowPayload(taskWindowPayload('blocked', project, { activity: project.activity || {}, pause: pauseInfo(project) }))) return;
  const act = project.activity || {};
  const info = pauseInfo(project);
  renderSessionMini(project);
  const ri = resetInfo(info.detail);
  setTaskNote(info.label === '한도 초과'
    ? `Claude 세션이 사용량 한도에 걸려 멈췄습니다.${ri ? ` 리셋: <b>${ri.label}${ri.zone ? ' ' + esc(ri.zone) : ''}</b>.` : ''} 리셋 전에는 이어서 실행해도 다시 멈출 수 있습니다.`
    : 'Claude 세션이 제한 또는 오류로 멈췄습니다. 같은 세션으로 이어서 실행을 시도할 수 있습니다.');
  taskCtx = {
    project,
    discuss: null,
    sessionId: act.sessionId || null,
    awaiting: false,
    asked: false,
    canResume: !!act.sessionId,
    external: true,
    resumeMode: 'blocked',
    resumePrompt: '이전 작업을 이어서 진행해줘.',
  };
  $('#taskTitle').textContent = `이어서 실행 · ${project.name}`;
  $('#taskSub').textContent = act.sessionId ? `Claude 세션 ${act.sessionId.slice(0, 8)} · ${project.path}` : project.path;
  $('#taskQuestions').style.display = 'none';
  $('#taskQuestions').innerHTML = '';
  setTaskPromptVisible(false);
  $('#taskRun').classList.remove('hidden');
  $('#taskStatus').textContent = act.sessionId
    ? `⏸ ${info.label}${ri ? ` · ${ri.label} 리셋` : ''} — 실행 버튼으로 같은 세션을 이어서 시도합니다${info.label === '한도 초과' ? ' (리셋 전에는 다시 멈출 수 있음)' : ''}`
    : `⏸ ${info.label} — 이어갈 세션 ID를 찾지 못했습니다`;
  setMarkdownOutput('#taskOut', info.detail || 'Claude가 제한 또는 오류로 중단되었습니다.');
  setTaskTokenUsage(null);
  $('#taskReplyRow').classList.add('hidden');
  $('#taskReply').value = '';
  $('#taskRunBtn').classList.remove('hidden');
  $('#taskRunBtn').disabled = !act.sessionId || (info.label === '한도 초과' && !resetReady(ri));
  $('#taskRunBtn').textContent = ri ? `▶ ${ri.label} 이후 이어서 실행` : '▶ 이어서 실행';
  setTaskStopVisible(false);
  setTaskInputsLocked(false);
  renderTaskPromptHistory(project);
  $('#taskDrawer').classList.remove('hidden');
  $('#actDrawer').classList.add('hidden');
}

function closeTask() {
  if (taskCtx && taskCtx.key && !taskCtx.running && !taskCtx.awaiting) {
    taskCtx.draft = $('#taskPrompt').value || taskCtx.draft || '';
  }
  $('#taskDrawer').classList.add('hidden');
  stopBackgroundTaskPoll();
  hideCommandPalettes();
  // 실행 중이거나 답변 대기(awaiting) 중에는 컨텍스트를 유지(드로어만 숨김).
  // → 레인의 '⏳ 진행 중' / '⏸ 답변 대기' 버튼으로 다시 열 수 있게.
  const hasDraft = !!(taskCtx && taskCtx.draftOpen && String(taskCtx.draft || '').trim());
  if (taskCtx && taskCtx.key && !taskCtx.running && !taskCtx.awaiting && !taskCtx.output && !taskCtx.sessionId && !hasDraft) removeTaskSession(taskCtx);
  else {
    persistTaskSessions();
    if (!(taskCtx && (taskCtx.running || taskCtx.awaiting))) taskCtx = null;
  }
  layout();
}
// 대화 완전 종료 (답변 대기 상태를 끝내고 작업요청 가능 상태로 복귀)
function endConversation() {
  $('#taskDrawer').classList.add('hidden');
  hideCommandPalettes();
  if (taskCtx && taskCtx.key) removeTaskSession(taskCtx);
  else taskCtx = null;
  setTaskPromptVisible(true);
  layout();
}
// 진행 중/대기 중인 작업 드로어를 다시 보여준다(초기화 없이 현재 스트리밍·질문 그대로).
function showTaskSession(ctx) {
  if (!ctx) return;
  if (ctx.lane && ctx.lane.kind === 'workstream') expandedLanes.add(workstreamGroupKey(ctx.project));
  focusBranchKey = branchAreaKey(ctx.project, ctx.branch || projectBranchKey(ctx.project));
  focusNext = true;
  const bg = backgroundTaskById(ctx.project, ctx.backgroundTaskId);
  if (bg) { openBackgroundTask(ctx.project, bg); return; }
  if (openTaskWindowPayload(taskWindowPayload('task-session', ctx.project, { task: ctx, lane: ctx.lane || null, discuss: ctx.discuss || null }))) return;
  renderTaskSession(ctx);
}

async function ensureTaskExecutionWorkspace(ctx, opts) {
  if (!ctx || !ctx.project || !opts) return opts;
  const branch = opts.branch || ctx.branch || projectBranchKey(ctx.project);
  opts.baseProjectPath = ctx.project.path;
  if (!ctx.project.git || !ctx.project.git.isRepo || !branch || branch === 'no-git' || !window.lodestar.ensureBranchWorktree) {
    opts.projectPath = ctx.project.path;
    ctx.executionPath = ctx.project.path;
    ctx.baseProjectPath = ctx.project.path;
    ctx.usingWorktree = false;
    return opts;
  }
  if (ctx.executionPath && ctx.executionBranch === branch) {
    opts.projectPath = ctx.executionPath;
    opts.baseProjectPath = ctx.baseProjectPath || ctx.project.path;
    opts.branch = ctx.branch || branch;
    return opts;
  }
  if (taskCtx === ctx) $('#taskStatus').textContent = `${branch} 브랜치 작업 공간을 준비하는 중…`;
  const res = await window.lodestar.ensureBranchWorktree(ctx.project.path, branch);
  if (!res || !res.ok) {
    const msg = (res && (res.stderr || res.error)) || 'unknown error';
    throw new Error(`브랜치 작업 공간 준비 실패: ${msg}`);
  }
  ctx.executionPath = res.projectPath || ctx.project.path;
  ctx.baseProjectPath = res.baseProjectPath || ctx.project.path;
  ctx.usingWorktree = !!res.usingWorktree;
  ctx.executionBranch = res.branch || branch;
  ctx.branch = res.branch || branch;
  opts.projectPath = ctx.executionPath;
  opts.baseProjectPath = ctx.baseProjectPath;
  opts.branch = ctx.branch;
  return opts;
}

// 현재 드로어 상태로 claude 에 보낼 옵션 구성
function taskOpts() {
  const opinion = $('#taskPrompt').value.trim() || ((taskCtx && taskCtx.canResume && taskCtx.sessionId) ? '이전 작업을 이어서 진행해줘.' : '');
  const startsFresh = isWccCommandText(opinion);
  const resumeSessionId = !startsFresh && taskCtx && taskCtx.canResume && taskCtx.sessionId ? taskCtx.sessionId : null;
  const d = taskCtx.discuss;
  if (d) {
    const question = taskCtx.pickedQuestion || d.question || '';
    const prompt = buildDiscussPrompt({ num: d.num, title: d.title, question }, opinion);
    return {
      projectPath: taskCtx.executionPath || taskCtx.project.path,
      baseProjectPath: taskCtx.project.path,
      prompt: startsFresh ? opinion : taskPromptWithScope(taskCtx.project, taskCtx.lane, prompt),
      historyPrompt: opinion,
      branch: taskCtx.branch || projectBranchKey(taskCtx.project),
      sessionId: resumeSessionId,
      clearContext: startsFresh,
      inbox: { phaseNum: d.num, phaseTitle: d.title, question, answer: opinion },
      workstream: taskCtx.lane && taskCtx.lane.kind === 'workstream' ? { name: taskCtx.lane.name } : null,
    };
  }
  return {
    projectPath: taskCtx.executionPath || taskCtx.project.path,
    baseProjectPath: taskCtx.project.path,
    prompt: promptWithMaybeClearedContext(taskCtx.project, taskCtx.lane, opinion),
    historyPrompt: opinion,
    branch: taskCtx.branch || projectBranchKey(taskCtx.project),
    sessionId: resumeSessionId,
    clearContext: startsFresh,
    workstream: taskCtx.lane && taskCtx.lane.kind === 'workstream' ? { name: taskCtx.lane.name } : null,
  };
}
// 대화형 한 턴 실행(스트리밍). label 이 있으면 출력 위에 구분선+내 답변을 먼저 기록.
async function runTaskTurn(opts, label) {
  const ctx = taskCtx;
  if (!ctx) return;
  registerTaskSession(ctx);
  try {
    opts = await ensureTaskExecutionWorkspace(ctx, opts);
  } catch (e) {
    ctx.running = false;
    ctx.statusText = `⚠ ${String(e && e.message || e)}`;
    if (taskCtx === ctx) $('#taskStatus').textContent = ctx.statusText;
    persistTaskSessions();
    return;
  }
  const clientRunId = newClientRunId(ctx);
  ctx.clientRunId = clientRunId;
  ctx.running = true;
  ctx.awaiting = false;
  ctx.restored = false;
  ctx.draftOpen = false;
  ctx.draft = '';
  ctx.backgroundTaskId = null;
  ctx.stopRequested = false;
  ctx.tokenUsage = null;
  ctx.lastPrompt = opts.prompt || '';
  ctx.statusText = '실행 중… (claude 작업 시작, 최대 10분)';
  opts.branch = opts.branch || ctx.branch || projectBranchKey(ctx.project);
  opts = { ...opts, clientRunId, backgroundOnly: true };
  const historyLabel = label ? label.replace(/^›\s*/, '') : ($('#taskRunBtn').textContent || '작업 실행');
  const historyPrompt = opts.historyPrompt || opts.prompt || '';
  savePromptHistoryItem(ctx.project, {
      label: historyLabel,
      prompt: historyPrompt,
      conversation: ctx.output || '',
      sessionId: ctx.sessionId || null,
      backgroundTaskId: ctx.backgroundTaskId || null,
      status: 'running',
  });
  renderTaskPromptHistory(ctx.project);
  syncTaskRunning();
  layout(); // 버튼 상태 반영
  $('#taskRun').classList.remove('hidden');
  updateTaskActivity('thinking', 'Claude가 요청을 해석하고 실행을 준비하고 있습니다.');
  $('#taskReplyRow').classList.remove('hidden');
  $('#taskReply').value = ctx.pendingInterjection || '';
  $('#taskReply').placeholder = '실행 중 전달할 메시지를 적어두세요. 현재 턴이 끝나면 같은 세션에 자동으로 보냅니다. (Ctrl+Enter)';
  $('#taskReplyBtn').textContent = ctx.pendingInterjection ? '예약됨' : '끝나면 보내기 ↵';
  setTaskInputsLocked(true);
  setTaskStopVisible(true, true);
  const out = $('#taskOut');
  ctx.output = ctx.output || '';
  if (label) ctx.output += (ctx.output ? '\n\n──────────\n' : '') + label + '\n\n──────────\n\n';
  setMarkdownOutput(out, ctx.output, { forceScroll: true });
  savePromptHistoryItem(ctx.project, {
    label: historyLabel,
    prompt: historyPrompt,
    conversation: ctx.output || '',
    sessionId: ctx.sessionId || null,
    backgroundTaskId: ctx.backgroundTaskId || null,
    status: 'running',
  });
  // 경과 시간 틱 — 도구 사용 전 조용한 구간에도 '진행 중'임을 보여준다
  const startedAt = Date.now();
  let lastChunkAt = startedAt;
  const fmt = (ms) => `${Math.floor(ms / 1000)}초`;
  const ticker = setInterval(() => {
    const idle = Date.now() - lastChunkAt;
    ctx.statusText =
      `실행 중… (${fmt(Date.now() - startedAt)} 경과 · 최대 10분)` +
      (idle > 4000 ? ` — claude 처리 중…` : '');
    if (taskCtx === ctx) $('#taskStatus').textContent = ctx.statusText;
    if (taskCtx === ctx) updateTaskActivity(idle > 4000 ? 'thinking' : taskActivityKind(), ctx.statusText);
  }, 1000);
  $('#taskStatus').textContent = '실행 중… (claude 작업 시작, 최대 10분)';
  const off = window.lodestar.onTaskProgress((payload) => {
    if (payload && typeof payload === 'object' && 'clientRunId' in payload) {
      if (payload.clientRunId !== clientRunId) return;
      payload = payload.chunk;
    }
    const chunk = payload;
    if (chunk && typeof chunk === 'object') {
      if (chunk.type === 'started') {
        ctx.backgroundTaskId = chunk.taskId;
        if (chunk.prompt) ctx.lastPrompt = chunk.prompt;
        if (taskCtx === ctx) setTaskStopVisible(true, true);
        if (ctx.stopRequested && taskCtx === ctx) {
          stopCurrentTask();
        }
        savePromptHistoryItem(ctx.project, {
          label: historyLabel,
          prompt: historyPrompt,
          conversation: ctx.output || '',
          sessionId: ctx.sessionId || null,
          backgroundTaskId: ctx.backgroundTaskId || null,
          status: 'running',
        });
      }
      if (chunk.type === 'usage') {
        ctx.tokenUsage = chunk.usage || null;
        if (taskCtx === ctx) setTaskTokenUsage(ctx.tokenUsage, ctx.quotaRemaining || null);
      }
      return;
    }
    lastChunkAt = Date.now();
    ctx.output = (ctx.output || '') + chunk;
    if (taskCtx === ctx) {
      updateTaskActivity('working', 'Claude 출력이 들어오고 있습니다.');
      scheduleMarkdownOutput(out, ctx.output);
    }
  });
  const res = await window.lodestar.runTask(opts);
  clearInterval(ticker);
  if (off) off();
  if (res && res.background && res.taskId && (res.running || res.stage === 'started')) {
    ctx.backgroundTaskId = res.taskId;
    ctx.running = true;
    ctx.awaiting = false;
    ctx.stopRequested = false;
    ctx.statusText = '실행 중입니다. 이 창이나 앱을 닫아도 작업은 계속 진행됩니다.';
    savePromptHistoryItem(ctx.project, {
      label: historyLabel,
      prompt: historyPrompt,
      conversation: ctx.output || '',
      sessionId: ctx.sessionId || null,
      backgroundTaskId: ctx.backgroundTaskId || null,
      status: 'running',
    });
    if (taskCtx === ctx) {
      $('#taskStatus').textContent = ctx.statusText;
      updateTaskActivity('thinking', ctx.statusText);
      setTaskInputsLocked(true);
      setTaskStopVisible(true, true);
      $('#taskRunBtn').disabled = true;
      $('#taskRunBtn').textContent = '실행 중…';
    }
    syncTaskRunning();
    pollTaskContextBackground(ctx);
    await refresh();
    return;
  }
  if (taskCtx === ctx) setTaskStopVisible(false);
  if (res.sessionId) ctx.sessionId = res.sessionId;
  if (res.tokenUsage) {
    ctx.tokenUsage = res.tokenUsage;
    if (taskCtx === ctx) setTaskTokenUsage(ctx.tokenUsage, ctx.quotaRemaining || null);
  }
  if (ctx.historySessionId || label) ctx.historySessionId = ctx.sessionId || ctx.historySessionId || null;
  // claude가 사용자에게 "질문하며 멈췄는지" 휴리스틱 판별 (멈춤 강조용)
  const asked = res.ok && isQuestion(res.output || '');
  const canResume = !!(ctx.sessionId && res.ok);
  ctx.awaiting = asked;
  ctx.asked = asked;
  ctx.canResume = canResume;
  ctx.running = false;
  ctx.stopRequested = false;
  ctx.excerpt = String(ctx.output || '').trim().slice(-1800);
  if (!asked) ctx.backgroundTaskId = null;
  if (!res.ok) ctx.statusText = res.stage === 'stopped'
    ? '⏹ 대화를 중단했습니다'
    : `⚠ ${stageMsg(res)} (exit ${res.exitCode ?? '?'})`;
  else if (asked) ctx.statusText = `⏸ claude가 질문했어요 — 아래에 답하면 이어서 진행합니다`;
  else ctx.statusText = `✓ 응답 완료${res.inboxFile ? ' · 인박스 기록됨' : ''} — 이어서 답하거나 ✕ 종료하세요`;
  if (taskCtx === ctx) $('#taskStatus').textContent = ctx.statusText;
  if (taskCtx === ctx) setTaskInputsLocked(false);
  savePromptHistoryItem(ctx.project, {
    label: historyLabel,
    prompt: historyPrompt,
    conversation: ctx.output || '',
    sessionId: ctx.sessionId || null,
    backgroundTaskId: ctx.backgroundTaskId || null,
    status: asked ? 'awaiting' : (!res.ok ? 'blocked' : 'completed'),
  });
  renderTaskPromptHistory(ctx.project);
  const pending = String(ctx.pendingInterjection || '').trim();
  ctx.pendingInterjection = '';
  if (pending && ctx.sessionId && taskCtx === ctx) {
    $('#taskReply').value = '';
    await runTaskTurn({
      projectPath: ctx.project.path,
      prompt: pending,
      historyPrompt: pending,
      branch: ctx.branch || projectBranchKey(ctx.project),
      sessionId: ctx.sessionId,
    }, `› 중간 메시지: ${pending}`);
    return;
  } else if (pending && taskCtx === ctx) {
    ctx.pendingInterjection = pending;
    $('#taskReply').value = pending;
    $('#taskStatus').textContent = '⚠ 세션 ID를 아직 찾지 못해 중간 메시지를 보류했습니다';
  }
  // 세션이 살아있으면 후속 답변 입력행 노출 — claude가 갈림길에서 물어봤을 수 있음
  if (canResume && taskCtx === ctx) {
    $('#taskReplyRow').classList.remove('hidden');
    $('#taskReplyBtn').textContent = '보내기 ↵';
    $('#taskReply').placeholder = '이 대화에 이어서 보낼 메시지를 입력하세요. (Ctrl+Enter)';
    setTimeout(() => $('#taskReply').focus(), 50);
  }
  syncTaskRunning();
  await refresh();
}

// claude 출력이 사용자에게 던진 질문으로 끝나는지 대략 판별 (멈춤 표시 강조용)
function isQuestion(text) {
  const tail = text.slice(-400);
  if (/[?？]\s*$/.test(tail.trim())) return true;
  return /(어느 것|어떤 (걸|것|쪽|방향)|선택해|골라|할까요|하시겠|하실래|알려주세요|진행할까|맞나요|괜찮(을까|나요)|1\)|①|\[1\])/.test(tail);
}

async function doTaskRun() {
  if (activeTaskRunning()) return;
  if (taskCtx && taskCtx.external && (taskCtx.resumeMode === 'blocked' || taskCtx.resumeMode === 'history')) {
    if (!taskCtx.sessionId) {
      $('#taskStatus').textContent = '⚠ 이어갈 Claude 세션 ID를 찾지 못했습니다.';
      return;
    }
    $('#taskRunBtn').disabled = true;
    const opts = {
      projectPath: taskCtx.project.path,
      prompt: taskCtx.resumePrompt || '이전 작업을 이어서 진행해줘.',
      historyPrompt: taskCtx.resumePrompt || '이전 작업을 이어서 진행해줘.',
      branch: taskCtx.branch || projectBranchKey(taskCtx.project),
      sessionId: taskCtx.sessionId,
    };
    taskCtx.lastPrompt = opts.prompt;
    await runTaskTurn(opts, taskCtx.resumeMode === 'history' ? '› 히스토리 세션 이어서 실행' : '› 이어서 실행');
    $('#taskRunBtn').disabled = activeTaskRunning();
    return;
  }
  if (!$('#taskPrompt').value.trim() && !(taskCtx && taskCtx.canResume && taskCtx.sessionId)) { $('#taskPrompt').focus(); return; } // 빈 지시 방지
  $('#taskRunBtn').disabled = true;
  setMarkdownOutput('#taskOut', '');
  const opts = taskOpts();
  if (taskCtx) taskCtx.lastPrompt = opts.prompt;
  const submitted = String(opts.historyPrompt || opts.prompt || '').trim();
  const visibleLabel = submitted
    ? (isWccCommandText(submitted) ? `› WCC 새 세션: ${submitted}` : `› 나: ${submitted}`)
    : '› 이어서 진행';
  await runTaskTurn(opts, visibleLabel);
  $('#taskRunBtn').disabled = activeTaskRunning();
}

// 후속 답변 → 같은 세션(--resume)으로 이어서 진행
async function doTaskReply() {
  if (!taskCtx) return;
  if (activeTaskRunning()) {
    const text = $('#taskReply').value.trim();
    if (!text) { $('#taskReply').focus(); return; }
    taskCtx.pendingInterjection = text;
    $('#taskReplyBtn').textContent = '예약됨';
    $('#taskStatus').textContent = '실행 중… 현재 턴이 끝나면 중간 메시지를 이어서 보냅니다';
    return;
  }
  if (!taskCtx.sessionId) {
    $('#taskStatus').textContent = '⚠ 이어갈 Claude 세션 ID를 찾지 못했습니다. 터미널에서 직접 답변하거나 새 작업 요청을 시작하세요.';
    return;
  }
  const text = $('#taskReply').value.trim();
  if (!text) { $('#taskReply').focus(); return; }
  $('#taskReply').value = '';
  taskCtx.awaiting = false; taskCtx.asked = false;
  const d = taskCtx.discuss;
  const startsFresh = isWccCommandText(text);
  const opts = {
    projectPath: taskCtx.project.path,
    prompt: text,
    branch: taskCtx.branch || projectBranchKey(taskCtx.project),
    sessionId: startsFresh ? null : taskCtx.sessionId,
    clearContext: startsFresh,
  };
  opts.historyPrompt = text;
  if (d) opts.inbox = { phaseNum: d.num, phaseTitle: d.title, question: '(후속)', answer: text };
  taskCtx.lastPrompt = opts.prompt;
  await runTaskTurn(opts, startsFresh ? `› WCC 새 세션: ${text}` : `› 내 답변: ${text}`);
}

async function stopCurrentTask() {
  if (!taskCtx || !window.lodestar.stopTask) return;
  const ctx = taskCtx;
  for (const btn of [$('#taskStopBtn'), $('#taskStopInlineBtn')]) {
    if (btn) btn.disabled = true;
  }
  ctx.stopRequested = true;
  updateTaskActivity('stopping', '현재 Claude 작업을 중단하고 있습니다.');
  $('#taskStatus').textContent = ctx.backgroundTaskId ? '중단 중…' : '중단 예약됨 — 실행 프로세스가 연결되는 즉시 중단합니다.';
  if (!ctx.backgroundTaskId) {
    setTaskStopVisible(true, false);
    return;
  }
  const res = await window.lodestar.stopTask(ctx.backgroundTaskId);
  if (!res || !res.ok) {
    $('#taskStatus').textContent = `⚠ 중지 실패${res && res.error ? ': ' + truncate(res.error, 100) : ''}`;
    setTaskStopVisible(true, true);
    return;
  }
  ctx.running = false;
  ctx.stopRequested = false;
  ctx.awaiting = false;
  ctx.canResume = false;
  ctx.statusText = '중단했습니다';
  syncTaskRunning();
  setTaskStopVisible(false);
  if (taskCtx === ctx) setTaskInputsLocked(false);
  if (taskCtx === ctx) $('#taskStatus').textContent = ctx.statusText;
  await refresh();
}

function injOpts() {
  return {
    projectPath: drawerCtx.project.path, projectName: drawerCtx.project.name,
    phaseNum: drawerCtx.phase.num, phaseTitle: drawerCtx.phase.title,
    question: $('#injQuestion').value.trim(), answer: $('#injAnswer').value.trim(),
  };
}
async function doPreview() {
  const answer = $('#injAnswer').value.trim();
  if (!answer) { $('#injAnswer').focus(); return; }
  const pv = await window.lodestar.previewInject(injOpts());
  $('#cvPath').textContent = pv.claudePath;
  $('#cvCwd').textContent = pv.cwd;
  $('#cvInbox').textContent = pv.inboxFile;
  $('#cvPrompt').textContent = pv.prompt;
  $('#confirmPanel').classList.remove('hidden');
  $('#btnPreview').classList.add('hidden');
  $('#btnConfirmRun').classList.remove('hidden');
}
async function doRun() {
  $('#btnConfirmRun').disabled = true;
  $('#runPanel').classList.remove('hidden');
  $('#runStatus').textContent = '실행 중… (claude -p 호출)';
  let runOutput = '';
  setMarkdownOutput('#runOut', runOutput);
  const off = window.lodestar.onInjectProgress((chunk) => {
    runOutput += chunk;
    scheduleMarkdownOutput('#runOut', runOutput);
  });
  const res = await window.lodestar.runInject(injOpts());
  if (off) off();
  if (res.ok) $('#runStatus').textContent = `✓ 완료 — 인박스 기록: ${res.inboxFile}`;
  else $('#runStatus').textContent = `⚠ ${stageMsg(res)} (원답 ${res.rawSaved ? '저장됨' : '미저장'})`;
  $('#btnConfirmRun').disabled = false;
  await refresh();
}
function stageMsg(res) {
  const m = { 'write-raw': '인박스 쓰기 실패', spawn: 'claude 실행 불가', exec: 'claude 오류', timeout: 'claude 시간 초과', stopped: '대화 중단됨', stale: '실행 상태 확인 불가' };
  return (m[res.stage] || 'claude -p 실패') + (res.error ? `: ${truncate(res.error, 100)}` : '');
}

// ---------- 새로고침 ----------
// 직전 스냅샷(노드별 단계)을 기억해, 자동 갱신 시 "방금 바뀐" 노드를 플래시한다.
let prevSnapshot = {};   // key "path|num" -> stage
let flashKeys = new Set();

function snapshotStages(list) {
  const snap = {};
  for (const p of list) {
    for (const ph of (p.phases || [])) {
      snap[`${p.path}|${ph.num}`] = ph.stage + (ph.isCurrent ? '*' : '') + `:${ph.plans ? ph.plans.done : 0}`;
    }
  }
  return snap;
}

async function refresh(opts = {}) {
  const auto = !!opts.auto;
  if (refreshBusy) {
    if (auto) refreshQueuedAuto = true;
    return;
  }
  refreshBusy = true;
  if (!auto) { $('#btnRefresh').disabled = true; $('#btnRefresh').textContent = '스캔 중…'; }
  try {
    const next = await window.lodestar.scan();
    // diff: 자동 갱신일 때만 변경 노드 플래시
    flashKeys = new Set();
    if (auto && Object.keys(prevSnapshot).length) {
      const nextSnap = snapshotStages(next);
      for (const k in nextSnap) {
        if (prevSnapshot[k] !== undefined && prevSnapshot[k] !== nextSnap[k]) flashKeys.add(k);
      }
    }
    projects = next.map(normalizeProjectActivity);
    restoreTaskSessionsForProjects(projects);
    prevSnapshot = snapshotStages(projects);
    renderSidebar();
    renderAttention();
    updateAttentionBadges(projects);
    layout();
    const t = new Date().toLocaleTimeString('ko-KR');
    $('#lastScan').textContent = (auto ? '⚡ 자동 ' : '갱신 ') + t;
    if (flashKeys.size) pulseLive();
    // 활동 패널이 열려 있으면 실시간 갱신
    if (activityCtx && !$('#actDrawer').classList.contains('hidden')) {
      const updated = projects.find(p => p.path === activityCtx.path);
      if (updated) openActivity(updated, activityCtx.scope || null);
    }
  } finally {
    refreshBusy = false;
    if (!auto) { $('#btnRefresh').disabled = false; $('#btnRefresh').textContent = '↻ 새로고침'; }
    if (refreshQueuedAuto) {
      refreshQueuedAuto = false;
      scheduleAutoRefresh();
    }
  }
}

function scheduleAutoRefresh() {
  if (interacting) { pendingRefresh = true; return; }
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
  const inputQuietFor = Date.now() - lastTextInputAt;
  const interactQuietFor = Date.now() - lastInteractionAt;
  const delay = Math.max(
    inputQuietFor < 1600 ? 1600 - inputQuietFor : 350,
    interactQuietFor < POST_INTERACTION_REFRESH_MS ? POST_INTERACTION_REFRESH_MS - interactQuietFor : 0,
  );
  autoRefreshTimer = setTimeout(() => {
    autoRefreshTimer = null;
    refresh({ auto: true });
  }, delay);
}

function markTextInputActive() {
  lastTextInputAt = Date.now();
}

// 라이브 인디케이터 깜빡임
function pulseLive() {
  const el = $('#liveDot');
  if (!el) return;
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
}

// ---------- 테마 ----------
function toggleTheme() {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
}

// ---------- 이벤트 ----------
$('#btnAdd').addEventListener('click', async () => { projects = await window.lodestar.addProjects(); await refresh(); });
$('#btnRefresh').addEventListener('click', () => refresh());
$('#zoomIn').addEventListener('click', () => zoomBy(1.15));
$('#zoomOut').addEventListener('click', () => zoomBy(0.87));
$('#zoomFit').addEventListener('click', zoomFit);
$('#themeToggle').addEventListener('click', toggleTheme);
$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerOverlay').addEventListener('click', closeDrawer);
$('#btnCancel').addEventListener('click', closeDrawer);
$('#btnPreview').addEventListener('click', doPreview);
$('#btnConfirmRun').addEventListener('click', doRun);
$('#actClose').addEventListener('click', closeActivity);
$('#actOverlay').addEventListener('click', closeActivity);
$('#agClose').addEventListener('click', closeAgentDetail);
$('#agOverlay').addEventListener('click', closeAgentDetail);
$('#gitClose').addEventListener('click', closeGitSwitch);
$('#gitOverlay').addEventListener('click', closeGitSwitch);
$('#gitCancel').addEventListener('click', closeGitSwitch);
$('#gitFilter').addEventListener('input', renderGitBranches);
$('#gitFilter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeGitSwitch(); }
  if (e.key === 'Enter') { e.preventDefault(); switchGitTo($('#gitFilter').value); }
});
$('#gitSwitchInput').addEventListener('click', () => switchGitTo($('#gitFilter').value));
$('#branchSessionClose').addEventListener('click', closeBranchSessionPicker);
$('#branchSessionOverlay').addEventListener('click', closeBranchSessionPicker);
$('#branchSessionCancel').addEventListener('click', closeBranchSessionPicker);
$('#branchSessionFilter').addEventListener('input', renderBranchSessionBranches);
$('#branchSessionFilter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeBranchSessionPicker(); }
  if (e.key === 'Enter') { e.preventDefault(); startBranchSession($('#branchSessionFilter').value); }
});
$('#branchSessionNewName').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeBranchSessionPicker(); }
  if (e.key === 'Enter') { e.preventDefault(); startBranchSession($('#branchSessionNewName').value); }
});
$('#branchSessionCreate').addEventListener('click', () => startBranchSession($('#branchSessionNewName').value));
$('#taskClose').addEventListener('click', closeTask);
$('#taskOverlay').addEventListener('click', closeTask);
$('#taskCancel').addEventListener('click', closeTask);
$('#taskStopBtn').addEventListener('click', stopCurrentTask);
const taskStopInlineBtn = $('#taskStopInlineBtn');
if (taskStopInlineBtn) taskStopInlineBtn.addEventListener('click', stopCurrentTask);
$('#taskRunBtn').addEventListener('click', doTaskRun);
$('#taskPrompt').addEventListener('keydown', (e) => {
  if (activeTaskRunning()) { e.preventDefault(); return; }
  if (handleCommandPaletteKey(e)) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doTaskRun(); }
});
$('#taskPrompt').addEventListener('input', () => {
  markTextInputActive();
  if (activeTaskRunning()) return;
  if (taskCtx && taskCtx.key && !taskCtx.awaiting) {
    taskCtx.draft = $('#taskPrompt').value;
    if (!taskCtx.sessionId && !taskCtx.backgroundTaskId && !taskCtx.output) {
      taskCtx.draftOpen = true;
      taskCtx.statusText = '새 세션 작성 중';
    }
    taskSessions.set(taskCtx.key, taskCtx);
    queueTaskDraftPersist();
  }
  commandActiveIndex = 0; scheduleSkillSuggest();
});
$('#taskPrompt').addEventListener('focus', renderSkillSuggest);
$('#taskReplyBtn').addEventListener('click', doTaskReply);
$('#taskReply').addEventListener('keydown', (e) => {
  if (handleCommandPaletteKey(e)) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doTaskReply(); }
});
$('#taskReply').addEventListener('input', () => {
  markTextInputActive();
  if (activeTaskRunning() && taskCtx) {
    taskCtx.pendingInterjection = $('#taskReply').value;
    $('#taskReplyBtn').textContent = taskCtx.pendingInterjection.trim() ? '끝나면 보내기 ↵' : '끝나면 보내기 ↵';
    return;
  }
  commandActiveIndex = 0; scheduleSkillSuggest();
});
$('#taskReply').addEventListener('focus', renderSkillSuggest);
bindTaskActivityStatusObserver();

// 자동 감시 (WCC 진행 실시간 반영) — main의 watch 알림에 반응
// 단, 드래그/줌 중에는 보류했다가 상호작용이 끝나면 1회 처리 (팬 버벅임 방지)
if (window.lodestar.onProjectsChanged) {
  window.lodestar.onProjectsChanged(() => {
    scheduleAutoRefresh();
  });
}

// ---------- 초기화 ----------
(async () => {
  if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark');
  setupPanZoom();
  applyTransform();
  await loadClaudeSkills();
  const stored = await window.lodestar.listProjects();
  if (stored && stored.length) await refresh();
  else { renderSidebar(); layout(); }
})();
