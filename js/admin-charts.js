// admin-charts.js — tiny dependency-free SVG charts for the admin dashboard.
// No external chart library needed; keeps the admin app light.

const CHART_COLORS = {
  mint: "#4fd1c5",
  amber: "#e3b341",
  green: "#3fb950",
  red: "#f2545b",
  blue: "#58a6ff",
  purple: "#a371f7",
};

// Vertical bar chart. labels + values must be same-length arrays.
function svgBarChart(labels, values, opts = {}) {
  const color = opts.color || CHART_COLORS.mint;
  const W = 520, H = 180, padL = 8, padB = 26, padT = 12;
  const max = Math.max(...values, 1);
  const n = values.length;
  if (!n) return `<div class="chart-empty">No data yet</div>`;
  const slot = (W - padL * 2) / n;
  const barW = Math.min(30, slot * 0.55);
  let out = "";
  values.forEach((v, i) => {
    const h = Math.max(3, ((H - padB - padT) * v) / max);
    const x = padL + slot * i + (slot - barW) / 2;
    const y = H - padB - h;
    out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${color}" opacity="${v ? 1 : 0.25}"><title>${escapeHtml(String(labels[i]))}: ${v}</title></rect>`;
    if (n <= 16 || i % 2 === 0) {
      out += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${escapeHtml(String(labels[i]))}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img">${out}</svg>`;
}

// Donut chart. segments: [{ label, value, color }]
function svgDonut(segments) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (!total) return `<div class="chart-empty">No data yet</div>`;
  const R = 54, C = 2 * Math.PI * R;
  let offset = 0, circles = "";
  segments.forEach((seg) => {
    if (!seg.value) return;
    const frac = seg.value / total;
    circles += `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${seg.color}" stroke-width="18" stroke-dasharray="${(frac * C).toFixed(1)} ${C.toFixed(1)}" stroke-dashoffset="${(-offset * C).toFixed(1)}"><title>${escapeHtml(seg.label)}: ${seg.value}</title></circle>`;
    offset += frac;
  });
  const legend = segments
    .map((s) => `<div class="donut-legend__row"><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}<strong>${s.value}</strong></div>`)
    .join("");
  return `<div class="donut-wrap"><svg viewBox="0 0 140 140" class="chart-svg chart-svg--donut" role="img">${circles}<text x="70" y="66" text-anchor="middle" font-size="22" font-weight="700" fill="var(--text-primary)">${total}</text><text x="70" y="84" text-anchor="middle" font-size="10" fill="var(--text-muted)">total</text></svg><div class="donut-legend">${legend}</div></div>`;
}

// Local calendar date (YYYY-MM-DD). toISOString() is UTC and shifts the
// day for IST (UTC+5:30) around midnight, so charts were off-by-one.
function localDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Bucket rows by day for the last `days` days using the row's dateKey field.
// Returns [{ label: "9 Sep", value: n }, ...] oldest → newest.
function bucketByDay(rows, dateKey, days) {
  const counts = {};
  (rows || []).forEach((r) => {
    if (!r || !r[dateKey]) return;
    const d = new Date(r[dateKey]);
    if (isNaN(d)) return;
    const k = localDayKey(d);
    counts[k] = (counts[k] || 0) + 1;
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const k = localDayKey(d);
    out.push({
      label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      value: counts[k] || 0,
    });
  }
  return out;
}

// Smooth multi-series line chart for the overview card. Values are real
// database buckets; the SVG is intentionally dependency-free and responsive.
function svgLineChart(labels, series, opts = {}) {
  const W = 760, H = 220, pad = { l: 30, r: 14, t: 18, b: 30 };
  const count = labels.length;
  if (!count || !series || !series.length) return `<div class="chart-empty">No data yet</div>`;
  const max = Math.max(1, ...series.flatMap((s) => s.values || []));
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const x = (i) => pad.l + (count === 1 ? innerW / 2 : (i / (count - 1)) * innerW);
  const y = (v) => pad.t + innerH - ((Number(v) || 0) / max) * innerH;
  const grid = [0, 0.5, 1].map((ratio) => {
    const yy = pad.t + innerH * ratio;
    const value = Math.round(max * (1 - ratio));
    return `<line x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${W - pad.r}" y2="${yy.toFixed(1)}" stroke="rgba(139,147,167,.16)" stroke-width="1" stroke-dasharray="3 5"/><text x="${pad.l - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-muted)">${value}</text>`;
  }).join("");
  const xLabels = labels.map((label, i) => {
    if (count > 14 && i % 3 !== 0 && i !== count - 1) return "";
    return `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${escapeHtml(String(label))}</text>`;
  }).join("");
  const content = series.map((s) => {
    const values = (s.values || []).map((v) => Number(v) || 0);
    const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const fillPoints = `${x(0).toFixed(1)},${(pad.t + innerH).toFixed(1)} ${points} ${x(count - 1).toFixed(1)},${(pad.t + innerH).toFixed(1)}`;
    const dots = values.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.2" fill="${s.color}" stroke="var(--bg-surface)" stroke-width="2"><title>${escapeHtml(String(labels[i]))}: ${v}</title></circle>`).join("");
    return `<polygon points="${fillPoints}" fill="${s.color}" opacity=".08"></polygon><polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline>${dots}`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg chart-svg--line" role="img" aria-label="${escapeHtml(opts.ariaLabel || "Growth overview chart")}">${grid}${content}${xLabels}</svg>`;
}
