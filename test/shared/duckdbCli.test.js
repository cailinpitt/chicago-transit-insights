const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { checkDuckDb, runDuckDb } = require('../../src/shared/duckdbCli');

function fakeCli(t, body) {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'duckdb-cli-test-'));
  t.after(() => Fs.rmSync(root, { recursive: true, force: true }));
  // Spaces and shell punctuation are a literal executable path.
  const bin = Path.join(root, 'duckdb cli; literal');
  Fs.writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return bin;
}

const version = `if (process.argv.includes('--version')) { console.log('v2.0.0 (Cyanoptera) test'); process.exit(0); }`;

test('missing CLI reports the server setup and configured executable', async () => {
  await assert.rejects(
    checkDuckDb({ bin: '/nonexistent/positions-duckdb' }),
    /not found.*POSITIONS_DUCKDB_BIN/,
  );
});

for (const found of ['v1.4.5', 'v2.0.0-dev88614']) {
  test(`rejects unpinned DuckDB ${found}`, async (t) => {
    const bin = fakeCli(t, `console.log('${found} test');`);
    await assert.rejects(checkDuckDb({ bin }), /v2.0.0 is required/);
  });
}

test('CLI invocation disables startup files, agent output and extension downloads', async (t) => {
  const bin = fakeCli(
    t,
    `${version}
    const assert = require('node:assert/strict');
    for (const arg of ['-no-init','-no-agent','-batch','-bail','-json']) assert.ok(process.argv.includes(arg));
    const sql = process.argv[process.argv.indexOf('-c') + 1];
    assert.ok(sql.includes('SET autoinstall_known_extensions = false'));
    assert.ok(sql.includes('SET autoload_known_extensions = false'));
    console.log('[{"answer":42}]');`,
  );
  assert.deepEqual(await runDuckDb('SELECT 42 AS answer;', { bin }), [{ answer: 42 }]);
});

test('nonzero CLI exit preserves the diagnostic and fails the operation', async (t) => {
  const bin = fakeCli(t, `${version} console.error('intentional failure'); process.exit(23);`);
  await assert.rejects(runDuckDb('SELECT 1;', { bin }), /failed \(23\).*intentional failure/);
});

test('CLI timeout terminates the child and fails the operation', async (t) => {
  const bin = fakeCli(t, `${version} setTimeout(() => {}, 10000);`);
  await assert.rejects(runDuckDb('SELECT 1;', { bin, timeoutMs: 200 }), /timed out/);
});

test('invalid CLI JSON cannot masquerade as a successful validation', async (t) => {
  const bin = fakeCli(t, `${version} console.log('not JSON');`);
  await assert.rejects(runDuckDb('SELECT 1;', { bin }), SyntaxError);
});

test('invalid timeout fails before starting a child', async () => {
  await assert.rejects(checkDuckDb({ timeoutMs: 0 }), /positive integer/);
});
