"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createGraphOrchestration = function createGraphOrchestration(context = {}) {
  const {
    $,
    esc,
    state,
    readablePreview,
    agentRoleLabel,
    isLiveSession,
    isControlRoomSession = isLiveSession,
    graphPath,
    connectedGraphSessions,
    sortGraphNodes,
    stableSessionSort = sessions => [...sessions],
    runtimeAgentSummary,
    liveTmuxEntries,
    runtimeSeparatedOverview,
    focusedGraph,
    scheduleAgentWorkflowConnections,
    rememberDisclosureStates = () => {},
    restoreDisclosureStates = () => {},
  } = context;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);

  function renderAgentMap(sessions, motionKind = "refresh") {
    const liveSessionGrid = $("#liveSessionGrid");
    rememberDisclosureStates(liveSessionGrid);
    const model = connectedGraphSessions(sessions);
    const focus =
      state.graphFocusId && model.byId.get(state.graphFocusId) && model.included.has(state.graphFocusId) ? model.byId.get(state.graphFocusId) : null;
    if (state.graphFocusId && !focus) state.graphFocusId = null;
    const rootSessions = model.nodes.filter((session) => !session.parentId || !model.included.has(session.parentId));
    const roots = state.controlRoomSort === "tokens"
      ? [...rootSessions].sort((a, b) => Number((b.usage && b.usage.total) || 0) - Number((a.usage && a.usage.total) || 0))
      : state.controlRoomSort === "context"
        ? [...rootSessions].sort((a, b) => Number((b.context && b.context.percent) || 0) - Number((a.context && a.context.percent) || 0))
        : stableSessionSort(rootSessions);
    if (!model.nodes.length) {
      liveSessionGrid.innerHTML = "";
      $("#graphBreadcrumbs").innerHTML = "";
      $("#graphResetBtn").classList.add("hidden");
      $("#agentMapToolbar")?.classList.add("hidden");
      $("#controlRoomProjectToolbar")?.classList.remove("hidden");
      $("#controlRoomListToolbar")?.classList.remove("hidden");
      if ($("#controlRoomPageSummary")) $("#controlRoomPageSummary").textContent = t("control.page_summary", { start: 0, end: 0, total: 0 });
      if ($("#controlRoomPagePrev")) $("#controlRoomPagePrev").disabled = true;
      if ($("#controlRoomPageNext")) $("#controlRoomPageNext").disabled = true;
      return 0;
    }

    if (focus) {
      $("#agentMapToolbar")?.classList.remove("hidden");
      $("#controlRoomProjectToolbar")?.classList.add("hidden");
      $("#controlRoomListToolbar")?.classList.add("hidden");
      liveSessionGrid.innerHTML = focusedGraph(focus, model, motionKind);
      const path = graphPath(focus, model.byId);
      $("#graphBreadcrumbs").innerHTML = `<button type="button" data-graph-reset>${esc(t("graph.task_list"))}</button>${path
        .map((item) => {
          const label = item.parentId ? item.agentName || agentRoleLabel(item.agentRole) : item.title;
          const preview = readablePreview(label, item.parentId ? 42 : 72);
          return `<i>›</i>
          <button type="button" data-graph-focus="${esc(item.id)}"
            class="${item.id === focus.id ? "current" : ""}"
            title="${esc(preview.full)}">${esc(preview.text)}</button>`;
        })
        .join("")}`;
      $("#graphResetBtn").classList.remove("hidden");
      scheduleAgentWorkflowConnections();
    } else {
      const runtime = runtimeAgentSummary(model, liveTmuxEntries(state.snapshot && state.snapshot.tmux));
      const pageSize = Math.max(1, Number(state.controlRoomPageSize || 4));
      const maxPage = Math.max(0, Math.ceil(roots.length / pageSize) - 1);
      state.controlRoomPage = Math.min(maxPage, Math.max(0, Number(state.controlRoomPage || 0)));
      const startIndex = state.controlRoomPage * pageSize;
      const endIndex = Math.min(roots.length, startIndex + pageSize);
      const visibleRoots = roots.slice(startIndex, endIndex);
      liveSessionGrid.innerHTML = runtimeSeparatedOverview(visibleRoots, model, roots);
      restoreDisclosureStates(liveSessionGrid);
      $("#graphBreadcrumbs").innerHTML = "";
      $("#agentMapToolbar")?.classList.add("hidden");
      $("#controlRoomProjectToolbar")?.classList.remove("hidden");
      $("#controlRoomListToolbar")?.classList.remove("hidden");
      if ($("#controlRoomPageSummary")) $("#controlRoomPageSummary").textContent = t("control.page_summary", {
        start: roots.length ? startIndex + 1 : 0,
        end: endIndex,
        total: roots.length,
      });
      if ($("#controlRoomPagePrev")) $("#controlRoomPagePrev").disabled = state.controlRoomPage === 0;
      if ($("#controlRoomPageNext")) $("#controlRoomPageNext").disabled = state.controlRoomPage >= maxPage;
      $("#graphResetBtn").classList.add("hidden");
      return runtime.activeCount;
    }
    return model.nodes.filter(isControlRoomSession).length;
  }

  return { renderAgentMap };
};
