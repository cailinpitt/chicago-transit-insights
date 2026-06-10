// Resolve Metra station mentions in alert text to canonical GTFS station names,
// so the published data carries `mentioned_stations` and the frontend can render
// them as links (it can't, because Metra's alert text uses friendly station names
// that DON'T match the GTFS stop names — e.g. the text says "Ogilvie
// Transportation Center" but the GTFS stop is "Chicago OTC"). This is the upstream
// "fix data, frontend stays a dumb renderer" approach.
//
// Pure; the station roster is read from the generated geometry file.

const metraStations = require('./data/metraStations.json');

// Curated alias map: friendly names Metra writes in alert text → the canonical
// GTFS stop name. Only the downtown terminals differ; suburb stops match the
// GTFS name directly. Keys are lowercased.
const ALIASES = {
  'ogilvie transportation center': 'Chicago OTC',
  'ogilvie transportation ctr': 'Chicago OTC',
  ogilvie: 'Chicago OTC',
  otc: 'Chicago OTC',
  'union station': 'Chicago Union Station',
  'chicago union station': 'Chicago Union Station',
  cus: 'Chicago Union Station',
  'lasalle street station': 'LaSalle Street',
  'lasalle st. station': 'LaSalle Street',
  'lasalle street': 'LaSalle Street',
  'millennium station': 'Millennium Station',
};

// Build the lookup once: lowercased alias/roster name → canonical GTFS name.
// Roster names map to themselves; the alias map is overlaid on top.
function buildLookup() {
  const lookup = new Map();
  for (const stations of Object.values(metraStations)) {
    for (const st of stations || []) {
      if (st.name) lookup.set(st.name.toLowerCase(), st.name);
    }
  }
  for (const [alias, canonical] of Object.entries(ALIASES)) lookup.set(alias, canonical);
  return lookup;
}
const LOOKUP = buildLookup();

// Candidate phrases sorted longest-first so "Chicago Union Station" wins over a
// bare "Union Station" / "Chicago" substring. Single-word names ≤ 3 chars are
// dropped to avoid matching abbreviations/noise.
const PHRASES = [...LOOKUP.keys()].filter((p) => p.length >= 4).sort((a, b) => b.length - a.length);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Find every canonical Metra station referenced in `text`. Matches roster names
// and friendly aliases as whole phrases (word-boundaried, case-insensitive),
// longest-first so a contained shorter name doesn't double-count. Returns
// de-duplicated canonical GTFS names in first-seen order.
function extractMetraStations(text) {
  if (!text) return [];
  const hay = String(text);
  const out = [];
  const seen = new Set();
  // Track which character ranges are already claimed by a longer match so a
  // shorter contained phrase doesn't also fire.
  const claimed = [];
  const overlaps = (lo, hi) => claimed.some(([a, b]) => lo < b && hi > a);
  for (const phrase of PHRASES) {
    const re = new RegExp(`(?<![A-Za-z])${escapeRe(phrase)}(?![A-Za-z])`, 'gi');
    let m = re.exec(hay);
    while (m !== null) {
      const lo = m.index;
      const hi = m.index + m[0].length;
      if (!overlaps(lo, hi)) {
        claimed.push([lo, hi]);
        const canonical = LOOKUP.get(phrase);
        if (canonical && !seen.has(canonical)) {
          seen.add(canonical);
          out.push(canonical);
        }
      }
      m = re.exec(hay);
    }
  }
  return out;
}

module.exports = { extractMetraStations, ALIASES };
