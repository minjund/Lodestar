'use strict';

function createTestHarness({ stdout = process.stdout, stderr = process.stderr } = {}) {
  const tests = [];

  function test(name, run) {
    tests.push({ name, run });
  }

  async function run({ cleanup = () => {} } = {}) {
    let passed = 0;
    for (const testCase of tests) {
      try {
        await testCase.run();
        passed += 1;
        stdout.write(`✓ ${testCase.name}\n`);
      } catch (error) {
        stderr.write(`✗ ${testCase.name}\n${error.stack}\n`);
        process.exitCode = 1;
      }
    }

    try {
      cleanup();
    } catch {}

    if (!process.exitCode) stdout.write(`\n${passed}개 회귀 테스트 통과\n`);
    return { passed, total: tests.length };
  }

  return { test, run, count: () => tests.length };
}

module.exports = { createTestHarness };
