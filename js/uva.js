// uva.js — Hybrid UVA irradiance model.
//
// We cannot fetch "pure UVA" from a free API (every weather API serves the
// erythemally-weighted UV Index, which is mostly UVB). So we DERIVE UVA
// (unweighted, ~315-400 nm, in W/m2) from:
//   1. solar geometry (zenith angle) -> clear-sky baseline
//   2. live atmospheric corrections (altitude, ozone, aerosol, cloud, albedo)
//
// All tunable coefficients live in MODEL below so they can be calibrated
// against reference data later. Functions are pure.

export const MODEL = {
  // Clear-sky UVA at the surface for an overhead sun (zenith = 0), in W/m2.
  // Literature puts surface UVA near ~66 W/m2 for overhead sun.
  UVA_MAX: 66,

  // Exponent on cos(zenith) for the clear-sky angular falloff. Higher = steeper
  // drop as the sun gets lower. ~1.1-1.3 matches published clear-sky curves.
  ZENITH_EXP: 1.2,

  // Altitude enhancement: fractional increase in UVA per km of elevation.
  ALTITUDE_PER_KM: 0.06,

  // Reference total-column ozone (Dobson Units) the baseline is normalized to.
  OZONE_REF_DU: 300,
  // UVA is only weakly ozone-sensitive (ozone absorbs mostly UVB). Small power.
  OZONE_EXP: 0.05,

  // Aerosol: UVA optical depth is scaled from the reported (broadband) AOD,
  // then attenuation = exp(-tau_uva * airmass).
  AOD_UVA_SCALE: 1.3,

  // Cloud transmission (fallback, parametric): factor = 1 - CLOUD_K * (cover/100)^CLOUD_EXP.
  // Used only when we can't derive the cloud effect from live UV data. Tuned to
  // be gentle and gradual — a reported "100% cover" is sky coverage, not optical
  // depth, so the average overcast UVA transmission is moderate (~0.6), not the
  // near-blackout the old steep curve produced.
  CLOUD_K: 0.4,
  CLOUD_EXP: 1.5,

  // UVA penetrates cloud better than the (UVB-dominated) erythemal UV: cloud
  // transmittance rises with wavelength across the UV band. When we know the
  // erythemal cloud transmission T_uv (from live uv_index / uv_index_clear_sky),
  // we lift it for UVA as T_uva = T_uv ^ CLOUD_UVA_PENETRATION. The exponent is
  // < 1, so any attenuation is softened (T_uva > T_uv) — and the gap widens for
  // thicker cloud, which matches the observed spectral behaviour.
  CLOUD_UVA_PENETRATION: 0.8,

  // Surface albedo enhancement multipliers (diffuse UVA bouncing back down).
  ALBEDO: {
    grass: 1.0, // ~3% reflectance, treated as baseline
    water: 1.0,
    sand: 1.04, // dry sand ~15-25%
    snow: 1.1, // fresh snow can exceed 80% but enhancement at surface is modest
  },

  // UVA Index scale: divisor turning UVA irradiance (W/m2) into a clean 0-11+
  // index. Chosen so the clear-sky overhead-sun maximum (UVA_MAX = 66) maps to
  // ~11 — the same top-of-scale feel as the erythemal UV Index (which scales
  // its irradiance by x40). One constant, strictly proportional to the real
  // irradiance, so the index is easy to explain and to recalibrate.
  INDEX_DIVISOR: 6,
};

// Convert UVA irradiance (W/m2) to the dimensionless UVA Index (0-11+).
export function uvaIndex(uva, model = MODEL) {
  return uva / model.INDEX_DIVISOR;
}

// Air mass approximation (Kasten-Young-ish, simple secant with a floor to
// avoid blow-up near the horizon).
function airMass(zenithDeg) {
  const z = Math.min(zenithDeg, 89);
  const cosz = Math.cos((z * Math.PI) / 180);
  return 1 / Math.max(cosz, 0.05);
}

// Compute UVA. `inputs` fields:
//   zenith        (deg, required)
//   aboveHorizon  (bool, required)
//   elevationM    (m, default 0)
//   ozoneDU       (Dobson Units, optional)
//   aod           (aerosol optical depth, optional)
//   cloudCover    (% 0-100, optional — parametric cloud fallback)
//   uvCloudTransmission (0-1, optional — erythemal cloud transmission derived
//                  from live uv_index / uv_index_clear_sky; preferred over
//                  cloudCover because it reflects the real sky, and UVA is
//                  lifted above it to honour its better cloud penetration)
//   surface       ('grass'|'water'|'sand'|'snow', default 'grass')
//
// Returns { uva, band, factors } where `factors` itemizes each multiplier so
// the UI can show a transparent breakdown.
export function computeUVA(inputs, model = MODEL) {
  const {
    zenith,
    aboveHorizon,
    elevationM = 0,
    ozoneDU,
    aod,
    cloudCover,
    uvCloudTransmission,
    surface = 'grass',
  } = inputs;

  if (!aboveHorizon || zenith >= 90) {
    return {
      uva: 0,
      index: 0,
      band: classifyUVA(0),
      factors: { baseline: 0, note: 'Sun below horizon' },
    };
  }

  const cosz = Math.cos((zenith * Math.PI) / 180);

  // 1. Clear-sky angular baseline.
  const baseline = model.UVA_MAX * Math.pow(Math.max(cosz, 0), model.ZENITH_EXP);

  // 2. Altitude.
  const altitudeFactor = 1 + model.ALTITUDE_PER_KM * (elevationM / 1000);

  // 3. Ozone (weak).
  let ozoneFactor = 1;
  if (typeof ozoneDU === 'number' && ozoneDU > 0) {
    ozoneFactor = Math.pow(model.OZONE_REF_DU / ozoneDU, model.OZONE_EXP);
  }

  // 4. Aerosol (Beer-Lambert with air mass).
  let aerosolFactor = 1;
  if (typeof aod === 'number' && aod > 0) {
    const tauUva = aod * model.AOD_UVA_SCALE;
    aerosolFactor = Math.exp(-tauUva * airMass(zenith));
  }

  // 5. Cloud cover. Prefer the live-UV-derived transmission (real sky), lifted
  // for UVA's better cloud penetration; otherwise fall back to the parametric
  // cloud-cover curve.
  let cloudFactor = 1;
  if (typeof uvCloudTransmission === 'number' && isFinite(uvCloudTransmission)) {
    const tUv = Math.min(1, Math.max(0, uvCloudTransmission));
    cloudFactor = Math.pow(tUv, model.CLOUD_UVA_PENETRATION);
  } else if (typeof cloudCover === 'number') {
    const c = Math.min(100, Math.max(0, cloudCover)) / 100;
    cloudFactor = 1 - model.CLOUD_K * Math.pow(c, model.CLOUD_EXP);
  }

  // 6. Albedo.
  const albedoFactor = model.ALBEDO[surface] ?? 1;

  const uva =
    baseline *
    altitudeFactor *
    ozoneFactor *
    aerosolFactor *
    cloudFactor *
    albedoFactor;

  const value = Math.max(0, uva);
  const index = uvaIndex(value, model);

  return {
    uva: value,
    index,
    band: classifyUVA(index),
    factors: {
      baseline,
      altitude: altitudeFactor,
      ozone: ozoneFactor,
      aerosol: aerosolFactor,
      cloud: cloudFactor,
      albedo: albedoFactor,
    },
  };
}

// Qualitative band for a UVA Index value (0-11+). The category boundaries
// deliberately reuse the WHO UV Index bands (Low 0-2, Moderate 3-5, High 6-7,
// Very High 8-10, Extreme 11+) so the scale is instantly familiar — only the
// underlying quantity (unweighted UVA, not erythemal UV) differs.
export function classifyUVA(index) {
  if (index < 3) return { label: 'Low', level: 0, color: '#3a7d44' };
  if (index < 6) return { label: 'Moderate', level: 1, color: '#f2c14e' };
  if (index < 8) return { label: 'High', level: 2, color: '#f08a24' };
  if (index < 11) return { label: 'Very High', level: 3, color: '#e3522f' };
  return { label: 'Extreme', level: 4, color: '#b5179e' };
}
