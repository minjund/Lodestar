'use strict';

function registerAgentIpc({ handleTrusted, snapshot, requestDetail, runner, probeProviders }) {
  handleTrusted('agents:snapshot', snapshot);
  handleTrusted('agents:detail', requestDetail);
  handleTrusted('agents:run', options => runner().start(options));
  handleTrusted('agents:stop', runId => runner().stop(runId));
  handleTrusted('agents:active-runs', () => runner().listActive());
  handleTrusted('providers:probe', probeProviders);
}

module.exports = { registerAgentIpc };
