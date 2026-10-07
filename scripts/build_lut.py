#!/usr/bin/env python3
"""Generate js/lut.js — the clear-sky UVA lookup table the model interpolates.

Instead of hand-tuned rules of thumb (a cos(zenith)^k curve, a %/km altitude
gain, a Beer-Lambert aerosol term), the clear-sky part of the UVA model comes
from a radiative-transfer calculation: the DISORT discrete-ordinates solver
(via the PythonicDISORT package) run over a plane-parallel, multi-layer
atmosphere for every combination of

    solar zenith angle  x  aerosol optical depth (550 nm)  x  surface pressure

and integrated over 315-400 nm. The table holds global (direct + diffuse)
horizontal UVA in W/m2 at 1 AU over a black surface, plus the atmosphere's
spherical albedo s, so the page can add surface reflection exactly for a
Lambertian surface of albedo a:  E(a) = E(0) / (1 - a * s).

Atmosphere (all assumptions are listed in META below and on the methodology
page):
  * Solar spectrum: ASTM G173-03 extraterrestrial (0.5 nm), via pvlib.
  * Rayleigh: Bodhaine et al. (1999) optical depth, scaled by p / 1013.25,
    depolarised Rayleigh phase function, scale height 8 km.
  * Ozone: SPECTRL2 (Leckner) absorption coefficients, 300 DU, Gaussian
    layer centred at 22 km above sea level.
  * Aerosol: AOD(lambda) = AOD550 * (lambda/550)^-1.14, single-scattering
    albedo 0.92, Henyey-Greenstein asymmetry 0.70, scale height 1.5 km.
  * Direct beam: pseudo-spherical — the Kasten & Young (1989) air mass
    replaces 1/cos(zenith), which over-counts the path near the horizon.

Usage (dev-only dependencies; the shipped site stays dependency-free):
    pip install -r scripts/requirements-lut.txt
    python3 scripts/build_lut.py            # writes js/lut.js
    python3 scripts/build_lut.py --compare  # also cross-checks vs SPECTRL2
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import warnings
from pathlib import Path

import numpy as np

try:
    import PythonicDISORT
    from pvlib.spectrum import get_reference_spectra
except ImportError as e:  # pragma: no cover
    sys.exit(f"{e}\nInstall the dev dependencies: pip install -r scripts/requirements-lut.txt")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "js" / "lut.js"

# --- grid --------------------------------------------------------------------

ZENITH = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 87.5, 90]
AOD = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0, 1.5, 2.0, 3.0]
PRESSURE = [500, 600, 700, 800, 900, 1013.25, 1060]  # hPa at the surface

# --- atmosphere --------------------------------------------------------------

BAND = (315.0, 400.0)  # nm
BIN_NM = 2.5
NQUAD = 16
OZONE_DU = 300
ANGSTROM = 1.14
AEROSOL_SSA = 0.92
AEROSOL_G = 0.70
H_RAYLEIGH = 8.0  # km
H_AEROSOL = 1.5  # km
OZONE_PEAK_KM = 22.0  # above sea level
OZONE_SIGMA_KM = 6.0
RAYLEIGH_DEPOL = 0.0279
# Layer boundaries, km above the surface.
LEVELS = [0, 0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 10, 13, 16, 20, 25, 30, 40, 60]

META = {
    "band_nm": list(BAND),
    "solar_spectrum": "ASTM G173-03 extraterrestrial",
    "solver": f"DISORT (PythonicDISORT {PythonicDISORT.__version__ if hasattr(PythonicDISORT, '__version__') else ''}".strip()
    + f", {NQUAD} streams, delta-M, {len(LEVELS) - 1} layers)",
    "rayleigh": "Bodhaine et al. 1999, scaled by surface pressure",
    "ozone_du": OZONE_DU,
    "aerosol": {"angstrom": ANGSTROM, "ssa": AEROSOL_SSA, "g": AEROSOL_G, "scale_height_km": H_AEROSOL},
    "direct_beam_airmass": "Kasten & Young 1989 (pseudo-spherical)",
    "distance": "1 AU (apply the Earth-Sun distance at run time)",
}


def rayleigh_tau(wl_nm: np.ndarray, p_hpa: float) -> np.ndarray:
    """Bodhaine et al. (1999) Rayleigh optical depth, eq. 30."""
    l = wl_nm / 1000.0
    l2 = l * l
    tau = 0.0021520 * (1.0455996 - 341.29061 / l2 - 0.90230850 * l2) / (1 + 0.0027059889 / l2 - 85.968563 * l2)
    return tau * p_hpa / 1013.25


def ozone_coeff(wl_nm: np.ndarray) -> np.ndarray:
    """Ozone absorption coefficient (per atm-cm), SPECTRL2 / Leckner table,
    interpolated in log space (it falls ~exponentially through the Huggins bands)."""
    import importlib

    c = importlib.import_module("pvlib.spectrum.spectrl2")._SPECTRL2_COEFFS
    w = c["wavelength"]
    k = np.maximum(c["ozone_absorption"], 1e-6)  # the table's zeros -> negligible
    return np.exp(np.interp(wl_nm, w, np.log(k)))


def kasten_young_airmass(zenith_deg: float) -> float:
    # The fit dips a hair below 1 overhead; an air mass under 1 is unphysical.
    m = 1.0 / (math.cos(math.radians(zenith_deg)) + 0.50572 * (96.07995 - zenith_deg) ** -1.6364)
    return max(m, 1.0)


def surface_altitude_km(p_hpa: float) -> float:
    """Standard-atmosphere altitude for a surface pressure (for the ozone layer)."""
    return 44.3308 * (1 - (p_hpa / 1013.25) ** 0.190263)


def layer_fractions_exp(scale_km: float) -> np.ndarray:
    z = np.array(LEVELS, dtype=float)
    cum = 1 - np.exp(-z / scale_km)
    frac = np.diff(cum)
    frac[-1] += 1 - cum[-1]  # everything above the top level goes in the top layer
    return frac


def layer_fractions_ozone(p_hpa: float) -> np.ndarray:
    z = np.array(LEVELS, dtype=float) + surface_altitude_km(p_hpa)
    cdf = 0.5 * (1 + np.vectorize(math.erf)((z - OZONE_PEAK_KM) / (OZONE_SIGMA_KM * math.sqrt(2))))
    frac = np.diff(cdf)
    frac[-1] += 1 - cdf[-1]
    frac[0] += cdf[0]  # ozone below the surface level is folded into the bottom layer
    return frac / frac.sum()


def spectral_bins():
    ref = get_reference_spectra(standard="ASTM G173-03")["extraterrestrial"]
    edges = np.arange(BAND[0], BAND[1] + 1e-9, BIN_NM)
    centres, flux = [], []
    for lo, hi in zip(edges[:-1], edges[1:]):
        seg = ref.loc[lo:hi]
        centres.append((lo + hi) / 2)
        flux.append(np.trapezoid(seg.values, seg.index.values))  # W/m2 in the bin
    return np.array(centres), np.array(flux)


def build_column(wl: float, aod550: float, p_hpa: float, frac_r, frac_a, frac_o):
    """Per-layer optical properties for one wavelength (top layer first)."""
    tau_r = rayleigh_tau(np.array([wl]), p_hpa)[0] * frac_r
    tau_a = aod550 * (wl / 550.0) ** -ANGSTROM * frac_a
    tau_o = ozone_coeff(np.array([wl]))[0] * (OZONE_DU / 1000.0) * frac_o
    tau = tau_r + tau_a + tau_o
    scat_r = tau_r
    scat_a = tau_a * AEROSOL_SSA
    omega = np.minimum((scat_r + scat_a) / tau, 1 - 1e-7)

    leg = np.zeros((len(tau), NQUAD + 1))
    g_r = np.zeros(NQUAD + 1)
    g_r[0] = 1.0
    gamma = RAYLEIGH_DEPOL / (2 - RAYLEIGH_DEPOL)
    g_r[2] = 0.1 * (1 - gamma) / (1 + 2 * gamma)
    g_a = AEROSOL_G ** np.arange(NQUAD + 1)
    scat = scat_r + scat_a
    for i in range(len(tau)):
        leg[i] = (scat_r[i] * g_r + scat_a[i] * g_a) / scat[i]
    # DISORT wants top layer first.
    return tau[::-1], omega[::-1], leg[::-1]


def solve(tau, omega, leg, mu0_eff: float, albedo: float) -> float:
    """Total downward flux at the surface for unit beam intensity."""
    tau_cum = np.cumsum(tau)
    res = PythonicDISORT.pydisort(
        tau_cum,
        omega,
        NQUAD,
        leg,
        mu0_eff,
        1.0,
        0.0,
        only_flux=True,
        f_arr=leg[:, NQUAD],
        BDRF_Fourier_modes=[albedo] if albedo else [],
        cache_asso_leg="no_mu0",
    )
    diffuse, direct = res[2](tau_cum[-1])
    return float(diffuse + direct)


def clear_sky(wls, flux, aod550, p_hpa, zeniths):
    """Integrated UVA (W/m2, black surface) per zenith, and the band's
    spherical albedo (flux-weighted at 30 deg zenith)."""
    frac_r = layer_fractions_exp(H_RAYLEIGH)
    frac_a = layer_fractions_exp(H_AEROSOL)
    frac_o = layer_fractions_ozone(p_hpa)
    out = np.zeros(len(zeniths))
    e0_ref = e1_ref = 0.0
    ref_mu = 1 / kasten_young_airmass(30.0)
    for wl, f0 in zip(wls, flux):
        tau, omega, leg = build_column(wl, aod550, p_hpa, frac_r, frac_a, frac_o)
        for k, z in enumerate(zeniths):
            cosz = math.cos(math.radians(z))
            if cosz <= 1e-9:
                continue  # sun on the horizon: no flux on a horizontal plane
            mu_eff = 1 / kasten_young_airmass(z)
            # DISORT's beam flux is I0*mu0*exp(-tau/mu0); choose I0 so that the
            # top-of-atmosphere flux is f0*cos(z) while the path uses the
            # spherical-atmosphere air mass.
            out[k] += solve(tau, omega, leg, mu_eff, 0.0) * f0 * cosz / mu_eff
        # Spherical albedo s at this wavelength from E(1) = E(0) / (1 - s).
        e0 = solve(tau, omega, leg, ref_mu, 0.0)
        e1 = solve(tau, omega, leg, ref_mu, 1.0)
        s = 1 - e0 / e1
        # Band-effective s: preserve the integrated E(a) at a typical snow albedo.
        a = 0.8
        e0_ref += f0 * e0
        e1_ref += f0 * e0 / (1 - a * s)
    s_eff = (1 - e0_ref / e1_ref) / a
    return out, s_eff


def build():
    wls, flux = spectral_bins()
    t0 = time.time()
    uva = np.zeros((len(ZENITH), len(AOD), len(PRESSURE)))
    sph = np.zeros((len(AOD), len(PRESSURE)))
    for j, aod in enumerate(AOD):
        for k, p in enumerate(PRESSURE):
            uva[:, j, k], sph[j, k] = clear_sky(wls, flux, aod, p, ZENITH)
        print(f"  AOD {aod:<4} done ({time.time() - t0:5.0f} s)", file=sys.stderr)
    return wls, flux, uva, sph


def render(uva, sph, flux) -> str:
    def rows(a, d):
        return json.dumps(np.round(a, d).tolist(), separators=(",", ":"))

    meta = dict(META, toa_uva_wm2=round(float(flux.sum()), 2))
    return (
        "// lut.js — clear-sky UVA lookup table.\n"
        "// GENERATED by scripts/build_lut.py from a DISORT radiative-transfer run —\n"
        "// do not edit by hand. See that script for the atmosphere it assumes.\n"
        "//\n"
        "// uva[z][a][p]: global horizontal UVA (315-400 nm, W/m2) at 1 AU over a\n"
        "//   black surface, for ZENITH[z] deg, AOD550 = AOD[a], surface pressure\n"
        "//   PRESSURE[p] hPa.\n"
        "// sphericalAlbedo[a][p]: the atmosphere's spherical albedo s, so a\n"
        "//   Lambertian surface of albedo r gives E(r) = E(0) / (1 - r * s).\n\n"
        f"export const META = {json.dumps(meta, indent=2)};\n\n"
        f"export const ZENITH = {json.dumps(ZENITH)};\n"
        f"export const AOD = {json.dumps(AOD)};\n"
        f"export const PRESSURE = {json.dumps(PRESSURE)};\n\n"
        f"export const UVA = {rows(uva, 2)};\n\n"
        f"export const SPHERICAL_ALBEDO = {rows(sph, 4)};\n"
    )


def direct_diffuse(aod550: float, p_hpa: float, zenith: float):
    """DISORT direct and diffuse horizontal UVA (W/m2) for one case."""
    wls, flux = spectral_bins()
    frac = (layer_fractions_exp(H_RAYLEIGH), layer_fractions_exp(H_AEROSOL), layer_fractions_ozone(p_hpa))
    mu = 1 / kasten_young_airmass(zenith)
    scale = math.cos(math.radians(zenith)) / mu
    direct = diffuse = 0.0
    for wl, f0 in zip(wls, flux):
        tau, omega, leg = build_column(wl, aod550, p_hpa, *frac)
        tau_cum = np.cumsum(tau)
        res = PythonicDISORT.pydisort(tau_cum, omega, NQUAD, leg, mu, 1.0, 0.0, only_flux=True, f_arr=leg[:, NQUAD])
        dif, dirc = res[2](tau_cum[-1])
        direct += dirc * f0 * scale
        diffuse += dif * f0 * scale
    return direct, diffuse


def compare_spectrl2(uva):
    """Cross-check the sea-level column against NREL's SPECTRL2 (Bird &
    Riordan 1986), an independent, simpler spectral clear-sky model. The
    direct beam should agree closely; SPECTRL2's diffuse sky is a simplified
    parameterisation that under-counts multiple Rayleigh scattering, which is
    strongest in the UV, so expect its diffuse (and global) to come out low."""
    from pvlib.irradiance import get_extra_radiation
    from pvlib.spectrum import spectrl2

    # SPECTRL2 needs a day of year for its Earth-Sun correction; take it back
    # out so both models sit at 1 AU.
    doy = 94
    distance_factor = get_extra_radiation(doy, solar_constant=1.0, method="spencer")

    print("\nCross-check vs SPECTRL2 (sea level, black surface, W/m2 315-400 nm):")
    print(f"{'zenith':>6} {'AOD550':>6} | {'global':>7} {'S2':>7} {'diff':>6} | "
          f"{'direct':>7} {'S2':>7} {'diff':>6} | {'diffuse':>7} {'S2':>7} {'diff':>6}")
    k = PRESSURE.index(1013.25)
    for aod in (0.05, 0.2, 0.6):
        for z in (0, 30, 60, 75, 85):
            tau500 = aod * (500 / 550) ** -ANGSTROM
            r = spectrl2(
                apparent_zenith=z, aoi=z, surface_tilt=0, ground_albedo=0.0,
                surface_pressure=101325, relative_airmass=kasten_young_airmass(z),
                precipitable_water=1.4, ozone=OZONE_DU / 1000, aerosol_turbidity_500nm=tau500,
                dayofyear=doy, alpha=ANGSTROM, aerosol_asymmetry_factor=AEROSOL_G,
            )
            wl = np.asarray(r["wavelength"])
            m = (wl >= BAND[0]) & (wl <= BAND[1])
            integ = lambda key, f=1.0: float(np.trapezoid(np.asarray(r[key]).ravel()[m] * f, wl[m])) / distance_factor
            s2_dir = integ("dni", math.cos(math.radians(z)))
            s2_dif = integ("dhi")
            d_dir, d_dif = direct_diffuse(aod, 1013.25, z)
            glob = uva[ZENITH.index(z)][AOD.index(aod)][k]
            pct = lambda a, b: f"{100 * (a - b) / b:5.1f}%"
            print(f"{z:>6} {aod:>6} | {glob:7.2f} {s2_dir + s2_dif:7.2f} {pct(s2_dir + s2_dif, glob)} | "
                  f"{d_dir:7.2f} {s2_dir:7.2f} {pct(s2_dir, d_dir)} | {d_dif:7.2f} {s2_dif:7.2f} {pct(s2_dif, d_dif)}")


def load_existing_uva() -> np.ndarray:
    text = OUT.read_text(encoding="utf-8")
    start = text.index("export const UVA = ") + len("export const UVA = ")
    return np.array(json.loads(text[start:text.index(";", start)]))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--compare", action="store_true", help="cross-check against SPECTRL2")
    ap.add_argument("--compare-only", action="store_true", help="cross-check the existing js/lut.js; don't rebuild")
    args = ap.parse_args()
    warnings.filterwarnings("ignore", module="PythonicDISORT")
    if args.compare_only:
        compare_spectrl2(load_existing_uva())
        return
    print(f"Running {len(AOD) * len(PRESSURE)} columns ...", file=sys.stderr)
    _, flux, uva, sph = build()
    OUT.write_text(render(uva, sph, flux), encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)}  (TOA UVA {flux.sum():.2f} W/m2; "
          f"overhead sea-level clean-air UVA {uva[0, 0, PRESSURE.index(1013.25)]:.2f} W/m2)")
    if args.compare:
        compare_spectrl2(uva)


if __name__ == "__main__":
    main()
