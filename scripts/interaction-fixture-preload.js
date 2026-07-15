'use strict';

const { contextBridge } = require('electron');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const now = new Date().toISOString();

const providers = [
  { id: 'claude', label: 'Claude', company: 'Anthropic', accent: '#d58b5b', mark: 'C', installed: true },
  { id: 'gpt', label: 'GPT', company: 'OpenAI', accent: '#63d6b1', mark: 'G', installed: true },
  { id: 'gemini', label: 'Gemini', company: 'Google', accent: '#6da8ff', mark: 'Ge', installed: true },
  { id: 'grok', label: 'Grok', company: 'xAI', accent: '#c394ff', mark: 'X', installed: true },
  { id: 'codex', label: 'GPT · Codex', company: 'OpenAI', accent: '#4fd1a7', mark: 'Cx', installed: true },
];

const usage = { input: 1200, output: 540, cachedInput: 100, cacheWrite: 0, reasoning: 80, total: 1920 };
const context = { used: 5200, window: 128000, percent: 4.1, source: 'session' };
const messages = [
  { id: 'm-user', role: 'user', text: '상호작용 테스트를 진행해줘', timestamp: now },
  { id: 'm-assistant', role: 'assistant', text: '버튼과 입력 동작을 확인하고 있습니다.', timestamp: now },
];

const rootSession = {
  id: 'fixture-root', externalId: 'fixture-root-external', provider: 'claude', model: 'claude-fixture',
  title: '상호작용 검증 메인 작업', cwd: 'D:\\fixture', workspace: 'fixture', status: 'running',
  statusDetail: '버튼 동작을 확인하는 중', updatedAt: now, parentId: null, childIds: ['fixture-child', 'fixture-resting'],
  messages, usage, turnUsage: usage, context, runId: 'fixture-run',
  lifecycle: [{ type: 'start', status: 'running', label: '검증 시작', detail: 'DOM 이벤트 확인', timestamp: now }],
  runtimePresence: [{ kind: 'terminal', terminalId: 'terminal-main', pid: 41001, label: 'fixture terminal' }],
  sourceLabel: '인메모리 테스트 기록',
  collaboration: {
    communications: [
      { id: 'resting-assignment', kind: 'assignment', label: '새 작업 배정', from: '/root', to: '/root/resting_check', taskName: 'resting_check', childId: 'fixture-resting', text: '완료된 테스트를 다시 검토해줘', timestamp: now },
      { id: 'resting-started', kind: 'started', label: '서브에이전트 실행 시작', from: 'Codex 런타임', to: '/root/resting_check', taskName: 'resting_check', childId: 'fixture-resting', text: 'started', timestamp: now },
      { id: 'resting-result', kind: 'result', label: '결과 반환', from: '/root/resting_check', to: '/root', taskName: 'resting_check', childId: 'fixture-resting', text: '검토 결과 이상이 없습니다.', timestamp: now },
    ],
    metrics: { cumulativeCreated: 3, simultaneousCapacity: 3, currentlyRunning: 1, completedRecords: 2, retainedCount: 3, capacitySource: 'runtime-instruction' },
  },
};

const childSession = {
  ...rootSession, id: 'fixture-child', externalId: 'fixture-child-external', provider: 'gpt', model: 'gpt-fixture',
  title: '하위 상호작용 검증', parentId: 'fixture-root', childIds: ['fixture-grandchild'], agentName: 'button-auditor', agentRole: 'tester',
  runtimePresence: [], runId: '', collaboration: { communications: [
    { id: 'nested-assignment', kind: 'assignment', label: '새 작업 배정', from: '/root/child', to: '/root/child/nested_check', taskName: 'nested_check', childId: 'fixture-grandchild', text: '하위 흐름을 검증해줘', timestamp: now },
    { id: 'nested-started', kind: 'started', label: '서브에이전트 실행 시작', from: 'Codex 런타임', to: '/root/child/nested_check', taskName: 'nested_check', childId: 'fixture-grandchild', text: 'started', timestamp: now },
    { id: 'nested-result', kind: 'result', label: '결과 반환', from: '/root/child/nested_check', to: '/root/child', taskName: 'nested_check', childId: 'fixture-grandchild', text: '중첩 흐름 정상', timestamp: now },
  ] },
};

const grandchildSession = {
  ...childSession, id: 'fixture-grandchild', externalId: 'fixture-grandchild-external', provider: 'codex', model: 'gpt-fixture',
  title: '중첩 서브에이전트 검증', taskName: 'nested_check', parentId: 'fixture-child', childIds: [], agentName: 'nested-auditor',
  status: 'completed', statusDetail: '중첩 검증 완료', runtimePresence: [], runId: '',
  result: '중첩 흐름 정상', delegation: { taskName: 'nested_check', result: '중첩 흐름 정상' },
};

const restingSession = {
  ...childSession, id: 'fixture-resting', externalId: 'fixture-resting-external', provider: 'codex', model: 'gpt-fixture',
  title: '쉬는 서브에이전트 검증', taskName: 'resting_check', parentId: 'fixture-root', childIds: [], agentName: 'resting-auditor',
  status: 'completed', statusDetail: '작업을 마치고 쉬는 중', runtimePresence: [], runId: '',
  result: '검토 결과 이상이 없습니다.', delegation: { taskName: 'resting_check', result: '검토 결과 이상이 없습니다.' },
};

const endedSession = {
  ...rootSession, id: 'fixture-ended', externalId: 'fixture-ended-external', provider: 'gpt', model: 'gpt-fixture',
  title: '완료된 대화 상세 검증', status: 'completed', statusDetail: '검증 완료', parentId: null, childIds: [],
  runtimePresence: [], runId: '',
  lifecycle: [
    { type: 'start', status: 'completed', label: '작업 시작', detail: '상세 화면 확인', timestamp: now },
    { type: 'complete', status: 'completed', label: '작업 완료', detail: '정상 완료', timestamp: now },
  ],
};

const waitingSession = {
  ...endedSession, id: 'fixture-waiting', externalId: 'fixture-waiting-external', provider: 'gemini',
  title: '사용자 확인 대기 검증', status: 'waiting', statusDetail: '사용자 선택 대기',
};

const extraLiveSessions = Array.from({ length: 7 }, (_, index) => ({
  ...rootSession,
  id: `fixture-live-${index}`,
  externalId: `fixture-live-${index}-external`,
  title: `추가 진행 작업 ${index + 1}`,
  childIds: [],
  runtimePresence: [],
  runId: '',
}));

const originSession = {
  ...rootSession,
  id: 'fixture-origin',
  externalId: 'fixture-origin-external',
  provider: 'codex',
  title: 'Codex 원래 작업 열기 검증',
  childIds: [],
  runtimePresence: [],
  runId: '',
  clientKind: 'codex-desktop',
};

const extraEndedSessions = Array.from({ length: 34 }, (_, index) => ({
  ...endedSession,
  id: `fixture-history-${index}`,
  externalId: `fixture-history-${index}-external`,
  title: index === 0 ? '상세 오류 재시도 검증' : `지난 작업 ${String(index + 1).padStart(2, '0')}`,
  provider: index % 2 ? 'gpt' : 'gemini',
  updatedAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
}));

const tmuxPane = {
  id: 'tmux-pane-id', nativeId: '%7', index: 0, pid: 51001, active: true, dead: false,
  command: 'claude', cwd: '/tmp/fixture', title: 'fixture pane',
  agent: { ...rootSession, linkedSessionId: 'fixture-root', pid: 51001 },
};
const tmuxWindow = { id: 'tmux-window-id', nativeId: '@3', index: 0, name: 'fixture-window', active: true, panes: [tmuxPane] };
const tmuxSession = { id: 'tmux-session-id', nativeId: '$2', name: 'fixture-session', attached: false, windows: [tmuxWindow] };
const tmuxDistro = { id: 'tmux-distro-id', name: 'FixtureLinux', tmuxVersion: 'tmux 3.4', sessions: [tmuxSession] };

const snapshot = {
  generatedAt: now,
  sessions: [rootSession, childSession, grandchildSession, restingSession, originSession, ...extraLiveSessions, endedSession, waitingSession, ...extraEndedSessions],
  summary: {
    totals: { sessions: 48, active: 10, waiting: 1, subagents: 3, usage },
    providers: providers.map(provider => ({ ...provider, sessions: 1, active: provider.id === 'claude' ? 8 : (provider.id === 'gpt' || provider.id === 'codex' ? 1 : 0), usage })),
  },
  tmux: {
    available: true, status: 'fixture ready', distros: [tmuxDistro],
    summary: { distros: 1, sessions: 1, windows: 1, panes: 1, aiPanes: 1, linked: 1 },
  },
};

const initialTerminals = [
  { id: 'terminal-main', type: 'powershell', title: 'Fixture PowerShell', status: 'running', pid: 41001, cwd: 'D:\\fixture' },
  { id: 'terminal-ended', type: 'powershell', title: 'Fixture Ended', status: 'exited', pid: 41002, cwd: 'D:\\fixture' },
];

let terminals = clone(initialTerminals);
let calls = [];
let failures = new Map();
let delays = new Map();
let terminalSequence = 0;
const snapshotListeners = new Set();
const terminalDataListeners = new Set();
const terminalStateListeners = new Set();
const terminalErrorListeners = new Set();

function record(name, args = []) {
  calls.push({ name, args: clone(args), at: Date.now() });
}

async function controlled(name, args, value = { ok: true }) {
  record(name, args);
  const delay = Number(delays.get(name) || 0);
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  const remaining = Number(failures.get(name) || 0);
  if (remaining > 0) {
    failures.set(name, remaining - 1);
    throw new Error(`${name} fixture failure`);
  }
  return clone(value);
}

const api = {
  bootstrap: async () => {
    record('bootstrap');
    return {
      providers: clone(providers), availability: Object.fromEntries(providers.map(provider => [provider.id, true])),
      workspaces: [{ name: 'fixture', path: 'D:\\fixture' }], snapshot: clone(snapshot), activeRuns: [],
      platform: { id: 'win32', label: 'Windows', localShell: 'powershell', localShellLabel: 'Windows 명령창', nativeTmux: false },
    };
  },
  snapshot: async () => controlled('snapshot', [], snapshot),
  sessionDetail: id => controlled('sessionDetail', [id], snapshot.sessions.find(session => session.id === id) || null),
  runAgent: options => controlled('runAgent', [options], { ok: true, runId: 'fixture-new-run' }),
  stopAgent: runId => controlled('stopAgent', [runId], { ok: true }),
  activeRuns: async () => [],
  probeProviders: async () => controlled('probeProviders', [], Object.fromEntries(providers.map(provider => [provider.id, true]))),
  listWorkspaces: async () => [{ name: 'fixture', path: 'D:\\fixture' }],
  addWorkspaces: async () => controlled('addWorkspaces', [], [{ name: 'fixture', path: 'D:\\fixture' }]),
  removeWorkspace: folder => controlled('removeWorkspace', [folder], []),
  pickWorkspace: () => controlled('pickWorkspace', [], 'D:\\fixture-picked'),
  openExternal: url => controlled('openExternal', [url]),
  openSessionOrigin: session => controlled('openSessionOrigin', [session], { ok: true }),
  writeClipboard: value => controlled('writeClipboard', [value]),
  bridgeCommand: provider => controlled('bridgeCommand', [provider], { ok: true, command: `loadtoagent bridge ${provider}` }),
  terminalList: async () => {
    record('terminalList');
    return clone(terminals);
  },
  wslDistros: async () => {
    record('wslDistros');
    return ['FixtureLinux'];
  },
  terminalGet: async id => {
    record('terminalGet', [id]);
    return { ok: true, replay: `fixture replay for ${id}\r\n` };
  },
  terminalCreate: async options => {
    const created = { id: `terminal-created-${++terminalSequence}`, type: options.type, title: options.title || 'Fixture terminal', status: 'running', pid: 42000 + terminalSequence, cwd: options.cwd || 'D:\\fixture', provider: options.provider || '', bridgeId: options.bridgeId || '', background: options.type === 'agent' };
    await controlled('terminalCreate', [options], created);
    terminals.push(created);
    return clone(created);
  },
  terminalWrite: (id, data) => record('terminalWrite', [id, data]),
  terminalCommand: (id, command) => controlled('terminalCommand', [id, command]),
  terminalResize: (id, cols, rows) => record('terminalResize', [id, cols, rows]),
  terminalSignal: (id, signal) => controlled('terminalSignal', [id, signal]),
  terminalRestart: async id => {
    await controlled('terminalRestart', [id]);
    const terminal = terminals.find(item => item.id === id);
    if (terminal) terminal.status = 'running';
    return { ok: true };
  },
  terminalClose: async id => {
    await controlled('terminalClose', [id]);
    terminals = terminals.filter(item => item.id !== id);
    return { ok: true };
  },
  tmuxSendText: options => controlled('tmuxSendText', [options]),
  tmuxSendKey: options => controlled('tmuxSendKey', [options]),
  tmuxCapture: options => controlled('tmuxCapture', [options], { ok: true, output: 'fixture tmux output\n' }),
  tmuxNewSession: options => controlled('tmuxNewSession', [options]),
  tmuxNewWindow: options => controlled('tmuxNewWindow', [options]),
  tmuxSplitPane: options => controlled('tmuxSplitPane', [options]),
  tmuxRenameSession: options => controlled('tmuxRenameSession', [options]),
  tmuxRenameWindow: options => controlled('tmuxRenameWindow', [options]),
  tmuxSelectLayout: options => controlled('tmuxSelectLayout', [options]),
  tmuxKillPane: options => controlled('tmuxKillPane', [options]),
  tmuxKillWindow: options => controlled('tmuxKillWindow', [options]),
  tmuxKillSession: options => controlled('tmuxKillSession', [options]),
  onTerminalData: callback => { terminalDataListeners.add(callback); return () => terminalDataListeners.delete(callback); },
  onTerminalState: callback => { terminalStateListeners.add(callback); return () => terminalStateListeners.delete(callback); },
  onTerminalError: callback => { terminalErrorListeners.add(callback); return () => terminalErrorListeners.delete(callback); },
  onSnapshot: callback => { snapshotListeners.add(callback); return () => snapshotListeners.delete(callback); },
};

const testApi = {
  getCalls: () => clone(calls),
  getSnapshot: () => clone(snapshot),
  clearCalls: () => { calls = []; },
  configure: options => {
    if (options && options.delays) for (const [name, value] of Object.entries(options.delays)) delays.set(name, Number(value) || 0);
    if (options && options.failures) for (const [name, value] of Object.entries(options.failures)) failures.set(name, Number(value) || 0);
    return true;
  },
  clearControls: () => { failures = new Map(); delays = new Map(); },
  restoreTerminals: () => { terminals = clone(initialTerminals); return clone(terminals); },
};

contextBridge.exposeInMainWorld('loadtoagent', api);
contextBridge.exposeInMainWorld('interactionTest', testApi);
