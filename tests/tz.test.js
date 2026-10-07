import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localMidnight, localDays, startOfLocalDay, tzOffsetMs, zonedParts, formatClock, formatDay } from '../js/tz.js';

const HOUR = 3600000;

test('local midnight in zones east and west of UTC', () => {
  assert.equal(localMidnight(2026, 10, 8, 'Australia/Sydney').toISOString(), '2026-10-07T13:00:00.000Z');
  assert.equal(localMidnight(2026, 10, 7, 'America/Los_Angeles').toISOString(), '2026-10-07T07:00:00.000Z');
  assert.equal(localMidnight(2026, 10, 7, 'UTC').toISOString(), '2026-10-07T00:00:00.000Z');
  // Odd offsets: India +5:30, Chatham +13:45.
  assert.equal(localMidnight(2026, 1, 15, 'Asia/Kolkata').toISOString(), '2026-01-14T18:30:00.000Z');
  assert.equal(localMidnight(2026, 1, 15, 'Pacific/Chatham').toISOString(), '2026-01-14T10:15:00.000Z');
});

test('day overflow rolls into the next month', () => {
  assert.equal(localMidnight(2026, 10, 32, 'UTC').toISOString(), '2026-11-01T00:00:00.000Z');
});

test('DST days are 23 or 25 hours long', () => {
  // Sydney springs forward on Sun 4 Oct 2026; Los Angeles falls back on Sun 1 Nov 2026.
  const [syd] = localDays(new Date('2026-10-04T05:00:00Z'), 'Australia/Sydney', 1);
  assert.equal(syd.end - syd.start, 23 * HOUR);
  const [la] = localDays(new Date('2026-11-01T20:00:00Z'), 'America/Los_Angeles', 1);
  assert.equal(la.end - la.start, 25 * HOUR);
});

test('consecutive local days tile without gaps', () => {
  const days = localDays(new Date('2026-10-07T21:00:00Z'), 'Australia/Sydney', 5);
  assert.equal(days.length, 5);
  assert.equal(days[0].start.toISOString(), '2026-10-07T13:00:00.000Z'); // 8 Oct local
  for (let i = 1; i < days.length; i++) assert.equal(days[i].start.getTime(), days[i - 1].end.getTime());
});

test('startOfLocalDay uses the location calendar, not UTC', () => {
  // 08:00 on 8 Oct in Sydney is still 7 Oct in UTC.
  const now = new Date('2026-10-07T21:00:00Z');
  assert.equal(startOfLocalDay(now, 'Australia/Sydney').toISOString(), '2026-10-07T13:00:00.000Z');
  // 18:00 on 7 Oct in Los Angeles is already 8 Oct in UTC.
  const eve = new Date('2026-10-08T01:00:00Z');
  assert.equal(startOfLocalDay(eve, 'America/Los_Angeles').toISOString(), '2026-10-07T07:00:00.000Z');
});

test('offsets and wall-clock parts', () => {
  assert.equal(tzOffsetMs(new Date('2026-10-07T21:00:00Z'), 'Australia/Sydney'), 11 * HOUR);
  assert.equal(tzOffsetMs(new Date('2026-07-01T00:00:00Z'), 'America/New_York'), -4 * HOUR);
  assert.deepEqual(zonedParts(new Date('2026-10-07T21:05:09Z'), 'Australia/Sydney'), {
    year: 2026, month: 10, day: 8, hour: 8, minute: 5, second: 9,
  });
  assert.equal(formatClock(new Date('2026-10-07T23:00:00Z'), 'Australia/Sydney'), '10:00');
  assert.equal(formatClock(new Date('2026-10-08T00:00:00Z'), 'Europe/London'), '01:00');
});

test('day labels', () => {
  const d = new Date('2026-10-09T13:00:00Z'); // Sat 10 Oct in Sydney
  assert.equal(formatDay(d, 'Australia/Sydney'), 'Sat');
  assert.equal(formatDay(d, 'Australia/Sydney', { long: true }), 'Sat 10 Oct');
});
