'use strict';

const { app, BrowserWindow, ipcMain, dialog, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { scanProject, scanAgentDetail, scanSessionDetail } = require('./src/scanner');
const {
  injectAnswer,
  previewInjection,
  previewTask,
  runTask,
  listClaudeSkills,
  listClaudeCommands,
  listBackgroundTasks,
  getBackgroundTask,
  stopBackgroundTask,
} = require('./src/claudeRunner');

let mainWindow = null;
const taskWindowPayloads = new Map();
const taskWindowIndex = new Map();
const execFileP = promisify(execFile);
const attentionSources = new Map();
let attentionKeys = new Set();
let attentionCount = 0;
let lastAttentionNotifyAt = 0;

// 선택한 프로젝트 폴더 목록을 userData 에 영속화 (재실행 시 복원)
function storeFile() {
  return path.join(app.getPath('userData'), 'projects.json');
}
function taskDir() {
  return path.join(app.getPath('userData'), 'background-tasks');
}
function branchWorktreeRoot() {
  return path.join(app.getPath('userData'), 'branch-worktrees');
}
function loadProjects() {
  try { return JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch { return []; }
}
function saveProjects(list) {
  try { fs.writeFileSync(storeFile(), JSON.stringify(list, null, 2), 'utf8'); } catch {}
}

function backgroundTaskMatchesBranch(task, project) {
  const branch = project && project.git && project.git.isRepo ? (project.git.branch || 'detached') : null;
  if (!branch || !task || !task.branch) return true;
  return task.branch === branch;
}

function registeredProjectPath(projectPath) {
  const target = path.resolve(String(projectPath || ''));
  return loadProjects().some(p => path.resolve(p) === target) ? target : null;
}

async function gitRun(projectPath, args, timeout = 12000) {
  const safePath = registeredProjectPath(projectPath);
  if (!safePath) return { ok: false, error: '등록된 프로젝트 경로가 아닙니다.' };
  try {
    const r = await execFileP('git', ['-C', safePath, ...args], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  } catch (e) {
    return { ok: false, error: String(e.message || e), stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

async function gitRunUnchecked(cwd, args, timeout = 12000) {
  try {
    const r = await execFileP('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  } catch (e) {
    return { ok: false, error: String(e.message || e), stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function validGitRefName(ref) {
  const target = String(ref || '').trim();
  return !!target
    && !/[\r\n]/.test(target)
    && !target.startsWith('-')
    && target.length <= 200
    && /^[A-Za-z0-9._/-]+$/.test(target)
    && !target.includes('..')
    && !target.startsWith('/');
}

function worktreeSafeName(projectPath, branch) {
  const safeBranch = String(branch || 'branch').replace(/[^A-Za-z0-9._-]+/g, '__').slice(0, 80) || 'branch';
  const hash = crypto.createHash('sha1').update(`${path.resolve(projectPath)}|${branch}`).digest('hex').slice(0, 12);
  return `${safeBranch}-${hash}`;
}

function parseGitWorktrees(text) {
  return String(text || '').split(/\r?\n\r?\n/).map(block => {
    const row = {};
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf(' ');
      const key = i >= 0 ? line.slice(0, i) : line;
      const value = i >= 0 ? line.slice(i + 1) : '';
      if (key) row[key] = value;
    }
    return row;
  }).filter(row => row.worktree);
}

async function listGitRefs(projectPath) {
  const current = await gitRun(projectPath, ['branch', '--show-current']);
  const branches = await gitRun(projectPath, ['branch', '--all', '--format=%(refname:short)', '--sort=-committerdate']);
  if (!branches.ok) return branches;
  const seen = new Set();
  const refs = [];
  for (const raw of branches.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    if (raw === 'HEAD' || raw.endsWith('/HEAD')) continue;
    const localName = raw.replace(/^remotes\//, '');
    if (seen.has(localName)) continue;
    seen.add(localName);
    refs.push(localName);
  }
  return { ok: true, current: current.ok ? current.stdout : '', branches: refs.slice(0, 80) };
}

async function switchGitRef(projectPath, ref) {
  const target = String(ref || '').trim();
  if (!target || /[\r\n]/.test(target) || target.startsWith('-') || target.length > 200) {
    return { ok: false, error: '유효하지 않은 Git ref입니다.' };
  }
  const remoteTrack = target.match(/^(?:remotes\/)?(origin|upstream)\/(.+)$/);
  let res = await gitRun(projectPath, ['switch', target], 30000);
  if (!res.ok && remoteTrack) {
    res = await gitRun(projectPath, ['switch', '--track', `${remoteTrack[1]}/${remoteTrack[2]}`], 30000);
  }
  if (!res.ok) res = await gitRun(projectPath, ['checkout', target], 30000);
  if (!res.ok && /^[A-Za-z0-9._/-]+$/.test(target) && !target.includes('..') && !target.startsWith('/') && !/^origin\//.test(target)) {
    res = await gitRun(projectPath, ['switch', '-c', target], 30000);
  }
  if (res.ok) {
    notifyChanged('git-switch');
    startWatchers();
  }
  return res;
}

async function createGitBranch(projectPath, ref) {
  const target = String(ref || '').trim();
  if (!target || /[\r\n]/.test(target) || target.startsWith('-') || target.length > 200) {
    return { ok: false, error: '유효하지 않은 Git branch 이름입니다.' };
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(target) || target.includes('..') || target.startsWith('/') || /^origin\//.test(target)) {
    return { ok: false, error: '유효하지 않은 Git branch 이름입니다.' };
  }
  const res = await gitRun(projectPath, ['branch', target], 30000);
  if (res.ok) {
    notifyChanged('git-branch-create');
    startWatchers();
  }
  return res;
}

async function ensureBranchWorktree(projectPath, ref) {
  const safePath = registeredProjectPath(projectPath);
  if (!safePath) return { ok: false, error: '등록된 프로젝트 경로가 아닙니다.' };
  const target = String(ref || '').trim();
  if (!validGitRefName(target)) return { ok: false, error: '유효하지 않은 Git branch 이름입니다.' };

  const current = await gitRun(safePath, ['branch', '--show-current']);
  if (current.ok && current.stdout === target) {
    return { ok: true, projectPath: safePath, baseProjectPath: safePath, branch: target, usingWorktree: false };
  }

  const remoteTrack = target.match(/^(?:remotes\/)?([^/]+)\/(.+)$/);
  const localBranch = remoteTrack ? remoteTrack[2] : target;
  if (!validGitRefName(localBranch) || /^origin\//.test(localBranch)) {
    return { ok: false, error: 'worktree로 만들 수 없는 브랜치 이름입니다.' };
  }

  const worktrees = await gitRun(safePath, ['worktree', 'list', '--porcelain'], 12000);
  if (worktrees.ok) {
    for (const wt of parseGitWorktrees(worktrees.stdout)) {
      const branchRef = String(wt.branch || '').replace(/^refs\/heads\//, '');
      if (branchRef === target || branchRef === localBranch) {
        return { ok: true, projectPath: wt.worktree, baseProjectPath: safePath, branch: branchRef, usingWorktree: true };
      }
    }
  }

  const parent = path.join(branchWorktreeRoot(), crypto.createHash('sha1').update(path.resolve(safePath)).digest('hex').slice(0, 16));
  const workspace = path.join(parent, worktreeSafeName(safePath, localBranch));
  fs.mkdirSync(parent, { recursive: true });

  const existing = await gitRunUnchecked(workspace, ['rev-parse', '--is-inside-work-tree'], 3000);
  if (existing.ok) {
    return { ok: true, projectPath: workspace, baseProjectPath: safePath, branch: localBranch, usingWorktree: true };
  }

  const localExists = await gitRun(safePath, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`], 12000);
  let res;
  if (localExists.ok) {
    res = await gitRun(safePath, ['worktree', 'add', workspace, target], 60000);
  } else if (remoteTrack) {
    const remoteRef = `${remoteTrack[1]}/${remoteTrack[2]}`;
    res = await gitRun(safePath, ['worktree', 'add', '-b', localBranch, workspace, remoteRef], 60000);
  } else {
    res = await gitRun(safePath, ['worktree', 'add', workspace, target], 60000);
  }
  if (!res.ok) return res;
  notifyChanged('git-worktree');
  return { ok: true, projectPath: workspace, baseProjectPath: safePath, branch: localBranch, usingWorktree: true };
}

// ---------- 자동 감시 (WCC 진행 실시간 감지) ----------
// 각 프로젝트의 .planning(산출물 변화) + .git/HEAD·index(브랜치·커밋 변화)를 감시.
// 변화가 생기면 debounce 후 렌더러에 알려 자동 재스캔하게 한다. (읽기 전용)
const watchers = [];
let watchDebounce = null;

function sendToAll(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

function attentionBadgeImage(count) {
  const label = count > 9 ? '9+' : String(Math.max(1, count));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#ef4444"/><text x="32" y="42" text-anchor="middle" font-family="Arial, sans-serif" font-size="${label.length > 1 ? 28 : 34}" font-weight="700" fill="white">${label}</text></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function normalizeAttentionItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    const key = String(it && it.key || '').trim();
    if (!key) continue;
    out.push({
      key,
      title: String(it.title || '답변 필요').trim(),
      body: String(it.body || '').trim(),
    });
  }
  return out;
}

function updateAttentionSource(source, items) {
  attentionSources.set(source || 'default', normalizeAttentionItems(items));
  const merged = [];
  const seen = new Set();
  for (const list of attentionSources.values()) {
    for (const it of list) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      merged.push(it);
    }
  }
  const nextKeys = new Set(merged.map(it => it.key));
  const newItems = merged.filter(it => !attentionKeys.has(it.key));
  attentionKeys = nextKeys;
  attentionCount = merged.length;

  const titlePrefix = attentionCount ? `(${attentionCount}) ` : '';
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try { win.setTitle(`${titlePrefix}Lodestar`); } catch {}
    try { win.setOverlayIcon(attentionCount ? attentionBadgeImage(attentionCount) : null, attentionCount ? `${attentionCount}개 답변 필요` : ''); } catch {}
    if (!attentionCount) {
      try { win.flashFrame(false); } catch {}
    }
  }
  try { app.setBadgeCount(attentionCount); } catch {}

  if (attentionCount && newItems.length) {
    const now = Date.now();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win || win.isDestroyed()) continue;
      try { win.flashFrame(true); } catch {}
    }
    if (now - lastAttentionNotifyAt > 15000 && Notification.isSupported()) {
      lastAttentionNotifyAt = now;
      const first = newItems[0];
      new Notification({
        title: attentionCount > 1 ? `답변 필요 ${attentionCount}개` : first.title,
        body: first.body || 'Claude가 사용자 답변을 기다리고 있습니다.',
        silent: false,
      }).show();
    }
  }
  sendToAll('attention:changed', { count: attentionCount, items: merged });
}

function projectAttentionItems(projects) {
  const items = [];
  for (const p of projects || []) {
    const act = p && p.activity ? p.activity : null;
    if (act && act.awaiting && !act.blocked) {
      items.push({
        key: `${p.path}|${act.sessionId || 'no-session'}|awaiting`,
        title: `${p.name || path.basename(p.path || '')} 답변 필요`,
        body: act.awaitingText || 'Claude가 사용자 답변을 기다리고 있습니다.',
      });
    }
  }
  return items;
}

function notifyChanged(reason) {
  if (watchDebounce) clearTimeout(watchDebounce);
  watchDebounce = setTimeout(() => {
    sendToAll('projects:changed', reason);
  }, 1200);
}

function closeWatchers() {
  while (watchers.length) { try { watchers.pop().close(); } catch {} }
}

function startWatchers() {
  closeWatchers();
  try {
    fs.mkdirSync(taskDir(), { recursive: true });
    watchers.push(fs.watch(taskDir(), { recursive: false }, () => notifyChanged('background-task')));
  } catch {}
  const list = loadProjects();
  for (const proj of list) {
    // .planning 재귀 감시 (Windows fs.watch recursive 지원)
    const planning = path.join(proj, '.planning');
    if (fs.existsSync(planning)) {
      try {
        watchers.push(fs.watch(planning, { recursive: true }, () => notifyChanged('planning')));
      } catch {}
    }
    // .git 감시 (HEAD·index 변화 = 브랜치 전환·커밋·스테이징)
    const gitDir = path.join(proj, '.git');
    if (fs.existsSync(gitDir)) {
      try {
        watchers.push(fs.watch(gitDir, { recursive: false }, (_e, fn) => {
          if (!fn || /HEAD|index|ORIG_HEAD/.test(String(fn))) notifyChanged('git');
        }));
      } catch {}
    }
    // Claude Code 세션 로그 감시 (서브에이전트 진행 = jsonl 추가)
    const logDir = path.join(os.homedir(), '.claude', 'projects', pathToSlug(proj));
    if (fs.existsSync(logDir)) {
      try {
        watchers.push(fs.watch(logDir, { recursive: false }, () => notifyChanged('activity')));
      } catch {}
    }
  }
}

// 경로 → Claude Code 세션 폴더 슬러그. 정규식 [:\\/] 가 백슬래시를 못 잡는 환경이 있어 명시 치환.
function pathToSlug(p) {
  const bs = String.fromCharCode(92);
  return String(p).split(bs).join('-').split('/').join('-').split(':').join('-').split('_').join('-');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#0f1117',
    title: 'Lodestar — WCC 상황판',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function taskLaneKeyFromPayload(payload = {}) {
  const lane = payload.lane || (payload.task && payload.task.lane) || null;
  if (lane && lane.kind === 'workstream') return `workstream:${lane.name || 'workstream'}`;
  if (payload.session && payload.session.laneId) return payload.session.laneId;
  if (payload.task && payload.task.laneId) return payload.task.laneId;
  if (payload.backgroundTask && payload.backgroundTask.workstream && payload.backgroundTask.workstream.name) {
    return `workstream:${payload.backgroundTask.workstream.name}`;
  }
  return 'main';
}

function taskWindowIdentity(payload = {}) {
  const projectPath = (payload.project && payload.project.path) || (payload.task && payload.task.projectPath) || '';
  const branch = payload.branch
    || (payload.task && payload.task.branch)
    || (payload.backgroundTask && payload.backgroundTask.branch)
    || (payload.session && payload.session.branch)
    || '';
  const sessionId = (payload.session && payload.session.sessionId)
    || (payload.task && payload.task.sessionId)
    || (payload.activity && payload.activity.sessionId)
    || (payload.backgroundTask && payload.backgroundTask.sessionId)
    || '';
  if (sessionId) return `session:${projectPath}|${sessionId}`;
  const backgroundTaskId = (payload.backgroundTask && payload.backgroundTask.id)
    || (payload.task && payload.task.backgroundTaskId)
    || '';
  if (backgroundTaskId) return `background:${projectPath}|${backgroundTaskId}`;
  const taskKey = payload.task && payload.task.key;
  if (taskKey) return `task:${projectPath}|${taskKey}`;
  if (payload.mode === 'phase-running') {
    const phase = payload.phase && (payload.phase.num || payload.phase.title || payload.phase.stage);
    return `phase:${projectPath}|${branch}|${taskLaneKeyFromPayload(payload)}|${phase || 'current'}`;
  }
  return `new:${projectPath}|${branch}|${taskLaneKeyFromPayload(payload)}|${payload.mode || 'new'}|${payload.openedAt || ''}`;
}

function focusTaskWindow(win) {
  if (!win || win.isDestroyed()) return false;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (process.platform === 'win32') {
      win.setAlwaysOnTop(true);
      win.setAlwaysOnTop(false);
    }
  } catch {}
  return true;
}

function createTaskWindow(payload = {}) {
  const identity = taskWindowIdentity(payload);
  const existing = taskWindowIndex.get(identity);
  if (existing && existing.win && !existing.win.isDestroyed()) {
    taskWindowPayloads.set(existing.id, { ...payload, windowId: existing.id, windowIdentity: identity });
    focusTaskWindow(existing.win);
    return { ok: true, windowId: existing.id, reused: true };
  }
  if (existing) taskWindowIndex.delete(identity);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  taskWindowPayloads.set(id, { ...payload, windowId: id, windowIdentity: identity });
  const projectName = payload.project && payload.project.name ? payload.project.name : 'Claude';
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#20232b',
    title: `Lodestar Session — ${projectName}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'session.html'), { query: { id } });
  taskWindowIndex.set(identity, { id, win });
  win.on('closed', () => {
    taskWindowPayloads.delete(id);
    const current = taskWindowIndex.get(identity);
    if (current && current.id === id) taskWindowIndex.delete(identity);
  });
  return { ok: true, windowId: id };
}

app.whenReady().then(() => {
  createWindow();
  startWatchers();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  closeWatchers();
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC ----------

// 저장된 프로젝트 목록 반환
ipcMain.handle('projects:list', () => loadProjects());

// 폴더 선택 (다중)
ipcMain.handle('projects:add', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'GSD 프로젝트 폴더 선택 (여러 개 가능)',
    properties: ['openDirectory', 'multiSelections'],
  });
  if (res.canceled) return loadProjects();
  const cur = loadProjects();
  for (const p of res.filePaths) {
    if (!cur.includes(p)) cur.push(p);
  }
  saveProjects(cur);
  startWatchers();
  return cur;
});

// 프로젝트 제거
ipcMain.handle('projects:remove', (_e, projectPath) => {
  const cur = loadProjects().filter(p => p !== projectPath);
  saveProjects(cur);
  startWatchers();
  return cur;
});

// 전체 스캔 (새로고침) — 프로젝트별 비동기 병렬 (git 비블로킹)
ipcMain.handle('projects:scan', async () => {
  const list = loadProjects();
  const bgTasks = listBackgroundTasks(taskDir());
  const projects = await Promise.all(list.map(async (p) => {
    try {
      const project = await scanProject(p);
      project.backgroundTasks = bgTasks
        .filter(t => t.projectPath === p || t.baseProjectPath === p)
        .slice(0, 24);
      return project;
    }
    catch (e) { return { path: p, name: path.basename(p), isGsd: false, error: String(e) }; }
  }));
  // Renderer owns attention counting because it can apply local "checked" state.
  // Keep the scan source empty so stale scan alerts cannot keep the app badge alive.
  updateAttentionSource('scan', []);
  return projects;
});

ipcMain.handle('attention:update', (_e, payload = {}) => {
  updateAttentionSource(payload.source || 'renderer', payload.items || []);
  return { ok: true, count: attentionCount };
});

// claude -p 주입 미리보기 (확인 게이트용)
ipcMain.handle('inject:preview', (_e, opts) => {
  return previewInjection(opts);
});

// claude -p 주입 실행 (확인 후)
ipcMain.handle('inject:run', async (_e, opts) => {
  return injectAnswer(opts, (chunk) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject:progress', chunk);
    }
  });
});

// 범용 작업 요청 (claude -p 로 프로젝트에서 직접 작업)
// 서브에이전트 상세 실행 내용 (클릭 시 on-demand)
ipcMain.handle('agent:detail', (_e, opts) => {
  try { return scanAgentDetail(opts.projectPath, opts.sessionId, opts.toolUseId); }
  catch (e) { return { ok: false, error: String(e) }; }
});
ipcMain.handle('session:detail', (_e, opts) => {
  try { return scanSessionDetail(opts.projectPath, opts.sessionId); }
  catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('task:preview', (_e, opts) => previewTask(opts));
ipcMain.handle('task:run', async (_e, opts) => {
  return runTask({ ...opts, taskDir: taskDir() }, (chunk) => {
    sendToAll('task:progress', { clientRunId: opts && opts.clientRunId, chunk });
  });
});
ipcMain.handle('tasks:list', () => listBackgroundTasks(taskDir()));
ipcMain.handle('tasks:get', (_e, id) => getBackgroundTask(taskDir(), id));
ipcMain.handle('tasks:stop', (_e, id) => stopBackgroundTask(taskDir(), id));
ipcMain.handle('task-window:open', (_e, payload) => createTaskWindow(payload));
ipcMain.handle('task-window:init', (_e, id) => taskWindowPayloads.get(id) || null);
ipcMain.handle('skills:list', () => listClaudeSkills());
ipcMain.handle('commands:list', (_e, opts = {}) => listClaudeCommands(opts.projectPath));
ipcMain.handle('git:refs', (_e, projectPath) => listGitRefs(projectPath));
ipcMain.handle('git:switch', (_e, opts = {}) => switchGitRef(opts.projectPath, opts.ref));
ipcMain.handle('git:create-branch', (_e, opts = {}) => createGitBranch(opts.projectPath, opts.ref));
ipcMain.handle('git:ensure-branch-worktree', (_e, opts = {}) => ensureBranchWorktree(opts.projectPath, opts.ref));
