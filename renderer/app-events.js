"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createEventBindings = function createEventBindings(context = {}) {
  const { bindNavigationAndUpdateEvents, bindSessionAndAgentEvents, bindFilterAndWorkspaceEvents, bindDialogAndGlobalEvents } = context;

  function bindEvents() {
    bindNavigationAndUpdateEvents();
    bindSessionAndAgentEvents();
    bindFilterAndWorkspaceEvents();
    bindDialogAndGlobalEvents();
  }

  return { bindEvents };
};
