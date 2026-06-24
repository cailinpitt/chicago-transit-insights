# standard.site (enhanced Bluesky link cards)

[standard.site](https://standard.site) is a set of AT Protocol lexicons for
publishing. When a web page can be tied back to a `site.standard.publication`
plus a `site.standard.document` record on the publisher's repo, Bluesky upgrades
the generic link card to an **enhanced card** (publication name, attribution,
reading time). We publish those records for the CTA/Metra archive so links to
`chicagotransitalerts.app` — both the bot's own posts and anyone else's shares —
render as first-class cards.

Records live on the **ALERTS** account's repo (the one that already posts the
archive links).

## The two paths to an enhanced card

Both are used; they're independent.

1. **Post-side (`associatedRefs`).** When an alert bin (`bin/{bus,train,metra}/
   alerts.js`) posts a resolved event's archive card, it attaches
   `associatedRefs` (the document + publication strong refs) to the
   `app.bsky.embed.external`. Helps the bot's own posts immediately; needs no
   page/path match. Wired via `src/shared/bluesky.js#postTextWithLinkCard` (new
   5th arg) and `src/shared/standardSite.js#eventAssociatedRefsForLink`.

   Note this only works on **resolution replies**: a document's rkey *is* the
   event's Bluesky post rkey, which isn't known until after the post lands, so a
   post can't attach refs to its own not-yet-created document. Initial posts are
   covered by the page-side path instead (the document is minted right after, by
   the sync below).

2. **Page-side (`<link>` tags + well-known).** Each canonical `/event/<id>` page
   declares its document record; the home page + every page declare the
   publication; and `/.well-known/site.standard.publication` returns the
   publication AT-URI (the *mandatory* half of verification — the `<link>` tag is
   only a hint). Helps *anyone* who shares an event permalink. Implemented in the
   frontend (`cta-alert-history`): `scripts/prerender-standard-site.js` (shell
   tag + well-known) and `scripts/prerender-events.js` (per-event document tag).

## Records

- **Publication** — rkey `self`, so its AT-URI is deterministic:
  `at://<did>/site.standard.publication/self`. Fields: `url`, `name`,
  `description`.
- **Document** — one per event, rkey = the event's `/event/<id>` slug (the
  Bluesky post rkey), so the record's `path` (`/event/<id>`) matches the page.

`putRecord` is create-or-replace, so publishing is idempotent. The installed
`@atproto/api` lexicon doesn't know `site.standard.*` (or `associatedRefs`) yet,
so the client passes them through unvalidated — matching how other standard.site
publishers create these records.

## Local state + the manifest

`src/shared/standardSite.js` persists what it has published to
`state/standard-site.json` (gitignored, alongside `history.sqlite`):

```json
{ "publication": { "did", "uri", "cid", "hash" },
  "documents": { "<rkey>": { "did", "cid", "hash" } } }
```

`bin/export-standard-site.js` turns that state into the public manifest
(`standard-site.json`, published to R2 next to `alerts.json`):

```json
{ "publication": "at://<did>/site.standard.publication/self",
  "documents": { "<rkey>": "at://<did>/site.standard.document/<rkey>" } }
```

The manifest carries AT-URIs only (page-side verification needs no cids) and has
no `generated_at`, so it's byte-stable when nothing changed and doesn't trigger a
needless rebuild. The frontend reads it at build time.

## Operations

1. **Continuous sync (automatic).** `bin/push-web-data.sh` runs
   `scripts/backfill-standard-site.js` against the freshly-exported
   `tmp/web-data/alerts.json` on every tick, *before* it builds the manifest — so
   every incident with an `/event` page gets a document (keyed by its event rkey)
   and the page-side tags stay complete, not just the narrow slice the live
   posting bins can mint. It ensures the publication record, then puts a document
   per incident. Idempotent: only new/changed records hit the network, and the
   step is non-fatal so a Bluesky hiccup never blocks the data push. These are
   repo writes (`com.atproto.repo.putRecord`), **not** timeline posts.

   Run it by hand for an immediate reconcile or the first mint:

   ```sh
   node scripts/backfill-standard-site.js --dry-run   # preview
   node scripts/backfill-standard-site.js             # ensure publication + all docs
   ```

2. **Publish the manifest.** The same `push-web-data.sh` run regenerates and
   uploads `standard-site.json` right after the sync; or run
   `bin/export-standard-site.js <out>` directly. After that, the next site build
   injects the tags + well-known.

The state path defaults under `state/` (override with `STANDARD_SITE_STATE`).
Uses the existing ALERTS-account Bluesky credentials.
