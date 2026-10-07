// Shared fixtures: synthetic hourly atmosphere in the shape fetchHourly()
// returns.

// `days` of hourly UTC samples starting at `fromIso` (00:00Z of a date).
// `at(time)` may override any field per hour.
export function syntheticHours(fromIso, days, at = () => ({})) {
  const t0 = Date.parse(fromIso);
  return Array.from({ length: days * 24 }, (_, i) => {
    const time = new Date(t0 + i * 3600000);
    return {
      time,
      cloudCover: 0,
      aod: 0.1,
      uvIndex: 5,
      uvIndexClearSky: 5, // ratio 1: a clear sky
      ozone: 60,
      ...at(time),
    };
  });
}
