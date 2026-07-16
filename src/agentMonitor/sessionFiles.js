'use strict';

const fs = require('fs');
const path = require('path');

const MAX_FILES_PER_PROVIDER = 80;
const MAX_JSONL_BYTES = 12 * 1024 * 1024;

function safeStat(file) {
  try { return fs.statSync(file); } catch (_missingOrUnreadableFile) { return null; }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_missingOrPartialJson) { return fallback; }
}

function parseJsonText(text) {
  try { return JSON.parse(text); } catch (_plainTextPayload) { return null; }
}

function readJsonLines(file, maxBytes = MAX_JSONL_BYTES) {
  const stat = safeStat(file);
  if (!stat || !stat.isFile()) return { rows: [], truncated: false };
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(length);
  let headerLine = '';
  try {
    fs.readSync(fd, buffer, 0, length, start);
    if (start > 0) {
      const headLength = Math.min(stat.size, 2 * 1024 * 1024);
      const head = Buffer.alloc(headLength);
      fs.readSync(fd, head, 0, headLength, 0);
      const newline = head.indexOf(10);
      if (newline >= 0) {
        headerLine = head.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString('utf8');
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline >= 0 ? text.slice(newline + 1) : '';
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = parseJsonText(line);
    if (row) rows.push(row);
  }
  if (headerLine) {
    const header = parseJsonText(headerLine);
    if (header && header.type === 'session_meta') rows.unshift(header);
  }
  return { rows, truncated: start > 0 };
}

function walkRecent(root, predicate, max = MAX_FILES_PER_PROVIDER, maxDepth = 6) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_unreadableDirectory) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      if (!entry.isFile() || !predicate(full, entry.name)) continue;
      const stat = safeStat(full);
      if (stat) out.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max);
}

module.exports = {
  MAX_FILES_PER_PROVIDER,
  readJson,
  readJsonLines,
  safeStat,
  walkRecent,
};
