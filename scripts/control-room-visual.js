'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-control-room-'));
app.setPath('userData', userData);
app.once('quit', () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(win, expression, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await wait(60);
  }
  throw new Error(message);
}

async function capture(win, outputDir, name) {
  await win.webContents.executeJavaScript(`document.fonts.ready.then(() => true)`);
  win.webContents.invalidate();
  await wait(180);
  const output = path.join(outputDir, name);
  fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
  return output;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    show: true,
    backgroundColor: '#08111b',
    webPreferences: {
      preload: path.join(__dirname, 'interaction-fixture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await waitFor(
      win,
      `Boolean(window.LoadToAgentApp?.state?.snapshot && document.querySelector('[data-control-room-overview]'))`,
      '세션 관제 홈이 준비되지 않았습니다.',
    );
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentI18n.setLocale('ko');
      const control = window.LoadToAgentApp;
      control.state.guideExpanded = false;
      control.state.search = '';
      control.state.workspace = 'all';
      control.state.provider = 'all';
      control.state.providerFilters.clear();
      window.interactionTest.setSessionRuntimePresence('fixture-child', [{ kind: 'terminal', terminalId: 'terminal-race-a', pid: 41003, label: 'subagent fixture terminal' }]);
      const child = control.state.snapshot.sessions.find(session => session.id === 'fixture-child');
      child.runtimePresence = [{ kind: 'terminal', terminalId: 'terminal-race-a', pid: 41003, label: 'subagent fixture terminal' }];
      control.state.agentCommandRoutes.set('fixture-child', 'parent');
      control.selectView('all');
      document.querySelector('#beginnerGuide')?.classList.add('hidden');
      document.querySelector('.main-stage')?.scrollTo(0, 0);
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    await wait(180);

    const overviewMetrics = await win.webContents.executeJavaScript(`(() => {
      const stage = document.querySelector('.main-stage');
      const section = document.querySelector('#liveSection');
      const root = document.querySelector('[data-control-session="fixture-root"]');
      return {
        attentionVisible: !document.querySelector('#operationsOverview')?.classList.contains('hidden'),
        attentionCount: Number(document.querySelector('[data-home-attention]')?.dataset.homeAttention || 0),
        controlRooms: document.querySelectorAll('[data-control-session]').length,
        rootVisible: Boolean(root),
        mainNode: Boolean(root?.querySelector('.control-room-main')),
        helperNodes: root?.querySelectorAll('.helper-node').length || 0,
        executionNodes: root?.querySelectorAll('.execution-node').length || 0,
        completedNodes: root?.querySelectorAll('.completed-list .control-room-node').length || 0,
        mainLeakedIntoWorkColumns: Boolean(root?.querySelector('.activity-column .control-room-main, .activity-column .direct-work, .completed-column .control-room-main, .completed-column .direct-work')),
        invalidRunningUnits: [...(root?.querySelectorAll('.activity-column .control-room-node:not(.overflow-node)') || [])]
          .filter(node => !node.matches('.helper-node, .execution-node')).length,
        invalidCompletedUnits: [...(root?.querySelectorAll('.completed-list .control-room-node') || [])]
          .filter(node => !node.matches('.helper-node, .execution-node')).length,
        emptyRunningColumns: document.querySelectorAll('.activity-column .control-room-running-empty').length,
        executionTypeLabels: [...(root?.querySelectorAll('.execution-node .control-node-copy > small') || [])].map(node => node.textContent.trim()),
        mainOwnerLabelsHidden: ![...(root?.querySelectorAll('.activity-column .control-node-copy > small, .completed-column .control-node-copy > small') || [])]
          .some(node => /^메인\s/.test(node.textContent.trim())),
        runtimeTooltips: [...(root?.querySelectorAll('.execution-node .control-node-copy > small') || [])].map(node => node.title),
        mainSummary: root?.querySelector('.control-room-main')?.dataset.controlSummary || '',
        helperSummaries: [...(root?.querySelectorAll('.helper-node') || [])].map(node => node.dataset.controlSummary || ''),
        executionSummaries: [...(root?.querySelectorAll('.execution-node') || [])].map(node => node.dataset.controlSummary || ''),
        executionTargets: [...(root?.querySelectorAll('.execution-node') || [])].map(node => ({ owner: node.dataset.openExecutionOwner || '', execution: node.dataset.openExecutionId || '', opensSession: node.hasAttribute('data-open-session') })),
        humanColumnLabels: [...(root?.querySelectorAll('.control-column-label') || [])].map(node => node.textContent.trim()),
        rawBackgroundLabelsHidden: ![...(root?.querySelectorAll('.execution-node .control-node-copy > b') || [])].some(node => /^(?:Background|Windows 명령창|백그라운드 작업)$/.test(node.textContent.trim())),
        noSectionOverflow: section.scrollWidth <= section.clientWidth + 2,
        noStageOverflow: stage.scrollWidth <= stage.clientWidth + 2,
        sessionRecords: document.querySelectorAll('#sessionGrid .session-record').length,
        semanticSamples: {
          copy: window.LoadToAgentApp.controlRoomSummary('메인이랑 서브 에이전트 그리고 실행중인 세션 문구를 사람이 알아보기 좋게 요약해줘', 64).text,
          loop: window.LoadToAgentApp.controlRoomSummary('/' + ['w', 'c', 'c'].join('') + '-loop --tick v18-seo-blog', 64).text,
          phase: window.LoadToAgentApp.controlRoomSummary('Now I understand the full phase-cycle-complete contract and requirements updated guard.', 64).text,
        },
      };
    })()`);
    if (!overviewMetrics.attentionVisible || overviewMetrics.attentionCount < 1 || overviewMetrics.controlRooms < 1
      || !overviewMetrics.rootVisible || !overviewMetrics.mainNode || overviewMetrics.helperNodes < 1
      || overviewMetrics.executionNodes < 1 || overviewMetrics.completedNodes < 1
      || overviewMetrics.mainLeakedIntoWorkColumns || overviewMetrics.invalidRunningUnits || overviewMetrics.invalidCompletedUnits
      || overviewMetrics.emptyRunningColumns < 1
      || !overviewMetrics.mainOwnerLabelsHidden || !overviewMetrics.executionTypeLabels.some(label => label.startsWith('PowerShell ·'))
      || overviewMetrics.runtimeTooltips.length !== overviewMetrics.executionNodes || overviewMetrics.runtimeTooltips.some(value => !value)
      || !overviewMetrics.mainSummary || overviewMetrics.helperSummaries.some(summary => !summary)
      || overviewMetrics.executionSummaries.some(summary => !summary) || !overviewMetrics.rawBackgroundLabelsHidden
      || overviewMetrics.executionTargets.some(target => !target.owner || !target.execution || target.opensSession)
      || !overviewMetrics.humanColumnLabels.some(label => label.includes('지금 실행 중인 작업'))
      || overviewMetrics.semanticSamples.copy !== '에이전트·실행 작업의 요약 문구 개선'
      || overviewMetrics.semanticSamples.loop !== 'v18-seo-blog 자동 작업 실행'
      || overviewMetrics.semanticSamples.phase !== '요구사항과 단계 완료 조건 확인'
      || !overviewMetrics.noSectionOverflow || !overviewMetrics.noStageOverflow || overviewMetrics.sessionRecords < 1) {
      throw new Error(`세션 관제 홈 검증 실패: ${JSON.stringify(overviewMetrics)}`);
    }

    const outputDir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(outputDir, { recursive: true });
    const overviewOutput = await capture(win, outputDir, 'loadtoagent-control-room.png');

    await win.webContents.executeJavaScript(`document.querySelector('[data-open-subagent-chat="fixture-child"]')?.click()`);
    await waitFor(
      win,
      `document.querySelector('#detailDrawer')?.classList.contains('open')
        && document.querySelector('#detailDrawer')?.dataset.mode === 'subagent'
        && Boolean(document.querySelector('.subagent-assignment-card'))
        && Boolean(document.querySelector('#drawerComposer .agent-command-panel'))`,
      '서브에이전트 대화와 참여 입력창이 열리지 않았습니다.',
    );

    const drawerMetrics = await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('#detailDrawer');
      const assignment = drawer.querySelector('.subagent-assignment-card')?.innerText || '';
      const routes = [...drawer.querySelectorAll('[data-agent-command-route]')];
      const child = window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-child');
      return {
        mode: drawer.dataset.mode,
        assignmentVisible: assignment.includes('메인 에이전트가 시킨 일') && assignment.includes('클릭 없이'),
        conversationMessages: drawer.querySelectorAll('.chat-row').length,
        routes: routes.map(route => ({ route: route.dataset.agentCommandRoute, disabled: route.disabled })),
        directSelected: drawer.querySelector('[data-agent-command-route="direct"]')?.getAttribute('aria-pressed') === 'true',
        composerVisible: !document.querySelector('#drawerComposer')?.classList.contains('hidden'),
        targetAvailable: !drawer.querySelector('[data-agent-command-form="fixture-child"] button[type="submit"]')?.disabled,
        runtimePresence: child?.runtimePresence || [],
        directTargets: window.LoadToAgentTerminal?.agentTargets(child) || [],
        scope: drawer.querySelector('[data-conversation-scope]')?.dataset.conversationScope || '',
        childWorkVisible: drawer.innerText.includes('실행 구조, 대화 기록, 직접 개입'),
        parentConversationHidden: !drawer.innerText.includes('상호작용 테스트를 진행해줘') && !drawer.innerText.includes('버튼과 입력 동작을 확인하고 있습니다.'),
        noDrawerOverflow: drawer.scrollWidth <= drawer.clientWidth + 2,
      };
    })()`);
    if (drawerMetrics.mode !== 'subagent' || !drawerMetrics.assignmentVisible || drawerMetrics.conversationMessages < 1
      || drawerMetrics.routes.length !== 2 || drawerMetrics.routes.some(route => route.disabled)
      || !drawerMetrics.directSelected || !drawerMetrics.composerVisible || !drawerMetrics.targetAvailable
      || drawerMetrics.scope !== 'subagent-only' || !drawerMetrics.childWorkVisible || !drawerMetrics.parentConversationHidden || !drawerMetrics.noDrawerOverflow) {
      throw new Error(`서브에이전트 대화 참여 검증 실패: ${JSON.stringify(drawerMetrics)}`);
    }

    await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.clearCalls();
      const input = document.querySelector('#drawerComposer [data-agent-command-draft]');
      input.value = '서브에이전트에게만 직접 전달할 메시지';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.closest('form').requestSubmit();
    })()`);
    await waitFor(
      win,
      `window.interactionTest.getCalls().some(call => call.name === 'terminalCommand'
        && call.args[0] === 'terminal-race-a'
        && call.args[1] === '서브에이전트에게만 직접 전달할 메시지')`,
      '서브에이전트 직접 지시가 해당 서브에이전트 입력 채널로 전달되지 않았습니다.',
    );
    const directRouteMetrics = await win.webContents.executeJavaScript(`(() => {
      const calls = window.interactionTest.getCalls().filter(call => call.name === 'terminalCommand');
      return {
        childCalls: calls.filter(call => call.args[0] === 'terminal-race-a').length,
        parentCalls: calls.filter(call => call.args[0] === 'terminal-main').length,
        selectedRoute: document.querySelector('#detailDrawer [data-agent-command-route][aria-pressed="true"]')?.dataset.agentCommandRoute || '',
      };
    })()`);
    if (directRouteMetrics.childCalls !== 1 || directRouteMetrics.parentCalls !== 0 || directRouteMetrics.selectedRoute !== 'direct') {
      throw new Error(`서브에이전트 직접 전달 경로 검증 실패: ${JSON.stringify(directRouteMetrics)}`);
    }

    await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.clearCalls();
      const route = document.querySelector('#detailDrawer [data-agent-command-route="parent"]');
      route.click();
      const input = document.querySelector('#drawerComposer [data-agent-command-draft]');
      input.value = '현재 검토에서 가장 큰 가독성 문제를 먼저 보고해줘.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.closest('form').requestSubmit();
    })()`);
    await waitFor(
      win,
      `window.interactionTest.getCalls().some(call => call.name === 'terminalCommand'
        && call.args[0] === 'terminal-main'
        && call.args[1].includes('현재 검토에서 가장 큰 가독성 문제'))`,
      '메인 에이전트 경유 지시가 실제 메인 세션 입력 대상으로 전달되지 않았습니다.',
    );
    const routeCall = await win.webContents.executeJavaScript(`window.interactionTest.getCalls().find(call => call.name === 'terminalCommand' && call.args[0] === 'terminal-main')`);
    if (!String(routeCall?.args?.[1] || '').includes('서브에이전트')) {
      throw new Error(`메인 경유 지시에 대상 서브에이전트 맥락이 없습니다: ${JSON.stringify(routeCall)}`);
    }

    await wait(180);
    const drawerOutput = await capture(win, outputDir, 'loadtoagent-control-room-subagent.png');

    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#closeDrawerBtn')?.click();
      document.querySelector('[data-open-execution-id="fixture-shell-running"]')?.click();
    })()`);
    await waitFor(
      win,
      `document.querySelector('#detailDrawer')?.classList.contains('open')
        && document.querySelector('#detailDrawer')?.dataset.mode === 'execution'
        && window.LoadToAgentApp.state.drawerExecutionId === 'fixture-shell-running'
        && Boolean(document.querySelector('[data-execution-detail="fixture-shell-running"]'))`,
      'PowerShell 실행 전용 상세 화면이 열리지 않았습니다.',
    );
    const executionMetrics = await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('#detailDrawer');
      const text = drawer?.innerText || '';
      return {
        mode: drawer?.dataset.mode || '',
        scope: drawer?.querySelector('[data-conversation-scope]')?.dataset.conversationScope || '',
        tabLabel: drawer?.querySelector('.drawer-tab:not(.hidden)')?.textContent.trim() || '',
        visibleTabs: drawer?.querySelectorAll('.drawer-tab:not(.hidden)').length || 0,
        commandVisible: text.includes('npm run dev'),
        outputVisible: text.includes('개발 서버가 http://localhost:4173 에서 실행 중입니다.'),
        purposeVisible: text.includes('개발 서버 실행'),
        parentConversationHidden: !text.includes('상호작용 테스트를 진행해줘') && !text.includes('버튼과 입력 동작을 확인하고 있습니다.'),
        composerHidden: document.querySelector('#drawerComposer')?.classList.contains('hidden'),
        noDrawerOverflow: drawer.scrollWidth <= drawer.clientWidth + 2,
      };
    })()`);
    if (executionMetrics.mode !== 'execution' || executionMetrics.scope !== 'execution-only'
      || executionMetrics.tabLabel !== '실행 과정' || executionMetrics.visibleTabs !== 1
      || !executionMetrics.commandVisible || !executionMetrics.outputVisible || !executionMetrics.purposeVisible
      || !executionMetrics.parentConversationHidden || !executionMetrics.composerHidden || !executionMetrics.noDrawerOverflow) {
      throw new Error(`실행 단위 상세 분리 검증 실패: ${JSON.stringify(executionMetrics)}`);
    }
    const executionOutput = await capture(win, outputDir, 'loadtoagent-control-room-execution.png');

    win.setContentSize(390, 844);
    await wait(260);
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#closeDrawerBtn')?.click();
      document.querySelector('#toast')?.classList.add('hidden');
      document.querySelector('.main-stage')?.scrollTo(0, 0);
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    const mobileMetrics = await win.webContents.executeJavaScript(`(() => {
      const stage = document.querySelector('.main-stage');
      const overview = document.querySelector('[data-control-room-overview]');
      return {
        width: innerWidth,
        overviewVisible: Boolean(overview),
        flowColumns: getComputedStyle(document.querySelector('.control-room-flow')).gridTemplateColumns,
        noOverviewOverflow: overview.scrollWidth <= overview.clientWidth + 2,
        noStageOverflow: stage.scrollWidth <= stage.clientWidth + 2,
        attentionVisible: Boolean(document.querySelector('[data-home-attention]')),
      };
    })()`);
    if (!mobileMetrics.overviewVisible || !mobileMetrics.noOverviewOverflow || !mobileMetrics.noStageOverflow || !mobileMetrics.attentionVisible) {
      throw new Error(`모바일 세션 관제 검증 실패: ${JSON.stringify(mobileMetrics)}`);
    }
    const mobileOutput = await capture(win, outputDir, 'loadtoagent-control-room-mobile.png');

    process.stdout.write(`세션 관제 시각·상호작용 검증 통과\n${JSON.stringify({ overviewMetrics, drawerMetrics, executionMetrics, mobileMetrics }, null, 2)}\n${overviewOutput}\n${drawerOutput}\n${executionOutput}\n${mobileOutput}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
