'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveClaude, buildTaskArgs, inboxPath } = require('./claudeRunner');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function appendInbox(file, block) {
  let header = '';
  if (!fs.existsSync(file)) {
    header = `# Phase 논의 의견 인박스 (Lodestar)\n\n` +
      `> Lodestar 상황판에서 주입한 사용자 의견 기록. GSD discuss/plan 시 참고용.\n` +
      `> 소스코드와 무관한 노트 파일이며 자유롭게 삭제 가능합니다.\n\n`;
  }
  fs.appendFileSync(file, header + block, 'utf8');
}

function nowIso() { return new Date().toISOString(); }

function update(file, patch) {
  const cur = readJson(file) || {};
  const next = { ...cur, ...patch, updatedAt: nowIso() };
  writeJson(file, next);
  return next;
}

function stopped(file) {
  const cur = readJson(file);
  return cur && cur.status === 'stopped';
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

function main() {
  const taskFile = process.argv[2];
  if (!taskFile) process.exit(2);
  const state = readJson(taskFile);
  if (!state || !state.projectPath || !state.prompt) {
    update(taskFile, { status: 'failed', error: 'invalid background task state' });
    process.exit(2);
  }

  const claude = resolveClaude();
  const args = buildTaskArgs({ prompt: state.prompt, sessionId: state.sessionId });
  let stderr = '';
  let finalResult = '';
  let assistantText = state.output || '';
  let buf = '';
  let isError = false;
  let done = false;
  let tokenUsage = state.tokenUsage || null;

  const ibFile = state.inbox ? inboxPath(state.projectPath, state.inbox.phaseNum) : null;
  if (ibFile && !state.sessionId) {
    try {
      appendInbox(ibFile,
        `## ${nowIso()} — Phase ${state.inbox.phaseNum} (${state.inbox.phaseTitle}) 의견 (claude 작업 요청)\n\n` +
        `**질문/맥락:**\n${state.inbox.question || '(자유 의견)'}\n\n` +
        `**내 의견:**\n${state.inbox.answer || ''}\n\n`);
    } catch {}
  } else if (ibFile && state.sessionId) {
    try { appendInbox(ibFile, `**내 후속 답변 (${nowIso()}):**\n${state.prompt}\n\n`); } catch {}
  }

  function handleLine(line) {
    let o; try { o = JSON.parse(line); } catch { return; }
    if (o.session_id) update(taskFile, { sessionId: o.session_id });
    const usage = tokenUsageFromEvent(o);
    if (usage) {
      tokenUsage = o.type === 'result' ? usage : mergeTokenUsage(tokenUsage, usage);
      update(taskFile, { tokenUsage });
    }
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const part of o.message.content) {
        if (part.type === 'text' && part.text) {
          assistantText += part.text;
          update(taskFile, { output: assistantText });
        } else if (part.type === 'tool_use') {
          // Tool calls are shown in the activity timeline. Keep the chat
          // transcript focused on Claude's actual text response.
        }
      }
    } else if (o.type === 'result') {
      finalResult = (o.result || '').trim();
      isError = !!o.is_error;
    }
  }

  let child;
  try {
    child = spawn(claude, args, {
      cwd: state.projectPath,
      shell: claude === 'claude',
      windowsHide: true,
    });
  } catch (e) {
    update(taskFile, { status: 'failed', stage: 'spawn', error: String(e), stderr });
    process.exit(1);
  }
  update(taskFile, { status: 'running', pid: child.pid, claudePath: claude });
  try { child.stdin && child.stdin.end(); } catch {}

  const timeout = setTimeout(() => {
    if (done) return;
    done = true;
    try { child.kill(); } catch {}
    if (stopped(taskFile)) process.exit(1);
    update(taskFile, { status: 'timeout', stage: 'timeout', error: '600s 초과', output: assistantText.trim(), stderr, tokenUsage });
    process.exit(1);
  }, 600000);

  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    update(taskFile, { stderr });
  });
  child.on('error', (e) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    if (stopped(taskFile)) process.exit(1);
    update(taskFile, { status: 'failed', stage: 'exec', error: String(e), stderr });
    process.exit(1);
  });
  child.on('close', (code) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    if (stopped(taskFile)) process.exit(1);
    if (buf.trim()) handleLine(buf.trim());
    const out = finalResult || assistantText.trim();
    if (ibFile) {
      try { appendInbox(ibFile, `**claude 응답 (exit ${code}):**\n${out || '(출력 없음)'}\n\n---\n\n`); } catch {}
    }
    update(taskFile, {
      status: code === 0 && !isError ? 'completed' : 'failed',
      exitCode: code,
      output: out,
      stderr,
      tokenUsage,
      inboxFile: ibFile,
    });
    process.exit(code === 0 && !isError ? 0 : 1);
  });
}

main();
