'use strict';

function registerWorkspaceIpc({ handleTrusted, list, add, remove, pick, openExternal, writeClipboard, bridgeCommand, openOrigin }) {
  handleTrusted('workspaces:list', list);
  handleTrusted('workspaces:add', add);
  handleTrusted('workspaces:remove', remove);
  handleTrusted('workspaces:pick', pick);
  handleTrusted('external:open', openExternal);
  handleTrusted('clipboard:write', writeClipboard);
  handleTrusted('bridge:command', bridgeCommand);
  handleTrusted('agents:open-origin', openOrigin);
}

module.exports = { registerWorkspaceIpc };
