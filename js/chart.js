// chart.js — tiny dependency-free SVG line chart for one local day of the UVA
// Index. Pure rendering: given the day's points ({ time: Date, index }) it
// returns an inline <svg> string to drop into the page.

import { BANDS, classifyUVA } from './uva.js';
import { zonedParts, tzAbbr } from './tz.js';

const PAD = { top: 14, right: 14, bottom: 34, left: 32 };
const H = 220;
const MIN_W = 280;

// Build the SVG markup.
//   day       — { start: Date, end: Date, points: [{ time, index }] }
//   timeZone  — IANA zone the hour labels are shown in
//   width     — pixel width to draw at (the SVG is drawn 1:1, so text keeps
//               its real size on narrow screens instead of being squashed)
//   now       — optional Date; marked on the curve when it falls in the day
//   label     — accessible description of the chart
export function chartSvg({ day, timeZone, width, now, label = '' }) {
  const points = (day.points || []).filter((p) => p && isFinite(p.index));
  if (points.length < 2) {
    return '<p class="chart-empty">Not enough data to plot the day.</p>';
  }

  const W = Math.max(MIN_W, Math.round(width) || 600);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Y axis is the UVA Index (0-11+); keep at least the familiar 0-12 range,
  // rounded up to a tidy even number.
  const maxIndex = Math.max(11, ...points.map((p) => p.index));
  const yMax = Math.ceil(maxIndex / 2) * 2;

  // X is real time across the local day (23-25 h around DST changes).
  const t0 = day.start.getTime();
  const span = day.end.getTime() - t0;
  const x = (t) => PAD.left + (plotW * (t.getTime() - t0)) / span;
  const y = (v) => PAD.top + plotH * (1 - v / yMax);

  const line = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p.index).toFixed(1)}`)
    .join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  const area =
    `${line} L${x(last.time).toFixed(1)},${y(0).toFixed(1)}` +
    ` L${x(first.time).toFixed(1)},${y(0).toFixed(1)} Z`;

  // Coloured band fills clipped to the area under the curve. The clip id is
  // unique per render so several charts could share a page.
  const clipId = `area-clip-${Math.random().toString(36).slice(2, 8)}`;
  const colorBands =
    `<defs><clipPath id="${clipId}"><path d="${area}" /></clipPath></defs>` +
    BANDS.map((b, i) => {
      const lo = b.from;
      const hi = Math.min(BANDS[i + 1]?.from ?? yMax, yMax);
      if (lo >= yMax) return '';
      const top = y(hi);
      const h = y(lo) - top;
      return `<rect x="${PAD.left}" y="${top.toFixed(1)}" width="${plotW}" height="${h.toFixed(1)}" fill="${b.color}" opacity="0.6" clip-path="url(#${clipId})" />`;
    }).join('');

  // Y gridlines / labels at 0, 1/2, full.
  const grid = [0, yMax / 2, yMax]
    .map((v) => {
      const yy = y(v).toFixed(1);
      return (
        `<line class="grid" x1="${PAD.left}" y1="${yy}" x2="${W - PAD.right}" y2="${yy}" />` +
        `<text class="axis" x="${PAD.left - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`
      );
    })
    .join('');

  // X labels on the location's local clock: every 6 h, or every 3 h when
  // there's room.
  const every = plotW >= 480 ? 3 : 6;
  const xLabels = points
    .map((p) => {
      const { hour, minute } = zonedParts(p.time, timeZone);
      if (minute !== 0 || hour % every !== 0 || p.time.getTime() === day.end.getTime()) return '';
      return `<text class="axis" x="${x(p.time).toFixed(1)}" y="${H - 18}" text-anchor="middle">${String(hour).padStart(2, '0')}:00</text>`;
    })
    .join('');
  const tzText = `<text class="axis axis-note" x="${W - PAD.right}" y="${H - 3}" text-anchor="end">${escapeXml(tzAbbr(first.time, timeZone))} local time</text>`;

  // "Now" marker, at the exact instant, when it falls within this day.
  let marker = '';
  if (now instanceof Date && now >= day.start && now < day.end) {
    let near = points[0];
    for (const p of points) if (Math.abs(p.time - now) < Math.abs(near.time - now)) near = p;
    const mx = x(now).toFixed(1);
    marker =
      `<line class="marker" x1="${mx}" y1="${PAD.top}" x2="${mx}" y2="${PAD.top + plotH}" />` +
      `<circle class="marker-dot" cx="${mx}" cy="${y(near.index).toFixed(1)}" r="4.5" style="fill:${classifyUVA(near.index).color}" />`;
  }

  return (
    `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeXml(label)}" class="uva-chart-svg">` +
    colorBands +
    grid +
    `<path class="curve" d="${line}" />` +
    marker +
    xLabels +
    tzText +
    '</svg>'
  );
}

function escapeXml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Render into `container` (a DOM element), sized to its current width.
export function renderChart(container, opts) {
  container.innerHTML = chartSvg({ ...opts, width: container.clientWidth });
}
