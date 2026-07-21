'use strict';

const assert = require('assert');
const { enrichSession } = require('../../src/sessionIntelligence');

function registerSessionIntelligenceTests(context) {
  const { test } = context;

  test('세션 관리 인텔리전스가 주의·진행·건강·근거·결과를 함께 계산한다', () => {
    const now = Date.parse('2026-07-21T04:20:00.000Z');
    const waiting = {
      id: 'child', provider: 'codex', parentId: 'missing-parent', status: 'waiting', statusObserved: false,
      updatedAt: '2026-07-21T04:00:00.000Z', statusDetail: '권한 승인과 선택이 필요합니다.',
      externalId: 'thread-1', cwd: 'D:\\project', title: '결제 검토', context: { percent: 82 },
      messages: [{ role: 'assistant', text: '배포 방식을 선택해 주세요?', timestamp: '2026-07-21T04:00:00.000Z' }],
      lifecycle: [
        { id: 'a', label: '분석 완료', status: 'done', timestamp: '2026-07-21T03:58:00.000Z' },
        { id: 'b', label: '테스트 실패', status: 'failed', timestamp: '2026-07-21T03:59:00.000Z' },
      ],
    };
    const result = enrichSession(waiting, [waiting], now);
    assert.equal(result.attention.required, true);
    assert.equal(result.attention.kind, 'approval');
    assert.equal(result.progress.totalSteps, 2);
    assert.equal(result.progress.completedSteps, 1);
    assert.equal(result.progress.failedSteps, 1);
    assert.equal(result.progress.blocker.includes('선택'), true);
    assert.equal(result.health.level, 'warning');
    assert.equal(result.health.signals.some(signal => signal.code === 'orphan-agent'), true);
    assert.equal(result.health.signals.some(signal => signal.code === 'context-warning'), true);
    assert.equal(result.evidence.status, 'inferred');
    assert.equal(result.controlCapabilities.respond, true);
    assert.equal(result.controlCapabilities.sendInstruction, true);
    assert.equal(result.controlCapabilities.reassign, true);

    const recovering = enrichSession({
      ...waiting, id: 'recovering', parentId: null, status: 'running', runId: 'run-recovering',
      statusObserved: true, statusDetail: '테스트 실패를 확인했고 자동으로 수정하는 중',
    }, [], now);
    assert.equal(recovering.attention.required, false);
  });

  test('완료 세션은 산출물·검증 이벤트·제어 가능 범위를 보존한다', () => {
    const session = {
      id: 'managed', runId: 'run-1', provider: 'claude', status: 'completed', statusObserved: true,
      completionObserved: true, updatedAt: '2026-07-21T04:00:00.000Z', cwd: '/work/project', title: '완료 작업',
      result: 'src/payment.js를 수정하고 tests/payment.test.js 검증을 완료했습니다. commit abcdef1234567',
      messages: [],
      lifecycle: [{ id: 'test', label: '결제 테스트', status: 'done', timestamp: '2026-07-21T04:00:00.000Z' }],
    };
    const result = enrichSession(session, [session], Date.parse('2026-07-21T04:01:00.000Z'));
    assert.equal(result.progress.percent, 100);
    assert.equal(result.outcome.verified, true);
    assert.equal(result.outcome.artifacts.some(item => item.kind === 'file' && item.value.includes('src/payment.js')), true);
    assert.equal(result.outcome.artifacts.some(item => item.kind === 'test'), true);
    assert.equal(result.outcome.artifacts.some(item => item.kind === 'commit'), true);
    assert.equal(result.outcome.checks[0].status, 'passed');
    assert.equal(result.controlCapabilities.stop, false);
  });

  test('장시간 신호가 없는 관리 실행은 정체 상태와 제어 기능을 노출한다', () => {
    const session = {
      id: 'running', runId: 'run-2', provider: 'codex', status: 'running', statusObserved: true,
      updatedAt: '2026-07-21T03:00:00.000Z', cwd: '/work/project', title: '긴 작업', messages: [], lifecycle: [],
    };
    const result = enrichSession(session, [session], Date.parse('2026-07-21T03:11:00.000Z'));
    assert.equal(result.health.level, 'critical');
    assert.equal(result.health.signals.some(signal => signal.code === 'stalled'), true);
    assert.equal(result.controlCapabilities.stop, true);
    assert.equal(result.controlCapabilities.pause, true);
  });
}

module.exports = { registerSessionIntelligenceTests };
