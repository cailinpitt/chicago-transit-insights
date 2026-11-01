const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const DUCKDB_VERSION = 'v2.0.0';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Values only; SQL identifiers come from the fixed positions schema.
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;

function settings(options) {
  const timeoutMs = Number(
    options.timeoutMs ?? process.env.POSITIONS_DUCKDB_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error('POSITIONS_DUCKDB_TIMEOUT_MS must be a positive integer');
  return {
    bin: options.bin || process.env.POSITIONS_DUCKDB_BIN || 'duckdb',
    timeoutMs,
  };
}

async function execute(args, options) {
  const { bin, timeoutMs } = settings(options);
  try {
    const { stdout } = await exec(bin, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(
        `DuckDB CLI ${DUCKDB_VERSION} not found at ${bin}. Set POSITIONS_DUCKDB_BIN; see docs/POSITIONS.md#server-setup.`,
        { cause: error },
      );
    const reason = error.killed
      ? 'timed out or exceeded its output limit'
      : `failed (${error.code ?? error.signal})`;
    throw new Error(`DuckDB CLI ${reason}: ${(error.stderr || error.message).slice(-4096)}`, {
      cause: error,
    });
  }
}

async function checkDuckDb(options = {}) {
  const output = await execute(['-no-init', '-no-agent', '--version'], options);
  const version = output.trim().split(/\s+/)[0];
  if (version !== DUCKDB_VERSION)
    throw new Error(
      `DuckDB CLI ${DUCKDB_VERSION} is required; found ${version}. See docs/POSITIONS.md#server-setup.`,
    );
  return version;
}

// SQL must end with one finite-valued JSON result set (or return no rows).
// No shell, user startup files, interactive output or extension downloads.
async function runDuckDb(sql, options = {}) {
  await checkDuckDb(options);
  const setup = [
    'SET threads = 1',
    `SET memory_limit = ${sqlString(options.memoryLimit || process.env.POSITIONS_MEMORY_LIMIT || '256MB')}`,
    'SET enable_progress_bar = false',
    'SET autoinstall_known_extensions = false',
    'SET autoload_known_extensions = false',
    ...(options.tempDirectory ? [`SET temp_directory = ${sqlString(options.tempDirectory)}`] : []),
  ].join(';\n');
  const stdout = await execute(
    [
      '-no-init',
      '-no-agent',
      '-batch',
      '-bail',
      '-json',
      options.database || ':memory:',
      '-c',
      `${setup};\n${sql}`,
    ],
    options,
  );
  return stdout.trim() ? JSON.parse(stdout) : [];
}

module.exports = { DUCKDB_VERSION, checkDuckDb, runDuckDb, sqlString };
