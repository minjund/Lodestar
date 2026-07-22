'use strict';

const assert = require('assert');
const fs = require('fs');
const { ensureMacNodePtyRuntime } = require('../src/nodePtyRuntime');

if (process.platform !== 'darwin') {
  console.log('macOS PTY 누수 테스트 건너뜀: darwin에서만 실행됩니다.');
  process.exit(0);
}

const pty = require('node-pty');
const iterations = 160;
const descriptorCount = () => fs.readdirSync('/dev/fd').length;

function spawnOnce() {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = pty.spawn('/bin/zsh', ['-lc', 'true'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.onExit(resolve);
  });
}

(async () => {
  const runtime = ensureMacNodePtyRuntime();
  const start = descriptorCount();
  let peak = start;
  for (let index = 0; index < iterations; index += 1) {
    await spawnOnce();
    peak = Math.max(peak, descriptorCount());
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  const end = descriptorCount();
  assert.ok(end - start <= 4, `macOS PTY 파일 디스크립터 누수: ${start} -> ${end} (peak ${peak})`);
  console.log(`✓ macOS ${process.arch} PTY ${iterations}회 생성: FD ${start} -> ${end} (peak ${peak}), helper ${runtime.repaired ? '복구됨' : '정상'}`);
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
