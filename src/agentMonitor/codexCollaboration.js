'use strict';

function createCodexCollaboration(session, dependencies) {
  const { compactText, timestamp } = dependencies;
  const calls = new Map();
  const spawns = new Map();
  const communications = [];

  function ensureSpawn(callId) {
    const key = String(callId || `spawn:${spawns.size}`);
    if (!spawns.has(key)) {
      spawns.set(key, {
        callId: key,
        taskName: '',
        agentPath: '',
        childId: '',
        assignment: '',
        assignmentObserved: false,
        assignmentProtected: false,
        assignmentSource: 'unavailable',
        sharedGoal: '',
        status: 'requested',
        startedAt: null,
        completedAt: null,
        result: '',
        agentName: '',
        currentlyRetained: false,
      });
    }
    return spawns.get(key);
  }

  function addCommunication(event) {
    const row = {
      id: String(event.id || `communication:${communications.length}`),
      kind: event.kind || 'message',
      label: compactText(event.label || '메시지', 100),
      from: compactText(event.from, 180),
      to: compactText(event.to, 180),
      taskName: compactText(event.taskName, 180),
      childId: compactText(event.childId, 180),
      text: compactText(event.text, 6000),
      protected: Boolean(event.protected),
      assignmentSource: compactText(event.assignmentSource, 80),
      timestamp: timestamp(event.timestamp, session.updatedAt),
    };
    if (!communications.some(item => item.id === row.id)) communications.push(row);
    return row;
  }

  function findSpawn({ childId, agentPath, taskName } = {}) {
    return [...spawns.values()].find(record => (childId && record.childId === childId)
      || (agentPath && record.agentPath === agentPath)
      || (taskName && record.taskName === taskName));
  }

  function linkCommunicationChildIds() {
    for (const record of spawns.values()) {
      for (const communication of communications) {
        if (communication.childId) continue;
        if ((record.agentPath && (communication.from === record.agentPath || communication.to === record.agentPath))
          || (record.taskName && communication.taskName === record.taskName)) {
          communication.childId = record.childId;
        }
      }
    }
  }

  function finalize(retainedAgents) {
    const retainedByTask = new Map((retainedAgents || []).map(agent => [agent.taskName, agent]));
    for (const record of spawns.values()) {
      const retained = retainedByTask.get(record.taskName);
      if (!retained) continue;
      record.currentlyRetained = true;
      record.agentName = retained.name || record.agentName;
    }
    linkCommunicationChildIds();
    return {
      spawns: [...spawns.values()].sort((a, b) => Date.parse(a.startedAt || 0) - Date.parse(b.startedAt || 0)),
      communications: communications.slice(-240),
    };
  }

  return {
    calls,
    spawns,
    communications,
    ensureSpawn,
    addCommunication,
    findSpawn,
    finalize,
  };
}

module.exports = { createCodexCollaboration };
