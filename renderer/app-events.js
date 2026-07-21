"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createEventBindings = function createEventBindings(context = {}) {
  const { bindNavigationAndUpdateEvents, bindSessionAndAgentEvents, bindFilterAndWorkspaceEvents, bindDialogAndGlobalEvents, bindQualityEvents = () => {} } = context;

  function bindEvents() {
    bindNavigationAndUpdateEvents();
    bindSessionAndAgentEvents();
    bindFilterAndWorkspaceEvents();
    bindDialogAndGlobalEvents();
    bindQualityEvents();
  }

  return { bindEvents };
};
