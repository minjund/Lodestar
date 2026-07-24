'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function registerTerminalAgentActionTests(context) {
  const { test, root } = context;

  test('대화창 Enter 전송은 숨겨진 일회성 프로세스 대신 지속형 관리 터미널을 만든다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    let launchOptions = null;
    let launchArgsCall = null;
    let workbenchOpened = false;
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            launchOptions = options;
            return {
              id: 'terminal:managed-resume',
              type: 'agent',
              provider: options.provider,
              status: 'running',
              pid: 4242,
              title: options.title,
            };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      $: () => null,
      state: {
        snapshot: null,
        sessions: [],
        platform: { id: 'win32' },
        wslDistros: [],
      },
      init: async () => {},
      notice: () => {},
      moveWorkbench: () => { workbenchOpened = true; },
      selectTmux: async () => {},
      selectSession: async () => {},
      bindAgent: () => {},
      queueHistoryRefresh: () => {},
      renderTarget: () => {},
      fitEntry: () => {},
      refreshSessions: async () => {},
      resumeSupport: () => ({
        supported: true,
        provider: 'claude',
        sessionId: 'session-123',
        args: ['--resume', 'session-123'],
      }),
      resumeLaunchArgs: (support, prompt, options) => {
        launchArgsCall = { support, prompt, options };
        return [...support.args, prompt];
      },
      preferredWorkspace: () => 'D:\\workspace',
      providerLabel: provider => provider,
      esc: value => String(value),
    });

    const result = await actions.resumeForAgent({
      id: 'claude:session-123',
      provider: 'claude',
      externalId: 'session-123',
      cwd: 'D:\\workspace',
      runtimePresence: [],
    }, '? 안되는데?', true, { focus: false });

    assert.deepStrictEqual(launchArgsCall.options, undefined);
    assert.equal(launchArgsCall.prompt, '? 안되는데?');
    assert.equal(launchOptions.transient, false);
    assert.deepStrictEqual(Array.from(launchOptions.args), ['--resume', 'session-123', '? 안되는데?']);
    assert.equal(result.background, true);
    assert.equal(result.promptSent, true);
    assert.equal(workbenchOpened, false, '백그라운드 전송은 터미널 화면을 강제로 열지 않아야 합니다.');
  });
}

module.exports = { registerTerminalAgentActionTests };
