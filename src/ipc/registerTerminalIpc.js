'use strict';

function registerTerminalIpc({ ipcMain, requireTrustedSender, trustedSender, manager, listWslDistros, sendError }) {
  ipcMain.handle('terminals:list', event => {
    requireTrustedSender(event);
    return manager() ? manager().list() : [];
  });
  ipcMain.handle('wsl:list-distros', event => {
    requireTrustedSender(event);
    return listWslDistros();
  });
  ipcMain.handle('terminals:get', (event, id) => {
    requireTrustedSender(event);
    return manager() ? manager().get(id, true) : null;
  });
  ipcMain.handle('terminals:create', (event, options) => {
    requireTrustedSender(event);
    return requireManager(manager).create(options || {});
  });
  ipcMain.on('terminals:write', (event, id, data) => {
    if (!trustedSender(event) || !manager()) return;
    try { manager().write(id, data); } catch (error) { sendError({ id: String(id || ''), message: error.message }); }
  });
  ipcMain.handle('terminals:command', (event, id, command) => {
    requireTrustedSender(event);
    return requireManager(manager).command(id, command);
  });
  ipcMain.on('terminals:resize', (event, id, cols, rows) => {
    if (!trustedSender(event) || !manager()) return;
    try {
      manager().resize(id, cols, rows);
    } catch (error) {
      sendError({ id: String(id || ''), message: error.message });
    }
  });
  for (const operation of ['signal', 'restart', 'close']) {
    ipcMain.handle(`terminals:${operation}`, (event, ...args) => {
      requireTrustedSender(event);
      return requireManager(manager)[operation](...args);
    });
  }
}

function requireManager(getManager) {
  const terminalManager = getManager();
  if (!terminalManager) throw new Error('터미널 관리자가 준비되지 않았습니다.');
  return terminalManager;
}

module.exports = { registerTerminalIpc };
