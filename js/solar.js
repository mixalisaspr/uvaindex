// solar.js — Solar position (zenith angle) from latitude/longitude and a timestamp.
//
// Implements the NOAA solar position algorithm (the same math behind the NOAA
// Solar Calculator). Pure functions, no dependencies. All angles in degrees
// unless noted. Accuracy is well within what the UVA model needs.

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// --- low-level helpers ------------------------------------------------------

// Julian Day from a JS Date (uses the UTC instant the Date represents).
function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

// Julian Century relative to J2000.0
function julianCentury(jd) {
  return (jd - 2451545) / 36525;
}

function geomMeanLongSun(t) {
  let l = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  if (l < 0) l += 360;
  return l; // degrees
}

function geomMeanAnomalySun(t) {
  return 357.52911 + t * (35999.05029 - 0.0001537 * t); // degrees
}

function eccentricityEarthOrbit(t) {
  return 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
}

function sunEqOfCenter(t) {
  const m = geomMeanAnomalySun(t) * DEG;
  return (
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289
  ); // degrees
}

function sunTrueLong(t) {
  return geomMeanLongSun(t) + sunEqOfCenter(t); // degrees
}

function sunApparentLong(t) {
  const o = sunTrueLong(t);
  return o - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * DEG); // degrees
}

function meanObliquityOfEcliptic(t) {
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  return 23 + (26 + seconds / 60) / 60; // degrees
}

function obliquityCorrection(t) {
  const e0 = meanObliquityOfEcliptic(t);
  const omega = 125.04 - 1934.136 * t;
  return e0 + 0.00256 * Math.cos(omega * DEG); // degrees
}

function sunDeclination(t) {
  const e = obliquityCorrection(t) * DEG;
  const lambda = sunApparentLong(t) * DEG;
  return Math.asin(Math.sin(e) * Math.sin(lambda)) * RAD; // degrees
}

// Equation of time, in minutes.
function equationOfTime(t) {
  const epsilon = obliquityCorrection(t) * DEG;
  const l0 = geomMeanLongSun(t) * DEG;
  const e = eccentricityEarthOrbit(t);
  const m = geomMeanAnomalySun(t) * DEG;

  let y = Math.tan(epsilon / 2);
  y *= y;

  const sin2l0 = Math.sin(2 * l0);
  const sinm = Math.sin(m);
  const cos2l0 = Math.cos(2 * l0);
  const sin4l0 = Math.sin(4 * l0);
  const sin2m = Math.sin(2 * m);

  const etime =
    y * sin2l0 -
    2 * e * sinm +
    4 * e * y * sinm * cos2l0 -
    0.5 * y * y * sin4l0 -
    1.25 * e * e * sin2m;

  return etime * RAD * 4; // minutes
}

// --- public API -------------------------------------------------------------

// Returns the solar zenith angle (degrees), solar elevation (degrees), and a
// boolean for whether the sun is above the horizon, for a given location and
// instant. `date` is a JS Date (any timezone — the underlying UTC instant is
// what matters). lat/lon in degrees, east-positive longitude.
export function solarPosition(date, lat, lon) {
  const jd = julianDay(date);
  const t = julianCentury(jd);

  const decl = sunDeclination(t); // degrees
  const eqTime = equationOfTime(t); // minutes

  // Minutes from UTC midnight for this instant.
  const utcMinutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60;

  // True solar time (minutes). Longitude moves 4 minutes per degree.
  let trueSolarTime = utcMinutes + eqTime + 4 * lon;
  trueSolarTime = ((trueSolarTime % 1440) + 1440) % 1440;

  // Hour angle (degrees): 0 at solar noon, negative in the morning.
  let hourAngle = trueSolarTime / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  const latR = lat * DEG;
  const declR = decl * DEG;
  const haR = hourAngle * DEG;

  const cosZenith =
    Math.sin(latR) * Math.sin(declR) +
    Math.cos(latR) * Math.cos(declR) * Math.cos(haR);

  const clamped = Math.min(1, Math.max(-1, cosZenith));
  const zenith = Math.acos(clamped) * RAD;
  const elevation = 90 - zenith;

  return {
    zenith, // solar zenith angle, degrees
    elevation, // solar elevation above horizon, degrees
    declination: decl,
    aboveHorizon: elevation > 0,
  };
}
