const test = require('node:test');
const assert = require('node:assert/strict');
const { detectCrossLineBunches } = require('../../src/train/crossBunching');
const { buildPostText, buildAltText } = require('../../src/train/crossBunchingPost');

const FT_PER_MILLIDEG_LAT = 365;
const dLatForFt = (ft) => ft / FT_PER_MILLIDEG_LAT / 1000;
const at = (rn, line, ft) => ({ rn, line, lat: 41.88 + dLatForFt(ft), lon: -87.63 });

test('headline names the place and line count; groups trains by line', () => {
  const ts = [at('801', 'brn', 0), at('900', 'org', 300), at('901', 'org', 600)];
  const [cluster] = detectCrossLineBunches(ts);
  const text = buildPostText(cluster, { placeName: 'the Loop' }, []);
  assert.match(text, /3 trains from 2 lines stacked up at the Loop/);
  assert.match(text, /Orange Line:/);
  assert.match(text, /Brown Line:/);
  assert.match(text, /#900 \(1️⃣\)/);
});

test('alt text lists the lines and span', () => {
  const ts = [at('801', 'brn', 0), at('802', 'org', 300), at('803', 'pink', 600)];
  const [cluster] = detectCrossLineBunches(ts);
  const alt = buildAltText(cluster, { placeName: 'Tower 18' });
  assert.match(alt, /Brown Line/);
  assert.match(alt, /3 trains from 3 lines/);
});
