'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { scanActivity, scanSessionDetail, scanPlanningArtifacts } = require('../src/scanner');
const { listClaudeSkills, listClaudeCommands, listBackgroundTasks, buildTaskArgs } = require('../src/claudeRunner');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function nodeCheck(file) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

function assertContains(text, needle, label) {
  assert(
    text.includes(needle),
    `${label}\nMissing: ${needle}`
  );
}

function pathToSlug(p) {
  const bs = String.fromCharCode(92);
  return String(p).split(bs).join('-').split('/').join('-').split(':').join('-').split('_').join('-');
}

nodeCheck('renderer/app.js');
nodeCheck('renderer/session.js');
nodeCheck('src/scanner.js');
nodeCheck('src/backgroundTaskRunner.js');
nodeCheck('main.js');
nodeCheck('preload.js');

const app = read('renderer/app.js');
const mainSrc = read('main.js');
const preloadSrc = read('preload.js');
const css = read('renderer/styles.css');
const html = read('renderer/index.html');
const sessionHtml = read('renderer/session.html');
const sessionJs = read('renderer/session.js');

assertContains(app, 'if (paused) {', 'Current phase nodes must route paused sessions.');
assertContains(app, 'if (canOpenDiscussion(ph)) {', 'Discussion clicks must still open the discussion flow.');
assertContains(app, 'openTask(project, {', 'Discussion clicks must preserve contextual task launch.');
assertContains(app, 'if (currentBranchView && ph.isCurrent && project.activity && project.activity.current) {', 'Running agent nodes/phases must route active sessions only for the checked-out branch view.');
assertContains(app, 'openActivitySession(project, { phase: ph, lane });', 'Current phase nodes with a running agent must open the session chat window.');
assertContains(app, 'if (currentBranchView && ph.isCurrent && project.activity && project.activity.hasLog) {', 'Current phase with logs must open activity only for the checked-out branch view.');
assertContains(app, 'function taskKey(project, lane)', 'Lodestar task sessions must be keyed by project and lane.');
assertContains(app, "const THEME_KEY = 'lodestar.theme';", 'Main window must persist and read the shared theme setting.');
assertContains(app, "window.matchMedia('(prefers-color-scheme: dark)')", 'Main window must follow the OS dark-mode preference.');
assertContains(sessionJs, "const THEME_KEY = 'lodestar.theme';", 'Independent task windows must read the shared theme setting.');
assertContains(sessionJs, "document.body.classList.toggle('dark', dark);", 'Independent task windows must apply dark mode to the body.');
assertContains(app, 'function projectBranchKey(project)', 'Task/session state must know the current Git branch.');
assertContains(app, 'function projectScopeKey(project)', 'Project session keys must include branch scope so a new branch starts fresh.');
assertContains(app, 'function taskKeyForBranch(project, lane, branch)', 'Task sessions must be able to target an explicit branch.');
assertContains(app, 'return `${projectScopeKeyForBranch(project, branch)}::${taskLaneId(lane)}`;', 'Task session keys must isolate each workstream within each branch.');
assertContains(app, 'function taskNodeKey(project, lane, branch = null)', 'Task sessions must keep a stable visual node key across Claude context resets.');
assertContains(app, "if (lane.kind === 'workstream') return `workstream:${lane.name || ''}`;", 'Each workstream must receive a distinct lane id.');
assertContains(app, 'return taskKeyForBranch(project, lane, projectBranchKey(project));', 'Default task session keys must still follow the checked-out branch.');
assertContains(app, 'const candidates = [...taskSessions.values()]', 'Task session lookup must reuse the visible session bound to the same project, branch, and lane.');
assertContains(mainSrc, "ipcMain.handle('task-window:open'", 'Task sessions must be able to open independent Electron windows.');
assertContains(mainSrc, "ipcMain.handle('task-window:init'", 'Independent task windows must receive their launch context from the main process.');
assertContains(mainSrc, 'const taskWindowIndex = new Map();', 'Independent task windows must be indexed so reopening the same session focuses the existing window.');
assertContains(mainSrc, 'function taskWindowIdentity(payload = {})', 'Task windows must derive a stable identity from session/task/background scope.');
assertContains(mainSrc, "if (sessionId) return `session:${projectPath}|${sessionId}`;", 'The same Claude session id must map to one task window.');
assertContains(mainSrc, 'focusTaskWindow(existing.win);', 'Opening an already visible session must focus its existing window instead of spawning a duplicate.');
assertContains(mainSrc, 'return { ok: true, windowId: existing.id, reused: true };', 'Reused task windows must report that the existing window was reused.');
assertContains(mainSrc, "function sendToAll(channel, payload)", 'Task progress must broadcast to every open Lodestar window.');
assertContains(mainSrc, "sendToAll('task:progress'", 'Independent task windows must receive streaming Claude progress.');
assertContains(mainSrc, 'function updateAttentionSource(source, items)', 'Main process must centralize answer-needed attention state.');
assertContains(mainSrc, 'new Notification({', 'Answer-needed state must trigger a desktop notification.');
assertContains(mainSrc, 'win.flashFrame(true)', 'Answer-needed state must flash the app window/taskbar.');
assertContains(mainSrc, 'win.setOverlayIcon(attentionCount ? attentionBadgeImage(attentionCount) : null', 'Answer-needed state must set a taskbar overlay badge when supported.');
assertContains(mainSrc, 'app.setBadgeCount(attentionCount)', 'Answer-needed state must set the app badge count when supported.');
assertContains(mainSrc, "ipcMain.handle('attention:update'", 'Renderers must be able to report local answer-needed state.');
assertContains(mainSrc, "updateAttentionSource('scan', []);", 'Project scans must not keep stale answer-needed app badges after the renderer has acknowledged them.');
assertContains(preloadSrc, 'openTaskWindow: (payload)', 'Renderer must expose a safe API for opening task windows.');
assertContains(preloadSrc, 'updateAttention: (payload)', 'Preload must expose answer-needed attention updates.');
assertContains(app, "const ATTENTION_ACK_KEY = 'lodestar.attentionAck.v1';", 'Checked answer-needed alerts must be remembered locally.');
assertContains(app, 'function projectAttentionSummary(project)', 'Project layers must be able to explain why an app badge is showing.');
assertContains(app, 'if (!attentionAcked(localItem))', 'Acknowledged attention items must not continue counting toward the app badge.');
assertContains(app, 'class="project-attention-pill', 'Project headers must show the reason for answer-needed attention.');
assertContains(preloadSrc, 'taskWindowInit: (id)', 'Session windows must be able to load their initial context.');
assertContains(app, "openTaskWindowPayload(taskWindowPayload('new'", 'Task request buttons must open a new session window.');
assertContains(sessionHtml, 'class="session-shell"', 'Independent task window must render the promoted session shell.');
assertContains(sessionHtml, 'id="contextHelp"', 'Independent task window must explain context handling in the side rail.');
assertContains(sessionHtml, 'class="session-composer"', 'Independent task window must use a chat-style composer instead of a large task form.');
assertContains(sessionHtml, 'id="runPanel" class="runpanel session-run"', 'Independent task window must show the conversation panel immediately.');
assertContains(sessionHtml, 'id="activityStrip" class="activity-strip idle"', 'Independent task windows must show a prominent Codex-like activity state strip.');
assertContains(sessionHtml, 'id="stopInlineBtn" class="btn btn-danger hidden"', 'Independent task windows must expose an inline stop button beside the activity state.');
assertContains(sessionHtml, '메시지를 입력하세요. Enter로 보냅니다. Shift+Tab은 줄바꿈입니다.', 'Independent task window must send chat messages with Enter and reserve Shift+Tab for newlines.');
assertContains(html, 'id="taskActivityStrip" class="activity-strip idle"', 'The in-app task panel must show the same prominent activity state strip.');
assertContains(app, 'function readableMarkdown(text)', 'Main renderer must normalize AI output into readable markdown before rendering.');
assertContains(app, 'function splitReadableParagraph(text)', 'Main renderer must split long AI paragraphs into readable chunks.');
assertContains(sessionJs, 'function readableMarkdown(text)', 'Session window renderer must normalize AI output into readable markdown before rendering.');
assertContains(sessionJs, 'function splitReadableParagraph(text)', 'Session window renderer must split long AI paragraphs into readable chunks.');
assertContains(sessionJs, 'function taskOpts(promptText, explicitSessionId = sessionId)', 'Independent task windows must preserve resume-aware context handling.');
assertContains(sessionJs, 'const startsFresh = isWccCommandText(raw);', 'WCC commands in task windows must start with cleared context.');
assertContains(sessionJs, "await runTurn(taskOpts(text), text ? `› 나: ${text}` : '› 이어서 진행');", 'Independent task windows must keep user messages in the conversation transcript.');
assertContains(sessionJs, "if (running) {", 'Independent task window composer must support messages while Claude is running.');
assertContains(sessionJs, "pendingReply = text;", 'Independent task window composer must queue mid-run chat messages.');
assertContains(sessionJs, "if (e.key === 'Tab' && e.shiftKey)", 'Independent task window composer must insert a newline with Shift+Tab.');
assertContains(sessionJs, "if (e.key === 'Enter' && !e.shiftKey)", 'Independent task window composer must send immediately with Enter.');
assertContains(sessionJs, 'function insertTextareaNewline(ta)', 'Independent task window composer must preserve multiline chat input.');
assertContains(sessionJs, '세션 히스토리', 'Independent task window history must use session-oriented wording.');
assertContains(sessionJs, 'async function renderHistorySession(session, opts = {})', 'History session windows must load the selected session as a resumable chat.');
assertContains(sessionJs, 'const detail = await window.lodestar.sessionDetail({ projectPath: project.path, sessionId });', 'History session windows must fetch the full Claude transcript.');
assertContains(sessionJs, "setOutput(nextOutput || '이 세션의 대화 내용이 비어 있습니다.');", 'History session windows must render the previous conversation in the chat output area.');
assertContains(sessionJs, 'function pollLiveSessionDetail(session)', 'Live Claude session windows must keep polling for new records while the run is active.');
assertContains(sessionJs, 'await refreshHistorySessionDetail(session, live);', 'Live and history session windows must share the full transcript refresh path.');
assertContains(sessionJs, 'renderHistorySession(payload.session);', 'Opening a history card must use the dedicated history chat renderer.');
assertContains(app, 'function activitySessionSnapshot(project)', 'Running external agent sessions must be converted into chat-window session payloads.');
assertContains(app, 'function openActivitySession(project, scope = null)', 'Running external agents must prefer opening the session chat window.');
assertContains(app, "const mode = (session.running || session.awaiting) ? 'live-session' : 'history';", 'External session windows must only open as live when there is active running or awaiting evidence.');
assertContains(app, "act.current ? '실시간 대화 중' : '최근 세션'", 'Current session cards must label active conversations as live.');
assertContains(sessionJs, "running ? '실행 중인 Claude 세션을 불러오는 중…' : '세션 히스토리를 불러오는 중…'", 'Running external session windows must display a running state while loading logs.');
assertContains(sessionJs, "const live = !!opts.live;", 'Session windows must distinguish live sessions from history sessions.');
assertContains(sessionJs, 'function liveSessionRecent(session, detail = null)', 'Live session windows must not stay locked as running when the last update is stale.');
assertContains(sessionJs, 'running = !!liveSessionRecent(session) && !awaiting;', 'Live session windows must use recent activity evidence instead of the live flag alone.');
assertContains(sessionJs, "최근 실행 증거가 없어 히스토리 세션으로 전환했습니다.", 'Stale live sessions must unlock as history sessions.');
assertContains(sessionJs, "mode === 'live-session'", 'Session windows must support live external Claude sessions.');
assertContains(sessionJs, "live ? `실시간 세션 · ${project.name}`", 'Live sessions must be titled as real-time sessions.');
assertContains(sessionJs, "if (!live && detail.firstUser)", 'Live sessions must not be saved as history while still running.');
assertContains(sessionJs, 'function needsUserDecision(text)', 'Live session windows must detect textual decision gates even without AskUserQuestion.');
assertContains(sessionJs, 'function liveSessionNeedsUserDecision(detail, session)', 'Live sessions must decide answer-needed from the latest turn, not stale transcript text.');
assertContains(sessionJs, 'const decisionGate = live && (liveSessionNeedsUserDecision(detail, session) || !!decisionQuestion);', 'Live sessions that ask for a decision must unlock the chat composer.');
assertContains(sessionJs, "if (turn && turn.role === 'user' && String(turn.text || '').trim()) return '';", 'A user reply after an old question must prevent stale answer-needed state.');
assertContains(sessionJs, "state('답변 필요', 'awaiting');", 'Decision-gated live sessions must be shown as answer-needed.');
assertContains(app, 'function taskRunningForLane(project, lane, branch = selectedProjectBranch(project))', 'Lodestar task running state must be scoped to the selected branch and active workstream lane.');
assertContains(app, 'function updateAttentionBadges(projectList)', 'Main renderer must report answer-needed project/task sessions to the main process.');
assertContains(app, 'window.lodestar.updateAttention({ source: \'renderer\', items })', 'Main renderer must update answer-needed badges after scans.');
assertContains(sessionJs, 'function updateWindowAttention()', 'Independent session windows must report answer-needed local sessions.');
assertContains(sessionJs, "window.lodestar.updateAttention({ source: `session:${windowId}`, items })", 'Session windows must report their own answer-needed state.');
assertContains(app, 'if (ph.isCurrent && !taskRunningForLane(project, lane, branch)) openTask(project, null, lane, { branch });', 'Current phase fallback click must only block the selected branch lane currently running a Lodestar task.');
assertContains(app, 'function activityScopeTerms(scope)', 'Activity feed must support node-scoped timeline filtering.');
assertContains(app, 'function scopedActivityItems(items, scope)', 'Activity feed must filter timeline items for the selected node.');
assertContains(app, "activityCtx = { path: project.path, scope };", 'Activity drawer refresh must remember the selected node scope.');
assertContains(app, "`${scoped ? '노드 활동' : '활동 피드'} · ${project.name}`", 'Activity drawer title must distinguish node-scoped activity from project-wide activity.');
assertContains(app, 'function lanePhaseRunning(project, lane, branch = selectedProjectBranch(project))', 'Lane labels must detect current running phases for the selected branch view.');
assertContains(app, 'const phaseRunning = lanePhaseRunning(p, lane, branch);', 'Lane task buttons must include running phase state for the selected branch.');
assertContains(app, 'const externalCurrent = isCurrentBranchView && isMainLane && p.activity && p.activity.current;', 'External terminal activity must not make every workstream lane or non-current branch view look busy.');
assertContains(app, 'function backgroundTaskForLane(project, lane, branch = projectBranchKey(project))', 'Restarted app must restore running task state per lane from persisted task files.');
assertContains(app, 'const runningStoredTask = backgroundTaskForLane(p, lane, branch);', 'Lane labels must read persisted running task state for the selected branch.');
assertContains(app, 'const busy = myTaskRunning || !!runningStoredTask || phaseRunning || externalCurrent;', 'Lane task buttons must not fall back to task request while a persisted task is running.');
assert(!app.includes('const busy = taskRunning ||'), 'Global taskRunning must not make every project lane look busy.');
assert(!app.includes("taskBtn.title = '다른 프로젝트 작업이 실행 중입니다';"), 'Other workstream buttons must remain available while a task is active elsewhere.');
assertContains(app, "return ph.stage === 'execute' || ph.stage === 'plan' || ph.stage === 'research';", 'Discussion phases must not be treated as running agent work.');
assertContains(app, "const discussionPending = currentBranchView && !paused && ph.isCurrent && ph.stage === 'discuss';", 'Current discussion phases must render as discussion-needed only for the checked-out branch view.');
assertContains(app, "discussionPending ? '<span class=\"node-status wait\">논의 필요</span>'", 'Discussion phases must not show an executing status badge.');
assertContains(app, "if (phaseRunning) { text = '에이전트 실행 중'; mode = 'phase'; }", 'Actually running phase lanes must not show the generic task request label.');
assertContains(app, '} else if (st.phaseRunning) {', 'Running phase lane buttons must route to activity or stay disabled instead of opening task requests.');
assertContains(app, 'function openPhaseRunningTask(project, lane, branch = selectedProjectBranch(project))', 'Running phase buttons must open a status view instead of creating a new task session.');
assertContains(app, "taskWindowPayload('phase-running'", 'Running phase status must be available in independent session windows.');
assertContains(sessionJs, "if (mode === 'phase-running') return '실행 중인 phase';", 'Phase-running windows must not label missing session ids as new sessions.');
assertContains(sessionJs, "if (mode === 'phase-running') {", 'Independent session windows must render phase-running status explicitly.');
assertContains(app, "execute: (pl.total > 0 && pl.done >= pl.total) || s === 'execute-done' || s === 'verify'", 'Execute-done phases must not leave the execute step highlighted as running.');
assertContains(app, "verify: ph.hasVerification || s === 'execute-done' || s === 'verify'", 'Execute-done phases must not leave the verification step highlighted as running.');
assertContains(app, 'else openAgentDetail(project, agent);', 'Agent node click must still open agent detail for real subagents.');
assertContains(app, "if (agent.kind === 'shell') openActivity(project);", 'Only shell activity should route to the activity feed instead of agent detail.');
assertContains(app, 'function workstreamGroupNode(project, workstreams, x, y, expanded)', 'Workstreams must render through a collapsible group node.');
assertContains(app, 'function phaseAutoFolded(ph)', 'Verified or completed phases must be eligible for automatic folding.');
assertContains(app, 'function completedPrefixCount(phs)', 'Phase folding must work even when there is no current phase.');
assertContains(app, 'const foldedCount = curIdx >= 0 ? curIdx : completedPrefixCount(phs);', 'Completed lanes must fold completed phases without relying on a current phase.');
assertContains(app, 'const startIdx = (collapsible && !expanded) ? foldedCount : 0;', 'Collapsed phase lanes must skip automatically folded completed phases.');
assertContains(app, 'function addProjectSessionBoard(nodesEl, project, lanes, x, y)', 'Projects must render an in-project session board.');
assertContains(app, 'function addProjectBranchBoard(nodesEl, project, x, y, width = PROJECT_MIN_W)', 'Projects must render Git branch areas for branches that own sessions with project-scoped width.');
assertContains(app, 'Git 브랜치 작업 공간', 'Branch boards must read as branch-scoped workspaces.');
assertContains(app, '.filter(area => area.sessions > 0 || area.current || area.selected || area.visible)', 'Branch boards must show current, selected, session-owning, and user-added visible branches.');
assertContains(app, 'function branchAreaAddLane(area, project, lane, opts = {})', 'Branch areas must synchronize visible workstreams with WCC lane state.');
assertContains(app, 'function branchAreaFlowHtml(area)', 'Branch areas must render a compact WCC process flow.');
assertContains(app, 'for (const area of byBranch.values())', 'Visible branch areas must receive milestone/workstream nodes inside their own branch card.');
assertContains(app, 'branchAreaAddLane(area, project, ctx.lane || projectMainLane(project)', 'Branch-scoped Claude sessions must mark their workstream inside the branch area.');
assertContains(css, '.pba-flow', 'Branch cards must visibly contain WCC process flow rows.');
assertContains(css, '.pba-step.current', 'Branch WCC flow must show the current process step.');
assertContains(app, 'class="project-layer-tab ${tab === \'current\' ? \'active\' : \'\'}"', 'Project layer header must expose a current tab.');
assertContains(app, 'class="project-layer-tab ${tab === \'history\' ? \'active\' : \'\'}"', 'Project layer header must expose a history tab.');
assertContains(app, 'setPlanningTab(project, btn.dataset.planTab || \'current\');', 'Project header current/history tabs must switch the project session board.');
assertContains(app, "if (tab === 'history') {", 'Project session board must switch to history mode from the project header tab.');
assertContains(app, 'boxes = projectHistoryItems(project).map(it => historySessionBox(it));', 'History mode must render history items as session boxes.');
assertContains(app, "if (planningTab(p) === 'history') {", 'History mode must stop before rendering current milestone/workstream nodes.');
assertContains(app, "return { nodes: 0, right: x, bottom: y, height: 0 };", 'Current tab must not render a separate session collection above milestone/workstream sessions.');
assert(!app.includes('boxes = currentSessionBoxes(project, lanes);'), 'Current mode must not reintroduce a separate session collection board.');
assertContains(app, 'const flowXBase = branchBoard.nodes ? branchBoard.right + 42 : xBase;', 'Project branch board must sit left of the selected branch workflow instead of above it.');
assertContains(app, 'const flowBounds = { ...projectBounds, left: flowXBase - 22 };', 'Branch-scoped workflow sessions must be bounded to the right-side workflow area.');
assert(!app.includes('laneY += branchBoard.height ? branchBoard.height + 26 : 0;'), 'Branch boards must not push the selected branch workflow downward.');
assertContains(app, 'const sessionBoard = addProjectSessionBoard(nodesEl, p, lanes, flowXBase', 'Session board must be laid out to the right of the branch rail inside each project.');
assertContains(app, 'renderLane(nodesEl, edges, p, lane, laneY + offset.y, activeAgent, flowXBase', 'Main phase lanes must render horizontally beside the branch rail.');
assertContains(app, 'bounds: flowBounds,', 'Right-side workflow session containers must stay inside the selected branch workflow area.');
assertContains(app, 'function laneSessionInfo(project, lane, branch = selectedProjectBranch(project))', 'Active task/session state must be derived per selected branch milestone or workstream lane.');
assertContains(app, 'function laneSessionFrame(project, lane, rect, info)', 'Running sessions must visually wrap the requested milestone/workstream lane.');
assertContains(app, 'function sessionFrameAgentBadge(info)', 'Session frames must visibly show when an Agent subagent is in use.');
assertContains(app, '${sessionFrameAgentBadge(info)}', 'Session frame headers must render the active agent badge.');
assertContains(app, 'const SESSION_FRAME_OFFSETS_KEY', 'Session frames must persist manual placement offsets.');
assertContains(app, 'function sessionFrameRect(project, lane, x, y, width, height, bounds = null)', 'Session frame size and placement must be computed consistently.');
assertContains(app, 'function setSessionFrameOffset(project, lane, x, y, persist = true)', 'Session frames must be draggable from their top bar.');
assertContains(app, 'function clampSessionFrameOffset(rect, x, y)', 'Session frame drag offsets must be clamped to project bounds.');
assertContains(app, 'function sessionDragVisualElements(rect, frameEl)', 'Session dragging must collect only the visible session contents once at drag start.');
assertContains(app, 'function applySessionDragVisual(items, dx, dy)', 'Session dragging must move visible contents with CSS transform instead of relayout.');
assertContains(app, 'function dragVisualApplier(items)', 'Drag visuals must coalesce DOM transform writes through requestAnimationFrame.');
assertContains(app, 'visual.move(clamped.x - start.x, clamped.y - start.y);', 'Session dragging must schedule one visual transform per frame instead of writing on every mousemove.');
assert(!app.includes('setSessionFrameOffset(project, lane, clamped.x, clamped.y, false);'), 'Session dragging must not mutate layout state on every mousemove.');
assertContains(app, 'function laneFrameMetrics(phs, startIdx, collapsible, activeAgent, lane)', 'Session frame size must be recalculated from the currently visible folded or expanded lane nodes.');
assertContains(app, 'const SESSION_FRAME_MIN_W = 520;', 'Session frames must stay wide enough to show readable lane names and task actions.');
assertContains(app, 'const WORKSTREAM_GROUP_FRAME_W = 680;', 'Workstream group frames must stay wide enough to show full group headers and task actions.');
assertContains(app, 'function sessionFrameContentOffset(project, lane, xBase, laneY, bounds = null, width = SESSION_FRAME_MIN_W, height = 168)', 'Stored session frame offsets must be clamped with the current dynamic frame size before moving child nodes.');
assertContains(app, 'sessionFrameContentOffset(p, lane, xBase, laneY, opts.projectBounds, frameMetrics.width, frameMetrics.height)', 'Expanded and collapsed lanes must move their nodes with the same clamped dynamic frame size as the visible session wrapper.');
assertContains(app, 'const projectBounds = { left: xBase - 22, top: projectTop + 28, right: Infinity, bottom: Infinity };', 'Session frames must keep top/left bounds while allowing large expanded sessions to drag and expand the project layer.');
assertContains(app, 'const contentXBase = xBase + frameOffset.x;', 'Dragging a session frame must move the contained lane nodes horizontally.');
assertContains(app, 'const contentLaneY = laneY + frameOffset.y;', 'Dragging a session frame must move the contained lane nodes vertically.');
assertContains(app, 'phaseNode(p, phs[i], x, contentLaneY, lane, branch)', 'Phase nodes must render inside the moved session frame with selected branch context.');
assertContains(app, 'agentNode(activeAgent, agentAnchorX + 10, ay, p)', 'Agent nodes must render inside the moved session frame even when the current phase is not visible.');
assertContains(app, 'const agentAnchorX = curX != null ? curX : (prevX != null ? prevX : null);', 'Agent nodes must anchor to the last visible lane node when there is no current phase node.');
assertContains(app, 'if (r.bottom != null) projectBottom = Math.max(projectBottom, r.bottom);', 'Moved session contents must expand the project layer bounds.');
assertContains(app, 'function dormantLaneSessionInfo(project, lane)', 'Completed or idle milestone lanes must still render as visible session areas.');
assertContains(app, 'function workstreamGroupSessionInfo(project, workstreams, expanded)', 'Workstream groups must have their own visible session container.');
assertContains(app, 'const desc = expanded', 'Expanded workstream group headers must avoid repeating child workstream names.');
assertContains(app, 'const summary = expanded', 'Expanded workstream group nodes must summarize counts instead of duplicating child workstream names.');
assertContains(app, '? `phase ${phaseCount} · 활성 ${activeCount}`', 'Expanded workstream group nodes must show only aggregate counts.');
assertContains(app, 'const groupOffset = clampSessionFrameOffset({', 'Workstream group containers must support bounded dragging.');
assertContains(app, '}, sessionFrameOffset(p, groupLane).x, sessionFrameOffset(p, groupLane).y);', 'Workstream group containers must persist their own drag offset.');
assertContains(app, 'const expanded = expandedLanes.has(groupKey) || visibleWorkstreamLanes.some(l => workstreamHasActiveSession(p, l, viewBranch));', 'Workstream groups must open automatically when a child workstream has an active session in the selected branch.');
assertContains(app, 'const groupY = groupBaseY + groupOffset.y + 24;', 'Workstream group toggle nodes need breathing room below the session header.');
assertContains(app, 'let groupLeft = groupX;', 'Workstream group containers must track the left edge of their child workstream sessions.');
assertContains(app, 'let groupTopBound = groupTop;', 'Workstream group containers must track the top edge of their child workstream sessions.');
assertContains(app, 'const childXBase = flowXBase + 36 + groupOffset.x;', 'Expanded workstreams must render inside the moved workstream session container horizontally beside the branch rail.');
assertContains(app, 'const childY = laneY + offset.y + groupOffset.y;', 'Expanded workstreams must render inside the moved workstream session container vertically.');
assertContains(app, 'const workstreamChildBounds = {', 'Expanded child workstream sessions must be clamped to their workstream container.');
assertContains(app, 'left: childXBase - 16,', 'Child workstream sessions must not drag outside the left edge of the workstream container.');
assertContains(app, 'top: groupBaseY + 76 + groupOffset.y,', 'Child workstream sessions must not drag above the workstream container body.');
assertContains(app, 'renderLane(nodesEl, edges, p, lane, childY, null, childXBase, { projectBounds: workstreamChildBounds, branch: viewBranch })', 'Child workstream session frames must use container-scoped drag bounds and selected branch scope.');
assertContains(app, 'if (r.top != null) groupTopBound = Math.min(groupTopBound, r.top);', 'Expanded workstream containers must include child workstreams that were dragged upward.');
assertContains(app, 'if (r.left != null) groupLeft = Math.min(groupLeft, r.left);', 'Expanded workstream containers must include child workstreams that were dragged left.');
assertContains(app, 'const groupFrameLeft = groupLeft - 16;', 'Workstream group containers must be anchored to actual child bounds rather than a stale stored offset.');
assertContains(app, 'baseLeft: groupFrameLeft - groupOffset.x,', 'Workstream group drag offsets must use an unshifted base rect.');
assertContains(app, 'const groupFrameTop = groupTopBound;', 'Workstream group containers must anchor to the actual top bound of contained workstreams.');
assertContains(app, 'baseTop: groupFrameTop - groupOffset.y,', 'Workstream group drag offsets must use an unshifted top base.');
assertContains(app, 'const groupHeight = Math.max(172, groupBottom - groupFrameTop + 44);', 'Expanded workstream containers must grow to wrap their child workstream sessions.');
assert(!app.includes('const groupRect = sessionFrameRect(p, groupLane'), 'Workstream group containers must not apply legacy draggable offsets that separate the frame from child workstreams.');
assertContains(app, "info.action === 'toggle-workstreams' ? ' workstream-container' : ''", 'Workstream group frames must have container-specific styling.');
assert(!app.includes("if (info.action === 'toggle-workstreams') return;"), 'Workstream group containers must be draggable from their top bar.');
assertContains(app, "title: '워크스트림 영역'", 'Workstream containers must read as an area, not a started work session.');
assertContains(app, "tone: done ? 'done' : 'ready'", 'Completed milestone sessions must use a non-running done tone.');
assertContains(app, 'addLaneLabel(nodesEl, p, lane, contentLaneY, contentXBase, { sessionFramed: !!sessionInfo, branch });', 'Lane labels must move with the session frame and know when it owns the lane title and selected branch.');
assertContains(app, "let html = sessionFramed ? '' : (laneKind === 'main'", 'Session-framed lanes must not duplicate the title above the frame.');
assertContains(app, 'if (sessionFramed && !html.trim()) return;', 'Session-framed lanes must not render external git badges or task buttons outside their session frame.');
assertContains(app, 'if (!sessionFramed && (!lane || lane.kind === \'main\')) html += gitBadge(p.git);', 'Git badges must stay off session-framed lane labels.');
assertContains(app, "if (!sessionFramed && canRequestTask) html += taskActionButtonHtml(p, lane, '', branch);", 'Task buttons must stay off session-framed lane labels and keep selected branch scope.');
assertContains(app, 'function sessionFrameTaskButtonHtml(project, lane, branch = selectedProjectBranch(project))', 'Session-framed lanes must expose their task entry point inside the selected branch session frame.');
assertContains(app, "${sessionFrameTaskButtonHtml(project, lane, info.branch || selectedProjectBranch(project))}", 'Session frame headers must include the lane task entry button for the selected branch.');
assertContains(app, "frameTaskBtn.addEventListener('mousedown', (e) => e.stopPropagation());", 'Session frame task buttons must not start dragging.');
assertContains(app, "if (e.target.closest('.lsf-toggle') || e.target.closest('.session-frame-task-btn') || e.target.closest('.lsf-agent-badge')) return;", 'Session frame task and agent buttons must be clickable without triggering drag.');
assertContains(app, 'extra += 56;', 'Session-framed lanes must reserve enough vertical space to avoid overlapping frames.');
assertContains(app, "if (taskSessionVisible(task))", 'Lodestar-created task sessions must wrap only their own lane.');
assertContains(app, "if (lane && lane.kind === 'workstream') expandedLanes.add(workstreamGroupKey(project));", 'Opening a workstream task must reveal the containing workstream session area.');
assertContains(app, "task.draftOpen || taskSessionRunning(task)", 'Draft and running task sessions must become visible immediately after task request.');
assertContains(app, "tone: isDraft ? 'draft'", 'New task sessions must have a distinct draft tone before execution.');
assertContains(app, "if (previous && !opts.forceNewDraft)", 'Reopening an existing draft session must edit the same session instead of replacing it.');
assertContains(app, "draftOpen: true", 'Opening a task request must create a visible draft session.');
assertContains(app, "taskCtx.draft = $('#taskPrompt').value;", 'Task prompt edits must update the visible draft session.');
assertContains(app, "ctx.draftOpen = false;", 'Draft sessions must convert to running sessions when execution starts.');
assertContains(app, "else if (info.action === 'background') openBackgroundTask(project, info.task);", 'Lane session wrappers must open the matching background task.');
assertContains(app, 'class="lsf-toggle"', 'Workstream session frames must expose an explicit expand/collapse button.');
assertContains(app, "toggleBtn.addEventListener('click'", 'Workstream session expand/collapse must only happen from its toggle button.');
assert(!app.includes("else if (info.action === 'toggle-workstreams') {\n      const key = workstreamGroupKey(project);"), 'Clicking the whole workstream session frame must not toggle it.');
assertContains(app, "const blocksFramePan = frame && (!frame.classList.contains('workstream-container') || e.target.closest('.lsf-head'));", 'Canvas panning must not steal normal session frame dragging while allowing workstream container body panning.');
assertContains(app, "frame.classList.contains('workstream-container')", 'Workstream container body must allow canvas panning when dragged.');
assertContains(app, "e.target.closest('.project-layer-head')", 'Project top bars must remain draggable instead of panning the canvas.');
assert(!app.includes("e.target.closest('.project-layer') ||"), 'Project interior should pan the canvas when dragged.');
assertContains(app, 'projectBottom - projectTop + 34', 'Project layers must keep enough bottom padding to contain workstream frames.');
assertContains(app, 'const sid = agent.sessionId || (project.activity && project.activity.sessionId);', 'Agent detail must use the clicked agent session id, not only the current project session.');
assertContains(app, 'const fallbackPrompt = agent.desc || agent.sub', 'Agent detail must show visible instructions even before subagent logs are written.');
assertContains(app, "'<span class=\"lane-name\">마일스톤 phase</span>'", 'Main lane should be labeled as milestone phase, not a separate main session.');
assert(!app.includes('lane-main-tag'), 'Main should not appear as a separate lane tag outside the milestone session.');
assertContains(app, 'function openGitSwitch(project)', 'Project headers must allow selecting the Git branch workspace view.');
assertContains(app, 'class="project-git-btn"', 'Git projects must expose an in-canvas Git branch workspace button.');
assertContains(app, "gitCtx = { project, current: (project.git && project.git.branch) || '', refs: [] };", 'Git branch workspace selection must open an in-app branch picker instead of a native prompt.');
assertContains(app, 'function renderGitBranches()', 'Git branch picker must render clickable branch options.');
assertContains(app, "btn.addEventListener('click', () => switchGitTo(btn.dataset.ref || ''));", 'Clicking a Git branch must select that branch workspace.');
assertContains(app, 'setSelectedProjectBranch(gitCtx.project, target);', 'Git branch picker must change the viewed branch without changing the project checkout.');
assert(!app.includes('await window.lodestar.switchGitRef(gitCtx.project.path, target)'), 'Git branch picker must not checkout the whole project.');
assert(!app.includes('const ref = prompt('), 'Git branch selection must not rely on a native prompt that can be invisible in Electron.');
assertContains(app, 'laneY += sessionBoard.height ? sessionBoard.height + 28 : 0;', 'Phase lanes must move down only when a real session board is visible.');
assertContains(app, 'const height = Math.max(SESSION_BOARD_H', 'Session board height must grow when multiple terminal-like sessions wrap.');
assertContains(app, 'session-box-task', 'Session boxes must expose task request actions.');
assertContains(app, "const canRequestTask = !lane || lane.kind === 'main' || lane.kind === 'workstream';", 'Milestone and workstream lanes must expose task request buttons that start sessions.');
assertContains(app, 'function taskActionButtonHtml(p, lane, extraClass = \'\', branch = selectedProjectBranch(p))', 'Task request button rendering must be reusable by lanes and session cards with selected branch scope.');
assertContains(app, 'function planningTab(project)', 'Planning artifact display must remember current/history tab per project.');
assertContains(app, 'data-plan-tab="history"', 'Planning artifact display must expose a history tab.');
assertContains(app, 'setPlanningTab(p, btn.dataset.planTab || \'current\');', 'Planning artifact tabs must be clickable.');
assert(!app.includes('...historyAgents(project)'), 'Planning history tab must not include completed inactive agents.');
assertContains(app, 'function backgroundHistoryItems(project)', 'Planning history tab must include completed background quick/process sessions.');
assertContains(app, 'const bySession = new Map();', 'Planning history must merge background tasks and Claude logs by session id.');
assertContains(app, 'sessionId: t.sessionId || null', 'Background history entries must carry their Claude session id for deduping.');
assertContains(app, "it && !it.active && it.bucket !== 'current'", 'History tab must exclude current active planning nodes.');
assertContains(app, "t && !isBgTaskRunning(t) && t.status === 'completed'", 'History tab must only show completed persisted process sessions.');
assertContains(app, 'openBackgroundTask(project, task)', 'Planning history background sessions must reopen their execution detail.');
assert(!app.includes("board.querySelectorAll('.project-session-box.history[data-agent-id]')"), 'History session board must not render completed agents as clickable history cards.');
assert(!app.includes('현재 관리 없음'), 'Planning current empty state should stay compact.');
assertContains(app, 'const workstreamLanes = lanes.filter(l => l.kind === \'workstream\');', 'Workstream lanes must be grouped separately from the main lane.');
assertContains(app, 'const renderMainLanes = visibleMainLanes.length ? visibleMainLanes : (!visibleWorkstreamLanes.length && currentBranchView && lanes[0] ? [lanes[0]] : []);', 'Projects that only have workstreams must not render the first workstream once as a fake main lane and again inside the selected branch workstream group.');
assert(!app.includes('for (const lane of mainLanes.length ? mainLanes : [lanes[0]])'), 'Main-lane fallback must not duplicate the first workstream outside the workstream group.');
assertContains(app, '? (p.activity.current || null)', 'Canvas must render only currently active external subagents as visible context.');
assertContains(app, 'function projectExternalActivityVisible(project, renderedMainLanes)', 'Workstream-only projects must still surface external terminal activity.');
assertContains(app, 'function activityMatchesBackgroundTask(project)', 'Lodestar-launched workstream tasks must not be reclassified as external terminal activity.');
assertContains(app, 'projects = next.map(normalizeProjectActivity);', 'Project scans must normalize internal Lodestar task activity before rendering external terminal nodes.');
assertContains(app, 'activity.internalLodestarTask = true;', 'Internal Lodestar task activity must be marked after external activity filtering.');
assert(!app.includes('act.hasLog && visibleSessions.length'), 'Completed external terminal sessions must not reappear as current canvas nodes.');
assertContains(app, 'function externalSessionHistoryItems(project)', 'Completed external Claude sessions must render as project history sessions.');
assertContains(app, '!s.running && !s.awaiting && !s.blocked && !isSessionHidden(project, s.sessionId)', 'History sessions must include only completed visible external sessions.');
assertContains(app, '...externalSessionHistoryItems(project)', 'History tab must include only real external sessions that can be opened.');
assert(!app.includes('...planningHistory(project)'), 'History tab must not include sessionless planning artifacts that cannot be opened.');
assertContains(app, 'function closeSession(project, sessionId)', 'Claude sessions must be closable from the UI.');
assertContains(app, "setSessionMark(project, sessionId, 'ignored');", 'Closing a session must persistently hide that session.');
assertContains(app, 'function backgroundSessionKey(task)', 'Background tasks must have a hideable session key.');
assertContains(app, 'function isBackgroundTaskHidden(project, task)', 'Closed background sessions must stay hidden after rescans.');
assertContains(app, 'async function closeBranchSession(project, btn)', 'Branch session nodes must expose a close/stop action.');
assertContains(app, 'const res = await window.lodestar.stopTask(bgId);', 'Closing a running Lodestar-managed branch session must attempt to stop the real background process.');
assertContains(app, 'const hiddenKey = sessionId || (bg ? backgroundSessionKey(bg) : \'\') || (bgId ? `bg:${bgId}` : \'\');', 'Closing branch sessions must persist a hidden marker even when there is only a background task id.');
assertContains(app, "board.querySelectorAll('.pba-session-close')", 'Branch session close buttons must be wired separately from opening the session.');
assertContains(app, 'data-session-id="${esc(item.sessionId)}"', 'History session cards must carry the Claude session id.');
assertContains(app, 'openHistorySessionTask(project, session)', 'Clicking a history session card must open that session conversation.');
assertContains(app, 'const task = historyBackgroundTaskById(project, chip.dataset.bgId);\n      if (task) {\n        openBackgroundTask(project, task);\n        return;\n      }', 'History cards backed by a background task must open the saved task log before falling back to the full live Claude session.');
assertContains(app, "openTaskWindowPayload(taskWindowPayload('background'", 'Opening a running/background session must use the dedicated session window.');
assertContains(app, "openTaskWindowPayload(taskWindowPayload('history'", 'Opening a history session must use the dedicated session window.');
assertContains(app, "openTaskWindowPayload(taskWindowPayload('task-session'", 'Opening an existing task session must use the dedicated session window.');
assertContains(mainSrc, "ipcMain.handle('session:detail'", 'Main process must expose Claude session transcript lookup.');
assertContains(preloadSrc, 'sessionDetail: (opts)', 'Renderer must access session transcript lookup through preload.');
assertContains(app, 'window.lodestar.sessionDetail', 'History fallback drawer must fetch the full Claude session transcript.');
assertContains(app, 'nodesEl.appendChild(externalActivityNode(p, flowXBase, y));', 'External terminal activity must render in the right-side project workflow when no main lane exists.');
assertContains(app, '외부 터미널 세션', 'External terminal work must be labeled clearly on the canvas.');
assert(!app.includes('최근 외부 터미널 세션'), 'Recent external terminal work must be kept in history, not as a current canvas node.');
assertContains(app, "agent.kind === 'shell'", 'Shell-running activity must route to the activity feed instead of subagent detail.');
assertContains(app, '<div class="tl-head">Shell 타임라인</div>', 'Activity feed must show a shell timeline.');
assert(!app.includes('backgroundTaskBadge(bgTask)'), 'Lane labels must not surface background tasks as user-visible status.');
assert(!app.includes('function backgroundTaskBadge'), 'Lane labels must not keep a background-task badge renderer around.');
assert(!app.includes("btnTxt = '◌ 백그라운드'"), 'Lane task buttons must not switch to a background-running label.');
assert(!app.includes('백그라운드 작업 — 클릭하면 저장된 진행 상황 보기'), 'Background tasks must not hijack lane task button clicks.');
assert(!app.includes('백그라운드에서 실행 중입니다'), 'Task drawer must not show background wording for persisted running work.');
assertContains(app, 'return projectAwaiting(project) || !!(project && project.activity && project.activity.blocked);', 'Node paused state must reflect actual blocked activity.');
assertContains(app, 'function workstreamPromptPrefix(project, lane)', 'Workstream task prompts must include scoped context.');
assertContains(app, 'openTask(p, null, lane, { branch })', 'Workstream lane task button must open a selected-branch scoped task.');
assertContains(app, 'promptWithMaybeClearedContext(taskCtx.project, taskCtx.lane, opinion)', 'Generic task prompts must preserve workstream scope while WCC commands can clear context.');
assertContains(app, 'function isWccCommandText(text)', 'Task runner must detect WCC commands that should start with a clear context.');
assertContains(app, 'function promptWithMaybeClearedContext(project, lane, prompt)', 'WCC slash commands must not be hidden behind Lodestar scope prefixes.');
assertContains(app, 'const startsFresh = isWccCommandText(opinion);', 'Task prompt execution must detect WCC commands before choosing resume context.');
assertContains(app, 'const resumeSessionId = !startsFresh && taskCtx && taskCtx.canResume && taskCtx.sessionId ? taskCtx.sessionId : null;', 'WCC commands must automatically clear previous Claude session context.');
assertContains(app, 'branch: taskCtx.branch || projectBranchKey(taskCtx.project)', 'Claude task execution must persist the originating branch.');
assertContains(app, 'workstream: taskCtx.lane && taskCtx.lane.kind === \'workstream\' ? { name: taskCtx.lane.name } : null,', 'Claude task execution must persist the originating workstream.');
assertContains(app, 'function stopCurrentTask()', 'Running Claude tasks must be stoppable from the task drawer.');
assertContains(app, 'window.lodestar.stopTask(ctx.backgroundTaskId)', 'Task stop button must call the main-process stop API for the active session.');
assertContains(app, 'ctx.stopRequested = false;', 'Starting a Claude turn must reset any previous stop request.');
assertContains(app, 'setTaskStopVisible(true, true);', 'Conversation stop must be clickable immediately when a run starts.');
assertContains(app, "ctx.stopRequested && taskCtx === ctx", 'Stop requests made before the background task id arrives must fire once the id is known.');
assertContains(app, "ctx.backgroundTaskId ? '중단 중…' : '중단 예약됨 — 실행 프로세스가 연결되는 즉시 중단합니다.'", 'Stopping before process discovery must show a clear queued stop state.');
assertContains(app, 'function taskSessionRunning(ctx)', 'Task running state must include persisted background task status.');
assertContains(app, 'return bg ? isBgTaskRunning(bg) : false;', 'Task sessions must not stay running from a stale background task id alone.');
assertContains(app, "이전 실행 상태를 찾지 못해 실행 중 표시를 정리했습니다.", 'Restored sessions with missing background task state must clear stale running labels.');
assertContains(app, 'const previous = readPersistedTaskSessions();', 'Persisting current task sessions must start from previously saved history.');
assertContains(app, 'if (historical) all[key] = raw;', 'Completed task sessions must survive refresh/restart as history.');
assertContains(app, 'if (raw.key && taskSessions.has(raw.key)) continue;', 'Restored task sessions must not render twice from saved raw state.');
assertContains(app, "key: `saved:${raw.key || raw.sessionId || raw.backgroundTaskId || raw.savedAt || raw.laneId}`", 'Saved task sessions must become branch session nodes even when no longer current.');
assertContains(app, '${row.sessionId ? `data-session-id="${esc(row.sessionId)}"` : \'\'}', 'Branch session nodes must carry Claude session ids for reopening history.');
assertContains(app, "openHistorySessionTask(project, {", 'Branch saved session nodes must reopen the Claude history transcript.');
assertContains(app, 'function setTaskInputsLocked(locked)', 'Task prompt and reply inputs must be lockable while Claude is running.');
assertContains(app, 'prompt.readOnly = !!locked;', 'Running Claude work must prevent editing the task instruction.');
assertContains(app, 'const lockReply = !!locked && !(taskCtx && taskCtx.running);', 'Running Claude work must keep the separate mid-run message input editable.');
assertContains(app, 'setTaskInputsLocked(true);', 'Task inputs must lock immediately when a run starts.');
assertContains(app, "$('#taskRunBtn').disabled = !!sessionRunning;", 'Task run button must stay disabled while the rendered session is running.');
assertContains(app, "$('#taskRunBtn').disabled = activeTaskRunning();", 'Task run button must not be re-enabled if the background session is still running.');
assertContains(app, 'class="project-session-add-btn"', 'Project headers must expose a project-level add-session button.');
assertContains(app, 'function openBranchSessionPicker(project, opts = {})', 'Project add-session button must require choosing or creating a branch before chat starts.');
assertContains(app, 'function openProjectSession(project)', 'Project add-session button must open the branch-scoped new-session flow.');
assertContains(app, 'openBranchSessionPicker(project, { lane: projectMainLane(project) });', 'Project-level sessions must not open chat until a branch is selected.');
assertContains(html, 'id="branchSessionDrawer"', 'Branch-scoped new sessions must have a dedicated selection drawer.');
assertContains(html, '브랜치 생성 후 세션 시작', 'New session flow must support creating a branch before chat.');
assertContains(app, 'function createDraftTaskSession(project, discuss, lane, branch = null, opts = {})', 'Opening a new session must register a branch-scoped draft session before the window appears.');
assertContains(app, 'const nodeKey = taskNodeKey(project, actualLane, actualBranch);', 'Opening a new session must bind the draft to the same branch/workstream visual node.');
assertContains(app, '::manual:', 'Explicit new-session actions must create a separate Claude context without overwriting an active node session.');
assertContains(app, "taskWindowPayload('new', project, { task: taskCtx", 'Project session windows must receive the draft task so the canvas can show it immediately.');
assertContains(app, 'restoreTaskSessionsForProjects(projects);', 'Opening a task must reload persisted session-window drafts before deciding whether to create a fresh session.');
assertContains(app, 'const myTaskDraft = !!(myTask && myTask.draftOpen && !runningStoredTask', 'Running background tasks must take visual priority over draft sessions.');
assertContains(app, "taskCtx.pendingInterjection = text;", 'Mid-run messages must be queued instead of mutating the original task instruction.');
assertContains(app, 'function renderAwaitingQuestionControls(question)', 'AskUserQuestion choices must render in the main task drawer.');
assertContains(app, 'function normalizedAwaitingQuestions(input)', 'AskUserQuestion controls must accept multiple pending questions.');
assertContains(app, '.await-answer-input', 'AskUserQuestion choices must fill per-question answer inputs.');
assertContains(app, 'sendAwaitingQuestionAnswers(box, questions)', 'AskUserQuestion answers must be submitted together through the same session.');
assertContains(sessionJs, 'function renderAwaitingQuestion(question)', 'AskUserQuestion choices must render in independent session windows.');
assertContains(sessionJs, 'function normalizedAwaitingQuestions(input)', 'Independent session windows must accept multiple pending questions.');
assertContains(sessionJs, 'sendAwaitingQuestionAnswers(box, questions)', 'Independent session answers must be submitted together through the same session.');
assertContains(app, "prompt: pending,\n      historyPrompt: pending,\n      branch: ctx.branch || projectBranchKey(ctx.project),\n      sessionId: ctx.sessionId", 'Queued mid-run messages must auto-send with --resume after the current turn completes on the originating branch.');
assertContains(app, "ctx.pendingInterjection = pending;", 'Queued mid-run messages must be preserved if no session id is available yet.');
assertContains(app, 'sessionId: startsFresh ? null : taskCtx.sessionId,', 'WCC commands typed into a past-session chat must start a fresh Claude session.');
assertContains(app, 'await runTaskTurn(opts, startsFresh ? `› WCC 새 세션: ${text}` : `› 내 답변: ${text}`);', 'Past-session chat must label WCC fresh starts distinctly.');
assertContains(app, 'if (ctx.historySessionId || label) ctx.historySessionId = ctx.sessionId || ctx.historySessionId || null;', 'Sending a reply from history must keep the same conversation selected.');
assertContains(app, "$('#taskReply').placeholder = '이 대화에 이어서 보낼 메시지를 입력하세요. (Ctrl+Enter)';", 'After replying, the drawer must remain in chat-continuation mode.');
assertContains(app, 'const TASK_PROMPT_HISTORY_KEY', 'Submitted task instructions must be stored as copyable history.');
assertContains(app, 'function savePromptHistoryItem(project, item)', 'Task execution must save submitted prompts into history.');
assertContains(app, 'function promptHistoryKey(item, prompt)', 'Task history must be keyed by Claude session or background task before prompt text.');
assertContains(app, 'function promptHistoryScopeKey(project, item = null)', 'Task history must be scoped by project, branch, lane, and session.');
assertContains(app, 'samePromptHistorySession(x, key, item, prompt)', 'Task history updates must merge into the same session entry.');
assertContains(app, 'function renderTaskPromptHistory(project)', 'Task drawer must render submitted prompt history.');
assert(!app.includes('task-history-copy'), 'Session history entries must not show copy buttons.');
assert(!sessionJs.includes('task-history-copy'), 'Independent session history entries must not show copy buttons.');
assertContains(app, 'function removePromptHistoryItem(project, item)', 'Main task session history must support deleting individual entries.');
assertContains(sessionJs, 'function removeHistoryItem(item)', 'Independent session history must support deleting individual entries.');
assertContains(sessionJs, 'function historyScopeKey(item = null)', 'Independent session history must be scoped to the current branch, lane, and session.');
assertContains(sessionJs, "const laneId = lane && lane.kind === 'workstream' ? `workstream:${lane.name || 'workstream'}` : 'main';", 'Independent session windows must scope history by workstream lane.');
assertContains(sessionJs, 'workstream: lane && lane.kind === \'workstream\' ? { name: lane.name } : null,', 'Independent session windows must pass the originating workstream to task execution.');
assertContains(sessionJs, "const TASK_SESSIONS_KEY = 'lodestar.taskSessions.v1';", 'Independent session windows must persist their task session state for the main canvas.');
assertContains(sessionJs, 'function persistSessionState(extra = {})', 'Independent session windows must save draft/run state outside prompt history.');
assertContains(sessionJs, 'localStorage.setItem(TASK_SESSIONS_KEY, JSON.stringify(all || {}));', 'Independent session windows must write the shared task session store.');
assertContains(sessionJs, "persistSessionState({ draft: el.value, draftOpen: !sessionId && !backgroundTaskId && !outputText", 'Typing in an independent session window must preserve the draft if the window is closed.');
assertContains(sessionJs, "persistSessionState({ draft: $('#prompt') ? $('#prompt').value : ''", 'Closing an independent session window must flush the latest draft state.');
assertContains(app, "box.querySelectorAll('.task-history-delete')", 'Main task session history must wire delete buttons.');
assertContains(sessionJs, "box.querySelectorAll('.task-history-delete')", 'Independent session history must wire delete buttons.');
assert(!app.includes('실행 중에는 히스토리 화면으로 전환하지 않습니다.'), 'Running sessions must not block viewing other session history in the main drawer.');
assert(!sessionJs.includes('실행 중에는 히스토리 화면으로 전환하지 않습니다.'), 'Running sessions must not block viewing other session history in session windows.');
assertContains(app, 'const showHistoryInWorkbench = (idx) => {', 'Task prompt history clicks must show the previous conversation in the execution pane.');
assertContains(app, "setMarkdownOutput('#taskOut', body);", 'Task prompt history must render the saved conversation in the main transcript pane.');
assertContains(app, "$('#taskRunBtn').classList.add('hidden');", 'Task prompt history must use chat continuation instead of a separate load-into-input action.');
assert(!app.includes('입력창에 불러오기'), 'Task prompt history must not offer a load-into-input action.');
assertContains(app, 'function compactHistoryTranscript(text)', 'Task prompt history must store bounded conversation snapshots.');
assertContains(app, 'promptHistoryConversation(item)', 'Task prompt history detail must render saved conversation snapshots.');
assertContains(app, 'conversation: ctx.output ||', 'Task execution history must preserve the visible Claude transcript.');
assertContains(sessionJs, 'const showHistoryInWorkbench = (idx) => {', 'Independent task windows must show history in the main workbench.');
assertContains(sessionJs, 'setOutput(body);', 'Independent task history must render the saved conversation in the transcript pane.');
assertContains(sessionJs, 'function compactTranscript(text)', 'Independent task windows must store bounded conversation snapshots.');
assertContains(sessionJs, 'historyConversation(item)', 'Independent task history detail must render saved conversation snapshots.');
assertContains(sessionJs, '대화 내용', 'Independent task history detail must label the saved transcript.');
assertContains(app, 'function renderSessionMini(project, selectedSessionId = null)', 'Session history rendering must accept a selected session id.');
assertContains(app, "if (!selectedId) { box.classList.add('hidden'); box.innerHTML = ''; return; }", 'Session mini history must not show unrelated sessions when no session is selected.');
assertContains(app, 'taskCtx.historySessionId', 'Selected history sessions must stay pinned instead of falling back to the current session.');
assertContains(app, 'renderSessionMini(project, session.sessionId || null);', 'Clicking a session history item must re-render the list with that item selected.');
assertContains(app, "$('#taskReplyRow').classList.toggle('hidden', !session.sessionId);", 'Past history sessions must show a chat box when a session id exists.');
assertContains(app, "$('#taskRunBtn').classList.add('hidden');", 'Past history sessions must use chat input instead of a separate resume button.');
assertContains(app, "선택한 과거 세션에 메시지를 보내면 같은 세션 ID로 <code>--resume</code> 전달합니다.", 'Past history session helper text must describe chat-based resume.');
assertContains(app, "const canChat = !!(task.sessionId && (!bgRunning || bgAwaiting));", 'Background sessions must expose chat after completion or when a decision gate is detected.');
assertContains(app, "bgAwaiting ? '결정 답변을 입력하세요. 선택지를 눌러도 됩니다. (Ctrl+Enter)' : '과거 세션에 이어서 보낼 메시지를 입력하세요. (Ctrl+Enter)'", 'Past sessions must present a chat-style placeholder and decision gates must present an answer placeholder.');
assertContains(app, 'aria-current="true"', 'Selected session history items must expose an active state.');
assertContains(app, 'savePromptHistoryItem(ctx.project', 'Task execution must add the sent prompt to history when run starts.');
assertContains(app, 'historyPrompt: opinion', 'Task prompt history must store the user typed instruction, not expanded scoped prompts.');
assertContains(app, "const historyPrompt = opts.historyPrompt || opts.prompt || '';", 'Task prompt history must prefer the original user instruction.');
assert(!app.includes('function copyCurrentTaskPrompt()'), 'Task drawer must not use a standalone copy-instruction footer button.');
assertContains(app, "$('#taskStopBtn').addEventListener('click', stopCurrentTask);", 'Task stop button must be wired.');
assertContains(sessionJs, 'let stopRequested = false;', 'Independent task windows must remember queued stop requests.');
assertContains(sessionJs, 'setStopVisible(true, true);', 'Independent task stop must be clickable immediately when a run starts.');
assertContains(sessionJs, 'if (stopRequested) stopCurrentTask();', 'Independent task windows must stop once the background task id arrives.');
assertContains(app, 'function renderSkillSuggest()', 'Task prompt must render Claude Skill suggestions.');
assertContains(app, 'function slashTokenInfo()', 'Task prompt must detect slash command tokens.');
assertContains(app, 'function handleCommandPaletteKey(e)', 'Slash command palette must support keyboard navigation.');
assertContains(app, 'insertSkillHint(btn.dataset.command)', 'Slash command suggestions must be clickable and insert commands.');
assertContains(app, 'function commandInputEl()', 'Slash command palette must work against the focused task or reply input.');
assertContains(app, 'commandBoxForInput(info && info.input)', 'Slash command palette must render next to the active input.');
assertContains(app, '<div class="command-preview">', 'Slash command palette must show the active command body preview.');
assertContains(app, 'active.detail || active.summary', 'Slash command preview must use command markdown contents.');
assert(!app.includes('.slice(0, 9);'), 'Slash command palette must not cap WCC command matches to nine items.');
assertContains(app, "$('#taskReply').addEventListener('input'", 'Reply input must support slash command suggestions.');
assertContains(app, 'if (!taskCtx || activeTaskRunning() || !matches.length)', 'Slash command palette must stay hidden when no slash match exists or the active session is running.');
assertContains(app, 'const taskSessions = new Map()', 'Task drawer state must keep independent workstream sessions.');
assertContains(app, 'const TASK_SESSIONS_KEY', 'Task conversation sessions must persist across app restarts.');
assertContains(app, 'function serializeTaskSession(ctx)', 'Task sessions must be serialized before the renderer is closed.');
assertContains(app, 'const excerpt = String(ctx.excerpt || ctx.output || ctx.statusText || ctx.lastPrompt || \'\').trim().slice(-1800);', 'Persisted task sessions must keep only a short excerpt, not full output history.');
assert(!app.includes("output: String(ctx.output || '').slice(-50000)"), 'Persisted task sessions must not duplicate full Claude output history.');
assertContains(app, 'function restoreTaskSessionsForProjects(projectList)', 'Task sessions must be restored after project scans.');
assertContains(app, 'restoreTaskSessionsForProjects(projects);', 'Project refresh must reattach persisted task sessions to current project objects.');
assertContains(app, 'laneForTaskId(project, src.laneId || taskLaneId(src.lane))', 'Persisted workstream sessions must restore into their original lane.');
assertContains(app, "ctx.statusText = src.statusText || '이전 세션을 이어서 실행할 수 있습니다';", 'Restored non-running Claude sessions must explain that they can be resumed.');
assertContains(app, "'백그라운드에서 계속 진행 중입니다'", 'Restarted running tasks must say they are still progressing in the background.');
assertContains(app, 'if (bg && !bgRunning && !existing) return;', 'Completed background tasks must be dropped from current session restore storage.');
assertContains(app, 'if (bg) { openBackgroundTask(ctx.project, bg); return; }', 'Opening a restored background task must show the live background task detail and polling.');
assert(!app.includes('앱 재시작 후 세션이 복원됐습니다'), 'Running background work must not be described as merely restored after restart.');
assertContains(app, 'const myTaskRestored = !!(myTask && myTask.restored', 'Only restored resume pointers should affect task button state.');
assertContains(app, "if (myTaskRestored) { text = '세션 열기'; mode = 'session'; }", 'Restored sessions must open existing conversation instead of looking like a new task request.');
assertContains(app, 'const resumeSessionId = !startsFresh && taskCtx && taskCtx.canResume && taskCtx.sessionId ? taskCtx.sessionId : null;', 'Resumed task runs must keep the Claude session id except WCC fresh-start commands.');
assertContains(app, 'sessionId: resumeSessionId,', 'Task runs from restored sessions must use --resume instead of starting fresh.');
assertContains(app, 'ctx.restored = false;', 'Restored sessions must stop looking current once they are actively resumed.');
assertContains(app, 'return `${projectScopeKey(project)}|${kind}|${name}`;', 'Session frame positions must be scoped by branch as well as lane.');
assertContains(app, 'const clientRunId = newClientRunId(ctx);', 'Task streaming must tag each run with a client run id.');
assertContains(app, 'if (payload.clientRunId !== clientRunId) return;', 'Task streaming must ignore progress from other workstream sessions.');
assertContains(app, 'opts = { ...opts, clientRunId, backgroundOnly: true };', 'Task runs must detach immediately into persisted background processes.');
assertContains(app, 'function pollTaskContextBackground(ctx)', 'Detached task runs must keep polling their persisted background state.');
assertContains(app, "ctx.statusText = '실행 중입니다. 이 창이나 앱을 닫아도 작업은 계속 진행됩니다.';", 'Detached task sessions must explain that app/window restart will not stop the job.');
assertContains(app, 'function addProjectLayer(nodesEl, project, x, y, width, height, offset)', 'Canvas must render draggable project separation layers.');
assertContains(app, "const layersEl = $('#projectLayers');", 'Canvas must use a dedicated project layer container.');
assertContains(app, 'function projectOffset(project)', 'Project separation layers must support persisted offsets.');
assertContains(app, 'setProjectOffset(project, nextX, nextY, true);', 'Dragging a project layer must persist final movement on mouseup.');
assertContains(app, "layer.querySelector('.project-layer-head').addEventListener('mousedown'", 'Project movement must start from the layer top bar only.');
assertContains(app, 'function projectDragVisualElements(rect, layerEl)', 'Project dragging must collect visible project contents once at drag start.');
assertContains(app, 'visual.move(nextX - start.x, nextY - start.y);', 'Project dragging must move visible contents with a coalesced transform.');
assert(!app.includes('setProjectOffset(project, nextX, nextY, false);'), 'Project dragging must not mutate layout state during mousemove.');
assert(!app.includes('function scheduleDragLayout()'), 'Dragging must not rebuild the canvas while the pointer is moving.');
assert(!app.includes('layout({ fast: true });'), 'Dragging must avoid even fast layout work while the pointer is moving.');
assertContains(app, 'if (!fast) for (const e of edges) edgesEl.appendChild(bezier(e));', 'Dragging must skip expensive edge regeneration until drop.');
assertContains(app, 'flushDragLayout();', 'Dragging must restore a full layout when the pointer is released.');
assertContains(app, 'Math.max(PROJECT_MIN_W, projectRight - xBase + 70)', 'Project layer width must leave enough room for session and main content without hard-coding branch board width.');
assert(!app.includes('lane-act-btn'), 'Lane labels must not show a separate project-wide activity button.');
assertContains(app, 'const scale = Math.abs(view.scale - 1) < 0.015 ? 1 : Number(view.scale.toFixed(3));', 'Canvas transform must snap near-100% scale to keep text crisp.');
assertContains(app, 'translate(${Math.round(view.x)}px, ${Math.round(view.y)}px) scale(${scale})', 'Canvas transform must avoid permanent 3D compositing that blurs text.');
assertContains(app, '`${esc(git.lastCommit.hash)} · ${esc(git.lastCommit.rel)}</span>`', 'Top git badge must stay compact and omit long commit subjects.');
assert(!app.includes('최근 도구 호출'), 'Activity feed must show the subagent timeline without a recent-tools section.');
assert(!app.includes('<div class="session-section"><div class="session-head">최근 도구</div>'), 'Task request drawer must not show recent tool noise.');
assert(!app.includes('<div class="tl-head">🔧 도구 호출</div>'), 'Agent detail must not show low-level tool call lists.');
assertContains(app, '<pre class="ag-pre ag-prompt">${esc(r.prompt)}</pre>', 'Agent detail prompt must render without truncation.');
assertContains(app, '상세 로그 대기 중', 'Agent detail fallback must still show instruction/output sections while logs are pending.');
assertContains(app, 'function renderMarkdown(text)', 'Claude markdown output must be rendered for readability.');
assertContains(app, 'function setMarkdownOutput(elOrSelector, text, opts = {})', 'Claude output panes must use a shared markdown renderer.');
assert(!app.includes('function tokenUsageLabel(usage)'), 'Task sessions must not show spent In/Out/Cache/Total token totals.');
assertContains(app, 'function setTaskTokenUsage(usage, remaining = null)', 'Main task drawer must show remaining quota when available.');
assertContains(app, 'function collectProjectTokenRemaining(projectList)', 'Top bar token summary must show remaining quota, not spent token totals.');
assertContains(app, 'function mergeRemainingQuota(a, b)', 'Top bar quota summary must merge each remaining quota bucket independently.');
assertContains(app, "for (const key of ['fiveHour', 'sevenDay', 'sonnet'])", 'Quota merging must not clear older buckets when a newer scan omits them.');
assertContains(app, "const TOKEN_REMAINING_CACHE_KEY = 'lodestar.tokenRemaining.v1';", 'Top bar quota summary must persist the last detected remaining quota.');
assertContains(app, 'function readTokenRemainingCache()', 'Top bar quota summary must read the last detected remaining quota.');
assertContains(app, 'writeTokenRemainingCache(remaining);', 'Top bar quota summary must keep showing the last detected quota when later scans omit it.');
assertContains(app, 'for (const t of p.backgroundTasks || [])', 'Top bar quota summary must include quota detected on background task records.');
assertContains(app, 'function quotaLabel(item)', 'Top bar remaining quota values must be formatted independently.');
assertContains(app, 'function quotaGauge(label, item)', 'Top bar remaining quota must render as gauge bars.');
assertContains(app, 'function updateTopTokenSummary(projectList)', 'Top bar token summary must be rendered from project data.');
assertContains(app, "${quotaGauge('5시간', remaining.fiveHour)}", 'Top bar must render the 5-hour remaining quota as a gauge.');
assertContains(app, "${quotaGauge('7일', remaining.sevenDay)}", 'Top bar must render the 7-day remaining quota as a gauge.');
assertContains(app, "${quotaGauge('소넷', remaining.sonnet)}", 'Top bar must render Sonnet remaining quota as a gauge.');
assertContains(app, 'min-width:${minWidth}px', 'Quota gauge fill must remain visible even when the remaining percentage is very small.');
assertContains(app, 'task-quota-gauges', 'Task drawer token panel must render remaining quota as gauge bars.');
assert(!app.includes('task-token-line">토큰'), 'Task drawer must not render spent token totals above quota gauges.');
assert(!app.includes('토큰 주 ${label(usage.total)}'), 'Top bar must not display aggregate spent token totals.');
assertContains(app, 'updateTopTokenSummary(vis);', 'Canvas layout must refresh the top token summary for visible projects.');
assertContains(app, "if (chunk.type === 'usage')", 'Task progress events must update token usage while running.');
assertContains(sessionJs, 'function setTokenUsage(usage)', 'Independent task windows must explicitly hide spent token totals.');
assert(!sessionHtml.includes('id="factTokens"'), 'Independent task windows must not show spent token totals in the context facts.');
assertContains(sessionJs, 'function setQuotaRemaining(remaining)', 'Independent task windows must show remaining quota as gauges.');
assertContains(sessionJs, "${quotaGauge('5시간', q.fiveHour)}", 'Independent session windows must render the 5-hour remaining quota as a gauge.');
assertContains(sessionJs, 'opts = { ...opts, clientRunId, backgroundOnly: true };', 'Independent task windows must detach Claude work before waiting for output.');
assertContains(sessionJs, 'pollBackgroundTask(backgroundTaskId);', 'Independent task windows must follow detached background work by task id.');
assertContains(sessionJs, "if (chunk.type === 'usage')", 'Independent task windows must update token usage while running.');
assertContains(app, 'function renderChatTranscript(text)', 'Task transcript must render user turns separately from assistant text.');
assertContains(app, 'userTurnLabel(line)', 'Task transcript must detect user turn labels for right-aligned bubbles.');
assertContains(app, 'function splitUserTail(tail)', 'Chat rendering must distinguish multiline user input from old mixed assistant output.');
assertContains(app, 'function splitWccCommandSpill(text)', 'WCC command labels must split accidental Claude text appended to the same line.');
assertContains(app, 'visual.move(clamped.x - start.x, clamped.y - start.y);', 'Session dragging must schedule one visual transform per frame instead of writing on every mousemove.');
assertContains(app, "pushAssistantText([turn.spill, tail].filter(Boolean).join('\\n'));", 'Chat rendering must move accidental WCC label spillover into assistant text.');
assertContains(app, "pushUserBubble([turn.label, split.userTail].filter(Boolean).join('\\n'));", 'Old transcripts must keep only the actual multiline user input in the user bubble.');
assertContains(app, 'pushAssistantText(split.assistantTail);', 'Old transcripts must move assistant text after a blank line out of the user bubble.');
assertContains(app, 'return rawSplit.spill ? { label: rawSplit.prompt, spill: rawSplit.spill } : null;', 'Raw WCC command spillover without a turn label must still split user text from assistant text.');
assertContains(app, 'function promptHistoryPrompt(item)', 'Task history must display the original user command, not appended Claude output.');
assertContains(app, 'el.innerHTML = renderChatTranscript(text);', 'Task output panes must use chat transcript rendering.');
assertContains(sessionJs, 'function renderChatTranscript(text)', 'Independent session transcript must render user turns separately from assistant text.');
assertContains(sessionJs, 'function splitUserTail(tail)', 'Independent session windows must distinguish multiline user input from old mixed assistant output.');
assertContains(sessionJs, 'function splitWccCommandSpill(text)', 'Independent session windows must split accidental WCC label spillover.');
assertContains(sessionJs, "pushAssistantText([turn.spill, tail].filter(Boolean).join('\\n'));", 'Independent session windows must render WCC spillover as assistant text.');
assertContains(sessionJs, "pushUserBubble([turn.label, split.userTail].filter(Boolean).join('\\n'));", 'Independent session windows must keep only actual multiline user input in the user bubble.');
assertContains(sessionJs, 'pushAssistantText(split.assistantTail);', 'Independent session windows must move assistant text after a blank line out of the user bubble.');
assertContains(sessionJs, 'function historyPromptText(item)', 'Independent session history must display cleaned user prompts.');
assertContains(sessionJs, 'function renderOutputNow(text, opts = {})', 'Independent session output must route through chat transcript rendering.');
assertContains(app, 'function renderMarkdownTable(headerLine, dividerLine, bodyLines)', 'Main markdown renderer must render pipe tables.');
assertContains(sessionJs, 'function renderMarkdownTable(headerLine, dividerLine, bodyLines)', 'Independent session markdown renderer must render pipe tables.');
assertContains(app, 'function stripToolUseMarkers(text)', 'Main renderer must hide legacy tool-use markers from chat transcripts.');
assertContains(sessionJs, 'function stripToolUseMarkers(text)', 'Independent task windows must hide legacy tool-use markers from chat transcripts.');
assertContains(app, 'const MAX_RENDER_CHARS = 120000;', 'Long transcripts must be capped before markdown rendering to avoid UI jank.');
assertContains(app, 'function scheduleMarkdownOutput(elOrSelector, text, opts = {})', 'Streaming markdown output must be coalesced with requestAnimationFrame.');
assertContains(app, 'scheduleMarkdownOutput(out, ctx.output);', 'Task streaming must not markdown-render on every chunk synchronously.');
assertContains(sessionJs, 'function scheduleOutput(text, opts = {})', 'Independent session streaming output must be coalesced with requestAnimationFrame.');
assertContains(sessionJs, 'scheduleOutput(outputText);', 'Independent session streaming must not markdown-render on every chunk synchronously.');
assertContains(sessionHtml, '<div><dt>작업 상태</dt><dd id="factTask"></dd></div>', 'Independent session context must show the concrete background task state.');
assertContains(sessionHtml, '<div><dt>세션 로그</dt><dd id="factLog"></dd></div>', 'Independent session context must show log growth and last update state.');
assertContains(sessionJs, "if (running && backgroundTaskId) return '실행 중 · 세션 ID 감지 대기';", 'Independent session context must not call a running background task a generic new Claude session.');
assertContains(sessionJs, 'function updateRunFacts(task = null)', 'Independent session context must refresh Claude/task/log facts from background task state.');
assertContains(app, 'function backgroundRuntimeText(task)', 'Main task drawer must show task id, log size, and update time for trustworthy run state.');
assertContains(app, "$('#taskStatus').textContent = bgAwaiting ? 'Claude가 결정을 기다리고 있습니다. 선택하거나 직접 답변하세요.' : backgroundRuntimeText(task);", 'Opening a background task must show concrete runtime evidence, except decision gates which must show answer-needed state.');
assertContains(app, 'const distanceFromBottom = el.scrollHeight - el.scrollTop;', 'Markdown output refresh must preserve manual scroll position.');
assertContains(app, 'setMarkdownOutput(out, ctx.output, { forceScroll: true });', 'Sending a new chat message must scroll to the newly appended user turn.');
assertContains(app, "const visibleLabel = submitted\n    ? (isWccCommandText(submitted) ? `› WCC 새 세션: ${submitted}` : `› 나: ${submitted}`)\n    : '› 이어서 진행';", 'Initial task execution must keep the submitted user message visible in the chat transcript.');
assertContains(app, 'await runTaskTurn(opts, visibleLabel);', 'Initial task execution must pass the visible user turn into the runner.');
assertContains(sessionJs, 'const distanceFromBottom = el.scrollHeight - el.scrollTop;', 'Independent session output refresh must preserve manual scroll position.');
assertContains(sessionJs, 'setOutput(outputText, { forceScroll: true });', 'Independent session sends must scroll to the newly appended user turn.');
assertContains(app, 'let refreshBusy = false;', 'Project auto-refresh must guard against overlapping scans.');
assertContains(app, 'function scheduleAutoRefresh()', 'Project auto-refresh must debounce file watcher bursts.');
assertContains(app, 'scheduleAutoRefresh();', 'Project change events must use debounced refresh scheduling.');
assertContains(app, 'let lastTextInputAt = 0;', 'Project auto-refresh must know when chat typing is active.');
assertContains(app, 'const POST_INTERACTION_REFRESH_MS = 1200;', 'Project auto-refresh must stay quiet briefly after dragging or zooming.');
assertContains(app, 'const interactQuietFor = Date.now() - lastInteractionAt;', 'Project auto-refresh must account for recent canvas interaction.');
assertContains(app, 'const delay = Math.max(', 'Project auto-refresh must wait for typing and canvas interaction to go quiet.');
assertContains(app, 'function queueTaskDraftPersist()', 'Typing in the task prompt must debounce draft persistence.');
assertContains(app, 'queueTaskDraftPersist();', 'Task prompt input must avoid relayout on every keystroke.');
assert(!app.includes('registerTaskSession(taskCtx);\n    layout();'), 'Task prompt typing must not trigger a full canvas layout on every keystroke.');
assertContains(app, 'function scheduleSkillSuggest()', 'Task slash suggestions must be scheduled instead of rendered synchronously on every keystroke.');
assertContains(app, 'ta.value.slice(Math.max(0, pos - 96), pos)', 'Task slash detection must only inspect a short tail near the cursor.');
assertContains(app, "if (!['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(e.key)) return false;", 'Task keydown handling must skip command matching for normal text input.');
assertContains(sessionJs, 'function scheduleCommandSuggest()', 'Independent session slash suggestions must be scheduled instead of rendered synchronously on every keystroke.');
assertContains(sessionJs, 'value.slice(Math.max(0, pos - 96), pos)', 'Independent session slash detection must only inspect a short tail near the cursor.');
assertContains(sessionJs, "if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) return false;", 'Independent session keydown handling must skip command matching for normal text input.');
assertContains(app, '<div class="tl-head">💬 현재까지 출력</div><div class="ag-pre md-output">${renderMarkdown(r.output)}</div>', 'Agent output must render markdown instead of raw preformatted text.');
assert(!app.includes('truncate(r.prompt'), 'Agent detail prompt must not be truncated.');

assertContains(html, 'class="drawer-box session-console"', 'Task drawer must use the promoted session console shell.');
assertContains(html, 'class="session-window-dots"', 'Task drawer must look like a dedicated desktop console window.');
assertContains(html, 'class="session-console-main"', 'Session console must reserve a main working transcript area.');
assertContains(html, 'class="session-console-side"', 'Session console must reserve a side rail for history and session context.');
assertContains(css, '.session-panel { pointer-events: none; z-index: 44; }', 'Session console shell must not block canvas clicks outside the overlay.');
assertContains(css, '.session-panel .session-console', 'Task sessions must open as a dedicated console window.');
assertContains(css, 'width: min(1180px, calc(100vw - 52px)); height: min(820px, calc(100vh - 88px));', 'Session console must be large enough to feel like a working terminal.');
assertContains(css, '.session-console-body', 'Session console must split the transcript and side history areas.');
assertContains(css, '.session-console-side', 'Session console must keep history in a readable side rail.');
assertContains(css, '.session-window-dots', 'Session console must have desktop-window chrome.');
assertContains(css, '.token-usage', 'Task token usage must have visible compact styling.');
assertContains(css, '.top-token-summary', 'Top bar must show aggregate token usage instead of a live-watch badge.');
assertContains(css, '.quota-gauge-track', 'Top bar quota gauges must have visible tracks.');
assertContains(css, '.quota-gauge-fill', 'Top bar quota gauges must have visible fills.');
assertContains(css, '.quota-gauge.unknown .quota-gauge-fill', 'Unknown remaining quota must still show a visible placeholder gauge.');
assertContains(css, '@media (max-width: 1100px)', 'Top bar quota gauges must remain visible on narrow workflow canvases.');
assert(!css.includes('min-width: 430px;'), 'Top bar quota summary must not use a fixed minimum width that pushes it off screen.');
assertContains(css, '.task-quota-gauges', 'Task drawer must style remaining quota gauges.');
assertContains(css, '.session-quota-gauges', 'Session windows must style remaining quota gauges.');
assertContains(css, '.project-branch-board', 'Project branch areas must have a visible board style.');
assertContains(css, '.project-branch-area.running', 'Running branch areas must have a distinct active style.');
assertContains(css, '.pba-head-session', 'Branch areas must expose a top-bar session action.');
assertContains(app, '<span class="pba-head-actions">', 'Branch header state, expand/collapse, and session actions must stay grouped on the right.');
assertContains(app, '<small>${esc(label)}</small>\n        <button class="pba-head-toggle branch-toggle"', 'Branch expand/collapse must sit immediately to the right of the branch state text.');
assertContains(app, 'class="pba-head-session branch-new-session"', 'Branch session action must sit to the right of the expand/collapse control.');
assertContains(app, 'class="pba-head-session branch-new-session"', 'Each branch card header must be able to start a session on that branch.');
assert(!app.includes('btn btn-primary branch-new-session'), 'Branch session creation must not be hidden at the bottom of the branch card.');
assertContains(css, '.pba-actions', 'Branch areas must expose checkout/view actions.');
assertContains(css, '.await-choice', 'AskUserQuestion choices must render as selectable answer buttons.');
assertContains(css, '.await-question', 'AskUserQuestion multiple prompts must render as separate answer cards.');
assertContains(css, '.await-answer-input', 'AskUserQuestion prompts must support free-text answers per question.');
assertContains(css, '.await-send-all', 'AskUserQuestion prompts must expose a single send-all control.');
assertContains(css, '-webkit-app-region: drag;', 'Independent session window header must use native window dragging.');
assertContains(css, '-webkit-app-region: no-drag;', 'Interactive controls inside session windows must not become draggable regions.');
assertContains(css, '#actDrawer, #agDrawer { z-index: 45; }', 'Activity and agent drawers must render over the session panel.');
assertContains(css, '#agDrawer { z-index: 50; }', 'Agent detail drawer must be top-most.');
assertContains(css, '.workstream-group-node', 'Collapsed workstream group must have a distinct visual style.');
assertContains(css, '.external-activity-node', 'External terminal work must have visible canvas styling.');
assertContains(css, '.external-activity-node.recent', 'Recent external terminal work must have a non-running visual state.');
assertContains(css, '.external-activity-node .ea-path', 'External terminal work must show where it is running.');
assertContains(css, '.lsf-agent-badge', 'Session frame agent usage must have a visible badge style.');
assertContains(css, '.node.lane-workstream', 'Workstream phase nodes must be visually distinct from main nodes.');
assert(!css.includes('lane-act-btn'), 'Lane activity button styling must not remain after removing the button.');
assertContains(css, '.skill-suggest', 'Claude Skill suggestions must have visible styling.');
assertContains(css, '.skill-chip', 'Claude Skill chips must have visible styling.');
assertContains(css, 'min-height: 236px;', 'Claude command suggestion area must show at least about five command rows.');
assertContains(css, 'max-height: min(52vh, 460px); overflow: hidden;', 'Claude command suggestion area must be large enough without escaping the drawer.');
assertContains(css, 'min-height: 158px; max-height: 210px; overflow-y: auto;', 'Claude command list must keep room for at least five visible commands.');
assertContains(css, '.command-preview', 'Claude command suggestions must include a readable command preview area.');
assertContains(css, 'max-height: 150px; min-height: 64px;', 'Claude command preview content must not steal space from the command list.');
assertContains(css, '.project-layer', 'Project separation layer must have visible styling.');
assertContains(css, '.project-layers', 'Project layers must render behind nodes in a dedicated layer.');
assertContains(css, '.project-layer-handle', 'Project separation layer must keep a compact drag handle without noisy helper text.');
assertContains(css, '.project-layer-head', 'Project layer top bar must have visible styling.');
assertContains(css, '.project-layer-tabs', 'Project layer header must show current/history tabs.');
assertContains(css, '.project-layer-tab.active', 'Active project current/history tab must be visually distinct.');
assertContains(css, '.project-session-add-btn', 'Project add-session button must be visibly styled.');
assertContains(css, '.project-git-btn', 'Project headers must style the Git switch button.');
assertContains(css, '.git-branch-list', 'Git switch drawer must show a visible branch list.');
assertContains(css, '.git-branch-item', 'Git switch drawer must render clickable branch rows.');
assertContains(css, '.agent-node.recent', 'Recently completed subagents must have a distinct non-running style.');
assert(!css.includes('.lane-main-tag'), 'Main lane tag styling must not remain after moving main into the milestone session.');
assertContains(css, '.lane-session-frame', 'Active sessions must be visible as wrappers around the relevant lane.');
assertContains(css, 'position: absolute; z-index: 4; pointer-events: none;', 'Session frame bodies must not block node clicks or canvas panning.');
assertContains(css, 'position: absolute; z-index: 5; pointer-events: auto;', 'Session frame headers must stay above nodes and remain draggable.');
assertContains(css, '.lane-session-frame.awaiting', 'Paused or answer-needed sessions must be visibly distinct in lane wrappers.');
assertContains(css, '.lane-session-frame.draft', 'Newly opened task sessions must be visibly distinct before execution.');
assertContains(css, '.lane-session-frame.draft .lsf-dot', 'Draft session headers must not look like active running sessions.');
assertContains(css, '.lane-session-frame.done', 'Completed milestone sessions must be visibly framed without looking active.');
assertContains(css, '.lane-session-frame.workstream-container', 'Workstream group session frames must visually contain expanded child workstreams.');
assertContains(css, '.lane-session-frame.workstream-container {\n  z-index: 1;', 'Workstream group containers must stay behind child workstream session headers so dragging still works.');
assertContains(css, '.lane-session-frame.workstream-container .lsf-head', 'Workstream group container headers must have dedicated styling.');
assertContains(css, 'cursor: move;', 'Workstream group container headers must communicate draggable placement.');
assertContains(css, '.lane-session-frame.workstream-container .lsf-toggle', 'Workstream group expand/collapse buttons must have extra spacing from the session title.');
assertContains(css, '.lane-label.session-framed::before { display: none; }', 'Session-framed lanes must avoid duplicated lane marker chrome.');
assertContains(css, '.lsf-head', 'Lane session wrappers need a clickable header for session detail.');
assertContains(css, '.lsf-head b {\n  flex: 0 1 auto; min-width: 0; max-width: min(520px, 44vw);', 'Session header titles must shrink before pushing task buttons out of the frame.');
assertContains(css, '.lsf-head small {\n  flex: 0 1 auto; min-width: 0; max-width: min(220px, 20vw);', 'Session header metadata must shrink before stealing task button width.');
assertContains(css, '.lsf-desc {\n  flex: 1 100 40px; min-width: 0;', 'Session header descriptions must shrink first to keep task buttons visible.');
assertContains(css, '.lsf-toggle', 'Workstream session expand/collapse button must be visibly styled.');
assertContains(css, '.session-frame-task-btn', 'Session frame task entry buttons must have visible styling.');
assertContains(css, '.session-frame-task-btn {\n  flex: 0 0 max-content; min-width: max-content;', 'Session frame task buttons must never be squeezed or clipped by long header text.');
assertContains(css, 'cursor: move; user-select: none;', 'Session frame headers must communicate draggable placement.');
assertContains(css, '.lsf-desc', 'Session frame descriptions must stay clipped cleanly after adding drag controls.');
assertContains(css, '.project-session-board', 'Project session board must have visible styling.');
assertContains(css, '.project-session-grid', 'Project session board must lay out terminal-like session boxes.');
assertContains(css, '.project-session-box', 'Individual sessions must be visible rectangular boxes.');
assert(!css.includes('.project-session-box.new'), 'Additional work must start from task request buttons, not a fake idle session box.');
assertContains(css, '.project-session-box.history', 'History mode must show completed sessions as session boxes.');
assert(!css.includes('.project-session-history'), 'History must not render as a strip inside the canvas session board.');
assert(!css.includes('.planning-panel-title'), 'Planning panel must not show an extra current-management label.');
assertContains(css, 'width: 1080px;', 'Project session board must be wide enough to separate concurrent sessions.');
assertContains(css, '.session-box-task', 'Task request action must sit inside each session box.');
assertContains(css, '.project-session-box.history:hover', 'Completed sessions in history must have visible hover styling.');
assertContains(css, '.psh-delete', 'Completed sessions in history must expose a close control.');
assertContains(css, '.session-close', 'Session history rows must expose a close affordance.');
assertContains(css, '.pba-session-close', 'Branch session nodes must expose a close affordance.');
assertContains(css, '.agent-node.stale', 'Long-silent running agents must be visually marked as needing confirmation.');
assertContains(css, '-webkit-font-smoothing: auto;', 'Text must use native font smoothing instead of thin antialiased rendering.');
assertContains(css, 'text-rendering: optimizeLegibility;', 'Text rendering should prefer legible glyph shaping.');
assertContains(css, 'backface-visibility: hidden;', 'Canvas world should avoid unnecessary backface painting during transform.');
assertContains(css, '.viewport.panning .world, body.interacting .world { will-change: transform; }', 'Canvas should only request transform compositing while interacting.');
assertContains(css, 'body.interacting { user-select: none; }', 'Canvas interactions must not spend time updating text selection.');
assertContains(css, 'body.interacting .project-layer,\nbody.interacting .project-layer:hover { background: transparent; }', 'Project layers must reduce paint cost while interacting.');
assertContains(css, 'body.interacting .session-drag-visual,\nbody.interacting .project-drag-visual { will-change: transform; pointer-events: none; }', 'Dragging must promote only the moving contents.');
assertContains(css, '#taskPrompt { min-height: 220px;', 'Task instruction input must reserve enough space.');
assertContains(css, '.fld.locked, .fld[readonly]', 'Locked task inputs must have visible read-only styling.');
assertContains(css, '#taskOut, #runOut {', 'Claude output must have dedicated readability styling.');
assertContains(css, '.md-output h1, .md-output h2, .md-output h3, .md-output h4', 'Markdown output must style headings.');
assertContains(css, '.md-output pre code', 'Markdown output must style code blocks.');
assertContains(css, '.md-table-wrap', 'Markdown tables must be rendered with a readable scroll container.');
assertContains(css, '.chat-row.user { justify-content: flex-end; }', 'User chat bubbles must align to the right.');
assertContains(css, '.chat-assistant', 'Assistant output must render as plain transcript text instead of a chat bubble.');
assert(!css.includes('.chat-row.assistant .chat-bubble'), 'Assistant output must not use chat-bubble styling.');
assertContains(css, '.chat-row.user .chat-bubble', 'User chat bubbles must have distinct styling.');
assertContains(css, 'color-scheme: dark;', 'Dark mode must affect native controls and scrollbars.');
assertContains(css, '.session-composer', 'Independent task window must style the chat composer.');
assertContains(css, '.session-send-hint', 'Independent task window composer must show a compact send hint.');
assertContains(css, 'font-size: 14px;', 'Independent task transcript must use a readable font size.');
assertContains(css, 'line-height: 1.58;', 'Independent task transcript must use compact readable line spacing.');
assertContains(css, '.ag-pre.md-output { white-space: normal;', 'Agent markdown output must not inherit raw pre whitespace.');
assertContains(css, '.task-history', 'Task prompt history must have visible styling.');
assert(!css.includes('.task-history-copy'), 'Session history copy button styling must be removed with the button.');
assertContains(css, '.task-history-delete', 'Session history delete buttons must have visible compact styling.');
assertContains(css, '.task-history-detail', 'Task prompt history full-detail pane must have visible styling.');
assertContains(css, '.task-history-detail pre', 'Task prompt history full text must preserve multiline prompts.');
assertContains(css, '.thd-label', 'Task prompt history detail must visually separate prompt and transcript sections.');
assertContains(css, '.thd-empty', 'Task prompt history detail must explain legacy entries without transcript snapshots.');
assertContains(css, '.session-history.active', 'Selected session history items must remain visually active.');
assertContains(css, '.reply-row #replySuggest', 'Reply slash command palette must be positioned with the reply input.');
assertContains(css, '#agDrawer .act-box { width: min(920px, 94vw); }', 'Agent detail drawer must be wide enough for prompts and output.');
assertContains(css, '.ag-pre.ag-prompt { max-height: min(56vh, 620px); min-height: 220px; }', 'Agent prompt detail must reserve a larger readable pane.');
assertContains(css, 'white-space: pre; word-break: normal; overflow: auto;', 'Agent prompt/output panes must allow scrolling instead of crushing text.');

assertContains(html, 'id="projectLayers"', 'Canvas must include a dedicated project layer container.');
assertContains(html, 'id="gitDrawer"', 'App must include a visible Git branch switch drawer.');
assertContains(html, 'id="gitBranchList"', 'Git branch switch drawer must include a branch list container.');
assertContains(html, 'id="replySuggest"', 'Reply area must include its own slash command suggestion box.');
assertContains(html, 'id="taskPromptHistory"', 'Task drawer must expose submitted prompt history.');
assertContains(html, 'id="taskOut" class="md-output"', 'Task drawer output must render markdown HTML.');
assertContains(html, 'id="runOut" class="md-output"', 'Injection output must render markdown HTML.');
assert(!html.includes('id="taskCopyPromptBtn"'), 'Task drawer must not expose a standalone copy-instruction footer button.');
assertContains(html, 'id="taskStopBtn"', 'Task drawer must expose a stop-running-task button.');
assertContains(html, 'id="taskStopBtn" class="btn btn-ghost hidden">대화 중단</button>', 'Task drawer stop button must read as conversation interruption.');
assertContains(html, 'id="topTokenSummary"', 'Top bar must expose token usage summary.');
assertContains(html, 'class="quota-gauge unknown"', 'Top bar default must show remaining quota gauge placeholders.');
assert(!html.includes('실시간 감시'), 'Top bar must no longer show the live-watch label.');
assertContains(sessionHtml, 'id="stopBtn" class="btn btn-ghost hidden">대화 중단</button>', 'Independent session stop button must read as conversation interruption.');
assert(!html.includes('id="taskEndBtn"'), 'Answer-needed reply row must not show an end button.');

const scanner = read('src/scanner.js');
assertContains(scanner, 'function quotaRemainingFromText(text, ts)', 'Scanner must parse remaining quota from Claude status text.');
assertContains(scanner, 'quotaRemaining: r.quotaRemaining || null', 'Scanned activity must expose remaining quota to the renderer.');
assertContains(scanner, 'quotaRemaining: s.quotaRemaining || null', 'Session history must expose remaining quota to the renderer.');
const main = read('main.js');
const preload = read('preload.js');
const runner = read('src/backgroundTaskRunner.js');
const claudeRunner = read('src/claudeRunner.js');
assertContains(scanner, 'recentCommits', 'Scanner must return recent commits.');
assertContains(scanner, 'statusFiles', 'Scanner must return dirty file summaries.');
assertContains(scanner, 'recentAgent', 'Scanner must expose recently active subagents after they come to rest.');
assertContains(scanner, 'function activityDirs(projectPath)', 'Scanner must include Claude logs from project subdirectories.');
assertContains(scanner, "d.name.startsWith(slug + '-')", 'Scanner must find external terminal sessions launched below the project root.');
assertContains(scanner, 'cwdHint', 'Scanner must expose a best-effort location for external terminal sessions.');
assertContains(scanner, 'function subagentHintFromText(text)', 'Scanner must infer subagent activity from WCC/Claude textual status output.');
assertContains(scanner, 'subagent\\s*실행\\s*중', 'Scanner must recognize Korean subagent-running status text.');
assertContains(scanner, 'inferred: true', 'Inferred textual subagent activity must be marked separately from real Agent tool logs.');
assertContains(scanner, 'const INFERRED_AGENT_LIVE_MS = 10 * 60 * 1000;', 'Text-inferred subagents must not stay running as long as real Agent tool calls.');
assertContains(scanner, 'laterAssistantTs - aTs > 30 * 1000', 'Text-inferred subagents must close when later assistant output proves the turn continued.');
assertContains(scanner, 'function scanPlanningArtifacts(planningDir, state)', 'Scanner must summarize WCC quick/debug/sketch/milestone artifacts.');
assertContains(scanner, 'const current = all.filter(x => x.bucket === \'current\').slice(0, 6);', 'Scanner must separate currently managed planning artifacts.');
assertContains(scanner, 'const history = all.filter(x => x.bucket !== \'current\').slice(0, 8);', 'Scanner must separate completed planning artifact history.');
assertContains(scanner, 'scanQuickArtifacts(planningDir)', 'Scanner must include recent WCC quick artifacts.');
assertContains(scanner, 'scanDebugArtifacts(planningDir)', 'Scanner must include WCC debug sessions.');
assertContains(scanner, 'scanSketchArtifacts(planningDir)', 'Scanner must include planning sketches.');
assertContains(scanner, 'scanMilestoneArtifacts(planningDir, state)', 'Scanner must include milestone-level planning artifacts.');
assertContains(scanner, 'function shouldRenderWorkstream(name, lane)', 'Scanner must filter non-renderable management workstream directories.');
assertContains(scanner, "normalized === 'milestone' || normalized === 'milestones'", 'State-only milestone management folders must not render as workstream sessions.');
assertContains(scanner, 'shells: r.shells.slice(-40)', 'Scanner must expose Bash shell activity.');
assertContains(scanner, "kind: 'shell'", 'Running Bash commands must be surfaced as shell activity.');
assertContains(scanner, 'for (const a of agents) a.sessionId = sessionId;', 'Parsed subagents must retain their owning Claude session id.');
assertContains(scanner, 'sessionId: recentAgent.sessionId || r.sessionId', 'Recent subagents must keep a session id for detail lookup.');
assertContains(scanner, 'sessionId: current.sessionId || r.sessionId', 'Current subagents and shells must keep a session id for detail lookup.');
assertContains(scanner, 'function scanSessionSubagentSections(projectPath, sessionId)', 'Full session detail must include subagent transcript sections, not only the main JSONL.');
assertContains(scanner, 'const AGENT_LIVE_MS = 2 * 60 * 60 * 1000;', 'Unfinished agents must survive app restart without falling back to task request too quickly.');
assertContains(scanner, 'const STALE_AGENT_MS = 60 * 60 * 1000;', 'Long-silent running agents must be flagged as stale.');
assertContains(main, 'background-tasks', 'Main process must persist background task state under userData.');
assertContains(main, 'project.backgroundTasks = bgTasks', 'Project scan results must include persisted background tasks.');
assertContains(main, "ipcMain.handle('tasks:get'", 'Renderer must be able to reopen persisted task state.');
assertContains(main, "ipcMain.handle('tasks:stop'", 'Renderer must be able to stop persisted background tasks.');
assertContains(main, "ipcMain.handle('git:refs'", 'Renderer must be able to list project Git refs.');
assertContains(main, "ipcMain.handle('git:switch'", 'Renderer must be able to switch a project Git ref.');
assertContains(main, "ipcMain.handle('git:create-branch'", 'Renderer must be able to create a branch without switching the project checkout.');
assertContains(main, "ipcMain.handle('git:ensure-branch-worktree'", 'Renderer must be able to prepare an isolated branch worktree for a session.');
assertContains(main, 'function ensureBranchWorktree(projectPath, ref)', 'Branch sessions must run in a branch-specific worktree instead of changing the project checkout.');
assertContains(main, 'function registeredProjectPath(projectPath)', 'Git switching must be limited to registered projects.');
assertContains(app, 'function projectBranchAreas(project)', 'Projects must group active sessions by Git branch inside the project.');
assertContains(app, 'function addProjectBranchBoard(nodesEl, project, x, y, width = PROJECT_MIN_W)', 'Projects must render a Git branch area board before milestone/workstream sessions.');
assertContains(app, "const PROJECT_BRANCH_VIEW_KEY = 'lodestar.projectBranchView.v1';", 'Projects must remember the branch currently selected for viewing.');
assertContains(app, "const PROJECT_BRANCH_VISIBLE_KEY = 'lodestar.projectBranchVisible.v1';", 'Projects must remember multiple visible branch workspaces.');
assertContains(app, 'function selectedProjectBranch(project)', 'Project rendering must distinguish the viewed branch from the checked-out branch.');
assertContains(app, 'function addVisibleProjectBranch(project, branch)', 'Git branch selection must add a branch workspace instead of replacing the only visible branch.');
assertContains(app, 'function setSelectedProjectBranch(project, branch)', 'Branch cards must change the project view without switching Git checkout.');
assertContains(app, 'addVisibleProjectBranch(project, branch);', 'Selecting a branch must keep it visible in the project branch board.');
assertContains(app, 'const viewBranch = selectedProjectBranch(p);', 'Project layout must render the selected branch view.');
assertContains(app, 'const visibleWorkstreamLanes = currentBranchView', 'Project layout must filter workstreams by selected branch when it is not the checked-out branch.');
assertContains(app, "const PROJECT_BRANCH_EXPANDED_KEY = 'lodestar.projectBranchExpanded.v1';", 'Branch workspace cards must remember their own expanded/collapsed state.');
assertContains(app, 'function toggleProjectBranchExpanded(project, branch)', 'Branch workspace cards must be collapsible like workstream groups.');
assertContains(app, 'branch-toggle', 'Branch workspace cards must expose an explicit expand/collapse control.');
assertContains(app, 'class="pba-head-toggle branch-toggle"', 'Branch expand/collapse must stay in the branch header so it is reachable when expanded.');
assertContains(app, 'function branchAreaLaneNodesHtml(project, area)', 'Branch workspace cards must render milestone/workstream nodes inside each branch.');
assertContains(app, 'function branchAreaPhaseNodesHtml(project, area, row)', 'Expanded branch cards must render workstream phase nodes inside the branch area.');
assertContains(app, 'function branchPhaseFoldKey(project, area, row)', 'Completed branch workflow nodes must have a stable fold key.');
assertContains(app, 'function branchPhaseCollapseNodeHtml(project, area, row, foldedCount, expanded)', 'Completed branch workflow nodes must render a collapse/expand control.');
assertContains(app, "board.querySelectorAll('.pba-phase-collapse')", 'Branch completed phase groups must be explicitly clickable without starting a task.');
assertContains(app, "board.querySelectorAll('.pba-lane-node, .pba-phase-node')", 'Branch workspace lane and phase nodes must be clickable to start scoped sessions.');
assertContains(app, 'if (visibleWorkstreamLanes.length && !branchBoard.nodes)', 'Once a branch board exists, workstream flows must stay inside branch cards instead of rendering a separate workstream area.');
assert(!app.includes('branchBoard.expandedWorkstreams'), 'Collapsed branch cards must not cause a duplicate standalone workstream area to reappear.');
assert(!app.includes("board.querySelectorAll('.project-branch-area').forEach"), 'Clicking an empty branch card background must not select/focus the branch or move the canvas.');
assertContains(app, 'function branchAreaAddSession(area, item = {})', 'Branch workspace cards must collect sessions executed on that branch as nodes.');
assertContains(app, 'function branchAreaSessionNodesHtml(area)', 'Branch workspace cards must render branch-executed sessions as nodes.');
assertContains(app, "item.logicalKey = item.logicalKey || `${item.branch || area.branch}|${item.laneId}`;", 'Branch session cards must group physical Claude sessions by branch and workstream scope.');
assertContains(app, 'const existing = area.sessionNodes.find(x => x.logicalKey === item.logicalKey);', 'Repeated cleared-context Claude sessions in the same workstream must merge into one logical card.');
assertContains(app, 'function logicalSessionMeta(item, existing)', 'Merged branch session cards must show a logical session summary instead of raw physical session noise.');
assertContains(app, 'const rows = Array.isArray(area && area.sessionNodes) ? area.sessionNodes.slice(0, 4) : [];', 'Branch cards must avoid flooding the canvas with physical session cards.');
assertContains(app, "branchAreaAddSession(area, {\n      key: `bg:${task.id}`", 'Background tasks executed on a branch must become branch session nodes.');
assertContains(app, "board.querySelectorAll('.pba-session-node')", 'Branch session nodes must be clickable.');
assertContains(app, 'data-lane-id="${esc(row.laneId || \'main\')}"', 'Branch session nodes must remember the workstream or milestone scope that created them.');
assertContains(app, 'const lane = laneForTaskId(project, btn.dataset.laneId || \'main\') || projectMainLane(project);', 'Clicking a branch session node must restore its original workstream scope.');
assertContains(app, "openTaskWindowPayload(taskWindowPayload('history', project, { session: { ...session, laneId: taskLaneId(lane), laneName: laneLabelText(lane), branch }, lane, branch }))", 'History sessions opened from branch nodes must carry branch and workstream scope into the session window.');
assertContains(app, 'async function ensureTaskExecutionWorkspace(ctx, opts)', 'Task runs must resolve their selected branch to an isolated worktree before launching Claude.');
assertContains(app, 'opts.baseProjectPath = ctx.project.path;', 'Worktree task runs must keep their base project path for grouping in the canvas.');
assertContains(sessionJs, 'async function ensureExecutionWorkspace(opts)', 'Independent task windows must also resolve selected branches to isolated worktrees.');
assertContains(sessionJs, 'if (!lane && payload.session && payload.session.laneId)', 'Independent history session windows must restore lane scope from saved session metadata.');
assertContains(sessionJs, 'opts.baseProjectPath = project.path;', 'Independent worktree task runs must keep their base project path for grouping.');
assertContains(sessionJs, "setActivity('working', '작업 중', 'Claude 출력이 들어오고 있습니다.')", 'Session windows must clearly switch from thinking to working once output arrives.');
assertContains(sessionJs, "setActivity('stopping', '중단 중', '현재 Claude 작업을 중단하고 있습니다.')", 'Pressing stop must immediately show a clear stopping state.');
assertContains(sessionJs, 'function decisionQuestionFromText(text)', 'Session windows must turn natural-language decision gates into answer controls.');
assertContains(sessionJs, '방향\\s*결정\\s*필요', 'Decision parsing must catch Korean direction-decision gates.');
assertContains(sessionJs, '승인된 옵션1로 진행', 'Decision parsing must offer a fallback option when an option1-vs-plan conflict is described.');
assertContains(app, "updateTaskActivity('thinking', 'Claude가 요청을 해석하고 실행을 준비하고 있습니다.')", 'In-app task runs must clearly show the initial thinking state.');
assertContains(app, "updateTaskActivity('working', 'Claude 출력이 들어오고 있습니다.')", 'In-app task runs must clearly show active work once output arrives.');
assertContains(app, "updateTaskActivity('stopping', '현재 Claude 작업을 중단하고 있습니다.')", 'In-app stop must immediately show a clear stopping state.');
assertContains(app, 'function decisionQuestionFromText(text)', 'In-app background task panels must turn natural-language decision gates into answer controls.');
assertContains(app, 'renderAwaitingQuestionControls(decisionQuestion ? [decisionQuestion] : null);', 'In-app background tasks must display extracted decision choices.');
assertContains(scanner, '방향\\s*결정\\s*필요', 'External Claude session scanning must detect Korean direction-decision gates.');
assertContains(css, '.project-branch-area.selected', 'Selected branch cards must be visually distinct.');
assertContains(css, '.pba-head-toggle', 'Branch header expand/collapse controls must be visibly styled.');
assertContains(css, '.pba-lane-nodes', 'Branch workspace cards must visibly contain lane/workstream nodes.');
assertContains(css, '.pba-lane-node', 'Branch workspace lane nodes must have their own node-like styling.');
assertContains(css, '.pba-workstream-lane', 'Branch workspace cards must expand workstreams as lane containers.');
assertContains(css, '.pba-phase-node', 'Branch workspace cards must show phase nodes inside each workstream lane.');
assertContains(app, 'class="pba-phase-node branch-flow-node', 'Branch phase entries must render as node-like workflow cards.');
assertContains(app, '<span class="pba-node-top">', 'Branch workflow nodes must use the same top/header structure as canvas nodes.');
assertContains(app, '<span class="pba-node-steps">', 'Branch workflow nodes must show WCC step progress like workstream nodes.');
assertContains(app, '<span class="pba-node-progress"><span style="width:${pct}%"></span></span>', 'Branch workflow nodes must show a progress bar like phase nodes.');
assertContains(css, '.branch-flow-node', 'Branch workflow nodes must have dedicated node-like styling.');
assertContains(css, '.pba-phase-collapse', 'Completed branch workflow groups must be styled as foldable nodes.');
assertContains(css, '.pba-node-status.running', 'Branch workflow nodes must show running status badges.');
assertContains(css, '.pba-node-progress', 'Branch workflow nodes must have a visible progress bar.');
assertContains(css, '.pba-phase-edge', 'Branch workspace phase nodes must read as a connected flow.');
assertContains(css, '.pba-session-nodes', 'Branch workspace cards must visibly contain executed session nodes.');
assertContains(css, '.pba-session-node', 'Executed branch sessions must have node-like styling.');
assertContains(app, 'const branchBoard = addProjectBranchBoard(nodesEl, p, xBase', 'Branch areas must be laid out inside each project before phase lanes.');
assertContains(app, 'const projectContentWidth = estimateProjectContentWidth(', 'Branch workspace width must be derived from the project content width.');
assertContains(app, 'function branchBoardColumnCount(width, count)', 'Branch workspace cards must stay in one vertical branch stack.');
assertContains(app, 'const gridHeight = areaHeights.reduce((sum, h) => sum + h, 0)', 'Branch workspace height must stack branch areas vertically.');
assertContains(app, "grid.style.setProperty('--branch-card-width'", 'Branch workspace cards must get a fixed rail width inside the project board.');
assertContains(app, "grid.style.flexDirection = 'column';", 'Branch workspace must stack branches vertically inside the project board.');
assertContains(app, "grid.style.flexWrap = 'nowrap';", 'Branch workspace stack must keep one branch per row.');
assertContains(app, "card.style.flex = '0 0 auto';", 'Branch cards must keep natural vertical height in the branch stack.');
assertContains(app, 'function branchAreaEstimatedHeight(area, cardWidth = BRANCH_CARD_MIN_W)', 'Branch workspace height must account for expanded cards and session rows.');
assertContains(app, 'function branchPhaseFlowEstimatedWidth(project, area, row)', 'Expanded completed branch nodes must widen the branch area instead of relying on internal scrolling.');
assertContains(app, 'function branchAreaEstimatedWidth(project, area, minWidth = BRANCH_CARD_MIN_W)', 'Branch workspace width must grow with expanded workflow nodes.');
assertContains(app, 'const boardWidth = Math.max(', 'Branch board width must be computed from expanded branch workflow content.');
assertContains(app, 'const areaHeights = areas.map(area => branchAreaEstimatedHeight', 'Branch board height must be calculated from each visible branch card, not a single fixed estimate.');
assertContains(app, 'const actualWidth = Math.max(boardWidth, Math.ceil(board.scrollWidth || board.offsetWidth || 0));', 'Branch board layout must use measured DOM width so expanded completed nodes stay inside the project layer.');
assertContains(app, 'right: x + actualWidth', 'Project bounds must expand to the measured branch board width.');
assertContains(app, 'const actualHeight = Math.max(height, Math.ceil(board.scrollHeight || board.offsetHeight || 0));', 'Branch board layout must use measured DOM height so expanded branches stay inside the project layer.');
assertContains(app, 'bottom: y + actualHeight', 'Project bounds must expand to the measured branch board height.');
assertContains(app, 'board.style.width = boardWidth + \'px\';', 'Branch workspace board must receive a dynamic project-scoped width.');
assertContains(css, '.project-branch-grid {\n  display: flex;', 'Branch workspaces must render as a controlled flex stack.');
assertContains(css, 'flex-direction: column;', 'Branch workspace CSS must place dev_merge under the selected branch area.');
assertContains(css, 'overflow-x: visible;', 'Branch workspace must expand horizontally for unfolded completed nodes instead of creating an inner rail.');
assertContains(css, '.pba-phase-flow', 'Branch phase flow must be styled explicitly.');
assertContains(css, 'overflow: visible;', 'Branch phase flow must not hide or internally scroll unfolded completed nodes.');
assertContains(css, 'flex: 0 0 auto;', 'Branch cards must keep natural vertical height.');
assert(!css.includes('.project-branch-board {\n  position: absolute;\n  z-index: 3;\n  width: 1080px;'), 'Branch workspace board must not use a hard-coded 1080px width.');
assertContains(app, 'focusBranchKey = branchAreaKey(project, actualBranch);', 'Creating a session must focus the newly visible branch area.');
assertContains(app, 'focusBranchKey = branchAreaKey(project, target);', 'Starting a project session from the branch picker must focus the selected branch area.');
assertContains(main, 't.projectPath === p || t.baseProjectPath === p', 'Project scans must keep worktree-backed background tasks grouped under the base project.');
assertContains(main, '.slice(0, 24)', 'Project scans must keep cross-branch background tasks so the renderer can group them by branch.');
assertContains(main, "sendToAll('task:progress', { clientRunId: opts && opts.clientRunId, chunk });", 'Task progress events must be routed to every open task window and filtered by clientRunId.');
assertContains(preload, 'getTask: (id) => ipcRenderer.invoke(\'tasks:get\', id)', 'Preload must expose background task reads.');
assertContains(preload, 'stopTask: (id) => ipcRenderer.invoke(\'tasks:stop\', id)', 'Preload must expose background task stop.');
assertContains(preload, "listGitRefs: (projectPath) => ipcRenderer.invoke('git:refs', projectPath)", 'Preload must expose project Git ref listing.');
assertContains(preload, "switchGitRef: (projectPath, ref) => ipcRenderer.invoke('git:switch', { projectPath, ref })", 'Preload must expose project Git switching.');
assertContains(preload, "createGitBranch: (projectPath, ref) => ipcRenderer.invoke('git:create-branch', { projectPath, ref })", 'Preload must expose branch creation without checkout.');
assertContains(preload, "ensureBranchWorktree: (projectPath, ref) => ipcRenderer.invoke('git:ensure-branch-worktree', { projectPath, ref })", 'Preload must expose branch worktree preparation.');
assertContains(main, "['switch', '-c', target]", 'Git switching must be able to create a new branch from direct input.');
assertContains(claudeRunner, 'function resolveNodeRuntime()', 'Background tasks must use a real Node runtime instead of relaunching the Electron portable wrapper.');
assertContains(claudeRunner, 'function materializeBackgroundRunner(taskDir)', 'Background tasks must copy runner files out of app.asar before spawning Node.');
assertContains(claudeRunner, 'const child = spawn(node, [runner, file]', 'Background tasks must spawn the materialized runner with Node.');
assertContains(claudeRunner, 'if (opts.backgroundOnly)', 'Background task launches must be able to return immediately after the persisted runner starts.');
assertContains(claudeRunner, "stage: 'started'", 'Detached task launches must report a started stage instead of waiting for Claude completion.');
assertContains(claudeRunner, 'historyPrompt: opts.historyPrompt || opts.prompt', 'Persisted background task state must remember the exact user-facing prompt.');
assertContains(claudeRunner, 'function stopBackgroundTask(taskDir, id)', 'Background task runner must support user stop.');
assertContains(claudeRunner, 'function normalizeBackgroundTask(file, task)', 'Stale persisted running background tasks must be normalized on scan.');
assertContains(claudeRunner, 'return normalizeBackgroundTask(file, readJson(file));', 'Single background task reads must also normalize stale running state.');
assertContains(claudeRunner, "stage: 'stale'", 'Stale persisted running tasks must be marked distinctly instead of staying active.');
assertContains(claudeRunner, "execFileSync('tasklist.exe'", 'Windows background task liveness must use tasklist instead of only process.kill.');
assertContains(claudeRunner, 'staleSuspectedAt', 'Background tasks must get a grace period before stale cleanup.');
assertContains(app, "stale: '실행 상태 확인 불가'", 'Main task UI must not describe stale cleanup as a Claude failure.');
assertContains(sessionJs, "stale: '실행 상태 확인 불가'", 'Independent session UI must not describe stale cleanup as a Claude failure.');
assertContains(app, 'function backgroundTaskTranscript(task, fallback = \'\')', 'Main task UI must keep the submitted prompt visible before background output arrives.');
assertContains(sessionJs, 'function backgroundTaskTranscript(task, fallback = \'\')', 'Independent session UI must keep the submitted prompt visible before background output arrives.');
assertContains(app, 'return `${prefix}${label}\\n\\n──────────\\n\\n${recorded}`.trim();', 'Main task UI must preserve the submitted user turn after background output arrives.');
assertContains(sessionJs, 'return `${prefix}${label}\\n\\n──────────\\n\\n${recorded}`.trim();', 'Independent session UI must preserve the submitted user turn after background output arrives.');
assertContains(app, 'Claude 출력이 기록되면 여기에 이어서 표시됩니다.', 'Empty background output must explain that live output will append instead of showing a blank record.');
assertContains(sessionJs, 'Claude 출력이 기록되면 여기에 이어서 표시됩니다.', 'Empty independent background output must explain that live output will append instead of showing a blank record.');
assertContains(sessionJs, 'function claudeFactLabel()', 'Independent session context must not call a running task a fresh session while session id is pending.');
assertContains(sessionJs, "return '실행 중 · 세션 ID 감지 대기';", 'Running sessions without a Claude session id must be shown as pending session detection.');
assertContains(claudeRunner, 'workstream: opts.workstream || null', 'Persisted task state must remember the originating workstream.');
assertContains(claudeRunner, 'branch: opts.branch || null', 'Persisted task state must remember the originating Git branch.');
assertContains(claudeRunner, 'function tokenUsageFromEvent(event)', 'Claude runner must extract token usage from stream-json events.');
assertContains(claudeRunner, "onData({ type: 'usage', usage: cur.tokenUsage })", 'Background task polling must stream token usage updates to windows.');
assertContains(runner, 'tokenUsage = o.type === \'result\' ? usage : mergeTokenUsage(tokenUsage, usage);', 'Background task runner must persist token usage from Claude events.');
assert(!claudeRunner.includes('[🔧 ${part.name'), 'Foreground task streaming must not inject tool-use labels into chat output.');
assert(!runner.includes('[🔧 ${part.name'), 'Background task streaming must not persist tool-use labels into chat output.');
assertContains(claudeRunner, "return status === 'completed' || status === 'failed' || status === 'timeout' || status === 'stopped';", 'Stopped background tasks must be terminal.');
assert(!claudeRunner.includes('ELECTRON_RUN_AS_NODE'), 'Background tasks must not rely on ELECTRON_RUN_AS_NODE in the portable app.');
assertContains(claudeRunner, "path.join(os.homedir(), '.claude', 'wincubecode', 'commands')", 'Claude slash commands must include packaged WCC commands.');
assertContains(claudeRunner, "path.join(os.homedir(), '.claude', 'wcc-local-patches', 'commands')", 'Claude slash commands must include local WCC patches.');
assertContains(claudeRunner, "path.join(os.homedir(), '.claude', 'wincubecode', 'workflows')", 'Claude slash commands must include WCC workflow bodies.');
assertContains(claudeRunner, "path.join(os.homedir(), '.claude', 'skills')", 'Claude slash commands must include WCC Claude Skills.');
assertContains(claudeRunner, 'detail: markdownDetail(file)', 'Claude slash commands must expose markdown contents for previews.');
assertContains(runner, "status: code === 0 && !isError ? 'completed' : 'failed'", 'Background runner must persist terminal completion state.');

const skills = listClaudeSkills();
assert(Array.isArray(skills), 'Claude Skill list must return an array.');
for (const s of skills) assert(s.name && typeof s.name === 'string', 'Each Claude Skill must have a name.');
const commands = listClaudeCommands();
assert(Array.isArray(commands), 'Claude slash command list must return an array.');
assert(commands.every(c => typeof c.name === 'string' && c.name.startsWith('/')), 'Claude slash command names must use slash form.');
if (fs.existsSync(path.join(os.homedir(), '.claude', 'wincubecode', 'commands', 'wcc', 'workstreams.md'))) {
  const wccWorkstreams = commands.find(c => c.name === '/wcc-workstreams');
  assert(wccWorkstreams, 'Packaged WCC commands must be listed as /wcc-* slash commands.');
  assert.match(wccWorkstreams.detail || '', /워크스트림|workstreams/i, 'WCC command preview must include command markdown contents.');
}
if (fs.existsSync(path.join(os.homedir(), '.claude', 'wincubecode', 'workflows', 'quick.md'))) {
  const wccQuick = commands.find(c => c.name === '/wcc-quick');
  assert(wccQuick, 'WCC workflow bodies must be listed as /wcc-* slash commands.');
  assert.match(wccQuick.detail || '', /quick|빠른|원자/i, 'WCC workflow command preview must include workflow markdown contents.');
}
if (fs.existsSync(path.join(os.homedir(), '.claude', 'skills', 'wcc-config', 'SKILL.md'))) {
  assert(commands.find(c => c.name === '/wcc-config'), 'WCC Claude Skills must be listed as /wcc-* slash commands.');
}
assert(!commands.some(c => /^\/wcc:/.test(c.name)), 'WCC command suggestions must not use Claude-unsupported colon names.');
assert(buildTaskArgs({ prompt: '/wcc:progress', sessionId: null }).includes('/wcc-progress'), 'Colon WCC compatibility input must be normalized before calling Claude.');
assert(buildTaskArgs({ prompt: 'wcc progress', sessionId: null }).includes('/wcc-progress'), 'Bare WCC compatibility input must be normalized before calling Claude.');

const staleTaskDir = path.join(os.tmpdir(), `lodestar-stale-task-${Date.now()}`);
try {
  fs.mkdirSync(staleTaskDir, { recursive: true });
  fs.writeFileSync(path.join(staleTaskDir, 'recent.json'), JSON.stringify({
    id: 'recent',
    projectPath: 'D:\\winCudeProject\\mediagw',
    status: 'running',
    pid: 99999999,
    output: '',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(staleTaskDir, 'stale.json'), JSON.stringify({
    id: 'stale',
    projectPath: 'D:\\winCudeProject\\mediagw',
    status: 'running',
    output: '',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }, null, 2), 'utf8');
  const tasks = listBackgroundTasks(staleTaskDir);
  const recent = tasks.find(t => t.id === 'recent');
  const stale = tasks.find(t => t.id === 'stale');
  assert.strictEqual(recent.status, 'running', 'Recently active tasks with a missing PID must get a grace period instead of being stopped.');
  assert(recent.staleSuspectedAt, 'Recently active tasks with a missing PID must record when stale was first suspected.');
  assert.strictEqual(stale.status, 'stopped', 'Old persisted running tasks with no live process must be stopped during scan.');
  assert.strictEqual(stale.stage, 'stale', 'Auto-stopped background tasks must expose stale stage.');
} finally {
  fs.rmSync(staleTaskDir, { recursive: true, force: true });
}

const planningPath = path.join(os.tmpdir(), `lodestar-planning-artifacts-${Date.now()}`, '.planning');
try {
  fs.mkdirSync(path.join(planningPath, 'quick', '260625-abc-small-fix'), { recursive: true });
  fs.writeFileSync(path.join(planningPath, 'quick', '260625-abc-small-fix', 'SUMMARY.md'), '# Quick Small Fix\n\n완료', 'utf8');
  fs.mkdirSync(path.join(planningPath, 'quick', '260625-def-running-fix'), { recursive: true });
  fs.writeFileSync(path.join(planningPath, 'quick', '260625-def-running-fix', 'PLAN.md'), '# Quick Running Fix\n\n진행', 'utf8');
  fs.mkdirSync(path.join(planningPath, 'debug'), { recursive: true });
  fs.writeFileSync(path.join(planningPath, 'debug', 'order-ui-broken-render.md'), [
    '---',
    'status: investigating',
    '---',
    '# Debug Session: order-ui-broken-render',
    '',
    'next_action: verify render',
  ].join('\n'), 'utf8');
  fs.mkdirSync(path.join(planningPath, 'sketches', '002-detail-card-layout'), { recursive: true });
  fs.writeFileSync(path.join(planningPath, 'sketches', '002-detail-card-layout', 'README.md'), '# Detail Card Layout\n', 'utf8');
  fs.mkdirSync(path.join(planningPath, 'milestones'), { recursive: true });
  fs.writeFileSync(path.join(planningPath, 'milestones', 'v4.0-ROADMAP.md'), '# v4 Roadmap\n', 'utf8');
  const planning = scanPlanningArtifacts(planningPath, { milestone: 'v4.0' });
  assert(planning.quick.some(x => x.title.includes('Quick Small Fix')), 'Recent quick artifacts must be summarized.');
  assert(planning.current.some(x => x.kind === 'quick' && x.title.includes('Quick Running Fix')), 'Running quick artifacts must stay on the current tab.');
  assert(planning.history.some(x => x.kind === 'quick' && x.title.includes('Quick Small Fix')), 'Completed quick artifacts must move to the history tab.');
  assert(planning.debug.some(x => x.active && /order-ui/.test(x.title)), 'Active debug artifacts must be summarized.');
  assert(planning.current.some(x => x.kind === 'debug' && x.active), 'Active debug artifacts must stay on the current tab.');
  assert(planning.sketches.some(x => /Detail Card/.test(x.title)), 'Sketch artifacts must be summarized.');
  assert(planning.history.some(x => x.kind === 'sketch' && /Detail Card/.test(x.title)), 'Sketch artifacts must be visible from the history tab.');
  assert(planning.milestones.some(x => x.active && /v4/.test(x.title)), 'Current milestone artifacts must be summarized.');
  assert(planning.current.some(x => x.kind === 'milestone' && x.active), 'Current milestone artifacts must stay on the current tab.');
} finally {
  fs.rmSync(path.dirname(planningPath), { recursive: true, force: true });
}

const detailProjectPath = path.join(os.tmpdir(), `lodestar-session-detail-${Date.now()}`);
const detailLogDir = path.join(os.homedir(), '.claude', 'projects', pathToSlug(detailProjectPath));
try {
  fs.mkdirSync(detailLogDir, { recursive: true });
  const sessionId = 'quick-history-session';
  const subDir = path.join(detailLogDir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(detailLogDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-30T01:00:00.000Z',
      sessionId,
      message: { content: '/wcc-quick optCnt Integer 변경' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-30T01:00:02.000Z',
      sessionId,
      message: { content: [{ type: 'text', text: 'quick 작업을 시작합니다.' }] },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-30T01:00:05.000Z',
      sessionId,
      message: { content: [{ type: 'text', text: '이어서 확인해줘' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-30T01:00:07.000Z',
      sessionId,
      message: { content: [{ type: 'text', text: '검증까지 완료했습니다.' }] },
    }),
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(subDir, 'agent-executor.meta.json'), JSON.stringify({
    toolUseId: 'task-1',
    agentType: 'wcc-executor',
    description: 'PLAN.md를 실행하는 서브에이전트',
  }), 'utf8');
  fs.writeFileSync(path.join(subDir, 'agent-executor.jsonl'), [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-30T01:00:03.000Z',
      sessionId,
      message: { content: '서브에이전트에게 전달된 지시문' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-30T01:00:04.000Z',
      sessionId,
      message: { content: [{ type: 'text', text: '서브에이전트 실행 결과입니다.' }] },
    }),
  ].join('\n'), 'utf8');
  const detail = scanSessionDetail(detailProjectPath, sessionId);
  assert.strictEqual(detail.ok, true, 'History session detail lookup must find the Claude JSONL by session id.');
  assert.strictEqual(detail.firstUser, '/wcc-quick optCnt Integer 변경', 'History detail must preserve the exact user command.');
  assert.match(detail.output, /› \/wcc-quick optCnt Integer 변경/, 'History detail must render user turns as chat labels.');
  assert.match(detail.output, /quick 작업을 시작합니다/, 'History detail must include assistant output.');
  assert.match(detail.output, /──────────/, 'History detail must separate turns for the chat renderer.');
  assert.match(detail.output, /서브에이전트 기록/, 'History detail must include the owning session subagent section.');
  assert.match(detail.output, /wcc-executor/, 'History detail must include subagent type names.');
  assert.match(detail.output, /서브에이전트 실행 결과입니다/, 'History detail must include subagent output.');
  assert.strictEqual(detail.turns.length, 4, 'History detail must keep all user and assistant turns.');
  assert.strictEqual(detail.subagents.length, 1, 'History detail must expose parsed subagent records.');
} finally {
  fs.rmSync(detailLogDir, { recursive: true, force: true });
}

const completedCurrentProjectPath = path.join(os.tmpdir(), `lodestar-completed-current-${Date.now()}`);
try {
  const pp = path.join(completedCurrentProjectPath, '.planning');
  const p6 = path.join(pp, 'phases', '06-audit-4');
  const p7 = path.join(pp, 'phases', '07-stray-next');
  fs.mkdirSync(p6, { recursive: true });
  fs.mkdirSync(p7, { recursive: true });
  fs.writeFileSync(path.join(pp, 'STATE.md'), [
    '---',
    'current_phase: 06',
    'status: phase-complete',
    'progress:',
    '  total_phases: 6',
    '  completed_phases: 6',
    '  percent: 100',
    '---',
    '',
    '# State',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(pp, 'ROADMAP.md'), [
    '# Roadmap',
    '',
    '## Phases',
    '',
    '- [x] **Phase 6: 횡단 게이트 audit (4축 + 디자인 무수정 게이트)** - 완료',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(p6, '06-01-PLAN.md'), '# Plan\n', 'utf8');
  fs.writeFileSync(path.join(p6, '06-01-SUMMARY.md'), '# Summary\n', 'utf8');
  fs.writeFileSync(path.join(p7, '07-CONTEXT.md'), '# Context\n', 'utf8');
  const check = [
    "const assert = require('assert');",
    "const { scanProject } = require('./src/scanner');",
    '(async () => {',
    `  const r = await scanProject(${JSON.stringify(completedCurrentProjectPath)});`,
    "  const p6 = r.phases.find(p => p.num === 6);",
    "  assert.strictEqual(r.currentPhaseNum, null, '100% complete lanes must not keep a completed current phase.');",
    "  assert(p6, 'Completed audit phase must remain visible as a phase.');",
    "  assert.strictEqual(p6.stage, 'execute-done', 'Completed audit phase must be classified as done.');",
    "  assert.strictEqual(p6.isCurrent, false, 'Completed audit phase must not stay current.');",
    "  assert(!r.phases.some(p => p.num === 7), '100% complete lanes must hide out-of-range stray phase directories.');",
    '})().catch(err => { console.error(err); process.exit(1); });',
  ].join('\n');
  execFileSync(process.execPath, ['-e', check], { cwd: process.cwd(), stdio: 'inherit' });
} finally {
  fs.rmSync(completedCurrentProjectPath, { recursive: true, force: true });
}

const projectPath = path.join(os.tmpdir(), `lodestar-regression-${Date.now()}`);
const slug = pathToSlug(projectPath);
const logDir = path.join(os.homedir(), '.claude', 'projects', slug);
try {
  fs.mkdirSync(logDir, { recursive: true });
  const sessionId = 'regression-session-limit';
  const limitTs = new Date('2026-06-24T09:35:00.000Z');
  const beforeReset = limitTs.getTime() + 5 * 60 * 1000;
  const rows = [
    {
      type: 'assistant',
      timestamp: new Date(limitTs.getTime() - 1000).toISOString(),
      sessionId,
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_regression_1', name: 'Task', input: { subagent_type: 'wcc-executor', description: 'regression running task' } },
        ],
      },
    },
    {
      type: 'assistant',
      timestamp: limitTs.toISOString(),
      sessionId,
      message: {
        content: [
          { type: 'text', text: "You've hit your session limit · resets 7:20pm (Asia/Seoul)" },
        ],
      },
    },
  ];
  fs.writeFileSync(path.join(logDir, `${sessionId}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n'), 'utf8');
  const activity = scanActivity(projectPath, beforeReset);
  assert.strictEqual(activity.blocked, true, 'Session limit text must mark the project as blocked.');
  assert.strictEqual(activity.current, null, 'Blocked sessions must not also appear as running.');
  assert.match(activity.blockedText, /session limit/i, 'Blocked text must keep the limit detail.');
} finally {
  fs.rmSync(logDir, { recursive: true, force: true });
}

const resetProjectPath = path.join(os.tmpdir(), `lodestar-reset-regression-${Date.now()}`);
const resetLogDir = path.join(os.homedir(), '.claude', 'projects', pathToSlug(resetProjectPath));
try {
  fs.mkdirSync(resetLogDir, { recursive: true });
  const sessionId = 'regression-session-limit-reset';
  const limitTs = new Date('2026-06-24T09:35:00.000Z');
  const afterReset = new Date('2026-06-25T12:00:00.000Z').getTime();
  fs.writeFileSync(path.join(resetLogDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'assistant',
      timestamp: limitTs.toISOString(),
      sessionId,
      message: {
        content: [
          { type: 'text', text: "You've hit your session limit · resets 7:20pm (Asia/Seoul)" },
        ],
      },
    }),
  ].join('\n'), 'utf8');
  const activity = scanActivity(resetProjectPath, afterReset);
  assert.strictEqual(activity.blocked, false, 'Session limit text must expire after the reset time passes.');
  assert.strictEqual(activity.blockedText, '', 'Expired session limit text must not remain visible as blocked text.');
} finally {
  fs.rmSync(resetLogDir, { recursive: true, force: true });
}

const quotaProjectPath = path.join(os.tmpdir(), `lodestar-quota-regression-${Date.now()}`);
const quotaLogDir = path.join(os.homedir(), '.claude', 'projects', pathToSlug(quotaProjectPath));
try {
  fs.mkdirSync(quotaLogDir, { recursive: true });
  const quotaTs = new Date('2026-06-24T09:40:00.000Z');
  fs.writeFileSync(path.join(quotaLogDir, 'quota-status.jsonl'), [
    JSON.stringify({
      type: 'assistant',
      timestamp: quotaTs.toISOString(),
      sessionId: 'quota-status',
      message: { content: [{ type: 'text', text: '◆ Sonnet │ 5시간: 33% (2시간57분) │ 7일: 35% (5일5시간)' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(quotaTs.getTime() + 1000).toISOString(),
      sessionId: 'quota-status',
      message: { content: [{ type: 'text', text: '◆ Opus(H) │ █░░░░░░░░░ │ 13% │ 130K/1.0M │ 5시간: 33% (2시간57분) │ 7일: 35% (5일5시간)' }] },
    }),
  ].join('\n'), 'utf8');
  const activity = scanActivity(quotaProjectPath, quotaTs.getTime() + 1000);
  assert.strictEqual(activity.quotaRemaining.fiveHour.pct, 33, 'Scanner must expose remaining 5-hour quota percentage.');
  assert.strictEqual(activity.quotaRemaining.sevenDay.pct, 35, 'Scanner must expose remaining 7-day quota percentage.');
  assert.strictEqual(activity.quotaRemaining.sonnet.pct, 13, 'Scanner must expose the model remaining quota percentage from Claude status bars.');
  assert.strictEqual(activity.sessions[0].quotaRemaining.fiveHour.reset, '2시간57분', 'Remaining quota reset details must be preserved.');
  const detail = scanSessionDetail(quotaProjectPath, 'quota-status');
  assert.strictEqual(detail.quotaRemaining.fiveHour.pct, 33, 'Session detail must expose remaining quota for session windows.');
} finally {
  fs.rmSync(quotaLogDir, { recursive: true, force: true });
}

const nonLimitProjectPath = path.join(os.tmpdir(), `lodestar-non-limit-regression-${Date.now()}`);
const nonLimitLogDir = path.join(os.homedir(), '.claude', 'projects', pathToSlug(nonLimitProjectPath));
try {
  fs.mkdirSync(nonLimitLogDir, { recursive: true });
  const sessionId = 'regression-non-limit';
  const ts = new Date('2026-06-24T09:35:00.000Z').toISOString();
  fs.writeFileSync(path.join(nonLimitLogDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      sessionId,
      message: { content: [{ type: 'text', text: '검증 기준 초과 항목을 정리했습니다. 다음 단계를 진행합니다.' }] },
    }),
  ].join('\n'), 'utf8');
  const activity = scanActivity(nonLimitProjectPath, Date.parse(ts) + 1000);
  assert.strictEqual(activity.blocked, false, 'Generic Korean words such as 초과 must not be treated as a Claude usage limit.');
} finally {
  fs.rmSync(nonLimitLogDir, { recursive: true, force: true });
}

const inferredDoneProjectPath = path.join(os.tmpdir(), `lodestar-inferred-done-${Date.now()}`);
const inferredDoneLogDir = path.join(os.homedir(), '.claude', 'projects', pathToSlug(inferredDoneProjectPath));
try {
  fs.mkdirSync(inferredDoneLogDir, { recursive: true });
  const sessionId = 'inferred-done-session';
  const startTs = new Date('2026-06-25T07:19:00.000Z');
  fs.writeFileSync(path.join(inferredDoneLogDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'assistant',
      timestamp: startTs.toISOString(),
      sessionId,
      message: { content: [{ type: 'text', text: 'subagent 실행 중 - 완료될 때까지 출력 없음, 약 1-5분; 멈춤이 아니라 정상 동작입니다.' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(startTs.getTime() + 90 * 1000).toISOString(),
      sessionId,
      message: { content: [{ type: 'text', text: 'WCC QUICK TASK 완료' }] },
    }),
  ].join('\n'), 'utf8');
  const activity = scanActivity(inferredDoneProjectPath, startTs.getTime() + 5 * 60 * 1000);
  assert.strictEqual(activity.current, null, 'Inferred textual subagents must not remain running after later completion output.');
  assert(activity.agents.some(a => a.inferred && a.done), 'Inferred textual subagent hints must be marked done after later assistant output.');
} finally {
  fs.rmSync(inferredDoneLogDir, { recursive: true, force: true });
}

const recentAgentProjectPath = path.join(os.tmpdir(), `lodestar-recent-agent-regression-${Date.now()}`);
const recentAgentLogDir = path.join(os.homedir(), '.claude', 'projects', pathToSlug(recentAgentProjectPath));
try {
  fs.mkdirSync(recentAgentLogDir, { recursive: true });
  const now = new Date();
  const sessionId = 'recent-agent-session';
  const toolUseId = 'toolu_recent_agent_1';
  fs.writeFileSync(path.join(recentAgentLogDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'assistant',
      timestamp: now.toISOString(),
      sessionId,
      message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { subagent_type: 'wcc-executor', description: 'Adding orderAuditGrepGuard to build.gradle' } }] },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: now.toISOString(),
      sessionId,
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Agent came to rest' }] },
    }),
  ].join('\n'), 'utf8');
  const subDir = path.join(recentAgentLogDir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-recent.meta.json'), JSON.stringify({
    agentType: 'wcc-executor',
    description: 'Adding orderAuditGrepGuard to build.gradle',
    toolUseId,
  }), 'utf8');
  fs.writeFileSync(path.join(subDir, 'agent-recent.jsonl'), [
    JSON.stringify({
      type: 'assistant',
      timestamp: now.toISOString(),
      agentId: 'recent',
      message: { content: [{ type: 'text', text: 'Adding orderAuditGrepGuard to build.gradle' }] },
    }),
  ].join('\n'), 'utf8');
  const activity = scanActivity(recentAgentProjectPath, now.getTime());
  assert.strictEqual(activity.current, null, 'Rested subagents must not appear as actively running.');
  assert(activity.recentAgent, 'Recently rested subagents must remain visible as recentAgent.');
  assert.strictEqual(activity.recentAgent.sub, 'wcc-executor', 'Recent subagent type must come from subagent metadata.');
  assert.match(activity.recentAgent.desc, /orderAuditGrepGuard/, 'Recent subagent description must preserve visible work text.');
} finally {
  fs.rmSync(recentAgentLogDir, { recursive: true, force: true });
}

const longAgentProjectPath = path.join(os.tmpdir(), `lodestar-long-agent-regression-${Date.now()}`);
const longAgentLogDir = path.join(os.homedir(), '.claude', 'projects', pathToSlug(longAgentProjectPath));
try {
  fs.mkdirSync(longAgentLogDir, { recursive: true });
  const now = new Date();
  const sessionId = 'long-agent-session';
  fs.writeFileSync(path.join(longAgentLogDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now.getTime() - 75 * 60 * 1000).toISOString(),
      sessionId,
      message: { content: [{ type: 'tool_use', id: 'toolu_long_agent_1', name: 'Agent', input: { subagent_type: 'wcc-debug-session-manager', description: '장시간 디버그 세션' } }] },
    }),
  ].join('\n'), 'utf8');
  const activity = scanActivity(longAgentProjectPath, now.getTime());
  assert(activity.current, 'Unfinished long-running agents must remain visible after app restart.');
  assert.strictEqual(activity.current.sub, 'wcc-debug-session-manager', 'Long-running debug managers must not fall back to task request after five minutes.');
  assert.strictEqual(activity.current.status, 'stale', 'Long-silent unfinished agents must be marked as needing confirmation.');
} finally {
  fs.rmSync(longAgentLogDir, { recursive: true, force: true });
}

const shellProjectPath = path.join(os.tmpdir(), `lodestar-shell-regression-${Date.now()}`);
const shellLogDir = path.join(os.homedir(), '.claude', 'projects', pathToSlug(shellProjectPath));
try {
  fs.mkdirSync(shellLogDir, { recursive: true });
  const now = new Date();
  const sessionId = 'shell-session';
  fs.writeFileSync(path.join(shellLogDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'assistant',
      timestamp: now.toISOString(),
      sessionId,
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_shell_running_1',
          name: 'Bash',
          input: {
            command: './gradlew test',
            description: '전체 JUnit 테스트 수트 실행',
          },
        }],
      },
    }),
  ].join('\n'), 'utf8');
  const activity = scanActivity(shellProjectPath, now.getTime() + 5 * 60 * 1000);
  assert(activity.current, 'Pending Bash tool calls must be visible as current activity.');
  assert.strictEqual(activity.current.kind, 'shell', 'Pending Bash activity must be marked as shell.');
  assert.match(activity.current.desc, /JUnit/, 'Shell activity description must preserve command purpose.');
  assert.strictEqual(activity.shellCount, 1, 'Shell activity count must be exposed.');
} finally {
  fs.rmSync(shellLogDir, { recursive: true, force: true });
}

const completedShellProjectPath = path.join(os.tmpdir(), `lodestar-shell-complete-regression-${Date.now()}`);
const completedShellLogDir = path.join(os.homedir(), '.claude', 'projects', pathToSlug(completedShellProjectPath));
try {
  fs.mkdirSync(completedShellLogDir, { recursive: true });
  const now = new Date();
  const sessionId = 'shell-complete-session';
  const toolUseId = 'toolu_shell_complete_1';
  fs.writeFileSync(path.join(completedShellLogDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'assistant',
      timestamp: now.toISOString(),
      sessionId,
      message: {
        content: [{
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: {
            command: './gradlew test',
            description: '전체 JUnit 테스트 수트 실행',
          },
        }],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: new Date(now.getTime() + 10 * 1000).toISOString(),
      sessionId,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'BUILD SUCCESSFUL',
        }],
      },
    }),
  ].join('\n'), 'utf8');
  const activity = scanActivity(completedShellProjectPath, now.getTime() + 60 * 1000);
  assert.strictEqual(activity.current, null, 'Completed Bash tool calls must not leave a running shell node.');
  assert.strictEqual(activity.shells[0].done, true, 'Completed Bash tool calls must be marked done in the shell timeline.');
} finally {
  fs.rmSync(completedShellLogDir, { recursive: true, force: true });
}

const askProjectPath = path.join(os.tmpdir(), `lodestar-ask-regression-${Date.now()}`);
const askLogDir = path.join(os.homedir(), '.claude', 'projects', pathToSlug(askProjectPath));
try {
  fs.mkdirSync(askLogDir, { recursive: true });
  const now = new Date();
  fs.writeFileSync(path.join(askLogDir, 'plain-question.jsonl'), [
    JSON.stringify({
      type: 'assistant',
      timestamp: now.toISOString(),
      sessionId: 'plain-question',
      message: { content: [{ type: 'text', text: '어떻게 진행할까요? (1 / 2 / 3)' }] },
    }),
  ].join('\n'), 'utf8');
  let activity = scanActivity(askProjectPath, now.getTime());
  assert.strictEqual(activity.awaiting, false, 'Plain assistant questions must not be marked awaiting without AskUserQuestion.');

  fs.writeFileSync(path.join(askLogDir, 'wcc-text-decision.jsonl'), [
    JSON.stringify({
      type: 'user',
      timestamp: new Date(now.getTime() + 200).toISOString(),
      sessionId: 'wcc-text-decision',
      message: { content: '› <command-name>/wcc-discuss-phase</command-name> <command-args>8</command-args>' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now.getTime() + 300).toISOString(),
      sessionId: 'wcc-text-decision',
      message: { content: [{ type: 'text', text: '▶ 결정 요청 — 환불 처리\n1. Port+폼 확장하여 환불도 실연동 완성\n2. 환불은 NoOp 유지, 이번 범위 제외\n3. 계좌·예금주 등 입력 출처를 더 조사 후 결정\n\n환불 처리 방향(1/2/3)만 정해주시면 이어서 진행하겠습니다.' }] },
    }),
  ].join('\n'), 'utf8');
  activity = scanActivity(askProjectPath, now.getTime() + 300);
  assert.strictEqual(activity.awaiting, true, 'WCC discuss text decision gates must show as answer-needed.');
  assert.match(activity.awaitingText, /결정 요청/, 'WCC text decision prompt must be exposed to the UI.');
  assert.strictEqual(activity.awaitingQuestion.choices.length, 3, 'WCC text numbered options must become selectable choices.');
  assert.strictEqual(activity.awaitingQuestion.choices[0].value, '1', 'WCC text choice values must preserve the requested number answer.');

  fs.writeFileSync(path.join(askLogDir, 'ask-tool.jsonl'), [
    JSON.stringify({
      type: 'assistant',
      timestamp: now.toISOString(),
      sessionId: 'ask-tool',
      message: { content: [{ type: 'tool_use', id: 'toolu_ask_1', name: 'AskUserQuestion', input: { question: '어느 옵션으로 진행할까요?', options: [{ label: '승인', value: '승인합니다', description: '다음 단계로 진행' }, '보류' ] } }] },
    }),
  ].join('\n'), 'utf8');
  activity = scanActivity(askProjectPath, now.getTime());
  assert.strictEqual(activity.awaiting, true, 'AskUserQuestion tool must mark a session awaiting user input.');
  assert.match(activity.awaitingText, /어느 옵션/, 'Awaiting text must use the AskUserQuestion prompt.');
  assert.strictEqual(activity.awaitingQuestion.choices.length, 2, 'AskUserQuestion options must be exposed to the UI.');
  assert.strictEqual(activity.awaitingQuestion.choices[0].value, '승인합니다', 'AskUserQuestion option values must be preserved.');

  fs.writeFileSync(path.join(askLogDir, 'ask-multiple-tools.jsonl'), [
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now.getTime() + 500).toISOString(),
      sessionId: 'ask-multiple-tools',
      message: { content: [
        { type: 'tool_use', id: 'toolu_ask_multi_1', name: 'AskUserQuestion', input: { question: '첫 번째 선택은?', options: ['A', 'B'] } },
        { type: 'tool_use', id: 'toolu_ask_multi_2', name: 'AskUserQuestion', input: { question: '두 번째 설명은?', allowText: true } },
      ] },
    }),
  ].join('\n'), 'utf8');
  activity = scanActivity(askProjectPath, now.getTime() + 500);
  assert.strictEqual(activity.awaiting, true, 'Multiple AskUserQuestion tools must keep the session awaiting.');
  assert.strictEqual(activity.awaitingQuestions.length, 2, 'Multiple AskUserQuestion tools must be exposed to the UI together.');
  assert.match(activity.awaitingText, /1\. 첫 번째 선택은\?/, 'Multiple awaiting text must include the first question.');
  assert.match(activity.awaitingText, /2\. 두 번째 설명은\?/, 'Multiple awaiting text must include the second question.');
  assert.strictEqual(activity.awaitingQuestions[0].choices.length, 2, 'Choices for the first pending question must be preserved.');

  fs.writeFileSync(path.join(askLogDir, 'ask-then-agent.jsonl'), [
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now.getTime()).toISOString(),
      sessionId: 'ask-then-agent',
      message: { content: [{ type: 'tool_use', id: 'toolu_ask_2', name: 'AskUserQuestion', input: { question: '체크포인트를 승인할까요?' } }] },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: new Date(now.getTime() + 1000).toISOString(),
      sessionId: 'ask-then-agent',
      message: { content: '승인' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now.getTime() + 2000).toISOString(),
      sessionId: 'ask-then-agent',
      message: { content: [{ type: 'tool_use', id: 'toolu_debug_agent_1', name: 'Agent', input: { subagent_type: 'wcc-debug-session-manager', description: '디버그 세션 order-ui-broken-render' } }] },
    }),
  ].join('\n'), 'utf8');
  activity = scanActivity(askProjectPath, now.getTime() + 3000);
  assert.strictEqual(activity.awaiting, false, 'Answered AskUserQuestion must not keep hiding later running agents.');
  assert(activity.current, 'Running debug session manager must be visible after an answered checkpoint.');
  assert.strictEqual(activity.current.sub, 'wcc-debug-session-manager', 'Debug session manager agents must appear as current agent activity.');
} finally {
  fs.rmSync(askLogDir, { recursive: true, force: true });
}

console.log('Regression checks passed.');
