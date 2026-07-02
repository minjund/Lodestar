'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lodestar', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  addProjects: () => ipcRenderer.invoke('projects:add'),
  removeProject: (p) => ipcRenderer.invoke('projects:remove', p),
  scan: () => ipcRenderer.invoke('projects:scan'),
  previewInject: (opts) => ipcRenderer.invoke('inject:preview', opts),
  runInject: (opts) => ipcRenderer.invoke('inject:run', opts),
  onInjectProgress: (cb) => {
    const handler = (_e, chunk) => cb(chunk);
    ipcRenderer.on('inject:progress', handler);
    return () => ipcRenderer.removeListener('inject:progress', handler);
  },
  agentDetail: (opts) => ipcRenderer.invoke('agent:detail', opts),
  sessionDetail: (opts) => ipcRenderer.invoke('session:detail', opts),
  previewTask: (opts) => ipcRenderer.invoke('task:preview', opts),
  runTask: (opts) => ipcRenderer.invoke('task:run', opts),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  getTask: (id) => ipcRenderer.invoke('tasks:get', id),
  stopTask: (id) => ipcRenderer.invoke('tasks:stop', id),
  openTaskWindow: (payload) => ipcRenderer.invoke('task-window:open', payload),
  taskWindowInit: (id) => ipcRenderer.invoke('task-window:init', id),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  listCommands: (opts) => ipcRenderer.invoke('commands:list', opts),
  listGitRefs: (projectPath) => ipcRenderer.invoke('git:refs', projectPath),
  switchGitRef: (projectPath, ref) => ipcRenderer.invoke('git:switch', { projectPath, ref }),
  createGitBranch: (projectPath, ref) => ipcRenderer.invoke('git:create-branch', { projectPath, ref }),
  ensureBranchWorktree: (projectPath, ref) => ipcRenderer.invoke('git:ensure-branch-worktree', { projectPath, ref }),
  updateAttention: (payload) => ipcRenderer.invoke('attention:update', payload),
  onTaskProgress: (cb) => {
    const handler = (_e, chunk) => cb(chunk);
    ipcRenderer.on('task:progress', handler);
    return () => ipcRenderer.removeListener('task:progress', handler);
  },
  onProjectsChanged: (cb) => {
    const handler = (_e, reason) => cb(reason);
    ipcRenderer.on('projects:changed', handler);
    return () => ipcRenderer.removeListener('projects:changed', handler);
  },
});
