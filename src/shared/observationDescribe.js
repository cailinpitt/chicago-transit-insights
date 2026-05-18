// Plain-English descriptions for bot-observation events, generated server-side
// at export time so the web app stays a dumb renderer. The detection sentence
// ("Route 124 service appears degraded — …") and the matching resolution
// sentence ("Buses observed on Route 124 again, …") both live here so any
// future signal additions only need one source-of-truth update.
//
// Each describe* function returns a sentence or null; null tells the renderer
// to omit the block rather than fall back to chip rendering. Callers should
// pass a row shaped like a disruption/roundup observation (kind, line,
// detection_source, signals).

const TRAIN_LINES = {
  red: 'Red',
  blue: 'Blue',
  brown: 'Brown',
  green: 'Green',
  orange: 'Orange',
  pink: 'Pink',
  purple: 'Purple',
  yellow: 'Yellow',
};

// CTA short-code → full-name aliases. Mirrors cta-alert-history's ctaLines.js
// so a row with `line: 'brn'` describes as "Brown Line" without the renderer
// having to normalize first.
const LINE_ALIAS = {
  brn: 'brown',
  g: 'green',
  org: 'orange',
  p: 'purple',
  y: 'yellow',
};

function normalizeTrainLine(key) {
  if (key == null) return key;
  return LINE_ALIAS[key] ?? key;
}

function observationSignals(obs) {
  if (!obs) return [];
  if (obs.detection_source === 'roundup') {
    if (Array.isArray(obs.signals)) return obs.signals;
    if (typeof obs.signals === 'string') return obs.signals.split(',').filter(Boolean);
    return [];
  }
  return obs.detection_source ? [obs.detection_source] : [];
}

function signalPhrase(signal, kind) {
  switch (signal) {
    case 'gap':
      return kind === 'bus'
        ? 'longer-than-scheduled gaps between buses'
        : 'longer-than-scheduled headways between trains';
    case 'bunching':
      return kind === 'bus' ? 'buses running bunched together' : 'trains running bunched together';
    case 'ghost':
      return kind === 'bus' ? 'fewer buses than scheduled' : 'fewer trains than scheduled';
    case 'pulse-cold':
      return 'a stretch of the line without trains';
    case 'pulse-held':
      return 'trains held in place';
    case 'thin-gap':
      return 'no buses observed within a full scheduled headway';
    default:
      return null;
  }
}

function botObservationSubject(incident) {
  if (incident.kind === 'bus') {
    const route = incident.line;
    if (!route) return null;
    return `Route ${route} service`;
  }
  const lineKey = normalizeTrainLine(incident.line);
  const label = TRAIN_LINES[lineKey];
  if (!label) return null;
  return `${label} Line service`;
}

function joinPhrases(phrases) {
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(', ')}, and ${phrases[phrases.length - 1]}`;
}

function isMergedOrAlert(incident) {
  return !!(incident && (incident._type === 'merged' || incident.alert_id));
}

function describeBotObservation(incident) {
  if (!incident) return null;
  if (isMergedOrAlert(incident)) return null;

  const signals = observationSignals(incident);
  const kind = incident.kind === 'bus' ? 'bus' : 'train';
  const phrases = signals.map((s) => signalPhrase(s, kind)).filter((p) => p != null);
  if (phrases.length === 0) return null;

  const subject = botObservationSubject(incident);
  if (!subject) return null;

  return `${subject} appears degraded — ${joinPhrases(phrases)}.`;
}

// Resolution sentence companion to describeBotObservation. Tailors the lead
// clause to the signal *category* so the sentence doesn't overclaim:
//
//   - absence (thin-gap, pulse-cold): vehicles weren't visible → "observed
//     again"
//   - paralysis (pulse-held): vehicles were visible but stuck → "moving
//     again"
//   - degradation (gap, bunching, ghost — including any roundup that bundles
//     them): vehicles were visible AND moving, service was just uneven →
//     drop the lead clause entirely. Saying "observed again" here would be
//     wrong because the trains were always observed.
function describeBotResolution(incident) {
  if (!incident) return null;
  if (isMergedOrAlert(incident)) return null;

  const signals = observationSignals(incident);
  if (signals.length === 0) return null;
  const known = signals.filter((s) => signalPhrase(s, 'bus') != null);
  if (known.length === 0) return null;

  const subject = botObservationSubject(incident);
  if (!subject) return null;

  const ABSENCE = new Set(['thin-gap', 'pulse-cold']);
  const PARALYSIS = new Set(['pulse-held']);
  const allAbsence = known.every((s) => ABSENCE.has(s));
  const allParalysis = known.every((s) => PARALYSIS.has(s));

  // Degradation (or any mixed bag) gets the minimal sentence — no leading
  // clause about vehicles being visible or moving, since neither was the
  // problem.
  if (!allAbsence && !allParalysis) {
    return `${subject} appears to be back to normal.`;
  }

  // Subject is "Route 124 service" / "Brown Line service" — strip the
  // trailing " service" so the sentence reads "on Route 124" / "on the Brown
  // Line" rather than "on Route 124 service".
  const place = subject.replace(/ service$/, '');
  const article = incident.kind === 'bus' ? '' : 'the ';
  const noun = incident.kind === 'bus' ? 'Buses' : 'Trains';
  const verb = allParalysis ? 'moving again' : 'observed again';

  return `${noun} ${verb} on ${article}${place}, service appears to be back to normal.`;
}

module.exports = {
  describeBotObservation,
  describeBotResolution,
  observationSignals,
  TRAIN_LINES,
  normalizeTrainLine,
};
