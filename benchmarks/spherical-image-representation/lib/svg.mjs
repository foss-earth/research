/**
 * Static SVG charts with no dependency, for the report. One visual system:
 * the colours are a validated categorical palette assigned in a fixed order,
 * each with a light and a dark value chosen by the viewer's colour scheme;
 * text is never coloured; grids are hairlines; a legend names every series,
 * and the results CSV each chart is drawn from is its table view.
 *
 * Marks carry a <title>, which a browser shows on hover when the SVG file is
 * opened on its own.
 */

/** Categorical slots, light then dark: blue, orange, aqua, yellow, magenta, green, violet, red. */
const SLOTS = [
  ["#2a78d6", "#3987e5"], ["#eb6834", "#d95926"], ["#1baf7a", "#199e70"], ["#eda100", "#c98500"],
  ["#e87ba4", "#d55181"], ["#008300", "#008300"], ["#4a3aa7", "#9085e9"], ["#e34948", "#e66767"],
];
const STYLE = `
  :root { --surface: #fcfcfb; --ink: #0b0b0b; --ink2: #52514e; --muted: #898781; --grid: #e1e0d9; --axis: #c3c2b7; --quiet: #b5b3ab;
${SLOTS.map((slot, i) => `    --s${i + 1}: ${slot[0]};`).join("\n")} }
  @media (prefers-color-scheme: dark) {
    :root { --surface: #1a1a19; --ink: #ffffff; --ink2: #c3c2b7; --muted: #898781; --grid: #2c2c2a; --axis: #383835; --quiet: #5c5b56;
${SLOTS.map((slot, i) => `      --s${i + 1}: ${slot[1]};`).join("\n")} }
  }
  text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 12px; fill: var(--ink2); }
  .title { font-size: 15px; font-weight: 600; fill: var(--ink); }
  .subtitle { font-size: 12px; fill: var(--ink2); }
  .panel-title { font-size: 12.5px; font-weight: 600; fill: var(--ink); }
  .tick { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  .value { font-size: 11.5px; fill: var(--ink); font-variant-numeric: tabular-nums; }
  .note { font-size: 11px; fill: var(--muted); }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis { stroke: var(--axis); stroke-width: 1; }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .dot { stroke: var(--surface); stroke-width: 2; }
`;
const colour = slot => (slot === "quiet" ? "var(--quiet)" : `var(--s${slot})`);
const escape = text => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const n = value => Number(value.toFixed(2));
/** A rough width of text in the system sans, for placing labels. */
export const textWidth = (text, size = 12) => String(text).length * size * 0.56;

export const linear = (domain, range) => value => range[0] + (value - domain[0]) / (domain[1] - domain[0]) * (range[1] - range[0]);
export const logarithmic = (domain, range) => value => range[0] + (Math.log(value) - Math.log(domain[0])) / (Math.log(domain[1]) - Math.log(domain[0])) * (range[1] - range[0]);

/** Round tick values covering a range, about `count` of them. */
export function niceTicks(low, high, count = 5) {
  const raw = (high - low) / count, magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(candidate => candidate >= raw);
  const ticks = [];
  for (let value = Math.ceil(low / step - 1e-9) * step; value <= high + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

/** A figure: a title block, then whatever the caller draws below it. */
export class Figure {
  constructor({ width = 760, title, subtitle = "" }) {
    this.width = width; this.parts = []; this.cursor = 0;
    this.text(16, 24, title, "title");
    this.cursor = 34;
    for (const line of wrap(subtitle, width - 32, 12)) { this.text(16, this.cursor + 10, line, "subtitle"); this.cursor += 17; }
    this.cursor += 10;
  }
  text(x, y, content, className = "", anchor = "start", extra = "") { this.parts.push(`<text x="${n(x)}" y="${n(y)}" class="${className}" text-anchor="${anchor}"${extra}>${escape(content)}</text>`); }
  raw(markup) { this.parts.push(markup); }
  /** A row of legend keys starting at y; returns the height used. */
  legend(items, y, { x = 16, line = true } = {}) {
    let cx = x, cy = y;
    for (const item of items) {
      const w = 26 + textWidth(item.name) + 18;
      if (cx + w > this.width - 8 && cx > x) { cx = x; cy += 20; }
      this.parts.push(line
        ? `<line x1="${n(cx)}" y1="${n(cy)}" x2="${n(cx + 18)}" y2="${n(cy)}" class="line" stroke="${colour(item.slot)}"/><circle cx="${n(cx + 9)}" cy="${n(cy)}" r="4" class="dot" fill="${colour(item.slot)}"/>`
        : `<rect x="${n(cx + 3)}" y="${n(cy - 6)}" width="12" height="12" rx="2" fill="${colour(item.slot)}"/>`);
      this.text(cx + 24, cy + 4, item.name);
      cx += w;
    }
    return cy - y + 22;
  }
  /** Small grey lines of explanation under the charts. */
  notes(lines) {
    for (const line of lines.flatMap(text => wrap(text, this.width - 32, 11))) { this.text(16, this.cursor + 10, line, "note"); this.cursor += 15; }
    this.cursor += 6;
  }
  toString() {
    const height = Math.ceil(this.cursor + 8);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${height}" viewBox="0 0 ${this.width} ${height}" role="img">\n<style>${STYLE}</style>\n<rect width="100%" height="100%" fill="var(--surface)"/>\n${this.parts.join("\n")}\n</svg>\n`;
  }
}

function wrap(text, width, size) {
  if (!text) return [];
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && textWidth(`${line} ${word}`, size) > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Lines in a box. `spec`: `{ title, x: { label, log, domain, ticks: [{ value, label }] },
 * y: { label, domain, ticks: [number] | [{ value, label }] }, series: [{ name, slot,
 * points: [[x, y]], endLabel }] }`. Points outside the y domain are dropped.
 */
export function linePanel(figure, box, spec) {
  // The panel's title, then the y axis's unit on its own line, then the plot.
  const { x, y, w, h } = box, left = x + 44, right = x + w - (spec.endLabels ? spec.endLabels : 10), top = y + (spec.title ? 20 : 0) + (spec.y.label ? 22 : 8), bottom = y + h - 34;
  const sx = (spec.x.log ? logarithmic : linear)(spec.x.domain, [left, right]), sy = linear(spec.y.domain, [bottom, top]);
  if (spec.title) figure.text(x, y + 12, spec.title, "panel-title");
  for (const tick of spec.y.ticks.map(t => (typeof t === "number" ? { value: t, label: String(t) } : t))) {
    figure.raw(`<line x1="${n(left)}" y1="${n(sy(tick.value))}" x2="${n(right)}" y2="${n(sy(tick.value))}" class="grid"/>`);
    figure.text(left - 6, sy(tick.value) + 4, tick.label, "tick", "end");
  }
  figure.raw(`<line x1="${n(left)}" y1="${n(bottom)}" x2="${n(right)}" y2="${n(bottom)}" class="axis"/>`);
  for (const tick of spec.x.ticks) {
    figure.raw(`<line x1="${n(sx(tick.value))}" y1="${n(bottom)}" x2="${n(sx(tick.value))}" y2="${n(bottom + 4)}" class="axis"/>`);
    figure.text(sx(tick.value), bottom + 16, tick.label, "tick", "middle");
  }
  if (spec.x.label) figure.text((left + right) / 2, bottom + 31, spec.x.label, "tick", "middle");
  if (spec.y.label) figure.text(x, top - 10, spec.y.label, "tick");
  const labels = [];
  // Quiet series first, so the series the panel is about is drawn over them.
  for (const series of [...spec.series].sort((a, b) => (a.slot === "quiet" ? 0 : 1) - (b.slot === "quiet" ? 0 : 1))) {
    const points = series.points.filter(([px, py]) => py !== null && Number.isFinite(py) && py >= spec.y.domain[0] - 1e-9 && py <= spec.y.domain[1] + 1e-9 && px >= spec.x.domain[0] && px <= spec.x.domain[1]);
    if (!points.length) continue;
    const path = points.map(([px, py], i) => `${i ? "L" : "M"}${n(sx(px))} ${n(sy(py))}`).join(" ");
    figure.raw(`<path d="${path}" class="line" stroke="${colour(series.slot)}"${series.step ? "" : ""}><title>${escape(series.name)}</title></path>`);
    if (series.markers !== false) for (const [px, py] of points) figure.raw(`<circle cx="${n(sx(px))}" cy="${n(sy(py))}" r="${series.slot === "quiet" ? 3 : 4}" class="dot" fill="${colour(series.slot)}"><title>${escape(`${series.name}: ${spec.x.format ? spec.x.format(px) : px}, ${spec.y.format ? spec.y.format(py) : n(py)}`)}</title></circle>`);
    if (series.endLabel) labels.push({ text: series.endLabel, x: sx(points.at(-1)[0]) + 8, y: sy(points.at(-1)[1]) + 4 });
  }
  // End labels that would overlap are moved apart only a little; charts with crowded ends use the legend instead.
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
  for (const label of labels) figure.text(label.x, label.y, label.text, "value");
}

/**
 * Horizontal bars, one per row, from a baseline. `spec`: `{ title, domain, baseline,
 * ticks: [{ value, label }], label, rows: [{ label, value, text, slot }] }`.
 * Returns the height drawn.
 */
export function barPanel(figure, box, spec) {
  const { x, y, w } = box, labelWidth = spec.labelWidth ?? 150, left = x + labelWidth, right = x + w - (spec.valueWidth ?? 64), rowHeight = spec.rowHeight ?? 24, bar = Math.min(16, rowHeight - 8);
  const top = y + (spec.title ? 22 : 4), bottom = top + spec.rows.length * rowHeight;
  const sx = linear(spec.domain, [left, right]), zero = sx(spec.baseline ?? 0);
  if (spec.title) figure.text(x, y + 12, spec.title, "panel-title");
  for (const tick of spec.ticks) {
    figure.raw(`<line x1="${n(sx(tick.value))}" y1="${n(top)}" x2="${n(sx(tick.value))}" y2="${n(bottom)}" class="grid"/>`);
    figure.text(sx(tick.value), bottom + 15, tick.label, "tick", "middle");
  }
  spec.rows.forEach((row, i) => {
    const cy = top + i * rowHeight + rowHeight / 2;
    figure.text(left - 8, cy + 4, row.label, row.emphasis ? "value" : "", "end");
    if (row.value === null || row.value === undefined) { figure.text(zero + 6, cy + 4, row.text ?? "not measured", "note"); return; }
    const end = sx(Math.max(spec.domain[0], Math.min(spec.domain[1], row.value))), from = Math.min(zero, end), length = Math.abs(end - zero);
    // Square at the baseline, rounded at the data end.
    const r = Math.min(4, length), positive = end >= zero;
    const d = positive
      ? `M${n(from)} ${n(cy - bar / 2)} H${n(end - r)} Q${n(end)} ${n(cy - bar / 2)} ${n(end)} ${n(cy - bar / 2 + r)} V${n(cy + bar / 2 - r)} Q${n(end)} ${n(cy + bar / 2)} ${n(end - r)} ${n(cy + bar / 2)} H${n(from)} Z`
      : `M${n(zero)} ${n(cy - bar / 2)} H${n(end + r)} Q${n(end)} ${n(cy - bar / 2)} ${n(end)} ${n(cy - bar / 2 + r)} V${n(cy + bar / 2 - r)} Q${n(end)} ${n(cy + bar / 2)} ${n(end + r)} ${n(cy + bar / 2)} H${n(zero)} Z`;
    figure.raw(`<path d="${d}" fill="${colour(row.slot ?? 1)}"><title>${escape(`${row.label}: ${row.text ?? row.value}`)}</title></path>`);
    // A bar that runs left of the baseline is labelled on the baseline's free side, clear of the row's name.
    if (row.text) figure.text(positive ? end + 6 : zero + 6, cy + 4, row.text, "value");
  });
  figure.raw(`<line x1="${n(zero)}" y1="${n(top)}" x2="${n(zero)}" y2="${n(bottom)}" class="axis"/>`);
  if (spec.label) figure.text((left + right) / 2, bottom + 31, spec.label, "tick", "middle");
  return bottom + (spec.label ? 38 : 22) - y;
}

/**
 * One row per item: a thin band from `low` to `high`, whiskers to `min` and `max`,
 * and a dot at `mark`. `spec`: `{ title, domain, log, ticks, label, rows: [{ label,
 * min, low, mark, high, max, text }] }`. Returns the height drawn.
 */
export function rangePanel(figure, box, spec) {
  const { x, y, w } = box, labelWidth = spec.labelWidth ?? 150, left = x + labelWidth, right = x + w - (spec.valueWidth ?? 120), rowHeight = 24;
  const top = y + (spec.title ? 22 : 4), bottom = top + spec.rows.length * rowHeight;
  const sx = (spec.log ? logarithmic : linear)(spec.domain, [left, right]), clamp = value => Math.max(spec.domain[0], Math.min(spec.domain[1], value));
  if (spec.title) figure.text(x, y + 12, spec.title, "panel-title");
  for (const tick of spec.ticks) {
    figure.raw(`<line x1="${n(sx(tick.value))}" y1="${n(top)}" x2="${n(sx(tick.value))}" y2="${n(bottom)}" class="${tick.reference ? "axis" : "grid"}"/>`);
    figure.text(sx(tick.value), bottom + 15, tick.label, "tick", "middle");
  }
  spec.rows.forEach((row, i) => {
    const cy = top + i * rowHeight + rowHeight / 2, slot = row.slot ?? 1;
    figure.text(left - 8, cy + 4, row.label, "", "end");
    if (row.min !== undefined) figure.raw(`<line x1="${n(sx(clamp(row.min)))}" y1="${n(cy)}" x2="${n(sx(clamp(row.max)))}" y2="${n(cy)}" stroke="${colour(slot)}" stroke-width="1.5" opacity="0.55"/>`);
    figure.raw(`<rect x="${n(sx(clamp(row.low)))}" y="${n(cy - 4)}" width="${n(Math.max(2, sx(clamp(row.high)) - sx(clamp(row.low))))}" height="8" rx="3" fill="${colour(slot)}"><title>${escape(`${row.label}: ${row.text ?? ""}`)}</title></rect>`);
    if (row.mark !== undefined) figure.raw(`<circle cx="${n(sx(clamp(row.mark)))}" cy="${n(cy)}" r="4.5" class="dot" fill="var(--ink)"/>`);
    if (row.text) figure.text(right + 10, cy + 4, row.text, "value");
  });
  if (spec.label) figure.text((left + right) / 2, bottom + 31, spec.label, "tick", "middle");
  return bottom + (spec.label ? 38 : 22) - y;
}

/**
 * Horizontal stacked bars: `rows: [{ label, segments: [{ value, slot, name }], text }]`,
 * touching segments separated by a gap in the surface colour. Returns the height drawn.
 */
export function stackPanel(figure, box, spec) {
  const { x, y, w } = box, labelWidth = spec.labelWidth ?? 200, left = x + labelWidth, right = x + w - (spec.valueWidth ?? 110), rowHeight = 24, bar = 14;
  const top = y + (spec.title ? 22 : 4), bottom = top + spec.rows.length * rowHeight;
  const sx = linear(spec.domain, [left, right]);
  if (spec.title) figure.text(x, y + 12, spec.title, "panel-title");
  for (const tick of spec.ticks) {
    figure.raw(`<line x1="${n(sx(tick.value))}" y1="${n(top)}" x2="${n(sx(tick.value))}" y2="${n(bottom)}" class="grid"/>`);
    figure.text(sx(tick.value), bottom + 15, tick.label, "tick", "middle");
  }
  spec.rows.forEach((row, i) => {
    const cy = top + i * rowHeight + rowHeight / 2;
    figure.text(left - 8, cy + 4, row.label, "", "end");
    let at = spec.domain[0];
    row.segments.forEach((segment, k) => {
      const from = sx(at) + (k ? 2 : 0), to = sx(Math.min(spec.domain[1], at + segment.value));
      if (to - from > 0.5) figure.raw(`<rect x="${n(from)}" y="${n(cy - bar / 2)}" width="${n(to - from)}" height="${bar}" rx="2" fill="${colour(segment.slot)}"><title>${escape(`${row.label}, ${segment.name}: ${segment.text ?? segment.value}`)}</title></rect>`);
      at += segment.value;
    });
    if (row.text) figure.text(sx(Math.min(spec.domain[1], at)) + 6, cy + 4, row.text, "value");
  });
  figure.raw(`<line x1="${n(left)}" y1="${n(top)}" x2="${n(left)}" y2="${n(bottom)}" class="axis"/>`);
  if (spec.label) figure.text((left + right) / 2, bottom + 31, spec.label, "tick", "middle");
  return bottom + (spec.label ? 38 : 22) - y;
}

/** Reads a results CSV into objects, numbers where they are numbers. */
export function parseCsv(text) {
  const rows = [];
  let field = "", row = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; }
    else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map(values => Object.fromEntries(header.map((key, i) => [key, values[i] === "" || values[i] === undefined ? null : Number.isFinite(Number(values[i])) && values[i].trim() !== "" ? Number(values[i]) : values[i]])));
}
