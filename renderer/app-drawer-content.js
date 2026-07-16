"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDrawerContent = function createDrawerContent(context = {}) {
  const { esc, uiLocale, state, messageContentHtml, compact, fullNumber, timeOnly, providerInfo, statusIcon, agentPathTaskName, snapshotSession } = context;

  function chatHtml(session) {
    const messages = session.messages || [];
    if (!messages.length) return '<div class="empty-state"><h3>표시할 대화가 없습니다</h3></div>';
    const conversation = messages.filter((message) => message.role === "user" || message.role === "assistant");
    const activities = messages.filter((message) => message.role !== "user" && message.role !== "assistant");
    const omitted = Number(session.omittedMessages || 0);
    const notice =
      omitted || session.truncated
        ? `<div class="chat-truncated">이 작업의 최근 기록을 표시합니다${omitted ? ` · 이전 ${omitted.toLocaleString(uiLocale())}개 메시지 생략` : ""}</div>`
        : "";
    const statusLabels = {
      started: "실행 중", running: "실행 중",
      done: window.LoadToAgentI18n.t("ui.completed"), completed: window.LoadToAgentI18n.t("ui.completed"), failed: "실패",
    };
    const statusLabel = (value) => statusLabels[value] || value || "";
    const rows = conversation
      .map((message) => {
        const role = message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : message.role === "system" ? "system" : "user";
        const label =
          role === "assistant"
            ? providerInfo(session.provider).label
            : role === "tool"
              ? message.title || "도구"
              : message.role === "system"
                ? "시스템"
                : "사용자";
        const avatar = role === "assistant" ? providerInfo(session.provider).mark : role === "tool" ? "⌘" : role === "system" ? "i" : "ME";
        const fullTime = new Date(message.timestamp).toLocaleString(uiLocale());
        return `<div class="chat-row ${role}" data-message-id="${esc(message.id || "")}">
        <span class="chat-avatar">${esc(avatar)}</span>
        <div class="chat-bubble">
        <div class="chat-bubble-head">
        <b>${esc(label)}</b>
        <span title="${esc(fullTime)}">${esc(timeOnly(message.timestamp))}</span>
        ${message.status ? `<span>${esc(statusLabel(message.status))}</span>` : ""}
        </div>${messageContentHtml(message)}</div>
        </div>`;
      })
      .join("");
    const activityHtml = activities.length
      ? `<details class="chat-activities">
      <summary>도구·시스템 활동 ${activities.length}건 보기</summary>
      <div>${activities
        .map(
          (message) => `<article>
      <header>
      <b>${esc(message.title || (message.role === "tool" ? "도구 실행" : "시스템"))}</b>
      <span>${esc(statusLabel(message.status))} · ${esc(timeOnly(message.timestamp))}</span>
      </header>${messageContentHtml(message)}</article>`,
        )
        .join("")}</div>
      </details>`
      : "";
    const emptyConversation = conversation.length ? "" : '<div class="empty-state compact"><h3>사용자와 AI의 대화는 아직 없습니다</h3></div>';
    return `${notice}<div class="chat-history-head">
      <span>대화 ${conversation.length}개${activities.length ? ` · 활동 ${activities.length}건` : ""}</span>
      <button type="button" data-scroll-latest>가장 최근 대화 ↓</button>
      </div>
      <div class="chat-list">${rows}${emptyConversation}${activityHtml}<div class="chat-latest-anchor" aria-label="가장 최근 대화">
      </div>
      </div>`;
  }

  function lifecycleHtml(session) {
    const events = session.lifecycle || [];
    if (!events.length) return '<div class="empty-state"><h3>아직 기록된 진행 과정이 없습니다</h3></div>';
    return `<div class="lifecycle-list">${events
      .map(
        (event) => `<div class="lifecycle-event ${esc(event.status)}">
      <span class="life-node">${statusIcon(event.type)}</span>
      <div class="life-copy">
      <b>${esc(event.label)}</b>
      <span>${esc(event.detail || event.type)}</span>
      </div>
      <time>${esc(timeOnly(event.timestamp))}</time>
      </div>`,
      )
      .join("")}</div>`;
  }

  function tokensHtml(session) {
    const usage = session.usage || {};
    const turn = session.turnUsage || {};
    const context = session.context || {};
    const sourceLabel =
      context.source === "session"
        ? "이 작업 기록에서 직접 확인한 기억 공간"
        : context.source === "model-catalog"
          ? "AI 모델 정보에 적힌 기억 공간"
          : "기억 공간 크기 정보 없음";
    return `<div class="token-hero" style="--drawer-provider:${providerInfo(session.provider).accent}">
      <div class="token-hero-head">
        <span>AI의 기억 공간 사용량</span>
        <b>${context.window ? `${fullNumber(context.used)} / ${fullNumber(context.window)} 토큰` : `${fullNumber(context.used)} 토큰`}</b>
        </div>
      <div class="big-context"><span style="width:${Math.min(100, context.percent || 0)}%"></span></div>
      <div class="context-scale">
        <span>0</span><span>${(context.percent || 0).toFixed(1)}%</span>
        <span>${context.window ? compact(context.window) : "--"}</span>
      </div>
    </div>
    <div class="token-grid">
      <div class="token-tile"><span>AI가 받은 글</span><strong>${fullNumber(usage.input)}</strong><small>AI에게 전달된 내용의 양</small></div>
      <div class="token-tile"><span>AI가 쓴 글</span><strong>${fullNumber(usage.output)}</strong><small>AI가 답하고 만든 내용의 양</small></div>
      <div class="token-tile"><span>다시 사용한 기억</span><strong>${fullNumber(usage.cachedInput)}</strong><small>전에 읽은 내용을 다시 활용한 양</small></div>
      <div class="token-tile"><span>새로 저장한 기억</span><strong>${fullNumber(usage.cacheWrite)}</strong><small>다음에 다시 쓰도록 저장한 양</small></div>
      <div class="token-tile"><span>생각에 사용</span><strong>${fullNumber(usage.reasoning)}</strong><small>AI가 따로 알려준 경우만 표시</small></div>
      <div class="token-tile"><span>전체 사용량</span><strong>${fullNumber(usage.total)}</strong><small>이 작업에서 사용한 토큰 합계</small></div>
      <div class="token-tile"><span>최근에 받은 글</span><strong>${fullNumber(turn.input)}</strong><small>가장 최근 대화 기준</small></div>
      <div class="token-tile"><span>최근 대화 전체</span><strong>${fullNumber(turn.total)}</strong><small>가장 최근 한 번의 사용량</small></div>
    </div><div class="token-note">${esc(sourceLabel)}입니다. 토큰은 AI가 글을 읽고 쓰는 양을 세는 단위이고, 기억 공간은 AI가 한 번에 기억할 수 있는 양입니다.</div>`;
  }

  function subagentCommunicationEvents(session) {
    if (!session || !session.parentId) return [];
    const parent = state.details.get(session.parentId) || snapshotSession(session.parentId);
    const all = (parent && parent.collaboration && parent.collaboration.communications) || [];
    const taskName = session.taskName || (session.delegation && session.delegation.taskName) || agentPathTaskName(session.agentPath);
    return all
      .filter((event) => ["assignment", "started", "followup", "message", "result", "interrupt"].includes(event.kind))
      .filter((event) => event.childId === session.id || (taskName && event.taskName === taskName));
  }

  function subagentTextPreview(value, maxCharacters = 360) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length <= maxCharacters) return { text, truncated: false };
    return { text: `${text.slice(0, maxCharacters).trimEnd()}…`, truncated: true };
  }

  function protectedSubagentEventText(event, taskName) {
    if (event.kind === "followup") return "보호된 추가 작업 지시를 전달했습니다.";
    if (event.kind === "message") return "보호된 메시지를 전달했습니다.";
    return `${taskName || "이 작업"}을 서브에이전트에게 배정했습니다.`;
  }

  function subagentConversationHtml(session) {
    const events = subagentCommunicationEvents(session);
    const taskName = session.taskName || (session.delegation && session.delegation.taskName) || session.title;
    const childPath = String(session.agentPath || "");
    const endpointIsChild = (value) => {
      const endpoint = String(value || "");
      return endpoint === childPath || endpoint === session.id || agentPathTaskName(endpoint) === taskName;
    };
    const enriched = events.map((event) => ({ ...event, fromChild: event.kind === "result" || endpointIsChild(event.from) }));
    const received = enriched.filter((event) => !event.fromChild && event.kind !== "started").length;
    const answered = enriched.filter((event) => event.fromChild).length;
    if (!events.length)
      return '<div class="empty-state"><h3>메인 AI와 주고받은 기록이 없습니다</h3><p>세션 로그에서 배정·추가 지시·결과 반환 이벤트를 찾지 못했습니다.</p></div>';
    const provider = providerInfo(session.provider);
    const rows = enriched
      .map((event) => {
        const runtime = event.kind === "started";
        const role = runtime ? "system" : event.fromChild ? "assistant" : "user";
        const label = runtime ? "실행 상태" : event.fromChild ? `서브 AI · ${session.agentName || taskName}` : "메인 AI";
        const avatar = runtime ? "↗" : event.fromChild ? provider.mark : "M";
        const route = runtime ? "런타임 → 서브 AI" : event.fromChild ? "서브 AI → 메인 AI" : "메인 AI → 서브 AI";
        const text = event.protected
          ? protectedSubagentEventText(event, taskName)
          : event.text || (runtime ? "서브에이전트 실행이 시작되었습니다." : "내용 없이 통신 상태만 기록되었습니다.");
        const preview = subagentTextPreview(text);
        const eventLabel = `${event.label || event.kind}${event.assignmentSource === "parent-narration" ? " · 작업 시작 직전 메인 AI 설명" : ""}`;
        return `<div class="chat-row ${role} subagent-dialog-row" data-subagent-communication="${esc(event.kind)}">
        <span class="chat-avatar">${esc(avatar)}</span>
        <div class="chat-bubble">
          <div class="chat-bubble-head">
            <b>${esc(label)}</b><span class="subagent-route">${esc(route)}</span>
            <span>${esc(timeOnly(event.timestamp))}</span>
          </div>
          <small class="subagent-event-label">${esc(eventLabel)}</small>
          <div class="chat-content subagent-message-preview${preview.truncated ? " is-truncated" : ""}"
            data-subagent-message-preview data-truncated="${preview.truncated ? "true" : "false"}">
            <p>${esc(preview.text)}</p>
          </div>
        </div>
      </div>`;
      })
      .join("");
    return `<div class="subagent-conversation-summary" data-subagent-dialog-count="${events.length}">
      <span>
      <small>받은 지시·응답</small>
      <b>${received}</b>건</span>
      <span>
      <small>메인에 보낸 답변</small>
      <b>${answered}</b>건</span>
      <span>
      <small>전체 소통</small>
      <b>${events.length}</b>건</span>
      </div>
      <div class="chat-history-head"><span><b>${esc(taskName)}</b>와 메인 AI가 주고받은 내용만 표시</span><button type="button" data-scroll-latest>가장 최근 대화 ↓</button></div>
      <div class="chat-list subagent-dialog-list">${rows}<div class="chat-latest-anchor" aria-label="가장 최근 대화"></div></div>`;
  }

  return { chatHtml, lifecycleHtml, tokensHtml, subagentCommunicationEvents, subagentTextPreview, protectedSubagentEventText, subagentConversationHtml };
};
