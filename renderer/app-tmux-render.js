"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createTmuxRenderer = function createTmuxRenderer(context = {}) {
  const { $, esc, state, compact, providerInfo, providerStyle } = context;

  function tmuxEntities(tmux) {
    const distros = new Map();
    const sessions = new Map();
    const windows = new Map();
    const panes = new Map();
    for (const distro of (tmux && tmux.distros) || []) {
      distros.set(distro.id, distro);
      for (const tmuxSession of distro.sessions || []) {
        sessions.set(tmuxSession.id, { item: tmuxSession, distro });
        for (const window of tmuxSession.windows || []) {
          windows.set(window.id, { item: window, session: tmuxSession, distro });
          for (const pane of window.panes || []) panes.set(pane.id, { item: pane, window, session: tmuxSession, distro });
        }
      }
    }
    return { distros, sessions, windows, panes };
  }

  function tmuxFocusPath(index) {
    const focus = state.tmuxFocus;
    if (!focus) return [];
    if (focus.type === "distro") {
      const distro = index.distros.get(focus.id);
      return distro ? [{ type: "distro", id: distro.id, label: distro.name }] : [];
    }
    if (focus.type === "session") {
      const found = index.sessions.get(focus.id);
      return found
        ? [
            { type: "distro", id: found.distro.id, label: found.distro.name },
            { type: "session", id: found.item.id, label: found.item.name },
          ]
        : [];
    }
    if (focus.type === "window") {
      const found = index.windows.get(focus.id);
      return found
        ? [
            { type: "distro", id: found.distro.id, label: found.distro.name },
            { type: "session", id: found.session.id, label: found.session.name },
            { type: "window", id: found.item.id, label: `${found.item.index}:${found.item.name}` },
          ]
        : [];
    }
    const found = index.panes.get(focus.id);
    return found
      ? [
          { type: "distro", id: found.distro.id, label: found.distro.name },
          { type: "session", id: found.session.id, label: found.session.name },
          { type: "window", id: found.window.id, label: `${found.window.index}:${found.window.name}` },
          { type: "pane", id: found.item.id, label: `pane ${found.item.index}` },
        ]
      : [];
  }

  function tmuxPaneCard(pane) {
    const agent = pane.agent;
    const provider = agent && providerInfo(agent.provider);
    const context = (agent && agent.context) || {};
    const usage = (agent && agent.usage) || {};
    const percent = Math.max(0, Math.min(100, Number(context.percent || 0)));
    return `<article class="tmux-pane-node ${pane.active ? "active" : ""} ${pane.dead ? "dead" : ""} ${agent ? "has-agent" : ""}"
      ${agent ? `style="${providerStyle(agent.provider)}"` : ""}>
      <button type="button" class="tmux-pane-main" data-tmux-type="pane" data-tmux-id="${esc(pane.id)}">
        <span class="tmux-pane-head">
          <b>나눠진 칸 ${pane.index + 1}</b><span>프로그램 ${pane.pid || "--"}</span>
          <i>${pane.dead ? "끝남" : pane.active ? "사용 중" : "뒤에서 실행"}</i>
        </span>
        <strong class="tmux-pane-command">${esc(pane.command || "shell")}</strong>
        <span class="tmux-pane-cwd" title="${esc(pane.cwd)}">${esc(pane.cwd || "경로 미보고")}</span>
        ${
          agent
            ? `<span class="tmux-agent-block">
          <span class="provider-mark">${esc(provider.mark)}</span>
          <span>
          <small>${esc(provider.label)} · 실행 번호 ${agent.pid}</small>
          <strong>${esc(agent.title)}</strong>
          <em>${esc(agent.statusDetail)}</em>
          </span>
          </span>
          <span class="tmux-agent-metrics">
            <span>
            <small>기억 사용</small>
            <b>${context.window ? `${percent.toFixed(1)}%` : "--"}</b>
            </span>
            <span>
            <small>${window.LoadToAgentI18n.t("ui.tokens_used_2")}</small>
            <b>${compact(usage.total)}</b>
            </span>
            <span>
            <small>도움 AI</small>
            <b>${(agent.childIds || []).length}</b>
            </span>
            </span>
          <span class="tmux-context-track"><i style="width:${percent}%"></i></span>`
            : '<span class="tmux-shell-note">AI가 아닌 일반 명령창입니다.</span>'
        }
      </button>
      <footer>
        <span>${agent ? (agent.linkedSessionId ? "대화 기록과 연결됨" : "AI가 실행 중인 것을 확인함") : pane.title || "명령창"}</span>
        <span class="tmux-pane-actions">
        <button type="button" data-control-tmux="${esc(pane.id)}">이 칸 조작하기 ↓</button>
        ${agent && agent.linkedSessionId ? `<button type="button" data-open-session="${esc(agent.linkedSessionId)}">대화 내용 보기 ↗</button>` : ""}
        </span>
        </footer>
    </article>`;
  }

  function tmuxWindowTree(window) {
    return `<div class="tmux-window-tree">
      <button type="button" class="tmux-window-node ${window.active ? "active" : ""}" data-tmux-type="window" data-tmux-id="${esc(window.id)}">
      <small>열린 창</small>
      <strong>${window.index + 1}. ${esc(window.name)}</strong>
      <span>${window.panes.length}개 칸으로 나눔</span>
      </button>
      <div class="tmux-link-line" aria-hidden="true">
      <i>
      </i>
      </div>
      <div class="tmux-pane-stack">${window.panes.map(tmuxPaneCard).join("")}</div>
      </div>`;
  }

  function tmuxSessionTree(tmuxSession) {
    return `<div class="tmux-session-tree">
      <button type="button" class="tmux-session-node ${tmuxSession.attached ? "attached" : ""}" data-tmux-type="session" data-tmux-id="${esc(tmuxSession.id)}">
      <small>작업 묶음</small>
      <strong>${esc(tmuxSession.name)}</strong>
      <span>${tmuxSession.attached ? "화면에 연결됨" : "뒤에서 실행 중"} · 열린 창 ${tmuxSession.windows.length}개</span>
      </button>
      <div class="tmux-link-line session-link" aria-hidden="true">
      <i>
      </i>
      </div>
      <div class="tmux-window-stack">${tmuxSession.windows.map(tmuxWindowTree).join("")}</div>
      </div>`;
  }

  function filteredTmuxDistros(tmux, index) {
    if (!state.tmuxFocus) return tmux.distros || [];
    const path = tmuxFocusPath(index);
    if (!path.length) {
      state.tmuxFocus = null;
      return tmux.distros || [];
    }
    const distroId = path[0].id;
    return (tmux.distros || [])
      .filter((distro) => distro.id === distroId)
      .map((distro) => ({
        ...distro,
        sessions: (distro.sessions || [])
          .filter((tmuxSession) => {
            const target = path.find((item) => item.type === "session");
            return !target || tmuxSession.id === target.id;
          })
          .map((tmuxSession) => ({
            ...tmuxSession,
            windows: (tmuxSession.windows || [])
              .filter((window) => {
                const target = path.find((item) => item.type === "window");
                return !target || window.id === target.id;
              })
              .map((window) => ({
                ...window,
                panes: (window.panes || []).filter((pane) => {
                  const target = path.find((item) => item.type === "pane");
                  return !target || pane.id === target.id;
                }),
              })),
          })),
      }));
  }

  function renderTmuxMap() {
    const tmux = (state.snapshot && state.snapshot.tmux) || { available: false, status: "확인 중", distros: [], summary: {} };
    const summary = tmux.summary || {};
    $("#tmuxStats").innerHTML = [
      ["Linux 환경", summary.distros || 0, window.LoadToAgentI18n.t("ui.items")],
      ["작업 묶음", summary.sessions || 0, window.LoadToAgentI18n.t("ui.items")],
      ["열린 창", summary.windows || 0, window.LoadToAgentI18n.t("ui.items")],
      ["나눠진 칸", summary.panes || 0, window.LoadToAgentI18n.t("ui.items")],
      ["AI가 일하는 칸", summary.aiPanes || 0, window.LoadToAgentI18n.t("ui.items")],
      ["대화 기록 연결", summary.linked || 0, window.LoadToAgentI18n.t("ui.items")],
    ]
      .map(
        ([label, value, unit], index) => `<div class="${index >= 4 ? "accent" : ""}">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${unit}</small>
      </div>`,
      )
      .join("");
    const index = tmuxEntities(tmux);
    const path = tmuxFocusPath(index);
    $("#tmuxBreadcrumbs").innerHTML = path.length
      ? `<button type="button" data-tmux-reset>전체 목록</button>${path
          .map(
            (item) => `<i>›</i>
      <button type="button"
        class="${item.type === state.tmuxFocus.type && item.id === state.tmuxFocus.id ? "current" : ""}"
        data-tmux-type="${item.type}" data-tmux-id="${esc(item.id)}">
        ${esc(item.label)}
      </button>`,
          )
          .join("")}`
      : `<span class="map-hint">
      <b>${summary.sessions || 0}</b>개 작업 묶음 · <b>${summary.aiPanes || 0}</b>개 칸에서 AI가 일하는 중</span>`;
    $("#tmuxResetBtn").classList.toggle("hidden", !path.length);
    const distros = filteredTmuxDistros(tmux, index);
    if (!distros.length || !Number(summary.sessions || 0)) {
      $("#tmuxMap").innerHTML = `<div class="tmux-empty">
        <span>▦</span>
        <h3>나눠서 실행 중인 명령창이 없습니다</h3>
        <p>${esc(tmux.status || "Linux 명령창 상태를 확인하는 중입니다.")}</p>
        <small>이 화면은 tmux를 사용하는 고급 작업이 있을 때 자동으로 채워집니다.</small>
        </div>`;
      return;
    }
    $("#tmuxMap").innerHTML = distros
      .map(
        (distro) => `<section class="tmux-distro-group">
      <button type="button" class="tmux-distro-node" data-tmux-type="distro" data-tmux-id="${esc(distro.id)}">
      <span>Linux</span>
      <div>
      <small>실행 환경</small>
      <strong>${esc(distro.name)}</strong>
      <em>${esc(distro.tmuxVersion || "tmux")}</em>
      </div>
      <b>작업 묶음 ${distro.sessions.length}개</b>
      </button>
      <div class="tmux-distro-line" aria-hidden="true">
      </div>
      <div class="tmux-session-stack">${distro.sessions.map(tmuxSessionTree).join("")}</div>
      </section>`,
      )
      .join("");
  }

  return { tmuxEntities, tmuxFocusPath, tmuxPaneCard, tmuxWindowTree, tmuxSessionTree, filteredTmuxDistros, renderTmuxMap };
};
