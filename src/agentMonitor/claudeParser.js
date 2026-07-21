'use strict';

const path = require('path');
const { createExecutionTracker } = require('./executionActivity');

function createClaudeParser(dependencies) {
  const {
    ACTIVE_THRESHOLD_MS,
    STALE_TURN_THRESHOLD_MS,
    addLifecycle,
    addMessage,
    baseSession,
    compactText,
    contextInfo,
    finalizeUsage,
    modelContextWindow,
    readJsonLines,
    settleLifecycle,
    sumUsage,
    timestamp,
    trimSession,
    assistantRequestsUserResponse,
    isUserInputTool,
  } = dependencies;

  function normalizeUsage(raw = {}) {
    return finalizeUsage({
      input: raw.input_tokens,
      cachedInput: raw.cache_read_input_tokens,
      cacheWrite: raw.cache_creation_input_tokens,
      output: raw.output_tokens,
      reasoning: raw.reasoning_tokens,
    });
  }

  function utilityKind(value) {
    const raw = compactText(value, 12000);
    if (/^Extract durable memory candidates from this Claude Code transcript tail/i.test(raw)
      || /^You are a memory extraction/i.test(raw)) return 'memory-extraction';
    if (/^Reply with exactly OK\. Do not use tools\.?$/i.test(raw)) return 'authentication-check';
    if (/^Approved command prefix saved:/i.test(raw)) return 'command-approval';
    return '';
  }

  function visibleUserText(value) {
    const raw = compactText(value, 12000);
    if (!raw) return '';
    const objective = raw.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/i);
    if (objective) return compactText(objective[1], 6000);
    if (/^<(?:local-command-[^>]+|command-name|command-message|system-reminder|task-notification)>/i.test(raw)) return '';
    if (utilityKind(raw)) return '';
    if (/^(?:Updated task #\d+|Your questions have been answered:)/i.test(raw)) return '';
    return raw;
  }

  function recordContent(session, state, row, item, index) {
    const kind = item && item.type;
    const id = `${row.uuid || row.requestId || session.externalId}:${index}`;
    if (kind === 'text' && item.text) {
      const text = row.message.role === 'user' ? visibleUserText(item.text) : item.text;
      if (text) addMessage(session, { id, role: row.message.role, text, timestamp: row.timestamp });
    } else if (kind === 'tool_use') {
      const name = item.name || 'tool';
      const callId = item.id || id;
      const args = item.input && typeof item.input === 'object' ? item.input : {};
      state.toolCalls.set(String(callId), { name, args });
      state.executionTracker.recordCall({ name, callId, args, rawInput: item.input, at: row.timestamp });
      addMessage(session, {
        id,
        role: 'tool',
        type: 'tool',
        title: name,
        text: compactText(item.input
          && (item.input.command || item.input.description || item.input.prompt || JSON.stringify(item.input)), 1200),
        status: 'started',
        timestamp: row.timestamp,
      });
      addLifecycle(session, {
        id: `tool:${item.id || id}`,
        type: 'tool',
        label: name,
        detail: compactText(item.input, 260),
        status: 'running',
        timestamp: row.timestamp,
      });
    } else if (kind === 'tool_result') {
      const call = state.toolCalls.get(String(item.tool_use_id || ''));
      state.executionTracker.recordOutput({
        name: call && call.name,
        callId: item.tool_use_id,
        args: call && call.args || {},
        output: item.content || item,
        at: row.timestamp,
        isError: item.is_error === true,
      });
      settleLifecycle(session, item.tool_use_id, item.is_error ? 'failed' : 'done', row.timestamp);
      addLifecycle(session, {
        id: `result:${item.tool_use_id || id}`,
        type: 'tool-result',
        label: item.is_error ? '도구 실패' : '도구 완료',
        status: item.is_error ? 'failed' : 'done',
        timestamp: row.timestamp,
      });
    } else if (kind === 'thinking') {
      addLifecycle(session, {
        id,
        type: 'reasoning',
        label: '추론',
        status: 'done',
        timestamp: row.timestamp,
      });
    }
  }

  function initializeSession(fileInfo, parsed) {
    const basename = path.basename(fileInfo.file, '.jsonl');
    const subMatch = fileInfo.file.match(/[\\/]([^\\/]+)[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/i);
    const externalId = subMatch ? subMatch[2] : basename;
    const session = baseSession('claude', externalId, fileInfo.file, fileInfo);
    session.truncated = parsed.truncated;
    session.parentId = subMatch ? `claude:${subMatch[1]}` : null;
    session.depth = subMatch ? 1 : 0;
    session.agentName = subMatch ? `agent-${subMatch[2].slice(0, 8)}` : '';
    const desktopSignals = new Set(parsed.rows.map(row => String(row && row.type || '')).filter(Boolean));
    const isDesktop = !subMatch
      && (desktopSignals.has('queue-operation') || desktopSignals.has('last-prompt') || desktopSignals.has('ai-title'));
    session.clientKind = isDesktop ? 'claude-desktop' : 'claude-cli';
    if (isDesktop) session.sourceLabel = 'Claude 데스크톱 앱';
    return session;
  }

  function processMessageRow(session, state, row) {
    const role = row.message.role === 'assistant' ? 'assistant' : 'user';
    const internalUserRow = role === 'user' && Boolean(row.isMeta || row.sourceToolUseID);
    state.lastRole = role;
    if (row.message.model) session.model = row.message.model;
    const content = Array.isArray(row.message.content)
      ? row.message.content
      : [{ type: 'text', text: row.message.content }];
    content.forEach((item, index) => {
      if (internalUserRow && (!item.type || item.type === 'text')) return;
      recordContent(session, state, row, item, index);
    });
    if (role === 'user') {
      content.filter(item => item && item.type === 'tool_result')
        .forEach(item => state.pendingUserInputCalls.delete(String(item.tool_use_id || '')));
      const rawUser = content
        .filter(item => !item.type || item.type === 'text')
        .map(item => typeof item === 'string' ? item : item.text)
        .filter(Boolean)
        .join('\n');
      if (!internalUserRow) {
        const detectedUtility = utilityKind(rawUser);
        if (detectedUtility) session.utilityKind = detectedUtility;
        const visibleUser = visibleUserText(rawUser);
        if (visibleUser) {
          session.utilityKind = '';
          state.latestUser = visibleUser;
          state.lastConversationRole = 'user';
        }
      }
    }
    if (role === 'assistant') {
      const assistantText = compactText(content
        .filter(item => item && item.type === 'text')
        .map(item => item.text)
        .filter(Boolean)
        .join('\n'), 6000);
      if (assistantText) {
        state.lastAssistantText = assistantText;
        state.lastConversationRole = 'assistant';
      }
      content.filter(item => item && item.type === 'tool_use' && isUserInputTool(item.name))
        .forEach(item => state.pendingUserInputCalls.add(String(item.id || item.name)));
    }
    if (role === 'assistant' && row.message.usage) {
      const key = row.requestId || row.message.id || row.uuid;
      const usage = normalizeUsage(row.message.usage);
      const previous = state.requestUsage.get(key);
      if (!previous || usage.total >= previous.total) state.requestUsage.set(key, usage);
      session.turnUsage = usage;
    }
  }

  function processRows(session, rows) {
    const state = {
      requestUsage: new Map(),
      latestUser: '',
      lastRole: '',
      lastConversationRole: '',
      lastAssistantText: '',
      pendingUserInputCalls: new Set(),
      toolCalls: new Map(),
      executionTracker: createExecutionTracker({ compactText, timestamp }),
      latestTs: session.updatedAt,
      lastTurnFinished: false,
    };
    for (const row of rows) {
      state.latestTs = timestamp(row.timestamp, state.latestTs);
      if (row.cwd && !session.originCwd) session.originCwd = row.cwd;
      if (row.cwd && !session.cwd) session.cwd = row.cwd;
      if (row.gitBranch) session.branch = row.gitBranch;
      if (row.agentId && session.depth) session.agentName = row.agentId;
      if (row.type === 'queue-operation' && row.operation === 'enqueue' && row.content) {
        const detectedUtility = utilityKind(row.content);
        if (detectedUtility) session.utilityKind = detectedUtility;
        const visibleUser = visibleUserText(row.content);
        const queueTitle = /^\//.test(visibleUser)
          ? compactText(visibleUser.split(/\r?\n/)[0], 6000)
          : visibleUser;
        if (queueTitle) {
          session.utilityKind = '';
          state.latestUser = queueTitle;
          state.lastRole = 'user';
          state.lastConversationRole = 'user';
        }
      }
      if (row.type === 'last-prompt' && !state.latestUser && row.lastPrompt) {
        const visibleUser = visibleUserText(row.lastPrompt);
        if (visibleUser) state.latestUser = visibleUser;
      }
      if (row.type === 'system' && row.subtype === 'init') {
        session.model = row.model || session.model;
        addLifecycle(session, {
          id: row.uuid,
          type: 'session-start',
          label: '세션 시작',
          status: 'done',
          timestamp: row.timestamp,
        });
      }
      if (row.type === 'system' && /turn_duration|turn_complete|stop/i.test(String(row.subtype || ''))) {
        state.lastTurnFinished = true;
      }
      if (row.message && row.message.role) processMessageRow(session, state, row);
    }
    return state;
  }

  function finalizeSession(session, state, parsed, fileInfo) {
    session.updatedAt = state.latestTs;
    session.startedAt = timestamp(parsed.rows[0].timestamp, session.updatedAt);
    session.usage = sumUsage([...state.requestUsage.values()]);
    session.executions = state.executionTracker.finalize();
    const utilityTitle = session.utilityKind === 'memory-extraction'
      ? 'Claude 백그라운드 메모리 추출'
      : (session.utilityKind === 'authentication-check' ? 'Claude 인증 점검' : '');
    session.title = compactText(state.latestUser, 180)
      || utilityTitle
      || (session.depth ? `Claude ${session.agentName}` : 'Claude 세션');
    const currentInput = session.turnUsage.input + session.turnUsage.cachedInput
      + session.turnUsage.cacheWrite + session.turnUsage.output + session.turnUsage.reasoning;
    session.context = contextInfo(currentInput, modelContextWindow('claude', session.model, 0));
    const age = Date.now() - fileInfo.mtimeMs;
    const pendingUserInput = state.pendingUserInputCalls.size > 0;
    const conversationalInput = state.lastConversationRole === 'assistant'
      && assistantRequestsUserResponse(state.lastAssistantText)
      && (state.lastTurnFinished || age >= ACTIVE_THRESHOLD_MS);
    if (!session.depth && (pendingUserInput || conversationalInput)) {
      session.status = 'waiting';
      session.statusDetail = pendingUserInput ? '선택 또는 입력 대기' : '답변 또는 선택 대기';
    } else if (age < ACTIVE_THRESHOLD_MS && !state.lastTurnFinished) {
      session.status = 'running';
      session.statusDetail = state.lastRole === 'user' ? '응답 생성 중' : '도구 실행 또는 스트리밍 중';
    } else if (state.lastRole === 'user' && age < STALE_TURN_THRESHOLD_MS) {
      session.status = 'waiting';
      session.statusDetail = '응답 또는 권한 확인 필요';
    } else {
      session.status = 'idle';
      session.statusDetail = state.lastRole === 'user' ? '마지막 응답 기록이 종료됨' : '다음 요청 대기';
    }
    session.statusObserved = age < ACTIVE_THRESHOLD_MS;
    trimSession(session);
    return session;
  }

  return function parseClaude(fileInfo) {
    const parsed = readJsonLines(fileInfo.file);
    if (!parsed.rows.length) return null;
    const session = initializeSession(fileInfo, parsed);
    const state = processRows(session, parsed.rows);
    return finalizeSession(session, state, parsed, fileInfo);
  };
}

module.exports = { createClaudeParser };
