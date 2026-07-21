'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-readability-'));
app.setPath('userData', userData);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function forceRepaint(win) {
  const [width, height] = win.getContentSize();
  win.setContentSize(width + 1, height);
  await wait(90);
  win.setContentSize(width, height);
  await wait(220);
}

async function waitFor(win, expression, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await wait(100);
  }
  throw new Error(`화면 준비를 기다리는 중 시간 초과: ${expression}`);
}

async function capture(win, outputDir, name, repaint = false) {
  if (repaint) await forceRepaint(win);
  await win.webContents.executeJavaScript(`document.fonts.ready.then(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } return true; })`);
  win.webContents.invalidate();
  await wait(300);
  const image = await win.webContents.capturePage();
  const [contentWidth, contentHeight] = win.getContentSize();
  const captured = image.getSize();
  if (Math.abs(captured.width - contentWidth) > 2 || Math.abs(captured.height - contentHeight) > 2) {
    throw new Error(`캡처 크기가 현재 창과 다릅니다: ${name} ${captured.width}×${captured.height} / ${contentWidth}×${contentHeight}`);
  }
  fs.writeFileSync(path.join(outputDir, name), image.toPNG());
}

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const win = new BrowserWindow({
      x: 24,
      y: 24,
      width: 1440,
      height: 980,
      show: true,
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, 'interaction-fixture-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await waitFor(win, `Boolean(window.LoadToAgentApp?.state?.snapshot?.sessions?.length && document.querySelector('#operationsOverview')?.innerText)`);
    win.setContentSize(1440, 980);
    await wait(260);
    const outputDir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(outputDir, { recursive: true });

    await win.webContents.executeJavaScript(`(async () => {
      const bootstrap = await window.loadtoagent.bootstrap();
      const app = window.LoadToAgentApp;
      app.state.providers = bootstrap.providers;
      app.state.availability = bootstrap.availability;
      app.state.workspaces = bootstrap.workspaces;
      app.state.rawSnapshot = bootstrap.snapshot;
      app.state.snapshot = bootstrap.snapshot;
      app.state.hiddenProviders.clear();
      window.LoadToAgentI18n.setLocale('ko');
      app.state.view = 'all';
      app.state.workspace = 'all';
      app.state.graphFocusId = null;
      app.syncViewChrome();
      app.render('view');
      document.querySelector('#beginnerGuide')?.classList.add('hidden');
      const stage = document.querySelector('.main-stage');
      const target = document.querySelector('#operationsOverview');
      if (stage && target) stage.scrollTop = Math.max(0, target.offsetTop - 18);
      return true;
    })()`);
    await waitFor(win, `!document.querySelector('#operationsOverview')?.classList.contains('hidden') && document.querySelector('#operationsOverview')?.innerText.includes('확인이 필요한 신호')`);
    // Chromium can return a stale first frame for a newly shown BrowserWindow.
    // Prime the compositor once so the checked artifact always reflects the DOM.
    await win.webContents.capturePage();
    await wait(300);
    await capture(win, outputDir, 'loadtoagent-readability-overview.png', true);

    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentApp.state.graphFocusId = null;
      window.LoadToAgentApp.renderSessions('view');
      document.querySelector('[data-graph-focus="fixture-root"]')?.click();
      return true;
    })()`);
    await waitFor(win, `Boolean(document.querySelector('.execution-activity-panel') && document.querySelector('[data-execution-mode="foreground"]'))`);
    await forceRepaint(win);
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentApp.closeDrawer(false);
      document.querySelector('#mainContent')?.focus({ preventScroll: true });
      const foreground = document.querySelector('[data-execution-mode="foreground"]');
      if (foreground) foreground.open = true;
      const stage = document.querySelector('.main-stage');
      const panel = document.querySelector('.execution-activity-panel');
      if (stage && panel) stage.scrollTop = Math.max(0, panel.offsetTop - 90);
      return true;
    })()`);
    await waitFor(win, `!document.querySelector('#detailDrawer')?.classList.contains('open')
      && document.querySelector('#detailDrawer')?.getAttribute('aria-hidden') === 'true'
      && document.querySelector('#detailDrawer')?.inert
      && document.querySelector('#drawerBackdrop')?.classList.contains('hidden')
      && !document.querySelector('#appShell')?.inert
      && !document.body.classList.contains('dialog-open')`);
    // Recreate the native compositor surface after removing the backdrop-filter
    // layer; capturePage can otherwise retain the closed drawer's dimmed frame.
    win.hide();
    await wait(100);
    win.show();
    win.focus();
    await wait(260);
    await waitFor(win, `(() => { const detail = document.querySelector('[data-execution-mode="foreground"]'); if (!detail) return false; detail.open = true; return detail.querySelector('.execution-detail-output pre')?.textContent.includes('128개 테스트 통과'); })()`);
    await win.webContents.executeJavaScript(`(() => {
      const detail = document.querySelector('[data-execution-mode="foreground"]');
      const stage = document.querySelector('.main-stage');
      if (detail && stage) {
        detail.open = true;
        const detailRect = detail.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        stage.scrollTop += detailRect.top - stageRect.top - 72;
      }
      return true;
    })()`);
    await waitFor(win, `(() => { const detail = document.querySelector('[data-execution-mode="foreground"]'); const rect = detail?.getBoundingClientRect(); return Boolean(detail?.open && rect && rect.top >= 0 && rect.top < innerHeight * .5); })()`);
    await capture(win, outputDir, 'loadtoagent-execution-activity.png', true);

    win.setContentSize(360, 620);
    await wait(250);
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentApp.state.view = 'all';
      window.LoadToAgentApp.state.graphFocusId = null;
      window.LoadToAgentApp.syncViewChrome();
      window.LoadToAgentApp.renderSessions('view');
      document.querySelector('#beginnerGuide')?.classList.add('hidden');
      document.querySelector('#mobileMoreBtn')?.click();
      const picker = document.querySelector('.mobile-project-picker');
      if (picker) picker.open = true;
      return true;
    })()`);
    await waitFor(win, `!document.querySelector('#mobileToolsMenu')?.classList.contains('hidden') && document.querySelector('.mobile-project-picker')?.open && document.querySelector('#mobileWorkspaceList [aria-pressed="true"]')`);
    await capture(win, outputDir, 'loadtoagent-responsive-projects-360.png');

    process.stdout.write('readability visual check passed\n');
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  } finally {
    app.exit(exitCode);
  }
}).catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});

app.on('quit', () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});
