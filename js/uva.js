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

  // Cloud transmission: factor = 1 - CLOUD_K * (cover/100)^CLOUD_EXP.
  CLOUD_K: 0.7,
  CLOUD_EXP: 3,

  // Surface albedo enhancement multipliers (diffuse UVA bouncing back down).
  ALBEDO: {
    grass: 1.0, // ~3% reflectance, treated as baseline
    water: 1.0,
    sand: 1.04, // dry sand ~15-25%
    snow: 1.1, // fresh snow can exceed 80% but enhancement at surface is modest
  },
};

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
//   cloudCover    (% 0-100, optional)
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
    surface = 'grass',
  } = inputs;

  if (!aboveHorizon || zenith >= 90) {
    return {
      uva: 0,
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

  // 5. Cloud cover.
  let cloudFactor = 1;
  if (typeof cloudCover === 'number') {
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

  return {
    uva: Math.max(0, uva),
    band: classifyUVA(uva),
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

// Qualitative band for a UVA value in W/m2. These thresholds are pragmatic
// (UVA has no official index), chosen so clear midday sun reads "Very High".
export function classifyUVA(uva) {
  if (uva < 5) return { label: 'Low', level: 0, color: '#3a7d44' };
  if (uva < 20) return { label: 'Moderate', level: 1, color: '#f2c14e' };
  if (uva < 40) return { label: 'High', level: 2, color: '#f08a24' };
  if (uva < 55) return { label: 'Very High', level: 3, color: '#e3522f' };
  return { label: 'Extreme', level: 4, color: '#b5179e' };
}
