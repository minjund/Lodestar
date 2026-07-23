"use strict";

const assert = require("assert");
const {
  CONFIRMATION_DELAY_MS,
  messageKey,
  deliveryState,
} = require("../../renderer/conversation-delivery");

function registerConversationDeliveryTests(context) {
  const { test } = context;

  test("대화 전송 상태는 요청·수신·실행·응답의 실제 관측 신호를 구분한다", () => {
    const sentAt = "2026-07-24T01:00:00.000Z";
    const oldMessages = [
      { id: "old-user", role: "user", text: "이전 요청", timestamp: "2026-07-24T00:59:00.000Z" },
      { id: "old-answer", role: "assistant", text: "이전 답변", timestamp: "2026-07-24T00:59:30.000Z" },
    ];
    const entry = {
      text: "새 요청",
      timestamp: sentAt,
      status: "sending",
      baselineMessageKeys: new Set(oldMessages.map(messageKey)),
    };
    const session = {
      status: "running",
      messages: oldMessages,
      lifecycle: [{ type: "turn-start", status: "running", timestamp: "2026-07-24T00:59:00.000Z" }],
    };

    assert.equal(deliveryState(session, entry, Date.parse(sentAt)).phase, "sending");

    entry.status = "awaiting";
    entry.dispatchedAt = sentAt;
    assert.equal(deliveryState(session, entry, Date.parse(sentAt) + 5_000).phase, "confirming");
    assert.equal(deliveryState(session, entry, Date.parse(sentAt) + CONFIRMATION_DELAY_MS).phase, "delayed");

    session.messages = [
      ...oldMessages,
      { id: "new-user", role: "user", text: "새 요청", timestamp: "2026-07-24T01:00:13.000Z" },
    ];
    assert.equal(deliveryState(session, entry, Date.parse(sentAt) + 13_000).phase, "received",
      "이전 턴의 실행 상태만으로 새 메시지에 응답 중이라고 표시하면 안 됩니다.");

    session.lifecycle.push({ type: "turn-start", status: "running", timestamp: "2026-07-24T01:00:14.000Z" });
    assert.equal(deliveryState(session, entry, Date.parse(sentAt) + 14_000).phase, "responding");

    session.messages.push({ id: "new-answer", role: "assistant", text: "응답 시작", timestamp: "2026-07-24T01:00:15.000Z" });
    assert.equal(deliveryState(session, entry, Date.parse(sentAt) + 15_000).phase, "responded");

    const failed = { ...entry, status: "failed" };
    assert.equal(deliveryState({ ...session, messages: oldMessages }, failed, Date.parse(sentAt) + 1_000).phase, "failed");
  });
}

module.exports = { registerConversationDeliveryTests };
