// admin-charts.js — "PyChart": real, interactive charts for the admin panel.
//
// Still zero dependencies and zero network requests, but these are proper
// product charts now, not static sketches:
//   * sized in REAL pixels (a ResizeObserver re-renders on layout changes),
//     so labels are legible on a phone instead of being shrunk by viewBox
//     scaling the way the old fixed 520x180 charts were,
//   * smooth (monotone cubic) lines with gradient areas,
//   * hover / touch tooltips with a crosshair and per-series values,
//   * rounded gradient bars that highlight on hover, with today emphasised,
//   * donuts with hover emphasis, centre read-out and percentage legend,
//   * one cheap entrance animation, automatically disabled when the user
//     prefers reduced motion.
//
// The three legacy helpers (svgBarChart / svgDonut / svgLineChart) keep their
// exact signatures and still return an HTML string, so every existing
// `element.innerHTML = svgBarChart(...)` call site keeps working — the markup
// they return hydrates itself on the next animation frame.

const CHART_COLORS = {
  mint: "#4fd1c5",
  amber: "#e3b341",
  green: "#3fb950",
  red: "#f2545b",
  blue: "#58a6ff",
  purple: "#a371f7",
};

const PyChart = (() => {
  "use strict";

  let uid = 0;
  const REDUCED_MOTION = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  const esc = (value) =>
    typeof window.escapeHtml === "function"
      ? window.escapeHtml(value)
      : String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  function compact(value) {
    const n = num(value);
    const abs = Math.abs(n);
    if (abs >= 1e7) return (n / 1e7).toFixed(abs >= 1e8 ? 0 : 1).replace(/\.0$/, "") + "Cr";
    if (abs >= 1e5) return (n / 1e5).toFixed(abs >= 1e6 ? 0 : 1).replace(/\.0$/, "") + "L";
    if (abs >= 1000) return (n / 1000).toFixed(abs >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
    return String(Math.round(n));
  }

  const full = (value) => num(value).toLocaleString("en-IN");

  // "Nice" axis maximum so the top gridline is a round number.
  function niceMax(value) {
    const n = Math.max(1, num(value));
    const mag = Math.pow(10, Math.floor(Math.log10(n)));
    const step = n / mag;
    const nice = step <= 1 ? 1 : step <= 2 ? 2 : step <= 2.5 ? 2.5 : step <= 5 ? 5 : 10;
    return nice * mag;
  }

  /* ------------------------------------------------------------------ *
   * Shared tooltip (one node for the whole page)                        *
   * ------------------------------------------------------------------ */
  let tipEl = null;
  function tip() {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "pychart-tip";
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  function showTip(html, clientX, clientY) {
    const el = tip();
    el.innerHTML = html;
    el.classList.add("is-visible");
    const rect = el.getBoundingClientRect();
    const pad = 12;
    let left = clientX + 14;
    if (left + rect.width + pad > window.innerWidth) left = clientX - rect.width - 14;
    if (left < pad) left = pad;
    let top = clientY - rect.height - 12;
    if (top < pad) top = clientY + 18;
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
  }

  function hideTip() {
    if (tipEl) tipEl.classList.remove("is-visible");
  }

  window.addEventListener("scroll", hideTip, { passive: true });

  /* ------------------------------------------------------------------ *
   * Geometry helpers                                                     *
   * ------------------------------------------------------------------ */
  // Monotone cubic interpolation — smooth but never overshoots into
  // impossible negative values the way a naive bezier does.
  function smoothPath(points) {
    if (points.length < 2) return points.length ? `M${points[0].x},${points[0].y}` : "";
    const n = points.length;
    const dx = [];
    const dy = [];
    const slope = [];
    for (let i = 0; i < n - 1; i++) {
      dx[i] = points[i + 1].x - points[i].x;
      dy[i] = points[i + 1].y - points[i].y;
      slope[i] = dy[i] / (dx[i] || 1);
    }
    const m = [slope[0]];
    for (let i = 1; i < n - 1; i++) {
      if (slope[i - 1] * slope[i] <= 0) m[i] = 0;
      else m[i] = (slope[i - 1] + slope[i]) / 2;
    }
    m[n - 1] = slope[n - 2];
    for (let i = 0; i < n - 1; i++) {
      if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / slope[i];
      const b = m[i + 1] / slope[i];
      const h = Math.hypot(a, b);
      if (h > 3) { m[i] = (3 * a * slope[i]) / h; m[i + 1] = (3 * b * slope[i]) / h; }
    }
    let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const c1x = points[i].x + dx[i] / 3;
      const c1y = points[i].y + (m[i] * dx[i]) / 3;
      const c2x = points[i + 1].x - dx[i] / 3;
      const c2y = points[i + 1].y - (m[i + 1] * dx[i]) / 3;
      d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${points[i + 1].x.toFixed(1)},${points[i + 1].y.toFixed(1)}`;
    }
    return d;
  }

  // Which x-axis ticks to label: evenly thinned, always including the newest
  // point, and never letting two labels sit closer than `minGap` pixels.
  function axisIndices(count, innerW, minGap, xFn) {
    const every = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(innerW / minGap))));
    const keep = [];
    for (let i = 0; i < count; i++) if (i % every === 0) keep.push(i);
    const last = count - 1;
    if (keep[keep.length - 1] !== last) keep.push(last);
    while (keep.length > 1 && xFn(last) - xFn(keep[keep.length - 2]) < minGap) {
      keep.splice(keep.length - 2, 1);
    }
    return keep;
  }

  function roundedTopBar(x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h));
    return `M${x.toFixed(1)},${(y + h).toFixed(1)}V${(y + radius).toFixed(1)}a${radius},${radius} 0 0 1 ${radius},${-radius}h${(w - radius * 2).toFixed(1)}a${radius},${radius} 0 0 1 ${radius},${radius}V${(y + h).toFixed(1)}Z`;
  }

  /* ------------------------------------------------------------------ *
   * Renderers                                                            *
   * ------------------------------------------------------------------ */
  function renderLine(el, spec, width) {
    const labels = spec.labels || [];
    const series = (spec.series || []).filter((s) => s && (s.values || []).length);
    if (!labels.length || !series.length) {
      el.innerHTML = '<div class="chart-empty">No data yet</div>';
      return;
    }
    const id = `pyc${++uid}`;
    const W = Math.max(260, Math.round(width));
    const H = Math.max(170, Math.round(spec.height || (W < 420 ? 190 : 225)));
    const pad = { l: 36, r: 12, t: 16, b: 26 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const count = labels.length;
    const peak = Math.max(1, ...series.flatMap((s) => (s.values || []).map(num)));
    const max = niceMax(peak);
    const x = (i) => pad.l + (count === 1 ? innerW / 2 : (i / (count - 1)) * innerW);
    const y = (v) => pad.t + innerH - (num(v) / max) * innerH;

    let svg = "";
    // Grid + Y labels
    [0, 0.25, 0.5, 0.75, 1].forEach((ratio) => {
      const yy = pad.t + innerH * ratio;
      svg += `<line class="pychart__grid" x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${W - pad.r}" y2="${yy.toFixed(1)}"/>`;
      if (ratio === 0 || ratio === 0.5 || ratio === 1) {
        svg += `<text class="pychart__axis" x="${pad.l - 7}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end">${compact(max * (1 - ratio))}</text>`;
      }
    });

    // Series: gradient area + smooth line
    series.forEach((s, si) => {
      const values = (s.values || []).map(num);
      const points = values.map((v, i) => ({ x: x(i), y: y(v) }));
      const line = smoothPath(points);
      const area = `${line}L${x(count - 1).toFixed(1)},${(pad.t + innerH).toFixed(1)}L${x(0).toFixed(1)},${(pad.t + innerH).toFixed(1)}Z`;
      const gid = `${id}-g${si}`;
      svg += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${s.color}" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/>
      </linearGradient></defs>`;
      svg += `<path class="pychart__area" d="${area}" fill="url(#${gid})"/>`;
      // pathLength=1 makes the draw-in animation exact for any path shape.
      svg += `<path class="pychart__line" d="${line}" stroke="${s.color}" stroke-width="2.4" pathLength="1" style="stroke-dasharray:1;--pychart-len:1"/>`;
      // Last point always visible — "where we are right now".
      const lastX = x(count - 1);
      const lastY = y(values[count - 1]);
      svg += `<circle class="pychart__last-dot" cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3.4" fill="${s.color}" color="${s.color}"/>`;
    });

    // Crosshair + per-series hover markers
    svg += `<line class="pychart__crosshair" data-crosshair x1="0" y1="${pad.t}" x2="0" y2="${pad.t + innerH}"/>`;
    series.forEach((s) => {
      svg += `<circle class="pychart__marker" data-marker r="4.4" fill="${s.color}" stroke="#121825" stroke-width="2"/>`;
    });

    // X labels — thinned out, and never overlapping the always-shown last one
    axisIndices(count, innerW, 58, x).forEach((i) => {
      const anchor = i === count - 1 ? "end" : "middle";
      const cls = i === count - 1 ? "pychart__axis pychart__axis--strong" : "pychart__axis";
      svg += `<text class="${cls}" x="${x(i).toFixed(1)}" y="${H - 7}" text-anchor="${anchor}">${esc(labels[i])}</text>`;
    });

    svg += `<rect class="pychart__hit" data-hit x="${pad.l}" y="${pad.t}" width="${innerW}" height="${innerH}"/>`;

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(spec.ariaLabel || "Trend chart")}">${svg}</svg>`;
    el.classList.toggle("pychart--animate", !REDUCED_MOTION.matches);

    // --- interaction -------------------------------------------------
    const svgEl = el.querySelector("svg");
    const crosshair = el.querySelector("[data-crosshair]");
    const markers = [...el.querySelectorAll("[data-marker]")];

    const toIndex = (clientX) => {
      const box = svgEl.getBoundingClientRect();
      const scale = box.width / W;
      const px = (clientX - box.left) / (scale || 1);
      const ratio = count === 1 ? 0 : (px - pad.l) / innerW;
      return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
    };

    const move = (event) => {
      const i = toIndex(event.clientX);
      el.classList.add("is-hot");
      const cx = x(i);
      crosshair.setAttribute("x1", cx.toFixed(1));
      crosshair.setAttribute("x2", cx.toFixed(1));
      series.forEach((s, si) => {
        const v = num((s.values || [])[i]);
        markers[si].setAttribute("cx", cx.toFixed(1));
        markers[si].setAttribute("cy", y(v).toFixed(1));
      });
      const rows = series
        .map((s) => `<span class="pychart-tip__row"><i class="pychart-tip__dot" style="background:${s.color}"></i>${esc(s.name || "Value")}<b class="pychart-tip__val">${full((s.values || [])[i])}</b></span>`)
        .join("");
      showTip(`<span class="pychart-tip__title">${esc(labels[i])}</span>${rows}`, event.clientX, event.clientY);
    };

    const leave = () => { el.classList.remove("is-hot"); hideTip(); };

    el.addEventListener("pointermove", move);
    el.addEventListener("pointerdown", move);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointercancel", leave);
  }

  function renderBar(el, spec, width) {
    const labels = spec.labels || [];
    const values = (spec.values || []).map(num);
    if (!values.length) {
      el.innerHTML = '<div class="chart-empty">No data yet</div>';
      return;
    }
    const id = `pyc${++uid}`;
    const color = spec.color || CHART_COLORS.mint;
    const W = Math.max(240, Math.round(width));
    const H = Math.max(150, Math.round(spec.height || (W < 420 ? 170 : 190)));
    const pad = { l: 30, r: 8, t: 14, b: 24 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const n = values.length;
    const max = niceMax(Math.max(1, ...values));
    const slot = innerW / n;
    const barW = Math.max(3, Math.min(26, slot * 0.62));
    const baseY = pad.t + innerH;

    let svg = `<defs><linearGradient id="${id}-g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.35"/>
    </linearGradient></defs>`;

    [0, 0.5, 1].forEach((ratio) => {
      const yy = pad.t + innerH * ratio;
      svg += `<line class="pychart__grid" x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${W - pad.r}" y2="${yy.toFixed(1)}"/>`;
      svg += `<text class="pychart__axis" x="${pad.l - 6}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end">${compact(max * (1 - ratio))}</text>`;
    });

    const geo = [];
    values.forEach((v, i) => {
      const h = v > 0 ? Math.max(3, (innerH * v) / max) : 2;
      const bx = pad.l + slot * i + (slot - barW) / 2;
      const by = baseY - h;
      geo.push({ bx, by, h, v, i });
      const isLast = i === n - 1;
      svg += `<g class="pychart__bar-group" style="animation-delay:${Math.min(240, i * 14)}ms">
        <path class="pychart__bar" data-bar="${i}" d="${roundedTopBar(bx, by, barW, h, Math.min(5, barW / 2))}" fill="url(#${id}-g)" opacity="${v ? 1 : 0.28}"${isLast ? ' stroke="' + color + '" stroke-width="0.8"' : ""}/>
      </g>`;
    });

    svg += `<line class="pychart__baseline" x1="${pad.l}" y1="${baseY}" x2="${W - pad.r}" y2="${baseY}"/>`;

    const barX = (i) => pad.l + slot * i + slot / 2;
    axisIndices(n, innerW, 46, barX).forEach((i) => {
      const cls = i === n - 1 ? "pychart__axis pychart__axis--strong" : "pychart__axis";
      svg += `<text class="${cls}" x="${barX(i).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(labels[i] ?? "")}</text>`;
    });

    // Full-height hit areas so thin bars are still easy to hit on a phone.
    geo.forEach(({ i }) => {
      svg += `<rect class="pychart__bar-hit" data-hit-bar="${i}" x="${(pad.l + slot * i).toFixed(1)}" y="${pad.t}" width="${slot.toFixed(1)}" height="${innerH}"/>`;
    });

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(spec.ariaLabel || "Bar chart")}">${svg}</svg>`;
    el.classList.toggle("pychart--animate", !REDUCED_MOTION.matches);

    const bars = [...el.querySelectorAll("[data-bar]")];
    const activate = (event) => {
      const hit = event.target.closest("[data-hit-bar]");
      if (!hit) return;
      const i = Number(hit.dataset.hitBar);
      el.classList.add("is-hot");
      bars.forEach((bar, bi) => bar.classList.toggle("is-active", bi === i));
      showTip(
        `<span class="pychart-tip__title">${esc(labels[i] ?? "")}</span>` +
        `<span class="pychart-tip__row"><i class="pychart-tip__dot" style="background:${color}"></i>${esc(spec.name || "Count")}<b class="pychart-tip__val">${full(values[i])}</b></span>`,
        event.clientX,
        event.clientY
      );
    };
    const leave = () => {
      el.classList.remove("is-hot");
      bars.forEach((bar) => bar.classList.remove("is-active"));
      hideTip();
    };
    el.addEventListener("pointermove", activate);
    el.addEventListener("pointerdown", activate);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointercancel", leave);
  }

  function renderDonut(el, spec, width) {
    const segments = (spec.segments || []).map((s) => ({ ...s, value: num(s.value) }));
    const total = segments.reduce((sum, s) => sum + s.value, 0);
    if (!total) {
      el.innerHTML = '<div class="chart-empty">No data yet</div>';
      return;
    }
    const size = Math.max(112, Math.min(168, Math.round(width || 150)));
    const c = size / 2;
    const stroke = Math.max(13, Math.round(size * 0.115));
    const r = c - stroke / 2 - 3;
    const C = 2 * Math.PI * r;
    const gap = segments.filter((s) => s.value > 0).length > 1 ? 2.2 : 0;

    let svg = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(148,163,184,.1)" stroke-width="${stroke}"/>`;
    let offset = 0;
    segments.forEach((seg, i) => {
      if (!seg.value) return;
      const frac = seg.value / total;
      const len = Math.max(0, frac * C - gap);
      svg += `<circle class="pychart__seg" data-seg="${i}" cx="${c}" cy="${c}" r="${r}" fill="none"
        stroke="${seg.color}" stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}"
        stroke-dashoffset="${(-offset * C).toFixed(1)}"
        style="pointer-events:stroke"
        transform="rotate(-90 ${c} ${c})"/>`;
      offset += frac;
    });
    svg += `<text class="pychart__center-value" data-center-value x="${c}" y="${c - 1}" text-anchor="middle" font-size="${Math.round(size * 0.165)}">${compact(total)}</text>`;
    svg += `<text class="pychart__center-label" data-center-label x="${c}" y="${c + 15}" text-anchor="middle">${esc(spec.centerLabel || "total")}</text>`;

    const legend = segments
      .map((s) => {
        const pct = total ? Math.round((s.value / total) * 100) : 0;
        return `<div class="donut-legend__row"><span class="swatch" style="background:${s.color}"></span>${esc(s.label)}<strong>${full(s.value)} <em style="font-style:normal;color:#6f7b91;font-weight:600">${pct}%</em></strong></div>`;
      })
      .join("");

    el.innerHTML = `<svg viewBox="0 0 ${size} ${size}" height="${size}" role="img" aria-label="${esc(spec.ariaLabel || "Share chart")}">${svg}</svg>`;
    el.classList.toggle("pychart--animate", !REDUCED_MOTION.matches);
    el.dataset.legend = "";
    if (el.parentElement && el.parentElement.classList.contains("donut-wrap")) {
      const holder = el.parentElement.querySelector(".donut-legend");
      if (holder) holder.innerHTML = legend;
    }

    const segEls = [...el.querySelectorAll("[data-seg]")];
    const centerValue = el.querySelector("[data-center-value]");
    const centerLabel = el.querySelector("[data-center-label]");
    const over = (event) => {
      const node = event.target.closest("[data-seg]");
      if (!node) return;
      const i = Number(node.dataset.seg);
      const seg = segments[i];
      el.classList.add("is-hot");
      segEls.forEach((s) => s.classList.toggle("is-active", s === node));
      centerValue.textContent = compact(seg.value);
      centerLabel.textContent = String(seg.label).slice(0, 14);
      showTip(
        `<span class="pychart-tip__row"><i class="pychart-tip__dot" style="background:${seg.color}"></i>${esc(seg.label)}<b class="pychart-tip__val">${full(seg.value)} · ${Math.round((seg.value / total) * 100)}%</b></span>`,
        event.clientX,
        event.clientY
      );
    };
    const leave = () => {
      el.classList.remove("is-hot");
      segEls.forEach((s) => s.classList.remove("is-active"));
      centerValue.textContent = compact(total);
      centerLabel.textContent = spec.centerLabel || "total";
      hideTip();
    };
    el.addEventListener("pointermove", over);
    el.addEventListener("pointerdown", over);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointercancel", leave);
  }

  const RENDERERS = { line: renderLine, bar: renderBar, donut: renderDonut };

  /* ------------------------------------------------------------------ *
   * Hydration + resize handling                                          *
   * ------------------------------------------------------------------ */
  function measure(el) {
    let width = el.clientWidth;
    if (!width && el.parentElement) width = el.parentElement.clientWidth;
    return width || 320;
  }

  function draw(el) {
    const spec = el.__pychart;
    if (!spec) return;
    const width = measure(el);
    if (!width) return;
    el.__pychartWidth = width;
    const render = RENDERERS[spec.type] || renderLine;
    render(el, spec, spec.type === "donut" ? Math.min(width, 168) : width);
  }

  let resizeObserver = null;
  let resizeQueue = new Set();
  let resizeScheduled = false;

  function flushResize() {
    resizeScheduled = false;
    const batch = [...resizeQueue];
    resizeQueue.clear();
    batch.forEach((el) => {
      if (!el.isConnected) return;
      const width = measure(el);
      if (Math.abs(width - (el.__pychartWidth || 0)) < 8) return;
      draw(el);
    });
  }

  function watch(el) {
    if (!("ResizeObserver" in window)) return;
    if (!resizeObserver) {
      resizeObserver = new ResizeObserver((entries) => {
        entries.forEach((entry) => resizeQueue.add(entry.target));
        if (resizeScheduled) return;
        resizeScheduled = true;
        requestAnimationFrame(flushResize);
      });
    }
    resizeObserver.observe(el);
  }

  function mount(el, spec) {
    if (!el) return;
    el.classList.add("pychart");
    el.__pychart = spec;
    draw(el);
    watch(el);
  }

  // Hydrates any markup produced by the string helpers below.
  function hydrate() {
    document.querySelectorAll(".pychart[data-pychart]").forEach((el) => {
      let spec = null;
      try { spec = JSON.parse(el.dataset.pychart); } catch (err) { spec = null; }
      el.removeAttribute("data-pychart");
      if (spec) mount(el, spec);
    });
  }

  let hydrateScheduled = false;
  function scheduleHydrate() {
    if (hydrateScheduled) return;
    hydrateScheduled = true;
    requestAnimationFrame(() => {
      hydrateScheduled = false;
      hydrate();
      // Safety net for callers that insert the markup a tick later.
      window.setTimeout(hydrate, 120);
    });
  }

  function html(spec) {
    const minHeight = spec.type === "donut" ? 150 : spec.height || 190;
    scheduleHydrate();
    return `<div class="pychart" data-pychart='${esc(JSON.stringify(spec))}' style="min-height:${minHeight}px"></div>`;
  }

  return { mount, html, hydrate, compact, full, hideTip };
})();

/* --------------------------------------------------------------------- *
 * Backwards-compatible helpers (same names/signatures as before)         *
 * --------------------------------------------------------------------- */

// Vertical bar chart. labels + values must be same-length arrays.
function svgBarChart(labels, values, opts = {}) {
  if (!values || !values.length) return `<div class="chart-empty">No data yet</div>`;
  return PyChart.html({
    type: "bar",
    labels: labels || [],
    values,
    color: opts.color || CHART_COLORS.mint,
    name: opts.name || "Count",
    height: opts.height,
    ariaLabel: opts.ariaLabel,
  });
}

// Donut chart. segments: [{ label, value, color }]
function svgDonut(segments, opts = {}) {
  const list = (segments || []).filter(Boolean);
  const total = list.reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  if (!total) return `<div class="chart-empty">No data yet</div>`;
  return `<div class="donut-wrap">${PyChart.html({
    type: "donut",
    segments: list,
    centerLabel: opts.centerLabel || "total",
    ariaLabel: opts.ariaLabel,
  })}<div class="donut-legend"></div></div>`;
}

// Smooth multi-series line chart. series: [{ name, values, color }]
function svgLineChart(labels, series, opts = {}) {
  if (!labels || !labels.length || !series || !series.length) return `<div class="chart-empty">No data yet</div>`;
  return PyChart.html({
    type: "line",
    labels,
    series,
    height: opts.height,
    ariaLabel: opts.ariaLabel || "Growth overview chart",
  });
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
  const counts = Object.create(null);
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

window.PyChart = PyChart;
