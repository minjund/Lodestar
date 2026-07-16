"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDrawerData = function createDrawerData(context = {}) {
  const { reportRecoverableError, state } = context;

  async function loadSessionDetail(id, force = false) {
    if (!force && state.details.has(id)) return state.details.get(id);
    state.detailErrors.delete(id);
    state.detailLoadingIds.add(id);
    context.renderDrawer();
    try {
      const detail = await window.loadtoagent.sessionDetail(id);
      if (detail) state.details.set(id, detail);
      return detail;
    } catch (error) {
      state.detailErrors.set(id, (error && error.message) || "작업 기록을 불러오지 못했습니다.");
      return null;
    } finally {
      state.detailLoadingIds.delete(id);
      if (state.selectedId === id) {
        state.drawerForceLatest = state.drawerTab === "chat";
        context.renderDrawer();
      }
    }
  }

  async function loadSubagentParentDetail(child) {
    if (!child || !child.parentId || state.details.has(child.parentId)) return;
    try {
      const detail = await window.loadtoagent.sessionDetail(child.parentId);
      if (detail) state.details.set(child.parentId, detail);
      if (state.drawerMode === "subagent" && state.selectedId === child.id) context.renderDrawer();
    } catch (error) {
      reportRecoverableError("subagent-parent-detail", error);
    }
  }

  return { loadSessionDetail, loadSubagentParentDetail };
};
