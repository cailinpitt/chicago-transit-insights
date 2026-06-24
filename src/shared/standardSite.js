// standard.site (https://standard.site) record publishing for the CTA/Metra
// archive.
//
// standard.site is a set of AT Protocol lexicons for long-form publishing. When
// a web page can be tied back to a `site.standard.publication` + a
// `site.standard.document` record on the publisher's repo, Bluesky upgrades the
// generic link card to an *enhanced* card (publication name, attribution,
// reading time). Two independent paths earn the upgrade and we use both:
//
//   - Post-side: the alerts bot attaches `associatedRefs` (the document +
//     publication strong refs) to the `app.bsky.embed.external` it already posts
//     for resolved-event archive links. Helps the bot's own posts immediately;
//     no page/path match required.
//   - Page-side: each event page declares the records via `<link>` tags and the
//     site serves /.well-known/site.standard.publication. Helps *anyone* who
//     shares an event permalink. The frontend reads the manifest this module's
//     state feeds (see bin/export-standard-site.js).
//
// Records live on the ALERTS account's repo (it already posts the archive
// links). The publication uses a stable rkey ("self") so its at:// URI is
// deterministic; documents are keyed by the event's rkey — the same slug the
// website uses for /event/<rkey> — so the record path matches the page.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLICATION_RKEY = 'self';
const PUBLICATION_COLLECTION = 'site.standard.publication';
const DOCUMENT_COLLECTION = 'site.standard.document';

const SITE_BASE = 'https://chicagotransitalerts.app';
const PUBLICATION = {
  url: SITE_BASE,
  name: 'Chicago Transit Alerts',
  description:
    'CTA and Metra service alerts, independently detected disruptions, and reliability history.',
};

// Local state (server-side, gitignored alongside history.sqlite). Records which
// records we've published and at what content hash, so re-runs are idempotent
// and the manifest exporter knows which documents actually exist.
const STATE_PATH =
  process.env.STANDARD_SITE_STATE ||
  path.join(__dirname, '..', '..', 'state', 'standard-site.json');

function agentDid(agent) {
  const did = agent?.did || agent?.session?.did;
  if (!did) throw new Error('standardSite: agent has no DID (not logged in)');
  return did;
}

function publicationUri(did) {
  return `at://${did}/${PUBLICATION_COLLECTION}/${PUBLICATION_RKEY}`;
}

function documentUri(did, rkey) {
  return `at://${did}/${DOCUMENT_COLLECTION}/${rkey}`;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    return { publication: null, documents: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function hashRecord(record) {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 16);
}

// putRecord is create-or-replace at a caller-chosen rkey, so publishing is
// idempotent. We pass the record straight through: the AtpAgent client only
// validates collections in its own lexicon set, and site.standard.* is not one,
// so unknown fields/types survive — matching how other standard.site publishers
// create these records.
async function putRecord(agent, collection, rkey, record) {
  const res = await agent.com.atproto.repo.putRecord({
    repo: agentDid(agent),
    collection,
    rkey,
    record,
  });
  return { uri: res.data.uri, cid: res.data.cid };
}

// Create or refresh the single publication record (rkey "self"). Idempotent:
// skips the network write when the record content is unchanged. Returns
// { did, uri, cid }.
async function ensurePublication(agent) {
  const did = agentDid(agent);
  const record = { $type: PUBLICATION_COLLECTION, ...PUBLICATION };
  const hash = hashRecord(record);
  const state = loadState();
  const cached = state.publication;
  if (cached && cached.did === did && cached.hash === hash && cached.cid) {
    return { did, uri: cached.uri, cid: cached.cid };
  }
  const { uri, cid } = await putRecord(agent, PUBLICATION_COLLECTION, PUBLICATION_RKEY, record);
  state.publication = { did, uri, cid, hash };
  saveState(state);
  return { did, uri, cid };
}

// Create or refresh the document record for one event. `rkey` is the event slug
// (the Bluesky post rkey used for /event/<rkey>). `publishedAt`/`updatedAt` are
// epoch ms or ISO strings. Idempotent on unchanged content. Returns
// { uri, cid }.
async function ensureDocument(agent, { rkey, title, description, publishedAt, updatedAt }) {
  if (!rkey) throw new Error('standardSite.ensureDocument: rkey is required');
  const did = agentDid(agent);
  const record = {
    $type: DOCUMENT_COLLECTION,
    site: publicationUri(did),
    title: String(title || 'Service incident'),
    path: `/event/${rkey}`,
    publishedAt: toIso(publishedAt),
    ...(description ? { description: String(description) } : {}),
    ...(updatedAt ? { updatedAt: toIso(updatedAt) } : {}),
  };
  const hash = hashRecord(record);
  const state = loadState();
  const cached = state.documents?.[rkey];
  if (cached && cached.did === did && cached.hash === hash && cached.cid) {
    return { uri: documentUri(did, rkey), cid: cached.cid };
  }
  const { uri, cid } = await putRecord(agent, DOCUMENT_COLLECTION, rkey, record);
  if (!state.documents) state.documents = {};
  state.documents[rkey] = { did, cid, hash };
  saveState(state);
  return { uri, cid };
}

function toIso(value) {
  if (value == null) return new Date().toISOString();
  if (typeof value === 'number') {
    // Our epoch fields are a mix of ms (first_seen_ts) and seconds (GTFS-rt
    // onset_ts/resolved_ts). Any real ms timestamp is > 1e12 (post-2001), and any
    // seconds timestamp for the next few centuries is < 1e12, so a value below
    // the threshold is seconds and needs ×1000 — otherwise it lands in 1970.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return new Date(value).toISOString();
}

// Convenience for the alert-posting bins: ensure the publication + the event's
// document record exist, then return the `associatedRefs` for the external
// embed. Best-effort — any failure degrades to a plain card (returns null)
// rather than blocking the post. `fields` is { rkey, title, description,
// publishedAt, updatedAt }.
async function eventAssociatedRefs(agent, fields) {
  try {
    if (!fields?.rkey) return null;
    const { did } = await ensurePublication(agent);
    const doc = await ensureDocument(agent, fields);
    return buildAssociatedRefs(did, doc);
  } catch (e) {
    console.warn(`standard.site publish skipped for /event/${fields?.rkey}: ${e.message}`);
    return null;
  }
}

// The event slug from an archive link URL (https://…/event/<rkey>/resolved).
function rkeyFromEventUrl(url) {
  const m = /\/event\/([^/?#]+)/.exec(url || '');
  return m ? m[1] : null;
}

// Convenience for alert bins that already hold a resolvedEventLink `link`: the
// rkey/title/description come from the link itself, so every call site is just
// `eventAssociatedRefsForLink(agent, link)`. The live record is minimal; the
// periodic backfill (scripts/backfill-standard-site.js) enriches its title,
// description, and publishedAt from the full incident data.
async function eventAssociatedRefsForLink(agent, link) {
  return eventAssociatedRefs(agent, {
    rkey: rkeyFromEventUrl(link?.url),
    title: link?.title,
    description: link?.description,
  });
}

// Build the `associatedRefs` strong-ref array for an external embed: the
// document first, then the publication. Both need a cid (a strong ref is
// uri+cid). The publication cid is read from state, so ensurePublication must
// have run. Returns null if either ref is unavailable so the caller can post a
// plain card rather than fail.
function buildAssociatedRefs(did, document) {
  const state = loadState();
  const pub = state.publication;
  if (!document?.uri || !document?.cid || !pub?.uri || !pub?.cid || pub.did !== did) {
    return null;
  }
  return [
    { uri: document.uri, cid: document.cid },
    { uri: pub.uri, cid: pub.cid },
  ];
}

module.exports = {
  PUBLICATION,
  PUBLICATION_RKEY,
  PUBLICATION_COLLECTION,
  DOCUMENT_COLLECTION,
  SITE_BASE,
  STATE_PATH,
  publicationUri,
  documentUri,
  loadState,
  saveState,
  ensurePublication,
  ensureDocument,
  buildAssociatedRefs,
  eventAssociatedRefs,
  eventAssociatedRefsForLink,
  rkeyFromEventUrl,
};
