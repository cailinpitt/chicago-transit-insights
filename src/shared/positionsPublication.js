const Fs = require('node:fs');
const Path = require('node:path');
const Crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Writable } = require('node:stream');
const { sha256 } = require('./positionsParquet');
const { KINDS, MANIFEST_VERSION, buildIndex, verifiedDay } = require('./positionsArchive');

function readJson(path, fallback) {
  try {
    return JSON.parse(Fs.readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

function writeJson(path, value) {
  Fs.mkdirSync(Path.dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  Fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  Fs.renameSync(tmp, path);
}

function loadManifest(path) {
  const manifest = readJson(path);
  if (manifest.manifest_version !== MANIFEST_VERSION || !manifest.days)
    throw new Error('Legacy positions manifest: run npm run migrate-positions before exporting');
  return manifest;
}

function localPath(outDir, remotePath) {
  if (
    !remotePath.startsWith('positions/') ||
    remotePath.split('/').some((p) => p === '..') ||
    remotePath.includes('\\')
  )
    throw new Error(`Invalid archive path: ${remotePath}`);
  return Path.join(outDir, remotePath.slice('positions/'.length));
}

function assertLegacyPath(path) {
  if (!/^positions\/(bus|train|metra)\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.ndjson\.gz$/.test(path))
    throw new Error(`Refusing to retire a non-legacy path: ${path}`);
}

async function verifyLocal(path, file) {
  if (Fs.statSync(path).size !== file.bytes || (await sha256(path)) !== file.sha256)
    throw new Error(`Local checksum/size mismatch: ${path}`);
}

// Read remote bytes: multipart ETags are not SHA-256 checksums.
function rcloneStore(remote) {
  const target = (path) => `${remote}/${path}`;
  return {
    async upload(local, path, contentType, immutable = true) {
      execFileSync(
        'rclone',
        [
          'copyto',
          local,
          target(path),
          '--s3-no-check-bucket',
          // R2 501s rclone's post-upload versioned HEAD; verify() re-hashes remote bytes instead.
          '--s3-no-head',
          '--ignore-times',
          '--header-upload',
          `Content-Type: ${contentType}`,
          '--header-upload',
          `Cache-Control: public, max-age=${immutable ? '31536000, immutable' : '300'}`,
        ],
        { stdio: 'pipe' },
      );
    },
    async verify(path, file) {
      const hash = Crypto.createHash('sha256');
      let bytes = 0;
      const child = spawn('rclone', ['cat', target(path)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-4096);
      });
      const done = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`rclone cat failed (${code}): ${stderr}`)),
        );
      });
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback();
        },
      });
      await Promise.all([done, pipeline(child.stdout, sink)]);
      if (bytes !== file.bytes || hash.digest('hex') !== file.sha256)
        throw new Error(`Remote checksum/size mismatch: ${path}`);
    },
    async readJson(path) {
      return JSON.parse(
        execFileSync('rclone', ['cat', target(path)], { maxBuffer: 32 * 1024 * 1024 }),
      );
    },
    async download(path, local) {
      Fs.mkdirSync(Path.dirname(local), { recursive: true });
      execFileSync('rclone', ['copyto', target(path), local], { stdio: 'pipe' });
    },
    async remove(path) {
      assertLegacyPath(path);
      // Exact root-anchored filter; no matches is success on a crash/retry.
      execFileSync(
        'rclone',
        [
          'delete',
          target(Path.posix.dirname(path)),
          '--include',
          `/${Path.posix.basename(path)}`,
          '--max-depth',
          '1',
        ],
        { stdio: 'pipe' },
      );
    },
  };
}

// The local adapter follows the same object-store contract as R2. It lets an
// operator rehearse the complete migration against a downloaded archive, with
// the publication pointer confined to a local directory.
function fileStore(root) {
  const pathFor = (path) => localPath(Path.join(root, 'positions'), path);
  return {
    async upload(local, path) {
      const target = pathFor(path);
      Fs.mkdirSync(Path.dirname(target), { recursive: true });
      Fs.copyFileSync(local, target);
    },
    async verify(path, file) {
      await verifyLocal(pathFor(path), file);
    },
    async readJson(path) {
      return readJson(pathFor(path));
    },
    async download(path, local) {
      Fs.mkdirSync(Path.dirname(local), { recursive: true });
      Fs.copyFileSync(pathFor(path), local);
    },
    async remove(path) {
      assertLegacyPath(path);
      Fs.rmSync(pathFor(path), { force: true });
    },
  };
}

async function uploadDay(entry, outDir, store) {
  entry.verified = false;
  entry.committed = false;
  for (const kind of KINDS) {
    const file = entry.files[kind];
    const local = localPath(outDir, file.path);
    await verifyLocal(local, file);
    await store.upload(local, file.path, 'application/vnd.apache.parquet');
    await store.verify(file.path, file);
  }
  entry.verified = true;
}

async function publishIndex(manifest, outDir, store, save, now = Date.now(), previous = null) {
  const index = buildIndex(manifest, now, previous);
  const staging = Path.join(outDir, 'manifest.partial.json');
  writeJson(staging, index);
  const hash = await sha256(staging);
  const path = `positions/manifests/${hash}.json`;
  const file = { path, sha256: hash, bytes: Fs.statSync(staging).size };
  const local = localPath(outDir, path);
  Fs.mkdirSync(Path.dirname(local), { recursive: true });
  Fs.renameSync(staging, local);
  await store.upload(local, path, 'application/json');
  await store.verify(path, file);

  // Updating the latest pointer is the commit point. Retry even if there are
  // no new days after a failed publication.
  const pointer = { manifest_version: MANIFEST_VERSION, ...file };
  const pointerPath = Path.join(outDir, 'index.json');
  writeJson(pointerPath, pointer);
  await store.upload(pointerPath, 'positions/index.json', 'application/json', false);
  await store.verify('positions/index.json', {
    sha256: await sha256(pointerPath),
    bytes: Fs.statSync(pointerPath).size,
  });
  manifest.published = file;
  for (const entry of Object.values(manifest.days)) {
    if (verifiedDay(entry)) entry.committed = true;
  }
  save(manifest);
  return index;
}

async function withLock(path, action) {
  Fs.mkdirSync(Path.dirname(path), { recursive: true });
  const fd = Fs.openSync(path, 'wx');
  try {
    Fs.writeFileSync(fd, `${process.pid}\n`);
    return await action();
  } finally {
    Fs.closeSync(fd);
    Fs.unlinkSync(path);
  }
}

module.exports = {
  readJson,
  writeJson,
  loadManifest,
  localPath,
  verifyLocal,
  rcloneStore,
  fileStore,
  uploadDay,
  publishIndex,
  withLock,
};
