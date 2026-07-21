'use strict';

/**
 * Small, dependency-free helpers shared by classic renderer scripts.
 * Keeping these on one frozen namespace avoids duplicate implementations
 * without introducing a bundler or changing Electron's preload boundary.
 */
window.LoadToAgentRendererUtils = Object.freeze({
  $: selector => document.querySelector(selector),
  $$: selector => [...document.querySelectorAll(selector)],
  esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  },
  uiLocale() {
    return window.LoadToAgentI18n?.getLocaleTag() || 'ko-KR';
  },
  providerLabel(provider) {
    return ({ claude: 'Claude', codex: 'GPT · Codex', gemini: 'Gemini', grok: 'Grok' })[provider] || 'AI';
  },
  preserveScrollPositions(targets) {
    const positions = (Array.isArray(targets) ? targets : [targets]).map(target => {
      const element = typeof target === 'string' ? document.querySelector(target) : target;
      return element ? { element, left: element.scrollLeft, top: element.scrollTop } : null;
    }).filter(Boolean);
    return () => {
      positions.forEach(({ element, left, top }) => {
        if (!element.isConnected) return;
        element.scrollLeft = left;
        element.scrollTop = top;
      });
    };
  },
  isScrolledToEnd(element, tolerance = 2) {
    if (!element) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight <= tolerance;
  },
  reportRecoverableError(operation, error) {
    const message = error && error.message ? error.message : String(error || 'unknown error');
    console.warn(`[LoadToAgent:${operation}] ${message}`);
  },
});
