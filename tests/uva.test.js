import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeUVA,
  classifyUVA,
  clearSkyUVA,
  sphericalAlbedo,
  pressureFromElevation,
  uvaIndex,
  BANDS,
  MODEL,
  P0,
} from '../js/uva.js';
import { ZENITH, AOD, PRESSURE, UVA, SPHERICAL_ALBEDO } from '../js/lut.js';

const clear = (zenith, extra = {}) =>
  computeUVA({ zenith, aboveHorizon: true, pressureHpa: P0, surface: 'grass', ...extra });
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

test('lookup table is well formed and physically ordered', () => {
  assert.equal(UVA.length, ZENITH.length);
  for (const plane of UVA) {
    assert.equal(plane.length, AOD.length);
    for (const row of plane) assert.equal(row.length, PRESSURE.length);
  }
  assert.equal(SPHERICAL_ALBEDO.length, AOD.length);
  for (let a = 0; a < AOD.length; a++) {
    for (let p = 0; p < PRESSURE.length; p++) {
      for (let z = 1; z < ZENITH.length; z++) {
        assert.ok(UVA[z][a][p] <= UVA[z - 1][a][p], `falls with zenith (z${z} a${a} p${p})`);
      }
      if (a > 0) assert.ok(UVA[0][a][p] < UVA[0][a - 1][p], 'overhead UVA falls with haze');
      if (p > 0) assert.ok(UVA[0][a][p] < UVA[0][a][p - 1], 'overhead UVA falls with more air');
      const s = SPHERICAL_ALBEDO[a][p];
      assert.ok(s > 0.1 && s < 0.6, `spherical albedo ${s}`);
    }
  }
  assert.equal(UVA[ZENITH.length - 1][0][0], 0, 'nothing on a horizontal plane at 90°');
});

test('table interpolation hits the nodes and stays between them', () => {
  const k = PRESSURE.indexOf(P0);
  assert.equal(clearSkyUVA(30, 0.2, P0), UVA[ZENITH.indexOf(30)][AOD.indexOf(0.2)][k]);
  const mid = clearSkyUVA(32.5, 0.2, P0);
  assert.ok(mid < clearSkyUVA(30, 0.2, P0) && mid > clearSkyUVA(35, 0.2, P0));
  // Outside the grid: clamped, never extrapolated into nonsense.
  assert.equal(clearSkyUVA(30, 9, P0), clearSkyUVA(30, AOD.at(-1), P0));
  assert.equal(clearSkyUVA(30, 0, 300), clearSkyUVA(30, 0, PRESSURE[0]));
});

test('sun below the horizon gives zero', () => {
  const r = computeUVA({ zenith: 95, aboveHorizon: false });
  assert.equal(r.uva, 0);
  assert.equal(r.index, 0);
  assert.equal(r.band.label, 'Low');
});

test('overhead clean sky at sea level is ~64 W/m2, about index 11', () => {
  const r = clear(0, { aod: 0 });
  close(r.factors.baseline, 64.45, 0.01);
  assert.ok(r.index > 10.5 && r.index < 11.2, `index ${r.index}`);
});

test('factors multiply to the result', () => {
  const r = clear(40, { aod: 0.3, pressureHpa: 850, surface: 'snow', distanceAU: 0.984, uvCloudTransmission: 0.6 });
  const product = Object.values(r.factors).reduce((a, b) => a * b, 1);
  close(product, r.uva, 1e-9);
});

test('UVA falls monotonically as the sun gets lower', () => {
  let prev = Infinity;
  for (let z = 0; z < 90; z += 2.5) {
    const { uva } = clear(z, { aod: 0.15 });
    assert.ok(uva < prev, `zenith ${z}`);
    prev = uva;
  }
});

test('altitude: less air above means more UVA; pressure wins over elevation', () => {
  const sea = clear(30, { aod: 0 }).uva;
  const high = clear(30, { aod: 0, pressureHpa: 700 }).uva;
  assert.ok(high / sea > 1.05 && high / sea < 1.12, `3 km gain ${high / sea}`);
  const viaElevation = computeUVA({ zenith: 30, aboveHorizon: true, aod: 0, elevationM: 3000 });
  close(viaElevation.pressureHpa, 701, 1);
  const both = computeUVA({ zenith: 30, aboveHorizon: true, aod: 0, elevationM: 3000, pressureHpa: P0 });
  assert.equal(both.pressureHpa, P0);
});

test('pressureFromElevation follows the standard atmosphere', () => {
  close(pressureFromElevation(0), P0, 1e-9);
  close(pressureFromElevation(1500), 845.6, 0.5);
});

test('aerosol attenuates without double counting at low sun', () => {
  const ratio = (z, aod) => clear(z, { aod }).factors.aerosol;
  assert.ok(ratio(20, 0.3) < 1);
  assert.ok(ratio(20, 1.0) < ratio(20, 0.3));
  // Haze scatters most "lost" UVA into diffuse skylight: even a low sun keeps
  // most of it (the old Beer-Lambert term left ~40% at 85°).
  assert.ok(ratio(85, 0.15) > 0.8, `85° factor ${ratio(85, 0.15)}`);
  assert.equal(clear(30).factors.aerosol, 1, 'missing AOD = clean air');
});

test('Earth-Sun distance scales by 1/r^2', () => {
  close(clear(30, { distanceAU: 0.9833 }).factors.distance, 1.0342, 1e-4);
  close(clear(30, { distanceAU: 1.0167 }).factors.distance, 0.9674, 1e-4);
});

test('cloud: live transmission is used as-is by default, cover curve as fallback', () => {
  assert.equal(MODEL.CLOUD_UVA_EXP, 1);
  close(clear(30, { uvCloudTransmission: 0.4 }).factors.cloud, 0.4, 1e-12);
  assert.equal(clear(30, { uvCloudTransmission: 1.4 }).factors.cloud, 1, 'clamped at 1');
  assert.equal(clear(30, { cloudCover: 100, uvCloudTransmission: 1 }).factors.cloud, 1);
  close(clear(30, { cloudCover: 100 }).factors.cloud, 1 - MODEL.CLOUD_K, 1e-12);
  let prev = 1;
  for (let c = 0; c <= 100; c += 10) {
    const f = clear(30, { cloudCover: c }).factors.cloud;
    assert.ok(f <= prev + 1e-12);
    prev = f;
  }
});

test('surroundings: reflection from the table spherical albedo', () => {
  const s = sphericalAlbedo(0.1, P0);
  const snow = clear(30, { aod: 0.1, surface: 'snow' });
  close(snow.factors.albedo, 1 / (1 - MODEL.ALBEDO.snow * s), 1e-12);
  assert.ok(snow.factors.albedo > 1.15 && snow.factors.albedo < 1.35, `snow ${snow.factors.albedo}`);
  assert.ok(clear(30, { surface: 'grass' }).factors.albedo < 1.02);
  assert.equal(clear(30, { albedo: 0 }).factors.albedo, 1, 'explicit albedo wins');
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
