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
    graphPath,
    connectedGraphSessions,
    sortGraphNodes,
    runtimeAgentSummary,
    liveTmuxEntries,
    runtimeSeparatedOverview,
    focusedGraph,
    scheduleAgentWorkflowConnections,
  } = context;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);

  function renderAgentMap(sessions, motionKind = "refresh") {
    const model = connectedGraphSessions(sessions);
    const focus =
      state.graphFocusId && model.byId.get(state.graphFocusId) && model.included.has(state.graphFocusId) ? model.byId.get(state.graphFocusId) : null;
    if (state.graphFocusId && !focus) state.graphFocusId = null;
    const roots = sortGraphNodes(model.nodes.filter((session) => !session.parentId || !model.included.has(session.parentId)));
    if (!model.nodes.length) {
      $("#liveSessionGrid").innerHTML = "";
      $("#graphBreadcrumbs").innerHTML = "";
      $("#graphResetBtn").classList.add("hidden");
      return 0;
    }

    if (focus) {
      $("#liveSessionGrid").innerHTML = focusedGraph(focus, model, motionKind);
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
      $("#liveSessionGrid").innerHTML = runtimeSeparatedOverview(roots, model);
      $("#graphBreadcrumbs").innerHTML = `<span class="control-room-legend">
        <span><i class="spawn"></i>${esc(t("control.legend_spawn"))}</span>
        <span><i class="running"></i>${esc(t("control.legend_running"))}</span>
        <span><i class="done"></i>${esc(t("control.legend_completed"))}</span>
        <b>${esc(t("control.live_summary", { sessions: runtime.rootCount, helpers: runtime.activeHelperCount, executions: runtime.runningExecutionCount }))}</b>
      </span>`;
      $("#graphResetBtn").classList.add("hidden");
      return runtime.activeCount;
    }
    return model.nodes.filter(isLiveSession).length;
  }

  return { renderAgentMap };
};
