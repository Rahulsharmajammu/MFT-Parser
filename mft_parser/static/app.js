"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const METRICS = [
  { key: "dE2000", label: "ΔE00 (CIEDE2000)" },
  { key: "dE76", label: "ΔE*ab (CIE76)" },
  { key: "L", label: "L*" },
  { key: "a", label: "a*" },
  { key: "b", label: "b*" },
  { key: "dL", label: "ΔL*" },
  { key: "da", label: "Δa*" },
  { key: "db", label: "Δb*" },
];
const X_LABELS = { dose: "Dose (Mlux·h)", time: "Time (s)", time_min: "Time (min)" };
// Eight categorical colour slots; groups beyond eight reuse a colour with a different dash.
const N_COLORS = 8;
const DASHES = ["solid", "dash", "dot", "dashdot"];
const SVG_DASH = { solid: "", dash: "6 3", dot: "2 3", dashdot: "6 3 2 3" };
const SESSION_VERSION = 1;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  measurements: new Map(), // id -> {id, meta, columns, spectra}
  groups: [], // {id, name, colorIdx, visible, collapsed, maxDose, members: [], excluded: []}
  selection: new Set(),
  filter: "",
  nextColor: 0,
  nextGroupId: 1,
  tab: "color",
  lastClicked: null,
  settings: {
    x_axis: "dose",
    max_dose: 0.5,
    smoothing: "none",
    window: 5,
    polyorder: 2,
    avg_points: "",
    view: "mean",
    metrics: METRICS.map((m) => m.key),
    columns: 2,
  },
};
let lastResult = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== "string") node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function groupColor(g) {
  return cssVar(`--series-${(g.colorIdx % N_COLORS) + 1}`);
}

function groupDash(g) {
  return DASHES[Math.floor(g.colorIdx / N_COLORS) % DASHES.length];
}

function withAlpha(hex, alpha) {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function swatch(g) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "8");
  svg.classList.add("swatch-svg");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  Object.entries({ x1: 1, y1: 4, x2: 23, y2: 4, stroke: groupColor(g), "stroke-width": 2.5, "stroke-linecap": "round" })
    .forEach(([k, v]) => line.setAttribute(k, v));
  if (SVG_DASH[groupDash(g)]) line.setAttribute("stroke-dasharray", SVG_DASH[groupDash(g)]);
  svg.append(line);
  return svg;
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPlots, 120);
}

function matchesFilter(id) {
  const f = state.filter.trim();
  if (!f) return true;
  if (f.length > 2 && f.startsWith("/") && f.endsWith("/")) {
    try { return new RegExp(f.slice(1, -1), "i").test(id); } catch { return true; }
  }
  return id.toLowerCase().includes(f.toLowerCase());
}

function download(name, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  el("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Loading files
// ---------------------------------------------------------------------------

async function filesFromDrop(dt) {
  const out = [];
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  async function walk(entry) {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  }
  if (entries.length) for (const e of entries) await walk(e);
  else out.push(...dt.files);
  return out;
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter((f) => /\.txt$/i.test(f.name) && !/-spect_convert\.txt$/i.test(f.name));
  if (!files.length) {
    setStatus("No MFT .txt files found.");
    return;
  }
  setStatus(`Parsing ${files.length} files…`);
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f, f.name));
  try {
    const res = await fetch("/api/parse", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const warnings = [...data.warnings];
    for (const m of data.measurements) {
      if (state.measurements.has(m.id)) warnings.push(`${m.id}: replaced previously loaded copy`);
      state.measurements.set(m.id, m);
    }
    showWarnings(warnings);
    setStatus(`Loaded ${data.measurements.length} measurements (${state.measurements.size} total).`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
  renderSidebar();
  scheduleRender();
}

function setStatus(text) {
  $("#loadStatus").textContent = text;
}

function showWarnings(list) {
  const box = $("#warningsBox");
  box.hidden = !list.length;
  $("#warnings").replaceChildren(...list.map((w) => el("li", {}, w)));
  box.querySelector("summary").textContent = `Warnings (${list.length})`;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function createGroup(name, members) {
  const g = {
    id: `g${state.nextGroupId++}`,
    name,
    colorIdx: state.nextColor++,
    visible: true,
    collapsed: true,
    maxDose: "",
    members: [...members],
    excluded: [],
  };
  state.groups.push(g);
  return g;
}

function sortedIds(ids) {
  return [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function autoGroup() {
  const buckets = new Map();
  for (const id of sortedIds(state.measurements.keys())) {
    const key = id.replace(/[-_. ]\d+$/, "");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(id);
  }
  const existing = new Set(state.groups.map((g) => g.name));
  for (const [key, ids] of buckets) if (!existing.has(key)) createGroup(key, ids);
  renderSidebar();
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------

function renderSidebar() {
  renderGroups();
  renderTable();
  renderGroupSelect();
}

function renderGroupSelect() {
  const sel = $("#addToGroup");
  sel.replaceChildren(el("option", { value: "" }, "Add selection to…"),
    ...state.groups.map((g) => el("option", { value: g.id }, g.name)));
}

function renderGroups() {
  const wrap = $("#groups");
  if (!state.groups.length) {
    wrap.replaceChildren(el("p", { class: "muted small" }, "No groups yet. Select measurements below and click “New group from selection”, or use Auto-group."));
    return;
  }
  wrap.replaceChildren(...state.groups.map(groupCard));
}

function groupCard(g) {
  const included = g.members.filter((m) => !g.excluded.includes(m)).length;
  const head = el("div", { class: "group-head" },
    el("input", {
      type: "checkbox", checked: g.visible, title: "Show on charts",
      onchange: (e) => { g.visible = e.target.checked; renderGroups(); scheduleRender(); },
    }),
    swatch(g),
    el("input", {
      type: "text", value: g.name, title: "Rename group",
      onchange: (e) => { g.name = e.target.value || g.name; renderGroupSelect(); renderTable(); scheduleRender(); },
    }),
    el("span", { class: "muted small" }, `${included}/${g.members.length}`),
    el("button", {
      class: "icon-btn", title: g.collapsed ? "Expand" : "Collapse",
      onclick: () => { g.collapsed = !g.collapsed; renderGroups(); },
    }, g.collapsed ? "▸" : "▾"),
    el("button", {
      class: "icon-btn", title: "Delete group",
      onclick: () => {
        state.groups = state.groups.filter((x) => x !== g);
        renderSidebar(); scheduleRender();
      },
    }, "✕"),
  );
  const card = el("div", { class: "group" + (g.visible ? "" : " hidden-group") }, head);
  if (!g.collapsed) {
    const body = el("div", { class: "group-body" },
      el("div", { class: "opts" },
        "Max dose",
        el("input", {
          type: "number", step: "any", min: "0", value: g.maxDose, placeholder: String(state.settings.max_dose),
          title: "Override the global max dose for this group",
          onchange: (e) => { g.maxDose = e.target.value; scheduleRender(); },
        }),
        "Mlux·h"),
      ...g.members.map((id) => {
        const excluded = g.excluded.includes(id);
        return el("div", { class: "member" + (excluded ? " excluded" : "") },
          el("input", {
            type: "checkbox", checked: !excluded, title: "Include in plots and average",
            onchange: (e) => {
              g.excluded = e.target.checked ? g.excluded.filter((x) => x !== id) : [...g.excluded, id];
              renderGroups(); scheduleRender();
            },
          }),
          el("span", { title: id }, id + (state.measurements.has(id) ? "" : " (not loaded)")),
          el("button", {
            class: "icon-btn", title: "Remove from group",
            onclick: () => {
              g.members = g.members.filter((x) => x !== id);
              g.excluded = g.excluded.filter((x) => x !== id);
              renderSidebar(); scheduleRender();
            },
          }, "✕"));
      }));
    card.append(body);
  }
  return card;
}

function renderTable() {
  const tbody = $("#measTable tbody");
  const ids = sortedIds(state.measurements.keys()).filter(matchesFilter);
  const groupsOf = new Map();
  for (const g of state.groups) for (const id of g.members) {
    if (!groupsOf.has(id)) groupsOf.set(id, []);
    groupsOf.get(id).push(g.name);
  }
  tbody.replaceChildren(...ids.map((id) => {
    const m = state.measurements.get(id);
    const sel = state.selection.has(id);
    const tip = Object.entries(m.meta).map(([k, v]) => `${k}: ${v}`).join("\n");
    return el("tr", { class: sel ? "sel" : "" },
      el("td", {}, el("input", {
        type: "checkbox", checked: sel,
        onclick: (e) => toggleSelect(id, e.target.checked, e.shiftKey, ids),
      })),
      el("td", { class: "name", title: tip }, id),
      el("td", {}, String(m.columns.time.length)),
      el("td", {}, ...(groupsOf.get(id) || []).map((n) => el("span", { class: "badge" }, n))));
  }));
  const allShownSelected = ids.length > 0 && ids.every((id) => state.selection.has(id));
  $("#selectAll").checked = allShownSelected;
  $("#selCount").textContent = state.measurements.size
    ? `${state.selection.size} selected · ${ids.length}/${state.measurements.size} shown` : "";
}

function toggleSelect(id, checked, shift, shownIds) {
  if (shift && state.lastClicked && shownIds.includes(state.lastClicked)) {
    const [a, b] = [shownIds.indexOf(state.lastClicked), shownIds.indexOf(id)].sort((x, y) => x - y);
    for (const x of shownIds.slice(a, b + 1)) checked ? state.selection.add(x) : state.selection.delete(x);
  } else {
    checked ? state.selection.add(id) : state.selection.delete(id);
  }
  state.lastClicked = id;
  renderTable();
}

// ---------------------------------------------------------------------------
// Processing + plotting
// ---------------------------------------------------------------------------

function visibleGroups() {
  return state.groups.filter((g) => g.visible);
}

async function fetchProcessed() {
  const groups = visibleGroups().map((g) => ({
    id: g.id,
    max_dose: g.maxDose === "" ? null : Number(g.maxDose),
    members: g.members
      .filter((id) => !g.excluded.includes(id) && state.measurements.has(id))
      .map((id) => ({ id, columns: state.measurements.get(id).columns })),
  })).filter((g) => g.members.length);
  const s = state.settings;
  const body = {
    settings: {
      x_axis: s.x_axis, max_dose: Number(s.max_dose) || 0.5, smoothing: s.smoothing,
      window: Number(s.window) || 5, polyorder: Number(s.polyorder) || 2,
      avg_points: s.avg_points === "" ? null : Number(s.avg_points),
    },
    groups,
  };
  const res = await fetch("/api/process", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  const out = await res.json();
  const byId = new Map(state.groups.map((g) => [g.id, g]));
  out.groups.forEach((r) => { r.group = byId.get(r.id); });
  return out;
}

function baseLayout(xTitle, yTitle, title) {
  const ink = cssVar("--text-primary");
  const ink2 = cssVar("--text-secondary");
  const grid = cssVar("--grid");
  const axis = (t) => ({
    title: { text: t, font: { color: ink2, size: 12 } },
    gridcolor: grid, zerolinecolor: cssVar("--border"), linecolor: cssVar("--border"),
    tickfont: { color: ink2, size: 11 }, automargin: true,
  });
  return {
    title: { text: title, font: { color: ink, size: 14 }, x: 0.02, xanchor: "left" },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    margin: { l: 56, r: 12, t: 36, b: 44 },
    xaxis: axis(xTitle), yaxis: axis(yTitle),
    showlegend: false, hovermode: "closest",
    hoverlabel: { bgcolor: cssVar("--surface-2"), bordercolor: cssVar("--border"), font: { color: ink } },
    font: { family: "system-ui, Segoe UI, sans-serif" },
  };
}

const PLOT_CONFIG = {
  responsive: true, displaylogo: false,
  toImageButtonOptions: { format: "png", scale: 3 },
  modeBarButtonsToRemove: ["select2d", "lasso2d"],
};

function metricTraces(metric, result, view) {
  const traces = [];
  const fmt = state.settings.x_axis === "dose" ? ".3f" : ".1f";
  for (const r of result.groups) {
    const g = r.group;
    const color = groupColor(g);
    const dash = groupDash(g);
    if (view === "raw" || view === "both") {
      for (const rep of r.replicates) {
        if (!rep[metric]) continue;
        traces.push({
          x: rep.x, y: rep[metric], type: "scatter", mode: "lines", name: rep.id,
          line: { color, width: view === "both" ? 1 : 1.75, dash },
          opacity: view === "both" ? 0.45 : 0.9,
          hovertemplate: `<b>${rep.id}</b><br>${g.name}<br>x=%{x:${fmt}}<br>y=%{y:.3f}<extra></extra>`,
        });
      }
    }
    const avg = r.average;
    if ((view === "mean" || view === "both") && avg && avg[metric]) {
      const sd = avg[metric + "_sd"];
      if (avg.n > 1) {
        const upper = avg[metric].map((v, i) => v + sd[i]);
        const lower = avg[metric].map((v, i) => v - sd[i]);
        traces.push({
          x: [...avg.x, ...[...avg.x].reverse()], y: [...upper, ...lower.reverse()],
          type: "scatter", mode: "lines", fill: "toself", fillcolor: withAlpha(color, 0.16),
          line: { width: 0 }, hoverinfo: "skip", name: g.name + " SD",
        });
      }
      traces.push({
        x: avg.x, y: avg[metric], type: "scatter", mode: "lines", name: g.name,
        line: { color, width: 2.25, dash },
        customdata: sd,
        hovertemplate: `<b>${g.name}</b> (n=${avg.n})<br>x=%{x:${fmt}}<br>mean=%{y:.3f} ± %{customdata:.3f}<extra></extra>`,
      });
    }
  }
  return traces;
}

function renderLegend(result) {
  const items = result ? result.groups.map((r) => el("span", { class: "item" },
    swatch(r.group), r.group.name, el("span", { class: "n" }, `n=${r.replicates.length}`))) : [];
  $("#legend").replaceChildren(...items);
}

async function renderPlots() {
  const charts = $("#charts");
  const spectra = $("#spectra");
  charts.style.gridTemplateColumns = `repeat(${state.settings.columns}, minmax(0, 1fr))`;
  spectra.style.gridTemplateColumns = `repeat(${Math.min(2, state.settings.columns)}, minmax(0, 1fr))`;

  const hasData = visibleGroups().some((g) => g.members.some((id) => !g.excluded.includes(id) && state.measurements.has(id)));
  $("#empty").hidden = hasData;
  if (!hasData) {
    lastResult = null;
    renderLegend(null);
    charts.replaceChildren();
    spectra.replaceChildren();
    return;
  }
  try {
    lastResult = await fetchProcessed();
  } catch (err) {
    setStatus(`Processing error: ${err.message}`);
    return;
  }
  renderLegend(lastResult);
  if (state.tab === "color") renderMetricCharts();
  else renderSpectra();
}

function renderMetricCharts() {
  const charts = $("#charts");
  const wanted = METRICS.filter((m) => state.settings.metrics.includes(m.key));
  // Keep chart divs for metrics still shown so Plotly can update in place.
  const existing = new Map([...charts.children].map((d) => [d.dataset.metric, d]));
  const divs = wanted.map((m) => existing.get(m.key) || el("div", { class: "chart", "data-metric": m.key }));
  charts.replaceChildren(...divs);
  const xTitle = X_LABELS[state.settings.x_axis];
  wanted.forEach((m, i) => {
    Plotly.react(divs[i], metricTraces(m.key, lastResult, state.settings.view),
      baseLayout(xTitle, m.label, m.label), { ...PLOT_CONFIG, toImageButtonOptions: { ...PLOT_CONFIG.toImageButtonOptions, filename: `mft_${m.key}` } });
  });
}

function renderSpectra() {
  const wrap = $("#spectra");
  const startTraces = [];
  const diffTraces = [];
  for (const g of visibleGroups()) {
    const color = groupColor(g);
    for (const id of g.members) {
      const m = state.measurements.get(id);
      if (!m || g.excluded.includes(id) || !m.spectra || !m.spectra.samples.length) continue;
      const sp = m.spectra;
      const first = sp.samples[0];
      const last = sp.samples[sp.samples.length - 1];
      startTraces.push({
        x: sp.wavelengths, y: first.values, type: "scatter", mode: "lines", name: `${id} start`,
        line: { color, width: 1.5 }, hovertemplate: `<b>${id}</b> t=${first.time_s}s<br>%{x:.1f} nm: %{y:.2f}<extra></extra>`,
      });
      if (sp.samples.length > 1) {
        startTraces.push({
          x: sp.wavelengths, y: last.values, type: "scatter", mode: "lines", name: `${id} end`,
          line: { color, width: 1.5, dash: "dot" }, hovertemplate: `<b>${id}</b> t=${last.time_s}s<br>%{x:.1f} nm: %{y:.2f}<extra></extra>`,
        });
        diffTraces.push({
          x: sp.wavelengths, y: last.values.map((v, i) => v - first.values[i]), type: "scatter", mode: "lines",
          name: id, line: { color, width: 1.5 }, hovertemplate: `<b>${id}</b><br>%{x:.1f} nm: %{y:.2f}<extra></extra>`,
        });
      }
    }
  }
  if (!startTraces.length) {
    wrap.replaceChildren(el("p", { class: "chart-note" }, "No spectrum files (-spect.txt) loaded for the visible groups."));
    return;
  }
  const a = el("div", { class: "chart" });
  const b = el("div", { class: "chart" });
  wrap.replaceChildren(a, b);
  Plotly.react(a, startTraces, baseLayout("Wavelength (nm)", "Sample spectrum (as recorded)", "Spectra — start (solid) / end (dotted)"), PLOT_CONFIG);
  Plotly.react(b, diffTraces, baseLayout("Wavelength (nm)", "End − start", "Spectral change"), PLOT_CONFIG);
}

// ---------------------------------------------------------------------------
// Export / sessions
// ---------------------------------------------------------------------------

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(kind) {
  if (!lastResult) return;
  const keys = METRICS.map((m) => m.key);
  const xName = X_LABELS[state.settings.x_axis];
  const rows = [];
  if (kind === "mean") {
    rows.push(["group", "n", xName, ...keys.flatMap((k) => [`${k}_mean`, `${k}_sd`])]);
    for (const r of lastResult.groups) {
      const a = r.average;
      if (!a) continue;
      a.x.forEach((x, i) => rows.push([r.group.name, a.n, x,
        ...keys.flatMap((k) => [a[k] ? a[k][i] : "", a[k + "_sd"] ? a[k + "_sd"][i] : ""])]));
    }
  } else {
    rows.push(["group", "measurement", xName, ...keys]);
    for (const r of lastResult.groups) for (const rep of r.replicates) {
      rep.x.forEach((x, i) => rows.push([r.group.name, rep.id, x, ...keys.map((k) => (rep[k] ? rep[k][i] : ""))]));
    }
  }
  // Leading BOM so Excel reads the file as UTF-8 (Mlux·h, Δ).
  download(`mft_${kind === "mean" ? "means" : "replicates"}.csv`, "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"));
}

function saveSession() {
  const session = {
    version: SESSION_VERSION,
    saved: new Date().toISOString(),
    settings: state.settings,
    groups: state.groups,
    nextColor: state.nextColor,
    nextGroupId: state.nextGroupId,
    measurements: [...state.measurements.values()],
  };
  download("mft_session.json", JSON.stringify(session), "application/json");
}

async function loadSession(file) {
  try {
    const s = JSON.parse(await file.text());
    if (s.version !== SESSION_VERSION) throw new Error("unsupported session version");
    state.measurements = new Map(s.measurements.map((m) => [m.id, m]));
    state.groups = s.groups;
    state.settings = { ...state.settings, ...s.settings };
    state.nextColor = s.nextColor;
    state.nextGroupId = s.nextGroupId;
    state.selection.clear();
    syncControls();
    renderSidebar();
    setStatus(`Session loaded: ${state.measurements.size} measurements, ${state.groups.length} groups.`);
    scheduleRender();
  } catch (err) {
    setStatus(`Could not load session: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Controls wiring
// ---------------------------------------------------------------------------

const CONTROL_MAP = {
  xAxis: "x_axis", maxDose: "max_dose", smoothing: "smoothing", window: "window",
  polyorder: "polyorder", avgPoints: "avg_points", columns: "columns",
};

function syncControls() {
  for (const [id, key] of Object.entries(CONTROL_MAP)) $("#" + id).value = state.settings[key];
  document.querySelectorAll("#viewMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.settings.view));
  document.querySelectorAll("#metricToggles input").forEach((i) => { i.checked = state.settings.metrics.includes(i.value); });
  $("#polyLabel").hidden = state.settings.smoothing !== "savgol";
  $("#maxDose").disabled = state.settings.x_axis !== "dose";
}

function wire() {
  $("#metricToggles").replaceChildren(...METRICS.map((m) => el("label", {},
    el("input", {
      type: "checkbox", value: m.key,
      onchange: (e) => {
        const set = new Set(state.settings.metrics);
        e.target.checked ? set.add(m.key) : set.delete(m.key);
        state.settings.metrics = METRICS.map((x) => x.key).filter((k) => set.has(k));
        scheduleRender();
      },
    }), m.label)));

  for (const [id, key] of Object.entries(CONTROL_MAP)) {
    $("#" + id).addEventListener("change", (e) => {
      state.settings[key] = e.target.value;
      syncControls();
      if (state.groups.some((g) => !g.collapsed)) renderGroups(); // refresh max-dose placeholders
      scheduleRender();
    });
  }
  document.querySelectorAll("#viewMode button").forEach((b) => b.addEventListener("click", () => {
    state.settings.view = b.dataset.v;
    syncControls();
    scheduleRender();
  }));

  $("#folderInput").addEventListener("change", (e) => { uploadFiles(e.target.files); e.target.value = ""; });
  $("#fileInput").addEventListener("change", (e) => { uploadFiles(e.target.files); e.target.value = ""; });
  $("#sessionInput").addEventListener("change", (e) => { if (e.target.files[0]) loadSession(e.target.files[0]); e.target.value = ""; });
  $("#saveSession").addEventListener("click", saveSession);
  $("#clearAll").addEventListener("click", () => {
    if (!confirm("Remove all measurements and groups?")) return;
    state.measurements.clear();
    state.groups = [];
    state.selection.clear();
    state.nextColor = 0;
    showWarnings([]);
    setStatus("");
    renderSidebar();
    scheduleRender();
  });

  const dz = $("#dropzone");
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", async (e) => {
    e.preventDefault();
    dz.classList.remove("over");
    uploadFiles(await filesFromDrop(e.dataTransfer));
  });

  $("#filter").addEventListener("input", (e) => { state.filter = e.target.value; renderTable(); });
  $("#selectAll").addEventListener("change", (e) => {
    const ids = [...state.measurements.keys()].filter(matchesFilter);
    ids.forEach((id) => (e.target.checked ? state.selection.add(id) : state.selection.delete(id)));
    renderTable();
  });
  $("#newGroup").addEventListener("click", () => {
    if (!state.selection.size) return setStatus("Select measurements first.");
    const ids = sortedIds(state.selection);
    const g = createGroup(`Group ${state.nextGroupId}`, ids);
    g.collapsed = false;
    state.selection.clear();
    renderSidebar();
    scheduleRender();
  });
  $("#addToGroup").addEventListener("change", (e) => {
    const g = state.groups.find((x) => x.id === e.target.value);
    e.target.value = "";
    if (!g || !state.selection.size) return;
    g.members = sortedIds(new Set([...g.members, ...state.selection]));
    state.selection.clear();
    renderSidebar();
    scheduleRender();
  });
  $("#autoGroup").addEventListener("click", autoGroup);
  $("#showAllGroups").addEventListener("click", () => { state.groups.forEach((g) => (g.visible = true)); renderGroups(); scheduleRender(); });
  $("#hideAllGroups").addEventListener("click", () => { state.groups.forEach((g) => (g.visible = false)); renderGroups(); scheduleRender(); });

  document.querySelectorAll(".tabs button[data-tab]").forEach((b) => b.addEventListener("click", () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll(".tabs button[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
    $("#charts").hidden = state.tab !== "color";
    $("#spectra").hidden = state.tab !== "spectra";
    scheduleRender();
  }));
  $("#exportMean").addEventListener("click", () => exportCsv("mean"));
  $("#exportRaw").addEventListener("click", () => exportCsv("raw"));

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { renderSidebar(); scheduleRender(); });

  syncControls();
  renderSidebar();
  renderPlots();
}

wire();
