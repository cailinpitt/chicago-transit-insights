const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// STATE_PATH is resolved at module load, so point it at a temp file first.
const STATE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'std-site-')),
  'standard-site.json',
);
process.env.STANDARD_SITE_STATE = STATE_PATH;

const {
  ensurePublication,
  ensureDocument,
  buildAssociatedRefs,
  eventAssociatedRefsForLink,
  rkeyFromEventUrl,
  publicationUri,
  documentUri,
} = require('../src/shared/standardSite');

const DID = 'did:plc:ctaalerts';

function fakeAgent() {
  const writes = [];
  let n = 0;
  return {
    writes,
    did: DID,
    com: {
      atproto: {
        repo: {
          putRecord: async ({ repo, collection, rkey, record }) => {
            writes.push({ repo, collection, rkey, record });
            return { data: { uri: `at://${repo}/${collection}/${rkey}`, cid: `cid-${++n}` } };
          },
        },
      },
    },
  };
}

test('ensurePublication writes the self record once and is idempotent', async () => {
  const agent = fakeAgent();
  const a = await ensurePublication(agent);
  assert.equal(a.uri, publicationUri(DID));
  assert.equal(agent.writes.length, 1);
  assert.equal(agent.writes[0].rkey, 'self');
  assert.equal(agent.writes[0].record.url, 'https://chicagotransitalerts.app');

  await ensurePublication(agent);
  assert.equal(agent.writes.length, 1);
});

test('ensureDocument keys by event rkey and sets a matching path', async () => {
  const agent = fakeAgent();
  await ensurePublication(agent);
  const doc = await ensureDocument(agent, {
    rkey: '3moyslkcfq32v',
    title: 'MDN Train #2158 is on the move',
    publishedAt: 1700000000000,
  });
  assert.equal(doc.uri, documentUri(DID, '3moyslkcfq32v'));
  const write = agent.writes.find((w) => w.collection === 'site.standard.document');
  assert.equal(write.record.path, '/event/3moyslkcfq32v');
  assert.equal(write.record.site, publicationUri(DID));
});

test('ensureDocument normalizes a seconds-epoch publishedAt to ms (no 1970)', async () => {
  const agent = fakeAgent();
  await ensurePublication(agent);
  // GTFS-rt onset_ts is in seconds; treated as ms it would land in 1970.
  const seconds = 1782273600; // 2026-06-24T00:00:00Z
  await ensureDocument(agent, { rkey: 'secs-evt', title: 'X', publishedAt: seconds });
  const write = agent.writes.find((w) => w.rkey === 'secs-evt');
  assert.equal(write.record.publishedAt, new Date(seconds * 1000).toISOString());
  assert.equal(write.record.publishedAt.slice(0, 4), '2026');

  // A real ms timestamp passes through unchanged.
  const ms = 1782273600000;
  await ensureDocument(agent, { rkey: 'ms-evt', title: 'X', publishedAt: ms });
  const msWrite = agent.writes.find((w) => w.rkey === 'ms-evt');
  assert.equal(msWrite.record.publishedAt, new Date(ms).toISOString());
});

test('rkeyFromEventUrl extracts the slug from a resolved archive link', () => {
  assert.equal(
    rkeyFromEventUrl('https://chicagotransitalerts.app/event/3moyslkcfq32v/resolved'),
    '3moyslkcfq32v',
  );
  assert.equal(rkeyFromEventUrl(undefined), null);
});

test('eventAssociatedRefsForLink ensures records and returns [doc, pub] refs', async () => {
  const agent = fakeAgent();
  const refs = await eventAssociatedRefsForLink(agent, {
    url: 'https://chicagotransitalerts.app/event/abc123/resolved',
    title: 'Red Line delays',
    description: 'View this incident on the archive.',
  });
  assert.equal(refs.length, 2);
  assert.equal(refs[0].uri, documentUri(DID, 'abc123'));
  assert.ok(refs[0].cid && refs[1].cid);
  assert.equal(refs[1].uri, publicationUri(DID));
});

test('buildAssociatedRefs is null when publication is unpublished', () => {
  assert.equal(buildAssociatedRefs('did:plc:other', { uri: 'at://x', cid: 'c' }), null);
});
