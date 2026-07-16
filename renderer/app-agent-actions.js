"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createAgentActions = function createAgentActions(context = {}) {
  const {
    $,
    esc,
    state,
    selectView,
    providerInfo,
    isLiveSession,
  } = context;

  function agentCommandTargets(session) {
    try {
      return window.LoadToAgentTerminal && typeof window.LoadToAgentTerminal.agentTargets === "function"
        ? window.LoadToAgentTerminal.agentTargets(session)
        : [];
    } catch (error) {
      window.LoadToAgentRendererUtils.reportRecoverableError("agent-command-targets", error);
      return [];
    }
  }

  function agentResumeSupport(session) {
    try {
      return window.LoadToAgentTerminal && typeof window.LoadToAgentTerminal.resumeSupport === "function"
        ? window.LoadToAgentTerminal.resumeSupport(session)
        : { supported: false, reason: "터미널 재개 기능을 준비하는 중입니다." };
    } catch (error) {
      return { supported: false, reason: (error && error.message) || "세션 재개 가능 여부를 확인하지 못했습니다." };
    }
  }

  function originAppInfo(session) {
    if (session && session.provider === "codex" && session.clientKind === "codex-desktop") {
      return { provider: "Codex", label: "Codex 데스크톱 앱" };
    }
    if (session && session.provider === "claude" && session.clientKind === "claude-desktop") {
      return { provider: "Claude", label: "Claude 데스크톱 앱" };
    }
    return null;
  }

  function agentControlMode(session, targets) {
    if (targets.length) return "direct";
    if (originAppInfo(session)) return !isLiveSession(session) && agentResumeSupport(session).supported ? "origin-resume" : "origin";
    if (agentResumeSupport(session).supported) return isLiveSession(session) ? "handoff" : "resume";
    if (isLiveSession(session)) return "connect";
    return "ended";
  }

  function agentCommandComposer(session) {
    const targets = agentCommandTargets(session);
    const mode = agentControlMode(session, targets);
    const savedTarget = state.agentCommandTargets.get(session.id) || "";
    const targetId = targets.some((target) => target.id === savedTarget) ? savedTarget : targets.length === 1 ? targets[0].id : "";
    if (targetId) state.agentCommandTargets.set(session.id, targetId);
    const target = targets.find((item) => item.id === targetId) || null;
    const draft = state.agentCommandDrafts.get(session.id) || "";
    const sending = state.agentCommandSending.has(session.id);
    const canSend = ((mode === "direct" && Boolean(target)) || ["resume", "handoff", "origin-resume"].includes(mode)) && !sending;
    const origin = originAppInfo(session);
    const status =
      mode === "direct"
        ? `직접 입력 가능 · ${targets.length === 1 ? target.label : `${targets.length}개 터미널 중 선택`}`
        : mode === "handoff"
          ? "외부 터미널에서 실행 중 · 같은 대화로 이어받기 가능"
          : mode === "resume"
            ? "원래 터미널이 종료됨 · 같은 세션으로 복구 가능"
            : mode === "origin-resume"
              ? "쉬는 데스크톱 작업 · 백그라운드 터미널로 이어가기 가능"
              : mode === "connect"
                ? "연결 후 입력 가능 · 현재 세션은 보기 전용"
                : mode === "origin"
                  ? "보기 전용 · 원래 앱에서 계속"
                  : window.LoadToAgentI18n.t("ui.ended_session");
    const help =
      mode === "direct"
        ? "기존 터미널에 바로 보냅니다. 앱 창을 닫아도 백그라운드에서 세션을 계속 유지합니다."
        : mode === "handoff"
          ? "같은 세션 ID와 대화 내역을 LoadToAgent 관리 터미널로 이어받고 백그라운드에서 유지합니다."
          : mode === "resume"
            ? "기존 세션 ID와 대화 맥락을 복구하고, 앱 창을 닫아도 백그라운드에서 유지합니다."
            : mode === "origin-resume"
              ? `원래 ${(origin && origin.provider) || "데스크톱"} 앱으로 돌아가거나, 같은 세션을 백그라운드 터미널로 이어서 작업할 수 있습니다.`
              : mode === "connect"
                ? `새 터미널에서 loadtoagent run ${session.provider}로 시작하면 창을 닫아도 안전하게 유지됩니다.`
                : mode === "origin"
                  ? `이 대화는 ${(origin && origin.label) || "데스크톱 앱"}에서 현재 실행 중이므로 원래 작업에서 계속합니다.`
                  : agentResumeSupport(session).reason || "이 제공사의 세션 재개 방식을 확인할 수 없습니다.";
    const picker =
      targets.length > 1
        ? `<label class="agent-command-target">
      <span>보낼 터미널</span>
      <select data-agent-command-target="${esc(session.id)}">
      <option value="">터미널을 선택하세요</option>
      ${targets.map((item) => `<option value="${esc(item.id)}" ${item.id === targetId ? "selected" : ""}>${esc(item.label)}</option>`).join("")}
      </select>
      </label>`
        : "";
    const originAction = `<button type="button" data-agent-open-origin="${esc(session.id)}">원래 ${esc((origin && origin.provider) || "데스크톱")} 앱에서 계속하기</button>`;
    const actions =
      mode === "direct"
        ? `<button type="button" data-agent-terminal-open="${esc(session.id)}" ${canSend ? "" : "disabled"}>터미널에서 열기</button>
      <button type="submit" ${canSend ? "" : "disabled"}>${sending ? "보내는 중…" : "바로 보내기 ↵"}</button>`
        : mode === "resume"
          ? `<button type="submit" ${canSend ? "" : "disabled"}>${sending ? "복구하는 중…" : "같은 세션으로 복구해 보내기 ↵"}</button>`
          : mode === "handoff"
            ? `<button type="submit" ${canSend ? "" : "disabled"}>${sending ? "이어받는 중…" : "관리 터미널로 이어받아 보내기 ↵"}</button>`
            : mode === "origin-resume"
              ? `${originAction}<button type="submit" ${canSend ? "" : "disabled"}>${sending ? "연결하는 중…" : "백그라운드 터미널로 이어서 보내기 ↵"}</button>`
              : mode === "connect"
                ? `<button type="button" data-agent-bridge-copy="${esc(session.provider)}">연결 명령 복사</button>`
                : mode === "origin"
                  ? originAction
                  : "";
    const editable = ["direct", "resume", "handoff", "origin-resume"].includes(mode);
    const placeholder = editable ? "예: 이전 작업에 이어서 테스트를 실행하고 결과를 알려줘" : status;
    const availabilityClass = mode === "direct" ? "connected" : ["resume", "handoff", "origin-resume"].includes(mode) ? "resume-ready" : "unavailable";
    return `<form class="agent-command-panel ${availabilityClass} control-${mode}"
      data-agent-command-form="${esc(session.id)}">
      <header>
        <span class="agent-command-icon" aria-hidden="true">›_</span>
        <span><b>이 AI에게 바로 지시하기</b><small>${esc(status)}</small></span>
        <i class="${mode === "direct" ? "connected" : ""}" aria-hidden="true"></i>
      </header>
      ${picker}
      <label class="agent-command-input">
        <span class="sr-only">AI에게 보낼 터미널 지시</span>
        <textarea data-agent-command-draft="${esc(session.id)}" maxlength="8000" rows="3"
          placeholder="${esc(placeholder)}" ${editable ? "" : "disabled"}>${editable ? esc(draft) : ""}</textarea>
      </label>
      <div class="agent-command-actions"><small aria-live="polite">${esc(help)}</small>${actions}</div>
    </form>`;
  }

  function selectedSession() {
    return (
      state.details.get(state.selectedId) || ((state.snapshot && state.snapshot.sessions) || []).find((session) => session.id === state.selectedId) || null
    );
  }

  function snapshotSession(id) {
    return ((state.snapshot && state.snapshot.sessions) || []).find((session) => session.id === id) || null;
  }

  function chosenAgentCommandTarget(session) {
    const targets = agentCommandTargets(session);
    const saved = state.agentCommandTargets.get(session.id) || "";
    if (saved) return targets.find((target) => target.id === saved) || null;
    return targets.length === 1 ? targets[0] : null;
  }

  async function resumeAgentTerminal(sessionId, sendDraft = false) {
    if (state.agentCommandSending.has(sessionId)) return;
    const session = snapshotSession(sessionId) || state.details.get(sessionId);
    if (!session || !window.LoadToAgentTerminal) return context.toast("다시 연결할 AI 세션 정보를 찾지 못했습니다.");
    const support = agentResumeSupport(session);
    if (!support.supported) return context.toast(support.reason || "이 AI 세션은 터미널에서 다시 연결할 수 없습니다.");
    state.agentCommandSending.add(sessionId);
    try {
      if ($("#detailDrawer").classList.contains("open")) context.closeDrawer(false);
      selectView("terminal");
      const draft = state.agentCommandDrafts.get(sessionId) || "";
      await window.LoadToAgentTerminal.resumeForAgent(session, draft, sendDraft);
      if (sendDraft && draft.trim()) state.agentCommandDrafts.delete(sessionId);
      document.querySelector(".main-stage")?.scrollTo({ top: 0, behavior: "auto" });
      context.toast(`${providerInfo(session.provider).label}의 기존 세션을 터미널에 다시 연결했습니다.`);
    } catch (error) {
      context.toast((error && error.message) || "AI 세션을 다시 연결하지 못했습니다.");
    } finally {
      state.agentCommandSending.delete(sessionId);
    }
  }

  async function dispatchAgentCommand(sessionId, form) {
    if (state.agentCommandSending.has(sessionId)) return;
    const session = snapshotSession(sessionId);
    if (!session || !window.LoadToAgentTerminal) return context.toast("선택한 AI의 최신 정보를 찾지 못했습니다.");
    const mode = agentControlMode(session, agentCommandTargets(session));
    if (mode === "resume" || mode === "handoff" || mode === "origin-resume") {
      const input = form.querySelector("[data-agent-command-draft]");
      if (input) state.agentCommandDrafts.set(sessionId, input.value);
      if (!String((input && input.value) || "").trim()) return context.toast("AI에게 보낼 지시를 입력하세요.");
      return resumeAgentTerminal(sessionId, true);
    }
    const target = chosenAgentCommandTarget(session);
    const input = form.querySelector("[data-agent-command-draft]");
    const command = String((input && input.value) || "").trim();
    if (!target)
      return context.toast(agentCommandTargets(session).length ? "지시를 보낼 터미널을 먼저 선택하세요." : "이 AI에 연결된 입력 가능한 터미널이 없습니다.");
    if (!command) return context.toast("AI에게 보낼 지시를 입력하세요.");
    state.agentCommandSending.add(sessionId);
    const submit = form.querySelector('[type="submit"]');
    if (submit) {
      submit.disabled = true;
      submit.textContent = "보내는 중…";
    }
    try {
      await window.LoadToAgentTerminal.dispatchAgentCommand(session, command, target.id);
      state.agentCommandDrafts.delete(sessionId);
      if (input) input.value = "";
      context.toast(`${target.label}에 지시를 보냈습니다.`);
    } catch (error) {
      const latest = snapshotSession(sessionId) || session;
      const support = agentResumeSupport(latest);
      if (!agentCommandTargets(latest).length && support.supported) {
        try {
          state.agentCommandDrafts.set(sessionId, command);
          await window.LoadToAgentTerminal.resumeForAgent(latest, command, true);
          state.agentCommandDrafts.delete(sessionId);
          if (input) input.value = "";
          context.toast("원래 터미널 연결이 종료되어 같은 AI 세션으로 복구한 뒤 지시를 보냈습니다.");
          return;
        } catch (resumeError) {
          context.toast((resumeError && resumeError.message) || "터미널 연결이 끊어졌고 세션 복구에도 실패했습니다.");
        }
      } else context.toast((error && error.message) || "터미널에 지시를 보내지 못했습니다.");
    } finally {
      state.agentCommandSending.delete(sessionId);
      if (submit && submit.isConnected) {
        submit.disabled = false;
        submit.textContent = "바로 보내기 ↵";
      }
    }
  }

  async function openAgentTerminal(sessionId) {
    const session = snapshotSession(sessionId);
    if (!session || !window.LoadToAgentTerminal) return context.toast("선택한 AI의 터미널 정보를 찾지 못했습니다.");
    const target = chosenAgentCommandTarget(session);
    if (!target)
      return context.toast(agentCommandTargets(session).length ? "열어볼 터미널을 먼저 선택하세요." : "이 AI에 연결된 입력 가능한 터미널이 없습니다.");
    selectView(target.kind === "tmux" ? "tmux" : "terminal");
    try {
      await window.LoadToAgentTerminal.openForAgent(session, target.id, state.agentCommandDrafts.get(sessionId) || "");
      document.querySelector(".main-stage")?.scrollTo({ top: 0, behavior: "auto" });
    } catch (error) {
      context.toast((error && error.message) || "AI의 터미널을 열지 못했습니다.");
    }
  }

  async function copyBridgeCommand(provider) {
    try {
      const result = await window.loadtoagent.bridgeCommand(provider);
      if (!result || !result.ok) throw new Error("연결 명령을 만들지 못했습니다.");
      const command = result.command;
      await window.loadtoagent.writeClipboard(command);
      context.toast(`${command} 명령을 복사했습니다.`);
    } catch (error) {
      context.toast((error && error.message) || "연결 명령을 복사하지 못했습니다.");
    }
  }

  async function openSessionOrigin(sessionId) {
    const session = snapshotSession(sessionId);
    const origin = originAppInfo(session);
    if (!session || !origin) return context.toast("원래 데스크톱 작업 정보를 찾지 못했습니다.");
    try {
      const result = await window.loadtoagent.openSessionOrigin(session);
      if (!result || !result.ok) return context.toast(`이 작업은 ${origin.label}에서 직접 열 수 없습니다.`);
      context.toast(`원래 ${origin.provider} 작업을 열었습니다.`);
    } catch (error) {
      context.toast((error && error.message) || `${origin.label}을 열지 못했습니다.`);
    }
  }

  return {
    agentCommandTargets,
    agentResumeSupport,
    originAppInfo,
    agentControlMode,
    agentCommandComposer,
    selectedSession,
    snapshotSession,
    chosenAgentCommandTarget,
    resumeAgentTerminal,
    dispatchAgentCommand,
    openAgentTerminal,
    copyBridgeCommand,
    openSessionOrigin,
  };
};
