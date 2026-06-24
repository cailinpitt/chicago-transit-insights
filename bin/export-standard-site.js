#!/usr/bin/env node
// Export the standard.site manifest for the public web data payload.
//
// The frontend (cta-alert-history) reads this at build time to inject the
// per-event `<link rel="site.standard.document">` / `site.standard.publication`
// tags and to write /.well-known/site.standard.publication. It carries only
// AT-URIs (page-side verification needs no cids); the post-side associatedRefs
// are attached at post time from local state, not from here.
//
// Source of truth is the local state file written by src/shared/standardSite.js
// as records are published (live + backfill).

require('../src/shared/env');

const Fs = require('node:fs');
const Path = require('node:path');
const { loadState, documentUri } = require('../src/shared/standardSite');

// No `generated_at`: the manifest must be byte-stable across runs when nothing
// changed, so push-web-data.sh's cmp check doesn't trigger a needless rebuild.
// Document keys are emitted sorted for the same reason.
function buildManifest() {
  const state = loadState();
  const documents = {};
  const did = state.publication?.did;
  for (const rkey of Object.keys(state.documents || {}).sort()) {
    const entry = state.documents[rkey];
    const entryDid = entry?.did || did;
    if (!entryDid || !entry?.cid) continue;
    documents[rkey] = documentUri(entryDid, rkey);
  }
  return {
    publication: state.publication?.uri || null,
    documents,
  };
}

function writeOutput(out, outputPath) {
  const json = `${JSON.stringify(out)}\n`;
  if (!outputPath) {
    process.stdout.write(json);
    return;
  }
  Fs.mkdirSync(Path.dirname(outputPath), { recursive: true });
  Fs.writeFileSync(outputPath, json, 'utf8');
  console.error(
    `export-standard-site: wrote ${Object.keys(out.documents).length} documents to ${outputPath}`,
  );
}

function main() {
  writeOutput(buildManifest(), process.argv[2]);
}

if (require.main === module) main();

module.exports = { buildManifest };
