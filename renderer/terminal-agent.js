'use strict';

/** Connect dashboard agent sessions to live or resumed terminal targets. */
window.LoadToAgentTerminalAgentActions = function createModule(context) {
  const {
    $, state, init, notice, moveWorkbench, selectTmux, selectSession, bindAgent, queueHistoryRefresh,
    renderTarget, fitEntry, refreshSessions, resumeSupport, resumeLaunchArgs, preferredWorkspace, providerLabel, esc,
  } = context;

  function tmuxRows(snapshot = state.snapshot) {
    const rows = [];
    for (const distro of snapshot && snapshot.tmux && snapshot.tmux.distros || []) {
      for (const session of distro.sessions || []) {
        for (const windowItem of session.windows || []) {
          for (const pane of windowItem.panes || []) rows.push({ distro, session, window: windowItem, pane });
        }
      }
    }
    return rows;
  }

  function agentTargets(agentSession) {
    if (!agentSession || !agentSession.id) return [];
    const targets = [];
    const presence = Array.isArray(agentSession.runtimePresence) ? agentSession.runtimePresence : [];
    const tmuxPresence = presence.filter(item => item.kind === 'tmux');
    for (const row of tmuxRows()) {
      const pane = row.pane || {};
      const linked = pane.agent && pane.agent.linkedSessionId === agentSession.id;
      const observed = tmuxPresence.some(item => item.paneId === pane.id
        || item.paneNativeId === pane.nativeId
        || item.id === `tmux:${row.distro.name}:${pane.nativeId}`);
      if (!linked && !observed) continue;
      targets.push({
        id: `tmux:${row.distro.name}:${pane.nativeId}`,
        kind: 'tmux',
        label: `${row.distro.name} · ${row.session.name} · ${pane.nativeId}`,
        detail: `${row.window.index}:${row.window.name} · ${pane.command || 'AI 명령창'}`,
        distro: row.distro.name,
        paneId: pane.id,
        paneNativeId: pane.nativeId,
      });
    }
    for (const terminal of state.sessions) {
      if (terminal.status !== 'running') continue;
      const matched = terminal.bridgeId === agentSession.id || presence.some(item => item.terminalId === terminal.id
        || Number(item.pid || 0) === Number(terminal.pid || -1)
        || Number(item.parentPid || 0) === Number(terminal.pid || -1));
      if (!matched) continue;
      targets.push({
        id: terminal.id,
        kind: 'terminal',
        label: terminal.title,
        detail: `${String(terminal.type || '').toUpperCase()} · PID ${terminal.pid || '--'}`,
        terminalId: terminal.id,
      });
    }
    return [...new Map(targets.map(target => [target.id, target])).values()];
  }

  function requiredAgentTarget(agentSession, targetId = '') {
    const targets = agentTargets(agentSession);
    if (!targets.length) throw new Error('이 AI가 실행 중인 입력 가능한 터미널을 찾지 못했습니다. 외부 터미널에서 시작한 AI는 LoadToAgent가 직접 입력할 수 없습니다.');
    if (targetId) {
      const selected = targets.find(target => target.id === targetId);
      if (!selected) throw new Error('선택한 터미널 연결이 더 이상 유효하지 않습니다.');
      return selected;
    }
    if (targets.length > 1) throw new Error('지시를 보낼 터미널을 먼저 선택하세요.');
    return targets[0];
  }

  async function dispatchAgentCommand(agentSession, command, targetId = '') {
    await init();
    const text = String(command || '').trim();
    if (!text) throw new Error('AI에게 보낼 지시를 입력하세요.');
    const target = requiredAgentTarget(agentSession, targetId);
    const result = target.kind === 'tmux'
      ? await window.loadtoagent.tmuxSendText({ distro: target.distro, target: target.paneNativeId, text, enter: true })
      : await window.loadtoagent.terminalCommand(target.terminalId, text);
    if (!result || result.ok === false) throw new Error(result && result.error || '터미널에 지시를 보내지 못했습니다.');
    notice(`${target.label}에 AI 지시를 보냈습니다.`, 'success');
    return { ok: true, target };
  }

  async function openForAgent(agentSession, targetId = '', draft = '') {
    await init();
    const target = requiredAgentTarget(agentSession, targetId);
    state.mode = target.kind === 'tmux' ? 'tmux' : 'general';
    moveWorkbench(state.mode);
    if (target.kind === 'tmux') await selectTmux(target.distro, target.paneNativeId);
    else await selectSession(target.terminalId);
    bindAgent(agentSession, target);
    queueHistoryRefresh(agentSession);
    renderTarget();
    const entry = target.kind === 'tmux' ? state.remoteTerminal : state.terminals.get(target.terminalId);
    fitEntry(entry, target.kind === 'tmux' ? '' : target.terminalId);
    const input = $('#terminalCommandInput');
    input.value = String(draft || '');
    state.commandDrafts.set(target.id, input.value);
    input.focus({ preventScroll: true });
    notice(`${target.label}의 기존 세션을 유지하고 있습니다. 이전 대화를 보면서 이어서 입력하세요.`, 'success');
    return target;
  }

  async function resumeForAgent(agentSession, draft = '', sendDraft = false) {
    await init();
    const support = resumeSupport(agentSession);
    if (!support.supported) throw new Error(support.reason);
    const cwd = String(agentSession.cwd || preferredWorkspace() || '').trim();
    if (!cwd) throw new Error('이 AI가 작업하던 폴더를 찾지 못해 세션을 안전하게 재개할 수 없습니다.');
    const prompt = String(draft || '').trim();
    const title = `${providerLabel(agentSession.provider)} · ${agentSession.taskName || agentSession.agentName || '세션'} 이어서 작업`;
    const created = await window.loadtoagent.terminalCreate({
      type: 'agent',
      provider: support.provider,
      args: resumeLaunchArgs(support, sendDraft ? prompt : ''),
      cwd,
      bridgeId: agentSession.id,
      title,
      cols: 120,
      rows: 32,
    });
    if (!created || !created.id) throw new Error('AI 세션을 재개할 터미널을 만들지 못했습니다.');
    state.mode = 'general';
    moveWorkbench('general');
    await refreshSessions();
    await selectSession(created.id);
    const target = {
      id: created.id,
      kind: 'terminal',
      label: created.title || title,
      detail: `${String(created.type || 'agent').toUpperCase()} · PID ${created.pid || '--'}`,
      terminalId: created.id,
    };
    bindAgent(agentSession, target);
    queueHistoryRefresh(agentSession);
    renderTarget();
    const input = $('#terminalCommandInput');
    if (input) {
      input.value = sendDraft ? '' : String(draft || '');
      state.commandDrafts.set(target.id, input.value);
      input.focus({ preventScroll: true });
    }
    notice(sendDraft && prompt
      ? `${providerLabel(agentSession.provider)} 세션 ${support.sessionId.slice(0, 12)}을 이어받아 지시를 보냈습니다.`
      : `${providerLabel(agentSession.provider)} 세션 ${support.sessionId.slice(0, 12)}을 다시 연결했습니다. 이어서 지시할 수 있습니다.`, 'success');
    return { ...target, promptSent: Boolean(sendDraft && prompt) };
  }

  return { tmuxRows, agentTargets, requiredAgentTarget, dispatchAgentCommand, openForAgent, resumeForAgent };
};
