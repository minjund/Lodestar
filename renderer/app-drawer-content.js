"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDrawerContent = function createDrawerContent(context = {}) {
  const {
    esc, uiLocale, state, messageContentHtml, compact, fullNumber, timeOnly, providerInfo, statusIcon, agentPathTaskName, snapshotSession,
    controlRoomAgentGoal, inferredExecutionSummary, executionActivityLabel, executionActivityStatus,
  } = context;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);

  function conversationTurns(session, options = {}) {
    const turns = [];
    let current = null;
    for (const message of session.messages || []) {
      if (!message) continue;
      if (message.role === "user") {
        current = { id: message.id || `turn-${turns.length}`, user: message, assistants: [], activityAfterAssistant: false };
        turns.push(current);
        continue;
      }
      if (message.role === "assistant") {
        if (!current) {
          const title = String(session.title || "").trim();
          const syntheticUser = options.synthesizeRequest === false || !title
            ? null
            : {
              id: `${session.id}:request`, role: "user", text: title,
              timestamp: session.startedAt || message.timestamp,
            };
          current = { id: syntheticUser?.id || message.id || `turn-${turns.length}`, user: syntheticUser, assistants: [], activityAfterAssistant: false };
          turns.push(current);
        }
        current.assistants.push(message);
        current.activityAfterAssistant = false;
        continue;
      }
      if (message.role === "tool" && current && current.assistants.length) current.activityAfterAssistant = true;
    }
    const latestIndex = turns.length - 1;
    const live = session.status === "running" || session.status === "starting";
    return turns.map((turn, index) => ({
      ...turn,
      representative: turn.assistants.at(-1) || null,
      progress: turn.assistants.slice(0, -1),
      live: live && index === latestIndex,
      awaitingFinal: Boolean(turn.activityAfterAssistant),
    }));
  }

  function conversationRowHtml(message, session, options = {}) {
    if (!message) return "";
    const assistant = message.role === "assistant";
    const label = assistant ? options.assistantLabel : options.userLabel;
    const avatar = assistant ? providerInfo(session.provider).mark : "ME";
    const fullTime = new Date(message.timestamp).toLocaleString(uiLocale());
    const answerKind = assistant && options.answerKind
      ? `<span class="chat-answer-kind${options.live ? " is-live" : ""}">${esc(options.answerKind)}</span>`
      : "";
    return `<div class="chat-row ${assistant ? "assistant" : "user"}" data-message-id="${esc(message.id || "")}">
      <span class="chat-avatar">${esc(avatar)}</span>
      <div class="chat-bubble">
      <div class="chat-bubble-head">
      <b>${esc(label)}</b>
      <span title="${esc(fullTime)}">${esc(timeOnly(message.timestamp))}</span>${answerKind}
      </div>${messageContentHtml(message, session.id)}</div>
      </div>`;
  }

  function progressUpdatesHtml(turn, session) {
    if (!turn.progress.length) return "";
    const rows = turn.progress.map((message, index) => {
      const fullTime = new Date(message.timestamp).toLocaleString(uiLocale());
      return `<article data-progress-message-id="${esc(message.id || "")}">
        <header><b>${esc(t("drawer.progress_update_item", { count: index + 1 }))}</b><time title="${esc(fullTime)}">${esc(timeOnly(message.timestamp))}</time></header>
        ${messageContentHtml(message, session.id)}
      </article>`;
    }).join("");
    return `<details class="chat-progress-updates" data-progress-count="${turn.progress.length}"
      data-disclosure-key="${esc(`drawer:${session.id}:turn:${turn.id}:progress`)}">
      <summary><span><b>${esc(t("drawer.progress_updates", { count: turn.progress.length }))}</b>
      <small>${esc(t("drawer.progress_updates_help"))}</small></span><i aria-hidden="true">↓</i></summary>
      <div class="chat-progress-list">${rows}</div>
      </details>`;
  }

  function chatHtml(session, options = {}) {
    const messages = session.messages || [];
    if (!messages.length) return `<div class="empty-state"><h3>${esc(t("drawer.no_conversation"))}</h3></div>`;
    const userLabel = options.userLabel || t("drawer.user");
    const assistantLabel = options.assistantLabel || providerInfo(session.provider).label;
    const conversationLabel = options.conversationLabel || t("drawer.conversation");
    const turns = conversationTurns(session, options);
    const progressCount = turns.reduce((sum, turn) => sum + turn.progress.length, 0);
    const omitted = Number(session.omittedMessages || 0);
    const notice =
      omitted || session.truncated
        ? `<div class="chat-truncated">${esc(t("drawer.recent_history"))}${omitted ? ` · ${esc(t("drawer.messages_omitted", { count: omitted.toLocaleString(uiLocale()) }))}` : ""}</div>`
        : "";
    const rows = turns.map((turn) => {
      const user = conversationRowHtml(turn.user, session, { userLabel, assistantLabel });
      const representative = conversationRowHtml(turn.representative, session, {
        userLabel,
        assistantLabel,
        answerKind: t(turn.live ? "drawer.current_progress" : turn.awaitingFinal ? "drawer.last_progress" : "drawer.final_answer"),
        live: turn.live,
      });
      const waiting = turn.live && !turn.representative
        ? `<div class="chat-turn-waiting"><span aria-hidden="true"></span><b>${esc(t("drawer.preparing_response"))}</b></div>`
        : "";
      return `<section class="chat-turn${turn.live ? " is-live" : ""}" data-conversation-turn="${esc(turn.id)}">
        ${user}${representative}${waiting}${progressUpdatesHtml(turn, session)}
      </section>`;
    }).join("");
    const emptyConversation = turns.length ? "" : `<div class="empty-state compact"><h3>${esc(t("drawer.no_user_ai_conversation"))}</h3></div>`;
    return `${notice}<div class="chat-history-head">
      <span>${esc(t("drawer.turn_summary", { label: conversationLabel, count: turns.length, updates: progressCount ? ` · ${t("drawer.progress_updates", { count: progressCount })}` : "" }))}</span>
      <button type="button" data-scroll-latest>${esc(t("drawer.latest_conversation"))} ↓</button>
      </div>
      <div class="chat-list">${rows}${emptyConversation}<div class="chat-latest-anchor" aria-label="${esc(t("drawer.latest_conversation"))}">
      </div>
      </div>`;
  }

  function lifecycleHtml(session) {
    const events = session.lifecycle || [];
    if (!events.length) return `<div class="empty-state"><h3>${esc(t("drawer.no_lifecycle"))}</h3></div>`;
    return `<div class="lifecycle-list">${events
      .map(
        (event) => `<div class="lifecycle-event ${esc(event.status)}">
      <span class="life-node">${statusIcon(event.type)}</span>
      <div class="life-copy">
      <b>${esc(window.LoadToAgentI18n.observedText(event.label))}</b>
      <span>${esc(window.LoadToAgentI18n.observedText(event.detail || event.type))}</span>
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
        ? t("drawer.context_source_session")
        : context.source === "model-catalog"
          ? t("drawer.context_source_catalog")
          : t("session.context_size_unknown");
    return `<div class="token-hero" style="--drawer-provider:${providerInfo(session.provider).accent}">
      <div class="token-hero-head">
        <span>${esc(t("session.context_usage"))}</span>
        <b>${esc(t("drawer.tokens", { count: context.window ? `${fullNumber(context.used)} / ${fullNumber(context.window)}` : fullNumber(context.used) }))}</b>
        </div>
      <div class="big-context"><span style="width:${Math.min(100, context.percent || 0)}%"></span></div>
      <div class="context-scale">
        <span>0</span><span>${(context.percent || 0).toFixed(1)}%</span>
        <span>${context.window ? compact(context.window) : "--"}</span>
      </div>
    </div>
    <div class="token-grid">
      <div class="token-tile"><span>${esc(t("drawer.input"))}</span><strong>${fullNumber(usage.input)}</strong><small>${esc(t("drawer.input_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.output"))}</span><strong>${fullNumber(usage.output)}</strong><small>${esc(t("drawer.output_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.cached"))}</span><strong>${fullNumber(usage.cachedInput)}</strong><small>${esc(t("drawer.cached_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.cache_write"))}</span><strong>${fullNumber(usage.cacheWrite)}</strong><small>${esc(t("drawer.cache_write_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.reasoning"))}</span><strong>${fullNumber(usage.reasoning)}</strong><small>${esc(t("drawer.reasoning_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.total"))}</span><strong>${fullNumber(usage.total)}</strong><small>${esc(t("drawer.total_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.last_input"))}</span><strong>${fullNumber(turn.input)}</strong><small>${esc(t("drawer.latest_turn"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.last_total"))}</span><strong>${fullNumber(turn.total)}</strong><small>${esc(t("drawer.last_total_help"))}</small></div>
    </div><div class="token-note">${esc(t("drawer.token_note", { source: sourceLabel }))}</div>`;
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

  function subagentCoordinationEvents(session) {
    return subagentCommunicationEvents(session).filter((event) => {
      if (!event || event.protected || event.kind === "started") return false;
      if (!["assignment", "followup", "message", "result", "interrupt"].includes(event.kind)) return false;
      const text = String(event.text || "").trim();
      return Boolean(text && text.toLowerCase() !== "started");
    });
  }

  function subagentWorkMessages(session) {
    const parent = session.parentId ? state.details.get(session.parentId) || snapshotSession(session.parentId) : null;
    const delegation = session.delegation || {};
    const startValue = delegation.startedAt || session.startedAt || "";
    const startedAt = startValue ? Date.parse(startValue) : Number.NaN;
    const normalizedText = value => String(value || "").replace(/\s+/g, " ").trim();
    const messageKey = message => `${message.role || ""}:${normalizedText(message.text)}`;
    const parentMessageIds = new Set((parent?.messages || []).map(message => String(message.id || "")).filter(Boolean));
    const parentMessageKeys = new Set((parent?.messages || []).map(messageKey));
    const messages = (session.messages || []).filter(message => {
      if (!message || !["user", "assistant"].includes(message.role) || message.protected || !normalizedText(message.text)) return false;
      const messageAt = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
      if (Number.isFinite(startedAt) && startedAt > 0 && Number.isFinite(messageAt) && messageAt < startedAt - 2000) return false;
      const inheritedId = message.id && parentMessageIds.has(String(message.id));
      const inheritedText = parentMessageKeys.has(messageKey(message));
      return !inheritedId && !inheritedText;
    });
    const hasConversation = messages.some((message) =>
      (message.role === "user" || message.role === "assistant") && String(message.text || "").trim(),
    );
    if (hasConversation) return messages;
    if (delegation.assignmentObserved && !delegation.assignmentProtected && String(delegation.assignment || "").trim()) {
      messages.push({
        id: `${session.id}:delegation`, role: "user", text: delegation.assignment,
        timestamp: delegation.startedAt || session.startedAt || session.updatedAt,
      });
    }
    if (String(session.result || delegation.result || "").trim()) {
      messages.push({
        id: `${session.id}:result`, role: "assistant", text: session.result || delegation.result,
        timestamp: session.completedAt || delegation.completedAt || session.updatedAt,
      });
    }
    return messages.sort((left, right) => Date.parse(left.timestamp || 0) - Date.parse(right.timestamp || 0));
  }

  function subagentCoordinationHtml(session) {
    const events = subagentCoordinationEvents(session);
    if (!events.length) return "";
    const taskName = session.taskName || (session.delegation && session.delegation.taskName) || session.title;
    const childPath = String(session.agentPath || "");
    const endpointIsChild = (value) => {
      const endpoint = String(value || "");
      return endpoint === childPath || endpoint === session.id || agentPathTaskName(endpoint) === taskName;
    };
    const rows = events
      .map((event) => {
        const fromChild = event.kind === "result" || endpointIsChild(event.from);
        const preview = subagentTextPreview(event.text);
        const label = fromChild ? t("drawer.child_to_main", { child: session.agentName || taskName }) : t("drawer.main_to_child");
        return `<article data-subagent-communication="${esc(event.kind)}">
          <header><b>${esc(window.LoadToAgentI18n.observedText(event.label || event.kind))}</b><span>${esc(label)} · ${esc(timeOnly(event.timestamp))}</span></header>
          <div class="chat-content plain subagent-message-preview${preview.truncated ? " is-truncated" : ""}"
            data-subagent-message-preview data-truncated="${preview.truncated ? "true" : "false"}"><p>${esc(preview.text)}</p></div>
        </article>`;
      })
      .join("");
    return `<details class="chat-activities subagent-coordination" data-subagent-coordination-count="${events.length}" data-disclosure-key="${esc(`drawer:${session.id}:coordination`)}">
      <summary>${esc(t("drawer.coordination_events", { count: events.length }))}</summary><div>${rows}</div>
    </details>`;
  }

  function subagentConversationHtml(session) {
    const delegation = session.delegation || {};
    const parent = session.parentId ? state.details.get(session.parentId) || snapshotSession(session.parentId) : null;
    const assignmentEvent = subagentCoordinationEvents(session).find(event => event.kind === "assignment" && String(event.text || "").trim());
    const assignment = String(delegation.assignment || assignmentEvent?.text || delegation.taskName || session.taskName || session.title || "").trim();
    let assignmentRemoved = false;
    const messages = subagentWorkMessages(session).filter(message => {
      if (assignmentRemoved || message.role !== "user" || !assignment) return true;
      if (String(message.text || "").replace(/\s+/g, " ").trim() !== assignment.replace(/\s+/g, " ").trim()) return true;
      assignmentRemoved = true;
      return false;
    });
    const conversationCount = messages.filter((message) => message.role === "user" || message.role === "assistant").length;
    const workSession = { ...session, messages };
    const sourceCopy = session.source === "collaboration-history"
      ? t("drawer.subagent_history_reconstructed")
      : t("drawer.subagent_history_actual");
    return `<section class="subagent-assignment-card" data-subagent-assignment="true">
      <span aria-hidden="true">⌁</span><div><b>${esc(t("control.main_assignment"))}</b>${parent ? `<small>${esc(t("control.created_from"))} · ${esc(parent.title)}</small>` : ""}<p>${esc(assignment || t("management.signal_unavailable"))}</p></div>
    </section><section class="subagent-work-source" data-subagent-work-messages="${conversationCount}" data-conversation-scope="subagent-only">
      <b>${esc(t("control.subagent_conversation"))}</b><span>${esc(sourceCopy)}</span>
    </section>${chatHtml(workSession, {
      userLabel: t("drawer.user"),
      assistantLabel: session.agentName || t("drawer.sub_ai"),
      conversationLabel: t("drawer.work_history"),
      synthesizeRequest: false,
    })}${subagentCoordinationHtml(session)}`;
  }

  function executionActivityDetailHtml(session, activity) {
    if (!activity) return `<div class="empty-state"><h3>${esc(t("drawer.execution_unavailable"))}</h3></div>`;
    const purpose = inferredExecutionSummary(activity);
    const ownerGoal = controlRoomAgentGoal(session, 180);
    const runtime = activity.runtime || activity.tool || t("graph.runtime_unknown");
    const handle = activity.backgroundId
      ? `${activity.backgroundIdType || t("graph.execution_handle")} · ${activity.backgroundId}`
      : "";
    const command = String(activity.command || activity.label || purpose.full || "").trim();
    const output = String(activity.output || "").trim();
    const status = executionActivityStatus(activity);
    const ownerLabel = session.parentId
      ? `${t("control.subagent")} · ${session.agentName || session.taskName || providerInfo(session.provider).label}`
      : `${t("control.main_agent")} · ${session.agentName || providerInfo(session.provider).label}`;
    const timeline = [
      activity.startedAt ? { label: t("drawer.execution_started"), value: activity.startedAt } : null,
      activity.updatedAt ? { label: activity.status === "running" ? t("drawer.execution_latest_activity") : t("drawer.execution_finished"), value: activity.updatedAt } : null,
    ].filter(Boolean);
    return `<div class="execution-drawer" data-execution-detail="${esc(activity.id)}" data-conversation-scope="execution-only">
      <section class="execution-purpose-card">
        <span class="execution-purpose-icon" aria-hidden="true">${activity.kind === "shell" ? "›_" : "◌"}</span>
        <div><small>${esc(t("drawer.execution_purpose"))}</small><b>${esc(purpose.text)}</b><p>${esc(t("drawer.execution_owner_context", { owner: ownerLabel, task: ownerGoal.text }))}</p></div>
      </section>
      <section class="execution-process-card">
        <header><span><small>${esc(executionActivityLabel(activity))}</small><b>${esc(status)}</b></span><em class="${activity.status === "running" ? "is-running" : ""}"><i aria-hidden="true"></i>${esc(activity.statusDetail || status)}</em></header>
        <dl>
          <div><dt>${esc(t("graph.execution_runtime"))}</dt><dd>${esc(runtime)}</dd></div>
          ${activity.cwd ? `<div><dt>${esc(t("graph.execution_workdir"))}</dt><dd title="${esc(activity.cwd)}">${esc(activity.cwd)}</dd></div>` : ""}
          ${handle ? `<div><dt>${esc(t("graph.execution_handle"))}</dt><dd>${esc(handle)}</dd></div>` : ""}
          ${activity.exitCode != null ? `<div><dt>${esc(t("drawer.execution_exit_code"))}</dt><dd>${esc(activity.exitCode)}</dd></div>` : ""}
        </dl>
      </section>
      <section class="execution-code-card">
        <header><span><small>${esc(t("drawer.execution_command_from", { owner: ownerLabel }))}</small><b>${esc(t("graph.execution_command"))}</b></span>${command ? `<button type="button" data-copy-text="${esc(command)}">${esc(t("graph.copy_command"))}</button>` : ""}</header>
        ${command ? `<pre><code>${esc(command)}</code></pre>` : `<p>${esc(t("drawer.execution_command_unavailable"))}</p>`}
      </section>
      <section class="execution-code-card output-card">
        <header><span><small>${esc(t("drawer.execution_output_help"))}</small><b>${esc(t("graph.execution_output"))}</b></span>${output ? `<button type="button" data-copy-text="${esc(output)}">${esc(t("graph.copy_output"))}</button>` : ""}</header>
        ${output ? `<pre>${esc(output)}</pre>` : `<p>${esc(activity.status === "running" ? t("drawer.execution_waiting_output") : t("graph.execution_output_unavailable"))}</p>`}
      </section>
      ${timeline.length ? `<section class="execution-timeline" aria-label="${esc(t("drawer.execution_timeline"))}">${timeline.map((item, index) => `<div><i aria-hidden="true"></i><span><b>${esc(item.label)}</b><time title="${esc(item.value)}">${esc(new Date(item.value).toLocaleString(uiLocale()))}</time></span>${index === timeline.length - 1 && activity.status === "running" ? `<em>${esc(t("graph.execution_running"))}</em>` : ""}</div>`).join("")}</section>` : ""}
    </div>`;
  }

  return { conversationTurns, chatHtml, lifecycleHtml, tokensHtml, subagentCommunicationEvents, subagentCoordinationEvents, subagentTextPreview, subagentConversationHtml, executionActivityDetailHtml };
};
