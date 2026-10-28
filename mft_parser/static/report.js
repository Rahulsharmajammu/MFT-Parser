"use strict";

// Per-group HTML reports: before/after colour patches, end-of-exposure summary,
// replicate table, curve fits, charts and the images matched to each measurement.
// The report is a single self-contained .html file (print it to PDF from the browser).

let reportGroups = [];

function openReportDialog(groups) {
  reportGroups = groups.filter((g) => includedMembers(g).length);
  if (!reportGroups.length) {
    setStatus("No groups with loaded measurements to report on.");
    return;
  }
  $("#rpScope").textContent = reportGroups.length === 1
    ? `Group: ${reportGroups[0].name}` : `${reportGroups.length} visible groups (one section each)`;
  if (!$("#rpTitle").value) $("#rpTitle").value = "Microfading report";
  $("#rpStatus").textContent = "";
  $("#reportDialog").showModal();
}

// CIELAB (D65 white) -> sRGB hex. `clipped` is true when the colour is outside the sRGB gamut.
function labToSrgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const finv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = 0.95047 * finv(fx);
  const Y = L > 8 ? fy ** 3 : L / 903.3;
  const Z = 1.08883 * finv(fz);
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  let clipped = false;
  const hex = lin.map((c) => {
    if (c < -0.001 || c > 1.001) clipped = true;
    c = Math.min(1, Math.max(0, c));
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(v * 255).toString(16).padStart(2, "0");
  }).join("");
  return { hex: `#${hex}`, clipped };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function startEndLab(columns) {
  const n = columns.L.length - 1;
  return {
    start: [columns.L[0], columns.a[0], columns.b[0]],
    end: [columns.L[n], columns.a[n], columns.b[n]],
  };
}

function patchPair(label, start, end, big = false) {
  const s = labToSrgb(...start);
  const e = labToSrgb(...end);
  const lab = (v) => `L* ${fmtNum(v[0], 2)} · a* ${fmtNum(v[1], 2)} · b* ${fmtNum(v[2], 2)}`;
  const gamut = s.clipped || e.clipped ? `<div class="note">Outside sRGB gamut — displayed colour is clipped.</div>` : "";
  return `<div class="patch-pair${big ? " big" : ""}">
    <div class="patch-label">${esc(label)}</div>
    <div class="patches">
      <figure><div class="patch" style="background:${s.hex}"></div><figcaption>Before<br>${lab(start)}</figcaption></figure>
      <figure><div class="patch" style="background:${e.hex}"></div><figcaption>After<br>${lab(end)}</figcaption></figure>
    </div>${gamut}
  </div>`;
}

async function chartImage(metric, entry, opts) {
  const theme = THEMES.light;
  const traces = buildTraces(metric, { groups: [entry] }, state.settings.view, theme, true);
  const layout = baseLayout(metric, theme, { exporting: true, legend: "bottom" });
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
  parts.push(`<h2>${esc(g.name)}</h2>
    <p class="meta">${members.length} measurement${members.length === 1 ? "" : "s"}
    ${state.settings.x_axis === "dose" ? ` · max dose ${fmtNum(dose, 3)} Mlux·h` : ""}
    ${illum.length ? ` · illuminant ${esc(illum.join(", "))}` : ""}
    ${dates.length ? ` · ${esc(dates.length === 1 ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`)}` : ""}</p>`);

  // Colour patches: group mean first, then each replicate.
  const labs = ms.filter((m) => m.columns.L && m.columns.a && m.columns.b).map((m) => ({ id: m.id, ...startEndLab(m.columns) }));
  if (labs.length) {
    const mean = (k) => [0, 1, 2].map((i) => labs.reduce((s, l) => s + l[k][i], 0) / labs.length);
    parts.push(`<h3>Colour change</h3>
      <div class="patch-grid">
        ${patchPair(labs.length > 1 ? `Mean of ${labs.length}` : labs[0].id, mean("start"), mean("end"), true)}
        ${labs.length > 1 ? labs.map((l) => patchPair(l.id, l.start, l.end)).join("") : ""}
      </div>
      <p class="note">Patches are sRGB renderings of the measured L*a*b* (D65) and are approximate on screen and in print.</p>`);
  }

  if (avg) {
    const keys = ["dE2000", "dE76", "dL", "da", "db", "L", "a", "b"].filter((k) => avg[k]);
    const last = avg.x.length - 1;
    parts.push(`<h3>At end of exposure (${esc(xLabel)} = ${fmtNum(avg.x[last], state.settings.x_axis === "dose" ? 3 : 1)})</h3>
      <table><thead><tr><th>Metric</th><th>Mean</th><th>SD</th></tr></thead><tbody>
      ${keys.map((k) => `<tr><td>${esc(METRIC_LABEL[k])}</td><td>${fmtNum(avg[k][last])}</td><td>${avg.n > 1 ? fmtNum(avg[k + "_sd"][last]) : "–"}</td></tr>`).join("")}
      </tbody></table>
      ${state.settings.smoothing !== "none" ? `<p class="note">Values are after ${esc(state.settings.smoothing.replace("_", " "))} smoothing (window ${esc(state.settings.window)}).</p>` : ""}`);
  }

  if (opts.replicates) {
    const row = (m) => {
      const c = m.columns;
      const n = c.time.length - 1;
      const v = (k, i) => (c[k] ? fmtNum(c[k][i], 2) : "–");
      return `<tr><td>${esc(m.id)}</td><td class="text">${esc(m.meta.Date || "")}</td>
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

  if (opts.fits && entry.fits) {
    const rows = Object.entries(entry.fits).map(([k, f]) => `<tr><td>${esc(METRIC_LABEL[k])}</td>
      <td>${f.error ? "fit failed" : esc(f.equation)}</td><td>${f.error ? esc(f.error) : esc(fitParamText(f))}</td><td>${f.error ? "" : fmtNum(f.r2, 4)}</td></tr>`);
    parts.push(`<h3>Curve fits (${esc(FIT_LABELS[state.settings.fit_model])}, x = ${esc(xLabel)})</h3>
      <table><thead><tr><th>Metric</th><th>Model</th><th>Parameters</th><th>R²</th></tr></thead><tbody>${rows.join("")}</tbody></table>`);
  }

  if (opts.charts) {
    const imgs = [];
    for (const k of state.settings.metrics) imgs.push(`<img src="${await chartImage(k, entry, { width: 800, height: 520 })}" alt="${esc(METRIC_LABEL[k])}">`);
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
  * { box-sizing: border-box; }
  body { font: 13px/1.45 "Segoe UI", system-ui, Arial, sans-serif; color: #1b1b1a; background: #fff; margin: 0 auto; max-width: 1000px; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 0 0 2px; border-bottom: 2px solid #1b1b1a; padding-bottom: 4px; }
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
  .patch-grid { display: flex; flex-wrap: wrap; gap: 14px; }
  .patch-pair { border: 1px solid #e0dfda; border-radius: 6px; padding: 8px; break-inside: avoid; }
  .patch-label { font-weight: 600; margin-bottom: 4px; }
  .patches { display: flex; gap: 8px; }
  .patches figure { margin: 0; }
  .patch { width: 90px; height: 60px; border: 1px solid #00000022; border-radius: 3px; }
  .big .patch { width: 150px; height: 100px; }
  figcaption { font-size: 10.5px; color: #52514e; margin-top: 3px; }
  .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .chart-grid img { width: 100%; border: 1px solid #eee; break-inside: avoid; }
  .image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .image-grid figure { margin: 0; break-inside: avoid; }
  .image-grid img { width: 100%; border-radius: 4px; }
  @media print { body { padding: 0; } }
`;

async function generateReport() {
  const status = $("#rpStatus");
  const btn = $("#rpGenerate");
  const opts = {
    title: $("#rpTitle").value || "Microfading report",
    notes: $("#rpNotes").value,
    charts: $("#rpCharts").checked,
    images: $("#rpImages").checked,
    replicates: $("#rpReplicates").checked,
    fits: $("#rpFits").checked,
  };
  btn.disabled = true;
  try {
    status.textContent = "Processing…";
    const result = await processGroups(reportGroups);
    const sections = [];
    for (const [i, entry] of result.groups.entries()) {
      status.textContent = `Building section ${i + 1} of ${result.groups.length}: ${entry.group.name}`;
      sections.push(await groupSection(entry, opts));
    }
    const s = state.settings;
    const settingsText = [
      `x axis: ${X_LABELS[s.x_axis]}`,
      s.x_axis === "dose" ? `default max dose ${s.max_dose} Mlux·h (time scaled linearly)` : null,
      `smoothing: ${s.smoothing === "none" ? "none" : `${s.smoothing.replace("_", " ")}, window ${s.window}${s.smoothing === "savgol" ? `, order ${s.polyorder}` : ""}`}`,
      `display: ${{ raw: "replicates", mean: "mean ± SD", both: "replicates + mean ± SD" }[s.view]}`,
      s.fit_model !== "none" ? `fit: ${FIT_LABELS[s.fit_model]}` : null,
    ].filter(Boolean).join(" · ");
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title><style>${REPORT_CSS}</style></head>
<body>
<header>
  <h1>${esc(opts.title)}</h1>
  <div class="meta">Generated ${esc(new Date().toLocaleString())} with MFT-Parser</div>
  <div class="settings">${esc(settingsText)}</div>
  ${opts.notes ? `<div class="notes">${esc(opts.notes)}</div>` : ""}
</header>
${sections.join("\n")}
</body></html>`;
    const name = reportGroups.length === 1 ? `MFT_report_${reportGroups[0].name}` : `MFT_report_${new Date().toISOString().slice(0, 10)}`;
    download(`${safeFilename(name)}.html`, html, "text/html");
    status.textContent = `Report saved (${sections.length} section${sections.length === 1 ? "" : "s"}). Open it and use Print → Save as PDF for a PDF.`;
  } finally {
    btn.disabled = false;
  }
}
