"use strict";

// Per-group HTML reports: before/after colour patches, end-of-exposure summary,
// replicate table, curve fits, charts, overview images and the images matched to each measurement.
// Reports are self-contained .html files (print them to PDF from the browser).

let reportRefData = "curves"; // the user's last choice: reference curves only, or also their data sections

// Opens the report dialog with `groups` ticked, plus the visible reference groups so their curves
// appear on the charts. Any other group can be ticked there too.
function openReportDialog(groups) {
  const reportable = state.groups.filter((g) => includedMembers(g).length);
  if (!reportable.length) {
    setStatus("No groups with loaded measurements to report on.");
    return;
  }
  const option = (g) => el("label", {},
    el("input", { type: "checkbox", value: g.id }),
    swatch(g), el("span", { class: "name" }, wrapName(g.name)),
    isRef(g) ? el("span", { class: "badge", title: ROLES[g.role] }, ROLE_SHORT[g.role]) : null,
    el("span", { class: "muted small" }, `n=${includedMembers(g).length}`));
  const samples = reportable.filter((g) => !isRef(g));
  const refs = reportable.filter(isRef);
  $("#rpGroups").replaceChildren(...(samples.length ? samples.map(option) : [el("span", { class: "muted small" }, "No sample groups.")]));
  // The section stays visible when there are no reference groups, with a hint on how to make one.
  $("#rpRefs").replaceChildren(...(refs.length ? refs.map(option) : [el("span", { class: "muted small" },
    "None yet. To add one, open a group's card in the side panel and set its Role to Blue Wool standard or Comparison.")]));
  $("#rpRefChoice").hidden = !refs.length;
  setReportPicks([...groups, ...refs.filter((g) => g.visible)]);
  // Opened from a reference group's own card: the report is about that group, so include its data
  // this time. Otherwise use the user's last choice.
  const fromRefCard = groups.length === 1 && isRef(groups[0]);
  document.querySelector(`input[name=rpRefData][value=${fromRefCard ? "sections" : reportRefData}]`).checked = true;
  if (!$("#rpTitle").value) $("#rpTitle").value = "Microfading report";
  $("#rpStatus").textContent = "";
  $("#reportDialog").showModal();
}

function setReportPicks(groups) {
  const ids = new Set(groups.map((g) => g.id));
  document.querySelectorAll("#rpGroups input, #rpRefs input").forEach((i) => { i.checked = ids.has(i.value); });
}

function pickedReportGroups() {
  const ids = new Set([...document.querySelectorAll("#rpGroups input:checked, #rpRefs input:checked")].map((i) => i.value));
  return state.groups.filter((g) => ids.has(g.id));
}

// ---------------------------------------------------------------------------
// Colour patches: CIELAB -> sRGB, gamut-mapped
// ---------------------------------------------------------------------------

// Reference whites (CIE 1931 2° observer, Y = 1) for the illuminant the L*a*b* is relative to.
const WHITES = {
  D65: [0.95047, 1, 1.08883], D50: [0.96422, 1, 0.82521], D55: [0.95682, 1, 0.92149], D75: [0.94972, 1, 1.22638],
  A: [1.0985, 1, 0.35585], C: [0.98074, 1, 1.18232], F2: [0.99187, 1, 0.67395], F7: [0.95044, 1, 1.08755], F11: [1.00966, 1, 0.6437],
};
const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const BRADFORD_INV = [[0.9869929, -0.1470543, 0.1599627], [0.4323053, 0.5183603, 0.0492912], [-0.0085287, 0.0400428, 0.9684867]];
const XYZ_TO_SRGB = [[3.2404542, -1.5371385, -0.4985314], [-0.969266, 1.8760108, 0.041556], [0.0556434, -0.2040259, 1.0572252]];

const mulVec = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const mulMat = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));

// The illuminant named in a file header ("D65", "D50/10", …) as a key of WHITES. Unknown names fall back to D65.
function whiteKey(illuminant) {
  const m = /(?:^|[^A-Z0-9])(D50|D55|D65|D75|F11|F2|F7|A|C)(?![A-Z0-9])/i.exec(illuminant || "");
  return m ? m[1].toUpperCase() : "D65";
}

// XYZ relative to the given white -> linear sRGB, with Bradford adaptation to D65 for other whites.
const srgbMatrices = new Map();
function srgbMatrix(key) {
  if (!srgbMatrices.has(key)) {
    const src = mulVec(BRADFORD, WHITES[key]);
    const dst = mulVec(BRADFORD, WHITES.D65);
    const scale = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? dst[i] / src[i] : 0)));
    srgbMatrices.set(key, key === "D65" ? XYZ_TO_SRGB : mulMat(XYZ_TO_SRGB, mulMat(BRADFORD_INV, mulMat(scale, BRADFORD))));
  }
  return srgbMatrices.get(key);
}

function labToLinearSrgb(L, a, b, key) {
  const kappa = 24389 / 27;
  const eps = 216 / 24389;
  const fy = (L + 16) / 116;
  const finv = (t) => (t ** 3 > eps ? t ** 3 : (116 * t - 16) / kappa);
  const w = WHITES[key];
  return mulVec(srgbMatrix(key), [w[0] * finv(fy + a / 500), L > kappa * eps ? fy ** 3 : L / kappa, w[2] * finv(fy - b / 200)]);
}

const inSrgbGamut = (rgb) => rgb.every((c) => c >= -1e-6 && c <= 1 + 1e-6);

// CIELAB -> an 8-bit sRGB colour for a patch. A colour outside the sRGB gamut is not clipped channel
// by channel (that shifts its hue and lightness); its chroma is reduced at the measured L* and hue
// until it fits. Returns the hex colour plus the measured and displayed chroma.
function labToSrgb(L, a, b, illuminant) {
  const key = whiteKey(illuminant);
  L = Math.min(100, Math.max(0, L));
  const chroma = Math.hypot(a, b);
  const hue = Math.atan2(b, a);
  const atChroma = (c) => labToLinearSrgb(L, c * Math.cos(hue), c * Math.sin(hue), key);
  let shown = chroma;
  let rgb = labToLinearSrgb(L, a, b, key);
  if (!inSrgbGamut(rgb)) {
    let lo = 0; // a neutral grey of any L* in 0–100 is always inside the gamut
    let hi = chroma;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (inSrgbGamut(atChroma(mid))) lo = mid;
      else hi = mid;
    }
    shown = lo;
    rgb = atChroma(lo);
  }
  const bytes = rgb.map((c) => {
    c = Math.min(1, Math.max(0, c));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  });
  return {
    hex: `#${bytes.map((v) => v.toString(16).padStart(2, "0")).join("")}`,
    chroma, shown, mapped: chroma - shown > 0.05, white: key,
  };
}

// Shorter metric names for the narrow summary tables.
const SHORT_LABEL = { dE2000: "ΔE00", dE76: "ΔE*ab" };

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// HTML version of wrapName() (app.js) for the report markup.
function wrapNameHtml(text) {
  return String(text).split(NAME_BREAKS).map(esc).join("<wbr>");
}

function startEndLab(columns) {
  const n = columns.L.length - 1;
  return {
    start: [columns.L[0], columns.a[0], columns.b[0]],
    end: [columns.L[n], columns.a[n], columns.b[n]],
  };
}

// One patch. It is an SVG fill rather than a CSS background, because browsers leave backgrounds
// out when printing unless "Background graphics" is ticked.
function patchFigure(caption, lab, illuminant) {
  const c = labToSrgb(...lab, illuminant);
  return `<figure>
    <svg class="patch" viewBox="0 0 3 2" preserveAspectRatio="none" role="img" aria-label="${esc(caption)} colour"><rect width="3" height="2" fill="${c.hex}"/></svg>
    <figcaption>${esc(caption)}<br>L* ${fmtNum(lab[0], 2)} · a* ${fmtNum(lab[1], 2)} · b* ${fmtNum(lab[2], 2)}<br>
      sRGB ${c.hex.toUpperCase()}${c.mapped ? ` <span class="gamut" title="Outside the sRGB gamut: chroma reduced to fit">C* ${fmtNum(c.chroma, 1)} → ${fmtNum(c.shown, 1)}†</span>` : ""}</figcaption>
  </figure>`;
}

function patchPair(label, start, end, illuminant, big = false) {
  return `<div class="patch-pair${big ? " big" : ""}">
    <div class="patch-label">${wrapNameHtml(label)}</div>
    <div class="patches">${patchFigure("Before", start, illuminant)}${patchFigure("After", end, illuminant)}</div>
  </div>`;
}

async function chartImage(metric, entry, opts) {
  const theme = THEMES.light;
  // Each group's charts also show the visible reference groups (Blue Wool standards, comparisons).
  const groups = [...opts.refs.filter((r) => r.group !== entry.group), entry];
  const traces = buildTraces(metric, { groups }, state.settings.view, theme, true);
  const layout = finishLayout(metric, traces, baseLayout(metric, theme, { exporting: true, legend: "bottom" }), theme);
  const div = await renderOffscreen(traces, layout, opts.width, opts.height);
  try {
    // SVG keeps reports small and sharp when printed.
    return await Plotly.toImage(div, { format: "svg", width: opts.width, height: opts.height });
  } finally {
    Plotly.purge(div);
    div.remove();
  }
}

async function groupSection(entry, opts) {
  const g = entry.group;
  const members = entry.replicates.map((r) => r.id);
  const ms = members.map((id) => state.measurements.get(id));
  const avg = entry.average;
  const dose = g.maxDose === "" ? Number(state.settings.max_dose) : Number(g.maxDose);
  const xLabel = X_LABELS[state.settings.x_axis];
  const parts = [];

  const dates = [...new Set(ms.map((m) => m.meta.Date).filter(Boolean))];
  const illum = [...new Set(ms.map((m) => m.meta.Illuminant).filter(Boolean))];
  parts.push(`<h2>${esc(g.name)}${isRef(g) ? ` <span class="role">${esc(ROLES[g.role])}</span>` : ""}</h2>
    <p class="meta">${members.length} measurement${members.length === 1 ? "" : "s"}
    ${state.settings.x_axis === "dose" ? ` · max dose ${fmtNum(dose, 3)} Mlux·h` : ""}
    ${illum.length ? ` · illuminant ${esc(illum.join(", "))}` : ""}
    ${dates.length ? ` · ${esc(dates.length === 1 ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`)}` : ""}</p>`);

  // Colour patches: group mean first, then each replicate.
  const labs = ms.filter((m) => m.columns.L && m.columns.a && m.columns.b)
    .map((m) => ({ id: m.id, illuminant: m.meta.Illuminant, ...startEndLab(m.columns) }));
  if (labs.length) {
    const mean = (k) => [0, 1, 2].map((i) => labs.reduce((s, l) => s + l[k][i], 0) / labs.length);
    const pairs = [patchPair(labs.length > 1 ? `Mean of ${labs.length}` : labs[0].id, mean("start"), mean("end"), labs[0].illuminant, true),
      ...(labs.length > 1 ? labs.map((l) => patchPair(l.id, l.start, l.end, l.illuminant)) : [])];
    const whites = [...new Set(labs.map((l) => whiteKey(l.illuminant)))];
    const adapted = whites.filter((w) => w !== "D65");
    parts.push(`<h3>Colour change</h3>
      <div class="patch-grid">${pairs.join("")}</div>
      <p class="note">Patches are sRGB renderings of the measured L*a*b* (${esc(whites.join(", "))}${adapted.length ? `, adapted to D65 with Bradford` : ""}).
      ${pairs.some((p) => p.includes('class="gamut"')) ? "† Outside the sRGB gamut: shown at the measured L* and hue with the chroma (C*) reduced until it fits, instead of being clipped. " : ""}
      On paper the result also depends on the printer, the paper and the print settings.</p>`);
  }

  // End-of-exposure summary and curve fits sit side by side.
  const summary = [];
  if (avg) {
    const keys = ["dE2000", "dE76", "dL", "da", "db", "L", "a", "b"].filter((k) => avg[k]);
    const last = avg.x.length - 1;
    summary.push(`<div>
      <h3>At end of exposure (${esc(xLabel)} = ${fmtNum(avg.x[last], state.settings.x_axis === "dose" ? 3 : 1)})</h3>
      <table><thead><tr><th>Metric</th><th>Mean</th><th>SD</th></tr></thead><tbody>
      ${keys.map((k) => `<tr><td>${esc(SHORT_LABEL[k] || METRIC_LABEL[k])}</td><td>${fmtNum(avg[k][last])}</td><td>${avg.n > 1 ? fmtNum(avg[k + "_sd"][last]) : "–"}</td></tr>`).join("")}
      </tbody></table>
      ${state.settings.smoothing !== "none" && state.settings.smooth_mode === "replace" ? `<p class="note">Values are after ${esc(SMOOTHING_LABELS[state.settings.smoothing].toLowerCase())} smoothing (window ${esc(state.settings.window)}).</p>` : ""}
    </div>`);
  }
  if (opts.fits && entry.fits && Object.keys(entry.fits).length) {
    const rows = Object.entries(entry.fits).map(([k, f]) => `<tr><td>${esc(SHORT_LABEL[k] || METRIC_LABEL[k])}</td>
      ${f.error ? `<td class="text" colspan="2">fit failed: ${esc(f.error)}</td><td></td>`
    : `<td class="text">${esc(f.equation)}</td><td class="text">${esc(fitParamText(f))}</td><td>${fmtNum(f.r2, 4)}</td>`}</tr>`);
    summary.push(`<div>
      <h3>Curve fits (${esc(FIT_LABELS[state.settings.fit_model])}, x = ${esc(xLabel)})</h3>
      <table><thead><tr><th>Metric</th><th>Model</th><th>Parameters</th><th>R²</th></tr></thead><tbody>${rows.join("")}</tbody></table>
    </div>`);
  }
  if (summary.length) parts.push(`<div class="two-col">${summary.join("")}</div>`);

  if (opts.replicates) {
    const row = (m) => {
      const c = m.columns;
      const n = c.time.length - 1;
      const v = (k, i) => (c[k] ? fmtNum(c[k][i], 2) : "–");
      return `<tr><td>${wrapNameHtml(m.id)}</td><td class="text">${esc(m.meta.Date || "")}</td>
        <td>${v("L", 0)}</td><td>${v("a", 0)}</td><td>${v("b", 0)}</td>
        <td>${v("L", n)}</td><td>${v("a", n)}</td><td>${v("b", n)}</td>
        <td>${v("dE2000", n)}</td><td>${v("dE76", n)}</td></tr>`;
    };
    parts.push(`<h3>Measurements (as recorded)</h3>
      <table class="wide"><thead>
        <tr><th rowspan="2">Measurement</th><th rowspan="2">Date</th><th colspan="3">Start</th><th colspan="3">End</th><th rowspan="2">ΔE00</th><th rowspan="2">ΔE*ab</th></tr>
        <tr><th>L*</th><th>a*</th><th>b*</th><th>L*</th><th>a*</th><th>b*</th></tr>
      </thead><tbody>${ms.map(row).join("")}</tbody></table>`);
  }

  if (opts.overview) {
    const mine = (a) => annGroups(a).includes(g);
    const figs = state.overviews.filter((o) => o.annotations.some(mine)).map((o) => {
      const labels = o.annotations.filter(mine).map((a) => a.label).filter(Boolean);
      return `<figure class="overview">${overviewSvg(o, { highlight: mine, imageRef: `ovimg-${o.id}` })}
        <figcaption>${esc(o.name)}${labels.length ? ` — marked: ${esc(labels.join(", "))}` : ""}</figcaption></figure>`;
    });
    if (figs.length) parts.push(`<h3>Location</h3>${figs.join("")}`);
  }

  if (opts.charts) {
    const imgs = [];
    for (const k of state.settings.metrics) imgs.push(`<img src="${await chartImage(k, entry, { width: 800, height: 520, refs: opts.refs })}" alt="${esc(METRIC_LABEL[k])}">`);
    parts.push(`<h3>Charts</h3><div class="chart-grid">${imgs.join("")}</div>`);
  }

  if (opts.images) {
    const figs = members.flatMap((id) => imagesFor(id).map((n) => `<figure><img src="${state.images.get(n)}" alt=""><figcaption>${esc(n)}</figcaption></figure>`));
    if (figs.length) parts.push(`<h3>Images</h3><div class="image-grid">${figs.join("")}</div>`);
  }
  return `<section class="group">${parts.join("\n")}</section>`;
}

const REPORT_CSS = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 13px/1.45 "Segoe UI", system-ui, Arial, sans-serif; color: #1b1b1a; background: #fff; margin: 0 auto; max-width: 1000px; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 0 0 2px; border-bottom: 2px solid #1b1b1a; padding-bottom: 4px; }
  h2 .role { font-size: 12px; font-weight: 500; color: #66655f; border: 1px solid #d8d7d2; border-radius: 4px; padding: 1px 6px; vertical-align: middle; }
  h3 { font-size: 14px; margin: 18px 0 6px; color: #333; }
  .meta, .note { color: #66655f; }
  .note { font-size: 11px; }
  header { margin-bottom: 20px; }
  header .notes { white-space: pre-wrap; margin-top: 8px; }
  .settings { color: #52514e; font-size: 12px; }
  section.group { margin-top: 28px; }
  section.group + section.group { break-before: page; }
  table { border-collapse: collapse; font-size: 12px; margin: 4px 0; }
  th, td { border: 1px solid #d8d7d2; padding: 3px 8px; text-align: right; }
  th:first-child, td:first-child, td.text { text-align: left; }
  th { background: #f3f3f1; font-weight: 600; }
  table.wide { width: 100%; }
  .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 0 20px; align-items: start; }
  .two-col table { width: 100%; }
  .two-col > div { break-inside: avoid; }
  .patch-grid { display: flex; flex-wrap: wrap; gap: 14px; }
  .patch-pair { border: 1px solid #e0dfda; border-radius: 6px; padding: 8px; break-inside: avoid; }
  .patch-label { font-weight: 600; margin-bottom: 4px; }
  .patches { display: flex; gap: 8px; }
  .patches figure { margin: 0; }
  .patch { display: block; width: 90px; height: 60px; border: 1px solid #00000022; }
  .gamut { white-space: nowrap; }
  .big .patch { width: 150px; height: 100px; }
  figcaption { font-size: 10.5px; color: #52514e; margin-top: 3px; }
  .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .chart-grid img { width: 100%; border: 1px solid #eee; break-inside: avoid; }
  .image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .image-grid figure { margin: 0; break-inside: avoid; }
  .image-grid img { width: 100%; border-radius: 4px; }
  figure.overview { margin: 6px 0 12px; break-inside: avoid; }
  figure.overview svg { display: block; width: 100%; height: auto; max-height: 640px; }
  section.group figure.overview { max-width: 560px; }
  .overview-list { columns: 2; font-size: 12px; margin: 6px 0 0; padding-left: 18px; }
  @media print { body { padding: 0; } }
`;

// Overview images shown once at the top, with every mark and a key to what each mark is linked to.
function overviewHeader() {
  return state.overviews.map((o) => `
    <figure class="overview">${overviewSvg(o, { imageRef: `ovimg-${o.id}` })}
      <figcaption>${esc(o.name)}</figcaption></figure>
    ${o.annotations.length ? `<ul class="overview-list">${o.annotations.map((a) => `<li><b>${esc(a.label || "(no label)")}</b>${linkName(a) ? ` — ${esc(linkName(a))}` : ""}</li>`).join("")}</ul>` : ""}`).join("");
}

function reportHtml(sections, opts, settingsText) {
  // Each overview image is embedded once and referenced from every figure that shows it.
  const defs = opts.overview && state.overviews.length
    ? `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${state.overviews.map((o) => `<image id="ovimg-${o.id}" href="${o.src}" width="${o.w}" height="${o.h}"/>`).join("")}</defs></svg>` : "";
  const overview = opts.overview ? overviewHeader() : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title><style>${REPORT_CSS}</style></head>
<body>
${defs}
<header>
  <h1>${esc(opts.title)}</h1>
  <div class="meta">Generated ${esc(new Date().toLocaleString())} with MFT-Parser</div>
  <div class="settings">${esc(settingsText)}</div>
  ${opts.notes ? `<div class="notes">${esc(opts.notes)}</div>` : ""}
  ${overview ? `<h3>Overview</h3>${overview}` : ""}
</header>
${sections.join("\n")}
</body></html>`;
}

async function generateReport() {
  const status = $("#rpStatus");
  const btn = $("#rpGenerate");
  const picked = pickedReportGroups();
  // Ticked reference groups (Blue Wool standards, comparisons) are always drawn on the charts;
  // they get a section of their own with their data only when the user asks for it.
  const refData = document.querySelector("input[name=rpRefData]:checked").value === "sections";
  const sectionGroups = [...picked.filter((g) => !isRef(g)), ...(refData ? picked.filter(isRef) : [])];
  if (!sectionGroups.length) {
    status.textContent = picked.length
      ? "Tick a sample group, or choose to include the reference groups' data."
      : "Tick at least one group.";
    return;
  }
  const opts = {
    title: $("#rpTitle").value || "Microfading report",
    notes: $("#rpNotes").value,
    charts: $("#rpCharts").checked,
    images: $("#rpImages").checked,
    replicates: $("#rpReplicates").checked,
    fits: $("#rpFits").checked,
    overview: $("#rpOverview").checked,
  };
  const separate = document.querySelector("input[name=rpSplit]:checked").value === "each";
  btn.disabled = true;
  try {
    status.textContent = "Processing…";
    const result = await processGroups(picked);
    opts.refs = result.groups.filter((e) => isRef(e.group));
    const byGroup = new Map(result.groups.map((e) => [e.group, e]));
    const entries = sectionGroups.map((g) => byGroup.get(g)).filter(Boolean);
    const sections = [];
    for (const [i, entry] of entries.entries()) {
      status.textContent = `Building section ${i + 1} of ${entries.length}: ${entry.group.name}`;
      sections.push(await groupSection(entry, opts));
    }
    const s = state.settings;
    const settingsText = [
      `x axis: ${X_LABELS[s.x_axis]}`,
      s.x_axis === "dose" ? `default max dose ${s.max_dose} Mlux·h (time scaled linearly)` : null,
      `smoothing: ${s.smoothing === "none" ? "none" : `${SMOOTHING_LABELS[s.smoothing].toLowerCase()}, window ${s.window}${s.smoothing === "savgol" ? `, order ${s.polyorder}` : ""}${s.smooth_mode === "overlay" ? ", drawn over the measured data" : ", applied to the data"}`}`,
      `display: ${{ raw: "replicates", mean: "mean ± SD", both: "replicates + mean ± SD" }[s.view]}`,
      s.fit_model !== "none" ? `fit: ${FIT_LABELS[s.fit_model]}` : null,
      opts.charts && opts.refs.length ? `reference curves on the charts: ${opts.refs.map((e) => e.group.name).join(", ")}` : null,
    ].filter(Boolean).join(" · ");
    if (separate) {
      // Browsers may ask once whether this page may download several files.
      entries.forEach((entry, i) => {
        download(`${safeFilename(`MFT_report_${entry.group.name}`)}.html`, reportHtml([sections[i]], opts, settingsText), "text/html");
      });
      status.textContent = `${entries.length} report file${entries.length === 1 ? "" : "s"} saved. If only one appeared, allow multiple downloads for this page and generate again.`;
    } else {
      const name = entries.length === 1 ? `MFT_report_${entries[0].group.name}` : `MFT_report_${new Date().toISOString().slice(0, 10)}`;
      download(`${safeFilename(name)}.html`, reportHtml(sections, opts, settingsText), "text/html");
      status.textContent = `Report saved (${sections.length} section${sections.length === 1 ? "" : "s"}). Open it and use Print → Save as PDF for a PDF.`;
    }
  } finally {
    btn.disabled = false;
  }
}
