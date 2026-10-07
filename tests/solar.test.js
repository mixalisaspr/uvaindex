import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solarPosition } from '../js/solar.js';

// Minute of the UTC day with the smallest zenith (solar noon) at `lon`.
function solarNoonMinute(dayIso, lat, lon) {
  const t0 = Date.parse(`${dayIso}T00:00:00Z`);
  let best = { minute: 0, zenith: Infinity };
  for (let m = 0; m < 1440; m++) {
    const { zenith } = solarPosition(new Date(t0 + m * 60000), lat, lon);
    if (zenith < best.zenith) best = { minute: m, zenith };
  }
  return best;
}

test('declination at the solstices and equinox', () => {
  const june = solarPosition(new Date('2026-06-21T08:24:00Z'), 0, 0).declination;
  const dec = solarPosition(new Date('2026-12-21T20:50:00Z'), 0, 0).declination;
  const march = solarPosition(new Date('2026-03-20T14:46:00Z'), 0, 0).declination;
  assert.ok(Math.abs(june - 23.44) < 0.05, `June declination ${june}`);
  assert.ok(Math.abs(dec + 23.44) < 0.05, `December declination ${dec}`);
  assert.ok(Math.abs(march) < 0.05, `March declination ${march}`);
});

test('solar noon follows the equation of time', () => {
  // Greenwich meridian: noon is ~14 min late in mid-February and ~16 min
  // early in early November (the two extremes of the equation of time).
  const feb = solarNoonMinute('2026-02-11', 51.5, 0);
  const nov = solarNoonMinute('2026-11-03', 51.5, 0);
  assert.ok(Math.abs(feb.minute - (12 * 60 + 14)) <= 1, `Feb noon at minute ${feb.minute}`);
  assert.ok(Math.abs(nov.minute - (11 * 60 + 44)) <= 1, `Nov noon at minute ${nov.minute}`);
});

test('noon zenith equals |latitude - declination|', () => {
  for (const lat of [-33.9, 0, 23.44, 51.5, 64.1]) {
    const { zenith } = solarNoonMinute('2026-06-21', lat, 0);
    assert.ok(Math.abs(zenith - Math.abs(lat - 23.44)) < 0.1, `lat ${lat}: zenith ${zenith}`);
  }
});

test('longitude shifts solar noon by 4 minutes per degree', () => {
  const a = solarNoonMinute('2026-04-15', 40, 0).minute;
  const b = solarNoonMinute('2026-04-15', 40, -90).minute; // 90°W -> 6 h later
  assert.ok(Math.abs(b - a - 360) <= 1, `${a} vs ${b}`);
});

test('elevation, zenith and the horizon flag agree', () => {
  const night = solarPosition(new Date('2026-06-21T00:00:00Z'), 51.5, 0);
  const day = solarPosition(new Date('2026-06-21T12:00:00Z'), 51.5, 0);
  assert.equal(night.aboveHorizon, false);
  assert.equal(day.aboveHorizon, true);
  assert.ok(Math.abs(day.elevation + day.zenith - 90) < 1e-9);
});

test('Earth-Sun distance: perihelion in early January, aphelion in early July', () => {
  const r = (iso) => solarPosition(new Date(iso), 0, 0).distanceAU;
  assert.ok(Math.abs(r('2026-01-03T17:00:00Z') - 0.98329) < 2e-4);
  assert.ok(Math.abs(r('2026-07-06T17:00:00Z') - 1.01670) < 2e-4);
});
