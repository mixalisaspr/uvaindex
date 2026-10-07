import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeUVA, classifyUVA, uvaIndex, BANDS, MODEL } from '../js/uva.js';

const clear = (zenith, extra = {}) => computeUVA({ zenith, aboveHorizon: true, ...extra });

test('sun below the horizon gives zero', () => {
  const r = computeUVA({ zenith: 95, aboveHorizon: false });
  assert.equal(r.uva, 0);
  assert.equal(r.index, 0);
  assert.equal(r.band.label, 'Low');
});

test('overhead clear sky at sea level is UVA_MAX, about index 11', () => {
  const r = clear(0);
  assert.equal(r.uva, MODEL.UVA_MAX);
  assert.ok(Math.abs(r.index - 11) < 1e-9);
  assert.equal(r.band.label, 'Extreme');
});

test('UVA falls monotonically as the sun gets lower', () => {
  let prev = Infinity;
  for (let z = 0; z < 90; z += 5) {
    const { uva } = clear(z);
    assert.ok(uva < prev || z === 0, `zenith ${z}`);
    prev = uva;
  }
});

test('altitude raises UVA by ALTITUDE_PER_KM per km', () => {
  const sea = clear(30).uva;
  const high = clear(30, { elevationM: 2000 }).uva;
  assert.ok(Math.abs(high / sea - (1 + 2 * MODEL.ALTITUDE_PER_KM)) < 1e-9);
});

test('aerosol only attenuates, and more so for a low sun', () => {
  const ratio = (z) => clear(z, { aod: 0.3 }).uva / clear(z).uva;
  assert.ok(ratio(20) < 1);
  assert.ok(ratio(70) < ratio(20));
  // The diffuse-recovery term keeps a moderate AOD from costing more than ~25%.
  assert.ok(ratio(20) > 0.75, `ratio ${ratio(20)}`);
});

test('cloud: UVA is lifted above the erythemal transmission', () => {
  for (const t of [0.2, 0.5, 0.8]) {
    const f = clear(30, { uvCloudTransmission: t }).factors.cloud;
    assert.ok(f > t && f <= 1, `T_uv ${t} -> ${f}`);
  }
  assert.equal(clear(30, { uvCloudTransmission: 1.4 }).factors.cloud, 1, 'clamped at 1');
});

test('cloud: live transmission wins over the parametric cover curve', () => {
  const both = clear(30, { cloudCover: 100, uvCloudTransmission: 1 }).factors.cloud;
  assert.equal(both, 1);
  const coverOnly = clear(30, { cloudCover: 100 }).factors.cloud;
  assert.ok(Math.abs(coverOnly - (1 - MODEL.CLOUD_K)) < 1e-9);
  // More cover never means more UVA.
  let prev = 1;
  for (let c = 0; c <= 100; c += 10) {
    const f = clear(30, { cloudCover: c }).factors.cloud;
    assert.ok(f <= prev + 1e-12);
    prev = f;
  }
});

test('surface albedo multiplier', () => {
  assert.equal(clear(30, { surface: 'snow' }).factors.albedo, MODEL.ALBEDO.snow);
  assert.equal(clear(30, { surface: 'unknown' }).factors.albedo, 1);
});

test('index is irradiance / INDEX_DIVISOR', () => {
  assert.equal(uvaIndex(60), 60 / MODEL.INDEX_DIVISOR);
});

test('band boundaries follow the WHO UV Index bands', () => {
  const cases = [
    [0, 'Low'], [2.99, 'Low'], [3, 'Moderate'], [5.99, 'Moderate'], [6, 'High'],
    [7.99, 'High'], [8, 'Very High'], [10.99, 'Very High'], [11, 'Extreme'], [15, 'Extreme'],
  ];
  for (const [i, label] of cases) assert.equal(classifyUVA(i).label, label, `index ${i}`);
  assert.deepEqual(BANDS.map((b) => b.level), [0, 1, 2, 3, 4]);
});
