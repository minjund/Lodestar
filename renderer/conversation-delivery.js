"use strict";

(function exposeConversationDelivery(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LoadToAgentConversationDelivery = api;
})(typeof window === "object" ? window : null, function createConversationDelivery() {
  const CONFIRMATION_DELAY_MS = 12_000;

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function messageKey(message) {
    const id = String(message?.id || "").trim();
    if (id) return `id:${id}`;
    return `${message?.role || ""}:${normalizedText(message?.text)}:${message?.timestamp || ""}`;
  }

  function newMessagesForEntry(session, entry) {
    const baseline = entry?.baselineMessageKeys instanceof Set
      ? entry.baselineMessageKeys
      : new Set(entry?.baselineMessageKeys || []);
    return (session?.messages || []).filter(message => !baseline.has(messageKey(message)));
  }

  function deliveryState(session, entry, now = Date.now()) {
    if (!entry) return null;
    const newMessages = newMessagesForEntry(session, entry);
    const expectedText = normalizedText(entry.text);
    const userMessage = newMessages.find(message =>
      message?.role === "user" && normalizedText(message.text) === expectedText) || null;
    const assistantMessage = newMessages.find(message =>
      message?.role === "assistant" && normalizedText(message.text)) || null;
    const dispatchedAt = Date.parse(entry.dispatchedAt || entry.timestamp || 0);
    const elapsedMs = Number.isFinite(dispatchedAt) ? Math.max(0, Number(now) - dispatchedAt) : 0;
    const userObservedAt = Date.parse(userMessage?.timestamp || 0);
    const responseStartEvent = userMessage
      ? (session?.lifecycle || []).find(event => {
        const eventAt = Date.parse(event?.timestamp || 0);
        return Number.isFinite(eventAt)
          && (!Number.isFinite(userObservedAt) || eventAt >= userObservedAt)
          && event?.status === "running"
          && /start|turn|run/i.test(String(event?.type || event?.label || ""));
      }) || null
      : null;

    let phase = "confirming";
    if (entry.status === "failed") phase = "failed";
    else if (assistantMessage) phase = "responded";
    else if (userMessage && responseStartEvent) phase = "responding";
    else if (userMessage) phase = "received";
    else if (entry.status === "sending") phase = "sending";
    else if (elapsedMs >= CONFIRMATION_DELAY_MS) phase = "delayed";

    return {
      phase,
      elapsedMs,
      userMessage,
      assistantMessage,
      responseStartEvent,
      receivedAt: userMessage?.timestamp || null,
      responseObservedAt: assistantMessage?.timestamp || responseStartEvent?.timestamp || null,
    };
  }

  return {
    CONFIRMATION_DELAY_MS,
    normalizedText,
    messageKey,
    newMessagesForEntry,
    deliveryState,
  };
});
