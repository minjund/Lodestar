'use strict';

// 사용자의 논의 답변을 해당 프로젝트의 .planning/NN-DISCUSS-INBOX.md 에 기록하고,
// claude -p 를 프로젝트 맥락에서 호출해 "정리된 의견"을 같은 파일에 덧붙인다.
// - 소스코드는 절대 수정하지 않는다 (인박스 노트 파일만 작성).
// - claude -p 호출은 "되돌릴 수 없는 외부 단계"이므로 UI에서 확인 게이트를 거친 뒤에만 부른다.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const os = require('os');

// claude 실행 파일 경로 해석
function resolveClaude() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
  ];
  for (const c of candidates) {
    try { fs.accessSync(c); return c; } catch {}
  }
  // PATH 에 의존 (shell:true 로 spawn)
  return 'claude';
}

// Lodestar는 대화형 실행이다(세션 resume 으로 사용자가 이어서 답함).
// 사소한 결정은 가정으로 진행하되, 중요한 갈림길에서는 멈춰서 사용자에게 물어보게 한다.
const FORK_SYS = [
  '이 작업은 Lodestar의 대화형 실행입니다. 사용자가 같은 세션에서 이어서 답변할 수 있습니다.',
  '사소하거나 명백한 결정은 합리적인 가정을 세워 그대로 진행하세요.',
  '그러나 무엇을 빌드/구현할지, 핵심 설계·범위·방향 같은 중요한 갈림길에서는 임의로 결정하지 말고,',
  '한국어로 명확한 질문을 제시한 뒤 거기서 멈추세요(그 이상 작업을 진행하지 말 것).',
  '질문할 때는 선택지가 있으면 번호로 함께 제시하세요. 사용자가 답하면 그 답을 반영해 이어서 진행합니다.',
  '한 단계가 끝나면 무엇을 했는지 또는 무엇을 묻는지 한국어로 간단히 정리하세요.',
].join(' ');

function normalizeWccPrompt(prompt) {
  return String(prompt || '')
    .replace(/^\/wcc:([\w-]+)(?=\s|$)/i, '/wcc-$1')
    .replace(/^wcc[:\s]+(quick|debug|review|phase|workstreams?|autonomous|help|config|profile-user|progress|verify-work)\b/i, '/wcc-$1');
}

function buildTaskArgs({ prompt, sessionId }) {
  prompt = normalizeWccPrompt(prompt);
  const args = ['-p', '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', FORK_SYS,
    '--output-format', 'stream-json', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  args.push(prompt);
  return args;
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

function pad2(n) { return String(n).padStart(2, '0'); }

function readSkillSummary(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const heading = lines.find(l => /^#\s+/.test(l));
  const body = lines.find(l => !/^#|^---|^name:|^description:/i.test(l));
  const desc = lines.find(l => /^description:/i.test(l));
  return (desc ? desc.replace(/^description:\s*/i, '') : (body || heading || '')).slice(0, 180);
}

function markdownSummary(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const desc = lines.find(l => /^description:/i.test(l));
  if (desc) return desc.replace(/^description:\s*/i, '').replace(/^["']|["']$/g, '').slice(0, 180);
  const heading = lines.find(l => /^#\s+/.test(l));
  const body = lines.find(l => !/^#|^---|^allowed-tools:|^argument-hint:/i.test(l));
  return (body || heading || '').replace(/^#\s+/, '').slice(0, 180);
}

function markdownDetail(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  const lines = text.split(/\r?\n/).filter(l => !/^\s*allowed-tools:|^\s*argument-hint:/i.test(l));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1600);
}

function commandName(root, file) {
  const rel = path.relative(root, file).replace(/\\/g, '/').replace(/\.md$/i, '');
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return `/${parts[0]}`;
  if (parts[0].toLowerCase() === 'wcc') return `/wcc-${parts.slice(1).join('-')}`;
  return `/${parts.slice(0, -1).join(':')}:${parts[parts.length - 1]}`;
}

function walkMarkdown(root, out = [], seenDirs = new Set(), depth = 0) {
  if (depth > 5) return out;
  let real = '';
  try { real = fs.realpathSync(root); } catch { return out; }
  if (seenDirs.has(real)) return out;
  seenDirs.add(real);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try { isDir = fs.statSync(p).isDirectory(); } catch {}
    }
    if (isDir) walkMarkdown(p, out, seenDirs, depth + 1);
    else if (/\.md$/i.test(e.name)) out.push(p);
  }
  return out;
}

function listMarkdownFiles(root) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isFile() && /\.md$/i.test(e.name))
    .map(e => path.join(root, e.name));
}

function addCommand(commands, seen, item) {
  if (!item.name || seen.has(item.name)) return;
  seen.add(item.name);
  commands.push(item);
}

function sourceKind(file, projectPath) {
  if (projectPath && file.startsWith(path.join(projectPath, '.claude'))) return 'project';
  if (file.includes(path.join(os.homedir(), '.claude', 'wincubecode'))) return 'wcc';
  if (file.includes(path.join(os.homedir(), '.claude', 'wcc-local-patches'))) return 'wcc-patch';
  if (file.includes(path.join(os.homedir(), '.claude', 'skills'))) return 'skill';
  return file.includes(path.join(os.homedir(), '.claude')) ? 'user' : 'project';
}

function listClaudeCommands(projectPath) {
  const commandRoots = [
    path.join(os.homedir(), '.claude', 'commands'),
    path.join(os.homedir(), '.claude', 'wincubecode', 'commands'),
    path.join(os.homedir(), '.claude', 'wcc-local-patches', 'commands'),
  ];
  if (projectPath) commandRoots.push(path.join(projectPath, '.claude', 'commands'));
  commandRoots.push(path.join(process.cwd(), '.claude', 'commands'));
  const seen = new Set();
  const commands = [];
  for (const root of commandRoots) {
    for (const file of walkMarkdown(root)) {
      const name = commandName(root, file);
      if (!name || seen.has(name)) continue;
      addCommand(commands, seen, {
        name,
        summary: markdownSummary(file),
        detail: markdownDetail(file),
        source: sourceKind(file, projectPath),
      });
    }
  }

  // WCC exposes many commands as workflow bodies and Claude Skills rather than
  // command wrappers. Surface those as /wcc-* suggestions because Claude Code
  // registers the actual slash commands with hyphenated names.
  const workflowRoots = [
    path.join(os.homedir(), '.claude', 'wincubecode', 'workflows'),
    path.join(os.homedir(), '.claude', 'wcc-local-patches', 'wincubecode', 'workflows'),
  ];
  for (const root of workflowRoots) {
    for (const file of listMarkdownFiles(root)) {
      const base = path.basename(file, '.md');
      if (!base || base.toLowerCase() === 'readme') continue;
      addCommand(commands, seen, {
        name: `/wcc-${base}`,
        summary: markdownSummary(file),
        detail: markdownDetail(file),
        source: sourceKind(file, projectPath),
      });
    }
  }

  const skillRoots = [
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(process.cwd(), '.claude', 'skills'),
  ];
  for (const root of skillRoots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !/^wcc[-:]/i.test(e.name)) continue;
      const skillFile = path.join(root, e.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const slug = e.name.replace(/^wcc[-:]/i, '').replace(/_/g, '-');
      addCommand(commands, seen, {
        name: `/wcc-${slug}`,
        summary: markdownSummary(skillFile),
        detail: markdownDetail(skillFile),
        source: sourceKind(skillFile, projectPath),
      });
    }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function listClaudeSkills() {
  const roots = [
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(process.cwd(), '.claude', 'skills'),
  ];
  const seen = new Set();
  const skills = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (seen.has(e.name)) continue;
      const skillDir = path.join(root, e.name);
      let isDir = e.isDirectory();
      if (!isDir) {
        try { isDir = fs.statSync(skillDir).isDirectory(); } catch {}
      }
      if (!isDir) continue;
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      seen.add(e.name);
      skills.push({
        name: e.name,
        summary: readSkillSummary(skillFile),
        source: root.includes(path.join(os.homedir(), '.claude')) ? 'user' : 'project',
      });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function inboxPath(projectPath, phaseNum) {
  return path.join(projectPath, '.planning', `${pad2(phaseNum)}-DISCUSS-INBOX.md`);
}

function buildPrompt({ projectName, phaseNum, phaseTitle, question, answer }) {
  return [
    `당신은 의견 전달 보조자입니다. GSD 프로젝트 "${projectName}"의 Phase ${phaseNum} (${phaseTitle}) 논의에 대한`,
    `개발자(사용자)의 의견을 GSD 다운스트림 에이전트가 읽기 좋게 정리하는 것이 임무입니다.`,
    ``,
    `다음 형식의 한국어 텍스트만 출력하세요 (어떤 파일도 직접 쓰지 말고, 소스 코드도 절대 수정하지 마세요):`,
    `1) 핵심 입장 (한두 문장)`,
    `2) 근거`,
    `3) 결정 제안 (다운스트림이 바로 반영할 수 있게 구체적으로)`,
    ``,
    `[논의 질문/맥락]`,
    question || '(질문 명시 없음 — 사용자가 자유 의견 제시)',
    ``,
    `[사용자 의견 원문]`,
    answer,
  ].join('\n');
}

// 확인 게이트용: 실제로 실행될 내용 미리보기
function previewInjection(opts) {
  const claude = resolveClaude();
  return {
    claudePath: claude,
    cwd: opts.projectPath,
    inboxFile: inboxPath(opts.projectPath, opts.phaseNum),
    prompt: buildPrompt(opts),
  };
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

// 메인: 답변 주입 실행
function injectAnswer(opts, onData) {
  return new Promise((resolve) => {
    const { projectPath, phaseNum, phaseTitle, question, answer } = opts;
    const file = inboxPath(projectPath, phaseNum);
    const ts = new Date().toISOString();

    // 1) 사용자 원답을 먼저 기록 (보장 — claude 실패해도 답은 남는다)
    const rawBlock =
      `## ${ts} — Phase ${phaseNum} (${phaseTitle}) 의견 주입\n\n` +
      `**질문/맥락:**\n${question || '(자유 의견)'}\n\n` +
      `**내 답 (원문):**\n${answer}\n\n`;
    try {
      appendInbox(file, rawBlock);
    } catch (e) {
      resolve({ ok: false, stage: 'write-raw', error: String(e), inboxFile: file });
      return;
    }

    // 2) claude -p 로 맥락 정리 호출
    const claude = resolveClaude();
    const prompt = buildPrompt(opts);
    const args = ['-p', prompt];
    let stdout = '';
    let stderr = '';
    let done = false;

    let child;
    try {
      child = spawn(claude, args, {
        cwd: projectPath,
        shell: claude === 'claude', // PATH 의존 시 shell 사용
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, stage: 'spawn', error: String(e), inboxFile: file, rawSaved: true });
      return;
    }
    // stdin을 즉시 닫아 claude의 "no stdin data received in 3s" 대기를 방지한다.
    try { child.stdin && child.stdin.end(); } catch {}

    const timeout = setTimeout(() => {
      if (!done) { done = true; try { child.kill(); } catch {}
        const note = `**claude -p 정리:** (시간 초과 — 원답만 저장됨)\n\n---\n\n`;
        try { appendInbox(file, note); } catch {}
        resolve({ ok: false, stage: 'timeout', error: '120s 초과', inboxFile: file, rawSaved: true });
      }
    }, 120000);

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onData) onData(s);
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timeout);
      const note = `**claude -p 정리:** (실행 실패: ${String(e)} — 원답만 저장됨)\n\n---\n\n`;
      try { appendInbox(file, note); } catch {}
      resolve({ ok: false, stage: 'exec', error: String(e), stderr, inboxFile: file, rawSaved: true });
    });

    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timeout);
      const cleaned = stdout.trim();
      const note = cleaned
        ? `**claude -p 정리:**\n${cleaned}\n\n---\n\n`
        : `**claude -p 정리:** (출력 없음, exit ${code})\n\n---\n\n`;
      try { appendInbox(file, note); } catch {}
      resolve({
        ok: code === 0 && !!cleaned,
        exitCode: code,
        output: cleaned,
        stderr,
        inboxFile: file,
        rawSaved: true,
      });
    });
  });
}

// ---------- 범용 작업 요청 (claude -p 로 프로젝트에서 직접 작업) ----------
// 터미널/세션을 못 찾을 때 Lodestar에서 바로 claude -p 에 작업을 시킨다.
// 실제 파일 변경이 가능한 강력한 동작이므로 UI 확인 게이트 후에만 호출한다.
function previewTask(opts) {
  return {
    claudePath: resolveClaude(),
    cwd: opts.projectPath,
    prompt: opts.prompt || '',
    inboxFile: opts.inbox ? inboxPath(opts.projectPath, opts.inbox.phaseNum) : null,
  };
}

function taskId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function resolveNodeRuntime() {
  const explicit = process.env.LODESTAR_NODE || process.env.npm_node_execpath;
  if (explicit && /node(?:\.exe)?$/i.test(path.basename(explicit))) {
    try { fs.accessSync(explicit); return explicit; } catch {}
  }
  try {
    const out = execFileSync('where.exe', ['node'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (out[0]) return out[0];
  } catch {}
  try {
    const out = execFileSync('which', ['node'], {
      encoding: 'utf8', timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (out[0]) return out[0];
  } catch {}
  return 'node';
}

function materializeBackgroundRunner(taskDir) {
  const runnerDir = path.join(taskDir, '_runner');
  fs.mkdirSync(runnerDir, { recursive: true });
  for (const name of ['backgroundTaskRunner.js', 'claudeRunner.js']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(runnerDir, name));
  }
  return path.join(runnerDir, 'backgroundTaskRunner.js');
}

function taskStateFile(taskDir, id) {
  return path.join(taskDir, `${id}.json`);
}

function pidAlive(pid) {
  const n = parseInt(pid, 10);
  if (!n) return false;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${n}`, '/NH'], {
        encoding: 'utf8',
        timeout: 1500,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return new RegExp(`\\b${n}\\b`).test(out);
    } catch {}
  }
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

function normalizeBackgroundTask(file, task) {
  if (!task || isTerminalStatus(task.status)) return task;
  if (task.status !== 'running' && task.status !== 'queued') return task;
  const STALE_SUSPECT_GRACE_MS = 2 * 60 * 1000;
  const STALE_OLD_TASK_MS = 60 * 60 * 1000;
  const updatedAt = Date.parse(task.updatedAt || task.startedAt || '') || 0;
  const ageMs = updatedAt ? Date.now() - updatedAt : Infinity;
  const hasLiveProcess = pidAlive(task.pid) || pidAlive(task.runnerPid);
  const hasAnyPid = !!(parseInt(task.pid, 10) || parseInt(task.runnerPid, 10));
  if (hasLiveProcess) {
    if (task.staleSuspectedAt) {
      const next = { ...task };
      delete next.staleSuspectedAt;
      writeJson(file, next);
      return next;
    }
    return task;
  }
  if (!hasAnyPid && ageMs < 2 * 60 * 1000) return task;
  const suspectedAt = Date.parse(task.staleSuspectedAt || '') || 0;
  if (!suspectedAt && ageMs < STALE_OLD_TASK_MS) {
    const next = { ...task, staleSuspectedAt: new Date().toISOString() };
    writeJson(file, next);
    return next;
  }
  if (suspectedAt && Date.now() - suspectedAt < STALE_SUSPECT_GRACE_MS) return task;
  const next = {
    ...task,
    status: 'stopped',
    stage: 'stale',
    error: task.error || '실행 프로세스 상태 확인이 오래 갱신되지 않아 정리했습니다.',
    stoppedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeJson(file, next);
  return next;
}

function startBackgroundTask(opts) {
  const id = taskId();
  const file = taskStateFile(opts.taskDir, id);
  const state = {
    id,
    projectPath: opts.projectPath,
    baseProjectPath: opts.baseProjectPath || opts.projectPath,
    branch: opts.branch || null,
    prompt: opts.prompt,
    historyPrompt: opts.historyPrompt || opts.prompt,
    inbox: opts.inbox || null,
    workstream: opts.workstream || null,
    sessionId: opts.sessionId || null,
    status: 'queued',
    output: '',
    stderr: '',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeJson(file, state);
  const node = resolveNodeRuntime();
  const runner = materializeBackgroundRunner(opts.taskDir);
  const child = spawn(node, [runner, file], {
    cwd: path.dirname(runner),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  });
  child.on('error', (e) => {
    writeJson(file, { ...state, status: 'failed', stage: 'spawn', error: String(e), nodePath: node, updatedAt: new Date().toISOString() });
  });
  child.unref();
  writeJson(file, { ...state, runnerPid: child.pid, nodePath: node, runnerPath: runner, status: 'running', updatedAt: new Date().toISOString() });
  return { ...state, runnerPid: child.pid, file };
}

function listBackgroundTasks(taskDir) {
  let entries = [];
  try { entries = fs.readdirSync(taskDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.json'))
    .map(e => {
      const file = path.join(taskDir, e.name);
      return normalizeBackgroundTask(file, readJson(file));
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function getBackgroundTask(taskDir, id) {
  if (!id) return null;
  const file = taskStateFile(taskDir, id);
  return normalizeBackgroundTask(file, readJson(file));
}

function killPid(pid) {
  const n = parseInt(pid, 10);
  if (!n) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(n), '/T', '/F'], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return;
    } catch {}
  }
  try { process.kill(n, 'SIGTERM'); } catch {}
}

function stopBackgroundTask(taskDir, id) {
  const file = taskStateFile(taskDir, id);
  const state = readJson(file);
  if (!state) return { ok: false, error: '작업 상태 파일을 찾지 못했습니다.' };
  if (isTerminalStatus(state.status)) return { ok: true, alreadyDone: true, task: state };
  killPid(state.pid);
  killPid(state.runnerPid);
  const next = {
    ...state,
    status: 'stopped',
    stage: 'stopped',
    error: '사용자가 작업을 중지했습니다.',
    stoppedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeJson(file, next);
  return { ok: true, task: next };
}

function isTerminalStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'timeout' || status === 'stopped';
}

// 대화형 한 턴 실행.
//  - opts.sessionId 가 있으면 --resume 으로 같은 세션을 이어간다(후속 답변).
//  - stream-json 으로 실행해 assistant 텍스트를 실시간 스트리밍하고 session_id 를 회수한다.
//  - 중요한 갈림길에서는 FORK_SYS 지시에 따라 claude 가 질문하고 멈춘다 → 사용자가 답하면 다시 호출.
function runTask(opts, onData) {
  if (opts.taskDir) {
    return new Promise((resolve) => {
      if (!opts.prompt || !opts.prompt.trim()) {
        resolve({ ok: false, stage: 'empty', error: '프롬프트 비어있음' });
        return;
      }
      let state;
      try { state = startBackgroundTask(opts); }
      catch (e) { resolve({ ok: false, stage: 'spawn', error: String(e) }); return; }
      if (onData) onData({ type: 'started', taskId: state.id, prompt: opts.prompt });
      if (opts.backgroundOnly) {
        resolve({
          ok: true,
          stage: 'started',
          running: true,
          taskId: state.id,
          sessionId: state.sessionId || null,
          output: '',
          stderr: '',
          tokenUsage: null,
          background: true,
        });
        return;
      }
      let sent = 0;
      let usageSent = '';
      const started = Date.now();
      const timer = setInterval(() => {
        const cur = readJson(state.file);
        if (!cur) return;
        const out = cur.output || '';
        if (out.length > sent) {
          if (onData) onData(out.slice(sent));
          sent = out.length;
        }
        const usageKey = JSON.stringify(cur.tokenUsage || null);
        if (usageKey !== usageSent) {
          usageSent = usageKey;
          if (cur.tokenUsage && onData) onData({ type: 'usage', usage: cur.tokenUsage });
        }
        if (isTerminalStatus(cur.status)) {
          clearInterval(timer);
          resolve({
            ok: cur.status === 'completed',
            stage: cur.stage,
            exitCode: cur.exitCode,
            error: cur.error || '',
            output: cur.output || '',
            stderr: cur.stderr || '',
            inboxFile: cur.inboxFile || null,
            sessionId: cur.sessionId || null,
            taskId: cur.id,
            tokenUsage: cur.tokenUsage || null,
            background: true,
          });
        } else if (Date.now() - started > 615000) {
          clearInterval(timer);
          resolve({
            ok: false,
            stage: 'timeout',
            error: 'background task poll timeout',
            output: cur.output || '',
            stderr: cur.stderr || '',
            sessionId: cur.sessionId || null,
            taskId: cur.id,
            tokenUsage: cur.tokenUsage || null,
            background: true,
          });
        }
      }, 500);
    });
  }
  return new Promise((resolve) => {
    const { projectPath, prompt, inbox, sessionId } = opts;
    if (!prompt || !prompt.trim()) { resolve({ ok: false, stage: 'empty', error: '프롬프트 비어있음' }); return; }
    const claude = resolveClaude();
    let stderr = '', done = false;
    let curSession = sessionId || null;
    let finalResult = '';
    let assistantText = '';
    let isError = false;
    let buf = '';
    let tokenUsage = null;

    // 논의 모드: 첫 턴에 한해 내 의견 원문을 인박스에 기록 (claude 실패해도 의견은 남음)
    const ibFile = inbox ? inboxPath(projectPath, inbox.phaseNum) : null;
    if (ibFile && !sessionId) {
      const ts = new Date().toISOString();
      try {
        appendInbox(ibFile,
          `## ${ts} — Phase ${inbox.phaseNum} (${inbox.phaseTitle}) 의견 (claude 작업 요청)\n\n` +
          `**질문/맥락:**\n${inbox.question || '(자유 의견)'}\n\n` +
          `**내 의견:**\n${inbox.answer || ''}\n\n`);
      } catch {}
    } else if (ibFile && sessionId) {
      // 후속 답변도 기록
      const ts = new Date().toISOString();
      try { appendInbox(ibFile, `**내 후속 답변 (${ts}):**\n${prompt}\n\n`); } catch {}
    }

    // stream-json 이벤트 한 줄 처리
    function handleLine(line) {
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.session_id) curSession = o.session_id;
      const usage = tokenUsageFromEvent(o);
      if (usage) {
        tokenUsage = o.type === 'result' ? usage : mergeTokenUsage(tokenUsage, usage);
        if (onData) onData({ type: 'usage', usage: tokenUsage });
      }
      if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        for (const part of o.message.content) {
          if (part.type === 'text' && part.text) { assistantText += part.text; if (onData) onData(part.text); }
          else if (part.type === 'tool_use') {
            // Tool calls are surfaced by scanner.js as shell/subagent timelines.
            // Do not inject tool labels into the user-facing transcript.
          }
        }
      } else if (o.type === 'result') {
        finalResult = (o.result || '').trim();
        isError = !!o.is_error;
      }
    }

    const args = buildTaskArgs({ prompt, sessionId });

    let child;
    try {
      // bypassPermissions: 권한 프롬프트 자동 통과(스킬/파일/bash 동작) — UI 확인 게이트가 안전장치.
      // FORK_SYS: 갈림길에서 질문하고 멈추도록 유도. stream-json: 실시간 스트리밍 + session_id 회수.
      child = spawn(claude, args, {
        cwd: projectPath,
        shell: claude === 'claude',
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, stage: 'spawn', error: String(e), sessionId: curSession });
      return;
    }
    // stdin을 즉시 닫아 claude의 "no stdin data received in 3s" 대기를 방지한다.
    try { child.stdin && child.stdin.end(); } catch {}

    // 실제 작업은 오래 걸릴 수 있어 타임아웃을 넉넉히 (10분)
    const timeout = setTimeout(() => {
      if (!done) { done = true; try { child.kill(); } catch {}
        resolve({ ok: false, stage: 'timeout', error: '600s 초과', output: assistantText.trim(), stderr, sessionId: curSession, tokenUsage });
      }
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
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timeout);
      resolve({ ok: false, stage: 'exec', error: String(e), stderr, sessionId: curSession });
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timeout);
      if (buf.trim()) handleLine(buf.trim());
      const out = finalResult || assistantText.trim();
      if (ibFile) {
        try { appendInbox(ibFile, `**claude 응답 (exit ${code}):**\n${out || '(출력 없음)'}\n\n---\n\n`); } catch {}
      }
      resolve({ ok: code === 0 && !isError, exitCode: code, output: out, stderr, inboxFile: ibFile, sessionId: curSession, tokenUsage });
    });
  });
}

module.exports = {
  injectAnswer,
  previewInjection,
  resolveClaude,
  inboxPath,
  previewTask,
  runTask,
  listClaudeSkills,
  listClaudeCommands,
  buildTaskArgs,
  listBackgroundTasks,
  getBackgroundTask,
  stopBackgroundTask,
};
