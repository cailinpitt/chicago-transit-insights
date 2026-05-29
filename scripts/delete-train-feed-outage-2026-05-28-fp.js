#!/usr/bin/env node
// One-off: delete the 2026-05-28 train feed-outage FPs. An upstream Train
// Tracker / observe-trains outage (21:11→21:43 CDT, stale-replaying on
// recovery) produced a cluster of pulse FPs plus one gap FP:
//   main alerts account (loginAlerts):
//     456 Purple full-line blackout
//     442 Red / 443 Blue "all"      + clears 454 / 455
//     462 Red / 463+464 Brown / 465 Blue segments + clears 466 / 467
//   train-bot gap account (loginTrain):
//     Red gap @ 47th (gap_events 6453)
// The website rebuilds alerts.json from the DB, so deleting these rows +
// re-running bin/push-web-data.sh drops them from the site too.
//
// Companion fix: the feed-coverage guard in src/train/pulse.js (detectFeedGap)
// + the train-feed-outage-2026-05-28 regression fixture.
require('../src/shared/env');
const Database = require('better-sqlite3');
const { loginAlerts } = require('../src/shared/bluesky');
const { loginTrain } = require('../src/train/bluesky');

const DB = process.env.HISTORY_DB || '/home/cailin/Development/cta-insights/state/history.sqlite';

const ALERTS_RKEYS = [
  '3mmxjnl3jxx2k', // 456 purple alert (still active)
  '3mmxi3hmses2m', // 442 red alert
  '3mmxi3kooce25', // 443 blue alert
  '3mmxjgf4nfz2m', // 454 red clear
  '3mmxjghd2l52v', // 455 blue clear
  '3mmxkcyq3ng2k', // 462 red alert
  '3mmxkgkulks2y', // 463 brn alert
  '3mmxkgnzqtg2k', // 464 brn alert
  '3mmxkrci2zs2y', // 465 blue alert
  '3mmxl3ynvgu25', // 466 brn clear
  '3mmxl7l6yqc2k', // 467 red clear
];
const TRAIN_RKEYS = [
  '3mmxjr3oulq2a', // 6453 red gap @ 47th
];
const DISRUPTION_IDS = [442, 443, 454, 455, 456, 462, 463, 464, 465, 466, 467];
const GAP_IDS = [6453];

async function deletePosts(agent, rkeys) {
  const repoDid = agent.session?.did || agent.did;
  for (const rkey of rkeys) {
    try {
      await agent.com.atproto.repo.deleteRecord({
        repo: repoDid,
        collection: 'app.bsky.feed.post',
        rkey,
      });
      console.log(`deleted bluesky post ${rkey} (${repoDid.slice(0, 16)}…)`);
    } catch (e) {
      console.warn(`bluesky delete ${rkey} failed: ${e.message}`);
    }
  }
}

async function main() {
  await deletePosts(await loginAlerts(), ALERTS_RKEYS);
  await deletePosts(await loginTrain(), TRAIN_RKEYS);

  const db = new Database(DB);
  const d1 = db
    .prepare(`DELETE FROM disruption_events WHERE id IN (${DISRUPTION_IDS.join(',')})`)
    .run();
  console.log(`disruption_events deleted: ${d1.changes}`);
  // Pre-post detection rows (posted=0) for the same lines inside the outage
  // window are the same FPs — clean them too.
  const d2 = db
    .prepare(
      `DELETE FROM disruption_events
       WHERE kind='train' AND posted=0
         AND ts BETWEEN 1780020900000 AND 1780024200000`,
    )
    .run();
  console.log(`disruption_events (posted=0 detections) deleted: ${d2.changes}`);
  const g1 = db.prepare(`DELETE FROM gap_events WHERE id IN (${GAP_IDS.join(',')})`).run();
  console.log(`gap_events deleted: ${g1.changes}`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
