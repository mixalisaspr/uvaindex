// tz.js — tiny, dependency-free IANA timezone helpers built on Intl.
//
// The calculator works in UTC instants internally, but "today" and the hours on
// the chart belong to the *location's* calendar, not UTC's and not the
// browser's. These helpers translate between the two. Pure functions.

const formatters = new Map();

function partsFormatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// The browser's own zone — the fallback when a location's zone is unknown.
export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// Wall-clock parts of a UTC instant in `timeZone`:
// { year, month (1-12), day, hour (0-23), minute, second }.
export function zonedParts(date, timeZone) {
  const out = {};
  for (const p of partsFormatter(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = parseInt(p.value, 10);
  }
  return out;
}

// Offset of `timeZone` from UTC at the given instant, in milliseconds
// (positive east of Greenwich, e.g. +11 h for Sydney in summer).
export function tzOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// UTC instant of local midnight at the start of the calendar day
// (year, month 1-12, day) in `timeZone`. `day` may overflow (e.g. 32) — it is
// normalised like Date.UTC does, which makes "add N days" trivial.
export function localMidnight(year, month, day, timeZone) {
  const wall = Date.UTC(year, month - 1, day);
  // Two passes settle the offset even when midnight sits next to a DST change.
  let t = wall - tzOffsetMs(new Date(wall), timeZone);
  t = wall - tzOffsetMs(new Date(t), timeZone);
  return new Date(t);
}

// UTC instant of the local midnight that starts the day containing `date`.
export function startOfLocalDay(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return localMidnight(p.year, p.month, p.day, timeZone);
}

// Local-day windows [{ start, end }] for `count` consecutive days, starting
// with the day that contains `date`. Days are 23 or 25 h long across DST
// changes, so each boundary is computed rather than added as 24 h.
export function localDays(date, timeZone, count) {
  const p = zonedParts(date, timeZone);
  const days = [];
  for (let i = 0; i < count; i++) {
    days.push({
      start: localMidnight(p.year, p.month, p.day + i, timeZone),
      end: localMidnight(p.year, p.month, p.day + i + 1, timeZone),
    });
  }
  return days;
}

// "14:05" in the location's zone.
export function formatClock(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// Short zone name such as "AEDT" or "GMT+11"; falls back to the IANA name.
export function tzAbbr(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      timeZoneName: 'short',
    }).formatToParts(date);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

// Day label in the location's zone, e.g. "Thu" or "Thu 9 Oct" (long).
export function formatDay(date, timeZone, { long = false } = {}) {
  const opts = long
    ? { timeZone, weekday: 'short', day: 'numeric', month: 'short' }
    : { timeZone, weekday: 'short' };
  const parts = new Intl.DateTimeFormat('en-GB', opts).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return [get('weekday'), get('day'), get('month')].filter(Boolean).join(' ');
}
