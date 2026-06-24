# CTA and Metra accessibility archive

Capture-only archive for elevator, escalator, entrance, ADA, and accessibility
notices. These alerts stay suppressed from the Bluesky timelines; this pipeline
preserves their current status and recent history for the website's
`accessibility.json`.

## Sources

`bin/accessibility.js` reads both existing official-alert sources:

- CTA Customer Alerts API via `src/shared/ctaAlerts.js#fetchAlerts`
- Metra GTFS-realtime ServiceAlerts via `src/metra/api.js#getMetraAlerts`

No posting or login happens here.

## Gates

`src/shared/accessibility.js` has separate CTA and Metra entry points, both pure.

CTA rows are kept when the alert is not significant enough for the timeline and
either CTA classifies it as `Impact === "Elevator Status"` or the alert text
mentions elevator, escalator, accessibility, or entrance.

Metra rows are kept when the alert is not significant enough for the timeline
and either `effect === "ACCESSIBILITY_ISSUE"` or the alert text matches the same
accessibility patterns.

## Parsing

Station and unit details are free text. The parser longest-matches against the
CTA rail roster or Metra station roster, then emits:

- `stationName` and `stationSlug` when the station resolves.
- `stationName` with `stationSlug: null` when prose gives an unmatched station.
- `unitType`: `elevator`, `escalator`, `entrance`, or `other`.
- `unitLabel`: nearby prose such as `to Red/Brown/Purple Line platform` or
  `near the Great Hall`.

CTA and Metra share output shape, but do not share upstream adapters.

## Storage

Rows live in `accessibility_outages` in the shared SQLite DB initialized by
`src/shared/history.js`. `source_id` is agency-prefixed (`cta-...`,
`metra-...`) so upstream ids cannot collide.

`upsertAccessibilityOutages(rows, now)` creates or refreshes active rows.
`reconcileAccessibilityOutages(seenIds, now)` marks rows restored after
`ACCESSIBILITY_CLEAR_TICKS` consecutive missing feed ticks, backdating
`restored_ts` to the first missing tick. Reappearing source ids reopen the same
row.

Restored outages are retained for 180 days. Active outages are never rolled off.

## Export

`bin/export-accessibility.js` writes schema-versioned `accessibility.json`:

```json
{
  "schema_version": 1,
  "generated_at": 1781920688280,
  "data_start_ts": 1781458745342,
  "window_days": 180,
  "outages": []
}
```

`bin/push-web-data.sh` uploads it beside `alerts.json`, `daily-counts.json`, and
`alerts.csv`, then triggers the same site rebuild when data changes.
