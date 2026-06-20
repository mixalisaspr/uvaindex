// chart.js — tiny dependency-free SVG line chart for the daily UVA Index curve.
// Pure rendering: given a series of { time: Date, uva: number } points and the
// selected instant, it returns an inline <svg> string to drop into the page.

import { classifyUVA } from './uva.js';

const PAD = { top: 14, right: 14, bottom: 26, left: 36 };
const W = 600;
const H = 220;

function svgEl(series, selectedTime) {
  const points = series.filter((p) => p && isFinite(p.uva));
  if (points.length < 2) {
    return '<p class="chart-empty">Not enough data to plot the day.</p>';
  }

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const n = points.length;
  const maxUva = Math.max(10, ...points.map((p) => p.uva));
  // Round the axis top up to a tidy number.
  const yMax = Math.ceil(maxUva / 10) * 10;

  const x = (i) => PAD.left + (plotW * i) / (n - 1);
  const y = (v) => PAD.top + plotH * (1 - v / yMax);

  // Line + area paths.
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.uva).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;

  // Y gridlines / labels at 0, 1/2, full.
  const yTicks = [0, yMax / 2, yMax];
  const grid = yTicks
    .map((v) => {
      const yy = y(v).toFixed(1);
      return (
        `<line class="grid" x1="${PAD.left}" y1="${yy}" x2="${W - PAD.right}" y2="${yy}" />` +
        `<text class="axis" x="${PAD.left - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`
      );
    })
    .join('');

  // X labels every 6 hours, by the hour of each point.
  const xLabels = points
    .map((p, i) => {
      const hr = p.time.getHours();
      if (hr % 6 !== 0) return '';
      return `<text class="axis" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${String(hr).padStart(2, '0')}:00</text>`;
    })
    .join('');

  // Marker at the selected time (nearest point).
  let marker = '';
  if (selectedTime instanceof Date && !isNaN(selectedTime)) {
    const target = selectedTime.getTime();
    let idx = 0;
    let best = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(p.time.getTime() - target);
      if (d < best) {
        best = d;
        idx = i;
      }
    });
    const mx = x(idx).toFixed(1);
    const my = y(points[idx].uva).toFixed(1);
    const band = classifyUVA(points[idx].uva);
    marker =
      `<line class="marker" x1="${mx}" y1="${PAD.top}" x2="${mx}" y2="${PAD.top + plotH}" />` +
      `<circle class="marker-dot" cx="${mx}" cy="${my}" r="4.5" style="fill:${band.color}" />`;
  }

  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="none" class="uva-chart-svg">` +
    grid +
    `<path class="area" d="${area}" />` +
    `<path class="curve" d="${line}" />` +
    marker +
    xLabels +
    '</svg>'
  );
}

// Render the chart into `container` (a DOM element).
export function renderChart(container, series, selectedTime) {
  container.innerHTML = svgEl(series, selectedTime);
}
