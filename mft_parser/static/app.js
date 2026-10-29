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
  { key: "ab", label: "a*b* trajectory" },
];
const METRIC_LABEL = Object.fromEntries(METRICS.map((m) => [m.key, m.label]));
const X_LABELS = { dose: "Dose (Mlux·h)", time: "Time (s)", time_min: "Time (min)" };
const FIT_LABELS = { none: "None", linear: "Linear", power: "Power law", exp: "Exponential saturation" };
const IMAGE_RE = /\.(png|jpe?g|bmp|gif|webp)$/i;
// Plot colours per theme. The eight categorical slots are validated for CVD separation in this order;
// groups beyond eight reuse a colour with a different dash.
const THEMES = {
  light: {
    surface: "#ffffff", text: "#0b0b0b", text2: "#52514e", grid: "#e9e8e4", axis: "#c9c8c2",
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  },
  dark: {
    surface: "#1a1a19", text: "#f0efec", text2: "#c3c2b7", grid: "#2c2c2a", axis: "#4a4a46",
    series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  },
};
const DASHES = ["solid", "dash", "dot", "dashdot"];
const SVG_DASH = { solid: "", dash: "6 3", dot: "2 3", dashdot: "6 3 2 3" };
const EXPAND_ICON = {
  width: 1000, height: 1000, transform: "matrix(1 0 0 1 0 0)",
  path: "M50 50h350v100H150v250H50zM600 50h350v350H850V150H600zM50 600h100v250h250v100H50zM850 600h100v350H600V850h250z",
};
const HIDE_ICON = { width: 1000, height: 1000, transform: "matrix(1 0 0 1 0 0)", path: "M150 450h700v100H150z" };
const SESSION_VERSION = 1;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  measurements: new Map(), // id -> {id, meta, columns, spectra}
  images: new Map(), // filename -> data URL
  groups: [], // {id, name, colorIdx, visible, collapsed, maxDose, members: [], excluded: []}
  selection: new Set(),
  filter: "",
  nextColor: 0,
  nextGroupId: 1,
  tab: "color",
  lastClicked: null,
  expanded: null,
  settings: {
    x_axis: "dose",
    max_dose: 0.5,
    smoothing: "none",
    window: 5,
    polyorder: 2,
    avg_points: "",
    fit_model: "none",
    view: "mean",
    metrics: METRICS.map((m) => m.key),
    columns: 2,
    chart_height: 340,
  },
  exportOpts: { theme: "light", width: 1200, height: 750, scale: 2, format: "png", legend: "right", titles: {} },
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

function screenTheme() {
  return matchMedia("(prefers-color-scheme: dark)").matches ? THEMES.dark : THEMES.light;
}

function groupColor(g, theme = screenTheme()) {
  return theme.series[g.colorIdx % theme.series.length];
}

function groupDash(g) {
  return DASHES[Math.floor(g.colorIdx / THEMES.light.series.length) % DASHES.length];
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

function download(name, data, type = "text/csv") {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  el("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ASCII-only file names: some browsers drop a download name containing characters like "–" or "Δ".
function safeFilename(s) {
  return s.replace(/Δ/g, "d").replace(/[–—]/g, "-").replace(/·/g, ".")
    .normalize("NFKD").replace(/[^\x20-\x7e]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() || "export";
}

function fmtNum(v, digits = 3) {
  return v == null || !Number.isFinite(v) ? "–" : Number(v).toFixed(digits);
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

// Images stay in the browser; large ones are downscaled so sessions and reports stay small.
async function readImage(file, maxSide = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("unreadable image"));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = el("canvas", { width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) });
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadFiles(fileList) {
  const all = [...fileList];
  const files = all.filter((f) => /\.txt$/i.test(f.name) && !/-spect_convert\.txt$/i.test(f.name));
  const images = all.filter((f) => IMAGE_RE.test(f.name));
  const warnings = all.filter((f) => /\.tiff?$/i.test(f.name)).map((f) => `${f.name}: TIFF images are not supported by browsers; convert to PNG/JPEG`);
  if (!files.length && !images.length) {
    setStatus("No MFT .txt files or images found.");
    showWarnings(warnings);
    return;
  }
  setStatus(`Reading ${files.length} data files and ${images.length} images…`);
  let nMeas = 0;
  try {
    if (files.length) {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f, f.name));
      const res = await fetch("/api/parse", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      warnings.push(...data.warnings);
      for (const m of data.measurements) {
        if (state.measurements.has(m.id)) warnings.push(`${m.id}: replaced previously loaded copy`);
        state.measurements.set(m.id, m);
      }
      nMeas = data.measurements.length;
    }
    for (const f of images) {
      try { state.images.set(f.name, await readImage(f)); } catch (err) { warnings.push(`${f.name}: ${err.message}`); }
    }
    const unmatched = images.filter((f) => state.images.has(f.name) && !imageOwner(f.name)).map((f) => f.name);
    if (unmatched.length) warnings.push(`Images not matched to any measurement: ${unmatched.join(", ")}`);
    showWarnings(warnings);
    setStatus(`Loaded ${nMeas} measurements and ${images.length} images (${state.measurements.size} measurements total).`);
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

// An image belongs to the measurement with the longest id that its name starts with,
// e.g. "BWS1_BWS1-12_after.jpg" -> "BWS1_BWS1-12" (but not "BWS1_BWS1-1").
function imageOwner(filename) {
  const stem = filename.replace(/\.[^.]+$/, "");
  let best = null;
  for (const id of state.measurements.keys()) {
    if ((stem === id || (stem.startsWith(id) && /[-_ .(]/.test(stem[id.length]))) && (!best || id.length > best.length)) best = id;
  }
  return best;
}

function imagesFor(id) {
  return [...state.images.keys()].filter((n) => imageOwner(n) === id).sort();
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

function includedMembers(g) {
  return g.members.filter((id) => !g.excluded.includes(id) && state.measurements.has(id));
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

// ---------------------------------------------------------------------------
// Drag and drop: table rows and group members onto groups / new-group / remove zones
// ---------------------------------------------------------------------------

let dragPayload = null; // {ids, from: source group id or null}

function startDrag(e, ids, from) {
  dragPayload = { ids, from };
  e.dataTransfer.effectAllowed = "copyMove";
  e.dataTransfer.setData("text/plain", ids.join("\n"));
  const ghost = el("div", { class: "drag-ghost" }, ids.length === 1 ? ids[0] : `${ids.length} measurements`);
  document.body.append(ghost);
  e.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => ghost.remove());
  // Delay the layout change so the browser has captured the drag source first.
  setTimeout(() => document.body.classList.add("dragging", ...(from ? ["dragging-member"] : [])));
}

function endDrag() {
  dragPayload = null;
  document.body.classList.remove("dragging", "dragging-member");
  document.querySelectorAll(".drop-over").forEach((n) => n.classList.remove("drop-over"));
}

function dropTarget(node, onDrop) {
  node.addEventListener("dragover", (e) => {
    if (!dragPayload) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragPayload.from && !e.ctrlKey ? "move" : "copy";
    node.classList.add("drop-over");
  });
  node.addEventListener("dragleave", (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove("drop-over");
  });
  node.addEventListener("drop", (e) => {
    if (!dragPayload) return;
    e.preventDefault();
    e.stopPropagation();
    const payload = dragPayload;
    const copy = e.ctrlKey;
    endDrag();
    onDrop(payload, copy);
    renderSidebar();
    scheduleRender();
  });
}

function removeFromGroup(g, ids) {
  g.members = g.members.filter((x) => !ids.includes(x));
  g.excluded = g.excluded.filter((x) => !ids.includes(x));
}

function dropIntoGroup(target, { ids, from }, copy) {
  if (from === target.id) return;
  target.members = sortedIds(new Set([...target.members, ...ids]));
  const source = state.groups.find((g) => g.id === from);
  if (source && !copy) removeFromGroup(source, ids);
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
    el("button", { class: "icon-btn", title: "Report for this group", onclick: () => openReportDialog([g]) }, "▤"),
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
  dropTarget(card, (payload, copy) => dropIntoGroup(g, payload, copy));
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
        const nImg = imagesFor(id).length;
        return el("div", {
          class: "member" + (excluded ? " excluded" : ""), draggable: true,
          title: "Drag to another group to move it (hold Ctrl to copy)",
          ondragstart: (e) => startDrag(e, [id], g.id), ondragend: endDrag,
        },
          el("input", {
            type: "checkbox", checked: !excluded, title: "Include in plots and average",
            onchange: (e) => {
              g.excluded = e.target.checked ? g.excluded.filter((x) => x !== id) : [...g.excluded, id];
              renderGroups(); scheduleRender();
            },
          }),
          el("span", { title: id }, id + (state.measurements.has(id) ? "" : " (not loaded)")),
          nImg ? el("span", { class: "muted small", title: imagesFor(id).join("\n") }, `${nImg} img`) : null,
          el("button", {
            class: "icon-btn", title: "Remove from group",
            onclick: () => { removeFromGroup(g, [id]); renderSidebar(); scheduleRender(); },
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
  const imgCount = new Map();
  for (const n of state.images.keys()) {
    const o = imageOwner(n);
    if (o) imgCount.set(o, (imgCount.get(o) || 0) + 1);
  }
  tbody.replaceChildren(...ids.map((id) => {
    const m = state.measurements.get(id);
    const sel = state.selection.has(id);
    const tip = Object.entries(m.meta).map(([k, v]) => `${k}: ${v}`).join("\n");
    return el("tr", {
      class: sel ? "sel" : "", draggable: true,
      // Dragging a selected row drags the whole selection.
      ondragstart: (e) => startDrag(e, state.selection.has(id) ? sortedIds(state.selection) : [id], null),
      ondragend: endDrag,
    },
      el("td", {}, el("input", {
        type: "checkbox", checked: sel,
        onclick: (e) => toggleSelect(id, e.target.checked, e.shiftKey, ids),
      })),
      el("td", { class: "name", title: tip }, id),
      el("td", {}, String(m.columns.time.length)),
      el("td", {}, imgCount.get(id) ? String(imgCount.get(id)) : ""),
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
// Processing
// ---------------------------------------------------------------------------

function visibleGroups() {
  return state.groups.filter((g) => g.visible);
}

async function processGroups(groupList) {
  const groups = groupList.map((g) => ({
    id: g.id,
    max_dose: g.maxDose === "" ? null : Number(g.maxDose),
    members: includedMembers(g).map((id) => ({ id, columns: state.measurements.get(id).columns })),
  })).filter((g) => g.members.length);
  const s = state.settings;
  const body = {
    settings: {
      x_axis: s.x_axis, max_dose: Number(s.max_dose) || 0.5, smoothing: s.smoothing,
      window: Number(s.window) || 5, polyorder: Number(s.polyorder) || 2,
      avg_points: s.avg_points === "" ? null : Number(s.avg_points),
      fit_model: s.fit_model,
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

// ---------------------------------------------------------------------------
// Chart construction (shared by screen, image export and reports)
// ---------------------------------------------------------------------------

function baseLayout(metric, theme, { title, exporting = false, legend = "none" } = {}) {
  const fs = exporting ? 1.25 : 1;
  const isAb = metric === "ab";
  const axis = (t) => ({
    title: { text: t, font: { color: theme.text2, size: 12 * fs } },
    gridcolor: theme.grid, zerolinecolor: theme.axis, linecolor: theme.axis, showline: exporting,
    tickfont: { color: theme.text2, size: 11 * fs }, automargin: true,
  });
  const layout = {
    title: { text: title ?? METRIC_LABEL[metric], font: { color: theme.text, size: 14 * fs }, x: 0.02, xanchor: "left" },
    paper_bgcolor: exporting ? theme.surface : "rgba(0,0,0,0)",
    plot_bgcolor: exporting ? theme.surface : "rgba(0,0,0,0)",
    margin: { l: 60, r: 16, t: 40 * fs, b: 48 },
    xaxis: axis(isAb ? "a*" : X_LABELS[state.settings.x_axis]),
    yaxis: axis(isAb ? "b*" : METRIC_LABEL[metric]),
    showlegend: legend !== "none",
    hovermode: "closest",
    hoverlabel: { bgcolor: theme.surface, bordercolor: theme.axis, font: { color: theme.text } },
    font: { family: "system-ui, Segoe UI, Arial, sans-serif", color: theme.text },
  };
  if (isAb) Object.assign(layout.yaxis, { scaleanchor: "x", scaleratio: 1 });
  if (legend !== "none") {
    layout.legend = {
      font: { color: theme.text, size: 12 * fs }, bgcolor: "rgba(0,0,0,0)",
      ...(legend === "bottom" ? { orientation: "h", x: 0, y: -0.18, yanchor: "top" }
        : legend === "inside" ? { x: 0.02, y: 0.98, bgcolor: withAlpha(theme.surface, 0.8), bordercolor: theme.axis, borderwidth: 1 }
          : { x: 1.02, y: 1, xanchor: "left" }),
    };
  }
  return layout;
}

// Builds Plotly traces for one chart. `withLegend` gives one legend entry per group (and per fit).
function buildTraces(metric, result, view, theme, withLegend = false) {
  if (metric === "ab") return abTraces(result, view, theme, withLegend);
  const traces = [];
  const fmt = state.settings.x_axis === "dose" ? ".3f" : ".1f";
  for (const r of result.groups) {
    const g = r.group;
    const color = groupColor(g, theme);
    const dash = groupDash(g);
    const showMean = (view === "mean" || view === "both") && r.average && r.average[metric];
    if (view === "raw" || view === "both") {
      r.replicates.forEach((rep, i) => {
        if (!rep[metric]) return;
        traces.push({
          x: rep.x, y: rep[metric], type: "scatter", mode: "lines", name: g.name, legendgroup: g.id,
          showlegend: withLegend && !showMean && i === 0,
          line: { color, width: view === "both" ? 1 : 1.75, dash },
          opacity: view === "both" ? 0.45 : 0.9,
          hovertemplate: `<b>${rep.id}</b><br>${g.name}<br>x=%{x:${fmt}}<br>y=%{y:.3f}<extra></extra>`,
        });
      });
    }
    if (showMean) {
      const avg = r.average;
      const sd = avg[metric + "_sd"];
      if (avg.n > 1) {
        const upper = avg[metric].map((v, i) => v + sd[i]);
        const lower = avg[metric].map((v, i) => v - sd[i]);
        traces.push({
          x: [...avg.x, ...[...avg.x].reverse()], y: [...upper, ...lower.reverse()],
          type: "scatter", mode: "lines", fill: "toself", fillcolor: withAlpha(color, 0.16),
          line: { width: 0 }, hoverinfo: "skip", name: g.name + " SD", legendgroup: g.id, showlegend: false,
        });
      }
      traces.push({
        x: avg.x, y: avg[metric], type: "scatter", mode: "lines", name: avg.n > 1 ? `${g.name} (n=${avg.n})` : g.name,
        legendgroup: g.id, showlegend: withLegend,
        line: { color, width: 2.25, dash },
        customdata: sd,
        hovertemplate: `<b>${g.name}</b> (n=${avg.n})<br>x=%{x:${fmt}}<br>mean=%{y:.3f} ± %{customdata:.3f}<extra></extra>`,
      });
    }
    const fit = r.fits && r.fits[metric];
    if (fit && !fit.error) {
      traces.push({
        x: fit.x, y: fit.y, type: "scatter", mode: "lines", legendgroup: g.id, showlegend: withLegend,
        name: `${g.name} fit (R²=${fmtNum(fit.r2, 3)})`,
        line: { color, width: 1.75, dash: dash === "dot" ? "dash" : "dot" },
        hovertemplate: `<b>${g.name}</b> ${FIT_LABELS[fit.model]} fit<br>${fitParamText(fit)}<br>R²=${fmtNum(fit.r2, 4)}<extra></extra>`,
      });
    }
  }
  return traces;
}

function abTraces(result, view, theme, withLegend) {
  const traces = [];
  const xName = state.settings.x_axis === "dose" ? "dose" : "t";
  const fmt = state.settings.x_axis === "dose" ? ".3f" : ".1f";
  const line = (x, y, xs, color, dash, width, opacity, name, label, legend) => {
    const n = x.length;
    traces.push({
      x, y, customdata: xs, type: "scatter", mode: "lines+markers", name, legendgroup: label, showlegend: legend, opacity,
      line: { color, width, dash },
      // Open circle marks the start, filled circle the end of the trajectory.
      marker: {
        color, size: x.map((_, i) => (i === 0 || i === n - 1 ? 9 : 0)),
        symbol: x.map((_, i) => (i === 0 ? "circle-open" : "circle")), line: { color, width: 2 },
      },
      hovertemplate: `<b>${label}</b><br>${xName}=%{customdata:${fmt}}<br>a*=%{x:.3f}, b*=%{y:.3f}<extra></extra>`,
    });
  };
  for (const r of result.groups) {
    const g = r.group;
    const color = groupColor(g, theme);
    const dash = groupDash(g);
    const showMean = (view === "mean" || view === "both") && r.average && r.average.a;
    if (view === "raw" || view === "both") {
      r.replicates.forEach((rep, i) => {
        if (rep.a && rep.b) line(rep.a, rep.b, rep.x, color, dash, view === "both" ? 1 : 1.75, view === "both" ? 0.45 : 0.9,
          g.name, rep.id, withLegend && !showMean && i === 0);
      });
    }
    if (showMean) line(r.average.a, r.average.b, r.average.x, color, dash, 2.25, 1, g.name, g.name, withLegend);
  }
  return traces;
}

function fitParamText(fit) {
  return Object.entries(fit.params).map(([k, v]) => `${k}=${Number(v).toPrecision(4)}`).join(", ");
}

// ---------------------------------------------------------------------------
// Screen rendering
// ---------------------------------------------------------------------------

function screenConfig(metric) {
  return {
    responsive: true, displaylogo: false,
    modeBarButtonsToRemove: ["toImage", "select2d", "lasso2d"],
    modeBarButtonsToAdd: [
      { name: "Export image…", icon: Plotly.Icons.camera, click: () => openExportDialog(metric) },
      { name: "Expand / restore", icon: EXPAND_ICON, click: () => toggleExpand(metric) },
      { name: "Hide this chart (re-enable it under Charts)", icon: HIDE_ICON, click: () => hideMetric(metric) },
    ],
  };
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
  document.documentElement.style.setProperty("--chart-h", `${state.settings.chart_height}px`);

  const groups = visibleGroups().filter((g) => includedMembers(g).length);
  $("#empty").hidden = groups.length > 0;
  if (!groups.length) {
    lastResult = null;
    renderLegend(null);
    renderFits(null);
    charts.replaceChildren();
    spectra.replaceChildren();
    return;
  }
  try {
    lastResult = await processGroups(groups);
  } catch (err) {
    setStatus(`Processing error: ${err.message}`);
    return;
  }
  renderLegend(lastResult);
  renderFits(lastResult);
  if (state.tab === "color") renderMetricCharts();
  else renderSpectra();
}

function renderMetricCharts() {
  const charts = $("#charts");
  const theme = screenTheme();
  const wanted = METRICS.filter((m) => state.settings.metrics.includes(m.key));
  if (state.expanded && !state.settings.metrics.includes(state.expanded)) state.expanded = null;
  // Keep chart divs for metrics still shown so Plotly can update in place.
  const existing = new Map([...charts.children].map((d) => [d.dataset.metric, d]));
  const divs = wanted.map((m) => existing.get(m.key) || el("div", { class: "chart", "data-metric": m.key }));
  divs.forEach((d) => d.classList.toggle("expanded", d.dataset.metric === state.expanded));
  charts.replaceChildren(...divs);
  wanted.forEach((m, i) => {
    Plotly.react(divs[i], buildTraces(m.key, lastResult, state.settings.view, theme),
      baseLayout(m.key, theme), screenConfig(m.key));
  });
}

function toggleExpand(metric) {
  state.expanded = state.expanded === metric ? null : metric;
  const charts = $("#charts");
  for (const d of charts.children) d.classList.toggle("expanded", d.dataset.metric === state.expanded);
  resizeCharts();
  const target = charts.querySelector(".chart.expanded");
  if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
}

function resizeCharts() {
  document.querySelectorAll(".chart").forEach((d) => { if (d._fullLayout) Plotly.Plots.resize(d); });
}

function renderFits(result) {
  const panel = $("#fitsPanel");
  const rows = [];
  if (result && state.settings.fit_model !== "none") {
    for (const r of result.groups) for (const [metric, fit] of Object.entries(r.fits || {})) {
      if (!state.settings.metrics.includes(metric)) continue;
      rows.push(el("tr", {},
        el("td", {}, r.group.name), el("td", {}, METRIC_LABEL[metric]),
        el("td", {}, fit.error ? `failed: ${fit.error}` : fit.equation),
        el("td", {}, fit.error ? "" : fitParamText(fit)),
        el("td", {}, fit.error ? "" : fmtNum(fit.r2, 4))));
    }
  }
  panel.hidden = !rows.length;
  $("#fitsTable tbody").replaceChildren(...rows);
  $("#fitsTitle").textContent = `Curve fits — ${FIT_LABELS[state.settings.fit_model]} (fitted to group means)`;
}

function renderSpectra() {
  const wrap = $("#spectra");
  const theme = screenTheme();
  const startTraces = [];
  const diffTraces = [];
  for (const g of visibleGroups()) {
    const color = groupColor(g, theme);
    for (const id of includedMembers(g)) {
      const m = state.measurements.get(id);
      if (!m.spectra || !m.spectra.samples.length) continue;
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
  const layout = (title, y) => {
    const l = baseLayout("L", theme, { title });
    l.xaxis.title.text = "Wavelength (nm)";
    l.yaxis.title.text = y;
    return l;
  };
  const cfg = { responsive: true, displaylogo: false, toImageButtonOptions: { format: "png", scale: 3 } };
  Plotly.react(a, startTraces, layout("Spectra — start (solid) / end (dotted)", "Sample spectrum (as recorded)"), cfg);
  Plotly.react(b, diffTraces, layout("Spectral change", "End − start"), cfg);
}

// ---------------------------------------------------------------------------
// Image export
// ---------------------------------------------------------------------------

let exportMetric = null;

function openExportDialog(metric) {
  if (!lastResult) return;
  exportMetric = metric;
  const o = state.exportOpts;
  $("#exTitle").value = o.titles[metric] ?? METRIC_LABEL[metric];
  $("#exTheme").value = o.theme;
  $("#exWidth").value = o.width;
  $("#exHeight").value = o.height;
  $("#exScale").value = o.scale;
  $("#exFormat").value = o.format;
  $("#exLegend").value = o.legend;
  $("#exportDialog").showModal();
}

async function renderOffscreen(traces, layout, width, height) {
  const div = el("div", { style: `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px` });
  document.body.append(div);
  await Plotly.newPlot(div, traces, layout, { staticPlot: true });
  return div;
}

async function exportChart() {
  const o = state.exportOpts;
  Object.assign(o, {
    theme: $("#exTheme").value, width: Number($("#exWidth").value) || 1200, height: Number($("#exHeight").value) || 750,
    scale: Number($("#exScale").value) || 2, format: $("#exFormat").value, legend: $("#exLegend").value,
  });
  const title = $("#exTitle").value;
  o.titles[exportMetric] = title;
  const theme = THEMES[o.theme];
  const traces = buildTraces(exportMetric, lastResult, state.settings.view, theme, o.legend !== "none");
  const layout = baseLayout(exportMetric, theme, { title, exporting: true, legend: o.legend });
  const div = await renderOffscreen(traces, layout, o.width, o.height);
  try {
    const url = await Plotly.toImage(div, {
      format: o.format, width: o.width, height: o.height, scale: o.format === "svg" ? 1 : o.scale,
    });
    download(`${safeFilename(title || METRIC_LABEL[exportMetric])}.${o.format === "jpeg" ? "jpg" : o.format}`, await (await fetch(url)).blob());
  } finally {
    Plotly.purge(div);
    div.remove();
  }
}

// ---------------------------------------------------------------------------
// Export / sessions
// ---------------------------------------------------------------------------

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(name, rows) {
  // Leading BOM so Excel reads the file as UTF-8 (Mlux·h, Δ).
  download(name, "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"));
}

function exportCsv(kind) {
  if (!lastResult) return;
  const keys = METRICS.filter((m) => m.key !== "ab").map((m) => m.key);
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
  downloadCsv(`mft_${kind === "mean" ? "means" : "replicates"}.csv`, rows);
}

function exportFitsCsv() {
  if (!lastResult) return;
  const rows = [["group", "metric", "model", "equation", "param1", "value1", "param2", "value2", "r2", "x_axis"]];
  for (const r of lastResult.groups) for (const [metric, fit] of Object.entries(r.fits || {})) {
    if (fit.error) { rows.push([r.group.name, metric, fit.model, "failed: " + fit.error]); continue; }
    rows.push([r.group.name, metric, fit.model, fit.equation, ...Object.entries(fit.params).flat(), fit.r2, X_LABELS[state.settings.x_axis]]);
  }
  downloadCsv("mft_fits.csv", rows);
}

function saveSession() {
  const session = {
    version: SESSION_VERSION,
    saved: new Date().toISOString(),
    settings: state.settings,
    exportOpts: state.exportOpts,
    groups: state.groups,
    nextColor: state.nextColor,
    nextGroupId: state.nextGroupId,
    measurements: [...state.measurements.values()],
    images: Object.fromEntries(state.images),
  };
  download("mft_session.json", JSON.stringify(session), "application/json");
}

async function loadSession(file) {
  try {
    const s = JSON.parse(await file.text());
    if (s.version !== SESSION_VERSION) throw new Error("unsupported session version");
    state.measurements = new Map(s.measurements.map((m) => [m.id, m]));
    state.images = new Map(Object.entries(s.images || {}));
    state.groups = s.groups;
    state.settings = { ...state.settings, ...s.settings };
    state.exportOpts = { ...state.exportOpts, ...(s.exportOpts || {}) };
    state.nextColor = s.nextColor;
    state.nextGroupId = s.nextGroupId;
    state.selection.clear();
    syncControls();
    renderSidebar();
    setStatus(`Session loaded: ${state.measurements.size} measurements, ${state.groups.length} groups, ${state.images.size} images.`);
    scheduleRender();
  } catch (err) {
    setStatus(`Could not load session: ${err.message}`);
  }
}

async function stopServer() {
  if (!confirm("Stop the MFT-Parser server? Unsaved groups and settings will be lost (use Save session first).")) return;
  try {
    const res = await (await fetch("/api/shutdown", { method: "POST" })).json();
    if (!res.stopped) return setStatus(`Could not stop the server: ${res.reason}`);
  } catch (err) {
    return setStatus(`Could not stop the server: ${err.message}`);
  }
  document.body.replaceChildren(el("div", { class: "stopped" },
    el("h2", {}, "MFT-Parser has stopped."),
    el("p", {}, "You can close this tab. Run run_windows.bat to start it again.")));
}

// ---------------------------------------------------------------------------
// Collapsible UI (remembered per browser)
// ---------------------------------------------------------------------------

const UI_KEY = "mft-parser-ui";
const ui = { collapsed: [], sidebarHidden: false };

function loadUi() {
  try { Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY)) || {}); } catch { /* storage unavailable */ }
}

function saveUi() {
  try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* storage unavailable */ }
}

function setupCollapsibleSections() {
  document.querySelectorAll("section[data-section]").forEach((sec) => {
    const key = sec.dataset.section;
    const h2 = sec.querySelector(":scope > h2, :scope > .section-head h2");
    sec.classList.toggle("collapsed", ui.collapsed.includes(key));
    h2.title = "Click to collapse / expand";
    h2.addEventListener("click", () => {
      const collapsed = sec.classList.toggle("collapsed");
      ui.collapsed = collapsed ? [...new Set([...ui.collapsed, key])] : ui.collapsed.filter((k) => k !== key);
      saveUi();
    });
  });
}

function setSidebarHidden(hidden) {
  ui.sidebarHidden = hidden;
  document.body.classList.toggle("sidebar-hidden", hidden);
  $("#showSidebar").hidden = !hidden;
  saveUi();
  resizeCharts();
}

function hideMetric(metric) {
  state.settings.metrics = state.settings.metrics.filter((k) => k !== metric);
  syncControls();
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Controls wiring
// ---------------------------------------------------------------------------

const CONTROL_MAP = {
  xAxis: "x_axis", maxDose: "max_dose", smoothing: "smoothing", window: "window",
  polyorder: "polyorder", avgPoints: "avg_points", columns: "columns", fitModel: "fit_model",
};

function syncControls() {
  for (const [id, key] of Object.entries(CONTROL_MAP)) $("#" + id).value = state.settings[key];
  $("#chartHeight").value = state.settings.chart_height;
  $("#chartHeightVal").textContent = `${state.settings.chart_height}px`;
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
  $("#fitModel").replaceChildren(...Object.entries(FIT_LABELS).map(([v, l]) => el("option", { value: v }, l)));

  for (const [id, key] of Object.entries(CONTROL_MAP)) {
    $("#" + id).addEventListener("change", (e) => {
      state.settings[key] = e.target.value;
      syncControls();
      if (state.groups.some((g) => !g.collapsed)) renderGroups(); // refresh max-dose placeholders
      scheduleRender();
    });
  }
  $("#chartHeight").addEventListener("input", (e) => {
    state.settings.chart_height = Number(e.target.value);
    $("#chartHeightVal").textContent = `${e.target.value}px`;
    document.documentElement.style.setProperty("--chart-h", `${e.target.value}px`);
    resizeCharts();
  });
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
    if (!confirm("Remove all measurements, images and groups?")) return;
    state.measurements.clear();
    state.images.clear();
    state.groups = [];
    state.selection.clear();
    state.nextColor = 0;
    showWarnings([]);
    setStatus("");
    renderSidebar();
    scheduleRender();
  });

  const dz = $("#dropzone");
  dz.addEventListener("dragover", (e) => { if (dragPayload) return; e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", async (e) => {
    if (dragPayload) return;
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
  $("#exportFits").addEventListener("click", exportFitsCsv);
  $("#reportBtn").addEventListener("click", () => openReportDialog(visibleGroups()));
  $("#stopServer").addEventListener("click", stopServer);
  $("#hideSidebar").addEventListener("click", () => setSidebarHidden(true));
  $("#showSidebar").addEventListener("click", () => setSidebarHidden(false));
  $("#foldGroups").addEventListener("click", () => {
    const anyOpen = state.groups.some((g) => !g.collapsed);
    state.groups.forEach((g) => { g.collapsed = anyOpen; });
    renderGroups();
  });
  dropTarget($("#dropNewGroup"), ({ ids, from }, copy) => {
    const g = createGroup(`Group ${state.nextGroupId}`, sortedIds(ids));
    g.collapsed = false;
    const source = state.groups.find((x) => x.id === from);
    if (source && !copy) removeFromGroup(source, ids);
  });
  dropTarget($("#dropRemove"), ({ ids, from }) => {
    const source = state.groups.find((x) => x.id === from);
    if (source) removeFromGroup(source, ids);
  });
  loadUi();
  setupCollapsibleSections();
  setSidebarHidden(ui.sidebarHidden);

  $("#exportForm").addEventListener("submit", (e) => {
    if (e.submitter && e.submitter.value === "cancel") return;
    exportChart().catch((err) => setStatus(`Export failed: ${err.message}`));
  });
  $("#reportForm").addEventListener("submit", (e) => {
    if (e.submitter && e.submitter.value === "cancel") return;
    e.preventDefault();
    generateReport().catch((err) => { $("#rpStatus").textContent = `Report failed: ${err.message}`; });
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { renderSidebar(); scheduleRender(); });

  syncControls();
  renderSidebar();
  renderPlots();
}

document.addEventListener("DOMContentLoaded", wire);
