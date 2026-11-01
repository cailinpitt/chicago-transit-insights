// Resolves an America/Chicago wall time to a Date without a tz library by
// round-tripping through Intl.DateTimeFormat. Correct across DST.
function chicagoWallTime(year, month, day, hour, minute, second) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcGuess));
  const get = (k) => +parts.find((p) => p.type === k).value;
  const seenAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return new Date(utcGuess + (utcGuess - seenAsUtc));
}

module.exports = { chicagoWallTime };
