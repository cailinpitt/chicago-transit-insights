const trainStations = require('../train/data/trainStations.json');
const metraStations = require('../metra/data/metraStations.json');
const { isSignificantAlert } = require('./ctaAlerts');
const { isSignificantMetraAlert, alertRelevance } = require('../metra/metraAlerts');

const ACCESS_PATTERNS = [
  /\b(?:elevator|escalator)\b/i,
  /\b(?:ada|accessib(?:le|ility)?)\b.{0,80}\b(?:out(?:\s+of\s+service)?|unavailable|closed|closure|issue|problem|not\s+available|not\s+working)\b/i,
  /\b(?:out(?:\s+of\s+service)?|unavailable|closed|closure|issue|problem|not\s+available|not\s+working)\b.{0,80}\b(?:ada|accessib(?:le|ility)?)\b/i,
  /\bentrance\b.{0,80}\b(?:closed|closure|unavailable|out\s+of\s+service)\b/i,
];

function slugifyStation(name) {
  if (!name) return null;
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

function normalizeStationKey(s) {
  return String(s)
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s*\/\s*/g, ' ')
    .replace(/[\s-]+/g, ' ')
    .replace(/\s*\bstation\b\s*$/i, '')
    .trim();
}

function displayCtaStationName(name) {
  return String(name || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

function textForCtaAlert(alert) {
  return [alert?.headline, alert?.shortDescription, alert?.fullDescription]
    .filter(Boolean)
    .join(' ');
}

function textForMetraAlert(alert) {
  return [alert?.header, alert?.description].filter(Boolean).join(' ');
}

function classifyUnit(text) {
  if (/\belevator\b/i.test(text || '')) return 'elevator';
  if (/\bescalator\b/i.test(text || '')) return 'escalator';
  if (/\bentrance\b/i.test(text || '')) return 'entrance';
  return 'other';
}

function hasAccessibilityText(text) {
  return ACCESS_PATTERNS.some((re) => re.test(text || ''));
}

function ctaStationCandidates(stations = trainStations) {
  return stations
    .map((s) => ({
      name: displayCtaStationName(s.name),
      rawName: s.name,
      slug: slugifyStation(s.name),
      lines: s.lines || [],
      key: normalizeStationKey(displayCtaStationName(s.name)),
    }))
    .sort((a, b) => b.name.length - a.name.length);
}

function metraStationCandidates(stations = metraStations) {
  const byName = new Map();
  for (const [line, list] of Object.entries(stations)) {
    for (const s of list || []) {
      if (!s.name) continue;
      const rec = byName.get(s.name) || {
        name: s.name,
        rawName: s.name,
        slug: slugifyStation(s.name),
        lines: [],
        key: normalizeStationKey(s.name),
      };
      if (!rec.lines.includes(line.toLowerCase())) rec.lines.push(line.toLowerCase());
      byName.set(s.name, rec);
    }
  }
  return [...byName.values()].sort((a, b) => b.name.length - a.name.length);
}

function matchRosterStation(text, candidates) {
  const normalizedText = normalizeStationKey(text || '');
  if (!normalizedText) return null;
  for (const s of candidates) {
    const escaped = s.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\ /g, '[ -]+');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(normalizedText)) return s;
  }
  return null;
}

function parseRawStationName(text) {
  const patterns = [
    /\bat\s+([A-Za-z0-9][A-Za-z0-9./&' -]+?)(?:\s+station)?(?:\s+is\b|\s+will\b|\s+has\b|\s+for\b|[.,;]|$)/i,
    /\b(?:elevator|escalator|entrance)\s+(?:at|near)\s+([A-Za-z0-9][A-Za-z0-9./&' -]+?)(?:\s+station)?(?:\s+is\b|\s+will\b|\s+has\b|\s+for\b|[.,;]|$)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text || '');
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function parseUnitLabel(text) {
  const unit = /\b(elevator|escalator|entrance)\b/i.exec(text || '');
  if (!unit) return null;
  const after = text.slice(unit.index + unit[0].length);
  const m =
    /^\s+(.+?)(?:\s+(?:at|near)\s+[A-Z0-9][A-Za-z0-9./&' -]+(?:\s+station)?\b|\s+is\b|\s+will\b|\s+has\b|[.;]|$)/i.exec(
      after,
    );
  if (!m?.[1]) return null;
  const label = m[1].replace(/\s+/g, ' ').trim();
  return label || null;
}

function parseStationAndUnit(text, candidates) {
  const roster = matchRosterStation(text, candidates);
  const stationName = roster?.name || parseRawStationName(text);
  return {
    stationName,
    stationSlug: roster?.slug ?? null,
    stationLines: roster?.lines || [],
    unitLabel: parseUnitLabel(text),
  };
}

function isCtaAccessibilityAlert(alert) {
  if (!alert || isSignificantAlert(alert)) return false;
  if (alert.impact === 'Elevator Status') return true;
  if (/\bschedules?\b/i.test(alert.headline || '')) return false;
  return hasAccessibilityText(textForCtaAlert(alert));
}

function isMetraAccessibilityAlert(alert) {
  if (!alert || isSignificantMetraAlert(alert)) return false;
  if (alert.effect === 'ACCESSIBILITY_ISSUE') return true;
  return hasAccessibilityText(textForMetraAlert(alert));
}

function ctaRouteLines(alert) {
  return alert.trainLines || [];
}

function metraRouteLines(alert) {
  return alertRelevance(alert).lines.map((line) => line.toLowerCase());
}

function toCtaOutageRows(alerts, now = Date.now(), stations = trainStations) {
  const candidates = ctaStationCandidates(stations);
  return (alerts || []).filter(isCtaAccessibilityAlert).map((alert) => {
    const text = textForCtaAlert(alert);
    const descriptionText = [alert.shortDescription, alert.fullDescription]
      .filter(Boolean)
      .join(' ');
    const parsed = parseStationAndUnit(text, candidates);
    const lines = parsed.stationLines.length ? parsed.stationLines : ctaRouteLines(alert);
    return {
      sourceId: `cta-${alert.id}`,
      agency: 'cta',
      stationName: parsed.stationName,
      stationSlug: parsed.stationSlug,
      lines,
      unitType: classifyUnit(text),
      unitLabel: parseUnitLabel(descriptionText) || parsed.unitLabel,
      headline: alert.headline || null,
      description: alert.shortDescription || alert.fullDescription || null,
      sourceUrl: alert.url || null,
      firstSeenTs: now,
    };
  });
}

function toMetraOutageRows(alerts, now = Date.now(), stations = metraStations) {
  const candidates = metraStationCandidates(stations);
  return (alerts || []).filter(isMetraAccessibilityAlert).map((alert) => {
    const text = textForMetraAlert(alert);
    const parsed = parseStationAndUnit(text, candidates);
    const lines = parsed.stationLines.length ? parsed.stationLines : metraRouteLines(alert);
    return {
      sourceId: `metra-${alert.id}`,
      agency: 'metra',
      stationName: parsed.stationName,
      stationSlug: parsed.stationSlug,
      lines,
      unitType: classifyUnit(text),
      unitLabel: parseUnitLabel(alert.description) || parsed.unitLabel,
      headline: alert.header || null,
      description: alert.description || null,
      sourceUrl: alert.url || null,
      firstSeenTs: now,
    };
  });
}

module.exports = {
  ACCESS_PATTERNS,
  classifyUnit,
  isCtaAccessibilityAlert,
  isMetraAccessibilityAlert,
  parseStationAndUnit,
  parseUnitLabel,
  slugifyStation,
  toCtaOutageRows,
  toMetraOutageRows,
};
