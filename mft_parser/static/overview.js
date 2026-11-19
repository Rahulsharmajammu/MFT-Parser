"use strict";

// Overview images: a photo of the whole object with the measured areas marked on it.
// Each mark (rectangle, ellipse or point) has a label and can be linked to a group or a
// measurement; reports then show where each group was measured.

const OV_TOOLS = { rect: "Rectangle", ellipse: "Ellipse", point: "Point" };
const UNLINKED_COLOR = "#ffd400";
const ov = { current: null, tool: "rect", selected: null, drag: null }; // editor state, not saved

function currentOverview() {
  return state.overviews.find((o) => o.id === ov.current) || state.overviews[0] || null;
}

function parseLink(link) {
  const i = (link || "").indexOf(":");
  return i < 0 ? [null, null] : [link.slice(0, i), link.slice(i + 1)];
}

// Groups a mark belongs to: the linked group, or every group containing the linked measurement.
function annGroups(a) {
  const [kind, id] = parseLink(a.link);
  if (kind === "g") return state.groups.filter((g) => g.id === id);
  if (kind === "m") return state.groups.filter((g) => g.members.includes(id));
  return [];
}

function annColor(a) {
  const groups = annGroups(a);
  const g = groups.find((x) => !isRef(x)) || groups[0];
  return g ? groupColor(g, THEMES.light) : UNLINKED_COLOR;
}

function linkName(a) {
  const [kind, id] = parseLink(a.link);
  if (kind === "g") return (state.groups.find((g) => g.id === id) || {}).name || "";
  return kind === "m" ? id : "";
}

// SVG markup for the marks, in image pixel coordinates. `highlight(a)` false draws a mark faded and unlabelled.
function annotationMarkup(o, { highlight = null, selected = null } = {}) {
  const size = Math.max(o.w, o.h);
  const fs = size * 0.024;
  const ns = 'vector-effect="non-scaling-stroke"';
  return o.annotations.map((a) => {
    const dim = highlight && !highlight(a);
    const color = annColor(a);
    const sw = a.id === selected ? 4 : 2.5;
    let geom;
    let lx;
    let ly;
    if (a.shape === "point") {
      const r = size * 0.011;
      geom = `<circle cx="${a.x}" cy="${a.y}" r="${r}" fill="${color}" stroke="#000" stroke-opacity=".6" stroke-width="${sw + 2}" ${ns}/>
        <circle cx="${a.x}" cy="${a.y}" r="${r}" fill="${color}" stroke="#fff" stroke-width="${sw - 1}" ${ns}/>`;
      lx = a.x + r * 1.5;
      ly = a.y + fs * 0.35;
    } else {
      const shape = (extra) => (a.shape === "ellipse"
        ? `<ellipse cx="${a.x + a.w / 2}" cy="${a.y + a.h / 2}" rx="${a.w / 2}" ry="${a.h / 2}" ${extra} ${ns}/>`
        : `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" ${extra} ${ns}/>`);
      geom = shape(`fill="none" stroke="#000" stroke-opacity=".55" stroke-width="${sw + 2.5}"`)
        + shape(`fill="${color}" fill-opacity=".12" stroke="${color}" stroke-width="${sw}"`);
      lx = a.x;
      ly = a.y - fs * 0.35;
      if (ly < fs) ly = a.y + a.h + fs; // no room above: put the label below
    }
    const label = !dim && a.label
      ? `<text x="${lx}" y="${ly}" font-size="${fs}" font-family="Segoe UI, Arial, sans-serif" font-weight="600" fill="#fff"
          stroke="#000" stroke-width="${fs * 0.16}" stroke-linejoin="round" paint-order="stroke">${esc(a.label)}</text>` : "";
    return `<g data-ann="${a.id}" opacity="${dim ? 0.3 : 1}">${geom}${label}</g>`;
  }).join("");
}

// Complete SVG of an overview image with its marks. `imageRef` points at an <image> defined once
// elsewhere in the document (reports use this to avoid repeating a large image in every section).
function overviewSvg(o, { highlight = null, imageRef = null } = {}) {
  const img = imageRef ? `<use href="#${imageRef}"/>` : `<image href="${o.src}" width="${o.w}" height="${o.h}"/>`;
  return `<svg viewBox="0 0 ${o.w} ${o.h}" xmlns="http://www.w3.org/2000/svg">${img}${annotationMarkup(o, { highlight })}</svg>`;
}

async function addOverviewImages(files) {
  for (const f of files) {
    if (!IMAGE_RE.test(f.name)) {
      setStatus(`${f.name}: not a supported image (PNG, JPEG, BMP, GIF, WebP)`);
      continue;
    }
    const src = await readImage(f, 2400);
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("unreadable image"));
      i.src = src;
    });
    const o = {
      id: `o${state.nextOverviewId++}`, name: f.name.replace(/\.[^.]+$/, ""), src,
      w: img.naturalWidth, h: img.naturalHeight, annotations: [], nextAnn: 1,
    };
    state.overviews.push(o);
    ov.current = o.id;
  }
  ov.selected = null;
  renderOverview();
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function renderOverview() {
  const wrap = $("#overview");
  const o = currentOverview();
  if (o) ov.current = o.id;

  const toolbar = el("div", { class: "ov-toolbar" },
    el("label", { class: "btn primary" }, "Add overview image…",
      el("input", { type: "file", accept: "image/*", multiple: true, hidden: true, onchange: (e) => { addOverviewImages([...e.target.files]); e.target.value = ""; } })),
    ...state.overviews.map((x) => el("button", {
      class: "btn small" + (o && x.id === o.id ? " on" : ""), title: "Show this image",
      onclick: () => { ov.current = x.id; ov.selected = null; renderOverview(); },
    }, x.name)));
  if (!o) {
    wrap.replaceChildren(toolbar, el("p", { class: "empty" },
      "Add a photo of the whole object, then drag on it to mark the areas you measured. Link each mark to a group or measurement so reports can show where it was taken."));
    return;
  }

  const tools = el("div", { class: "seg ov-tools" }, ...Object.entries(OV_TOOLS).map(([k, l]) => el("button", {
    class: ov.tool === k ? "on" : "", onclick: () => { ov.tool = k; renderOverview(); },
  }, l)));
  const imageOpts = el("div", { class: "row" },
    el("label", { class: "inline" }, "Name",
      el("input", { type: "text", value: o.name, title: "Image name, shown as the caption in reports", onchange: (e) => { o.name = e.target.value || o.name; renderOverview(); } })),
    tools,
    el("button", {
      class: "btn small ghost", title: "Remove this overview image and its marks",
      onclick: () => {
        if (!confirm(`Remove the overview image "${o.name}" and its ${o.annotations.length} marks?`)) return;
        state.overviews = state.overviews.filter((x) => x !== o);
        ov.current = null;
        ov.selected = null;
        renderOverview();
      },
    }, "Remove image"));

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${o.w} ${o.h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("ov-overlay", `tool-${ov.tool}`);
  svg.innerHTML = annotationMarkup(o, { selected: ov.selected });
  wireStage(svg, o);
  const stage = el("div", { class: "ov-stage" }, el("img", { src: o.src, alt: o.name, draggable: false }), svg);

  wrap.replaceChildren(toolbar, imageOpts,
    el("p", { class: "muted small" }, "Drag on the image to mark an area (or click, with the Point tool). Click a mark to select it, drag it to move it, press Delete to remove it."),
    el("div", { class: "ov-body" }, stage, annotationList(o)));
}

function annotationList(o) {
  const groupOpts = state.groups.map((g) => el("option", { value: `g:${g.id}` }, g.name));
  const measOpts = sortedIds(state.measurements.keys()).map((id) => el("option", { value: `m:${id}` }, id));
  const rows = o.annotations.map((a) => {
    const select = el("select", {
      title: "Link this mark to a group or measurement",
      onchange: (e) => { a.link = e.target.value; renderOverview(); },
    }, el("option", { value: "" }, "— not linked —"),
    el("optgroup", { label: "Groups" }, ...groupOpts.map((x) => x.cloneNode(true))),
    el("optgroup", { label: "Measurements" }, ...measOpts.map((x) => x.cloneNode(true))));
    select.value = a.link || "";
    if (select.value !== (a.link || "")) {
      // Linked group or measurement no longer exists.
      select.prepend(el("option", { value: a.link }, `(missing) ${parseLink(a.link)[1]}`));
      select.value = a.link;
    }
    return el("div", {
      class: "ov-ann" + (a.id === ov.selected ? " selected" : ""),
      onclick: (e) => { if (e.target.closest("input,select,button")) return; ov.selected = a.id; renderOverview(); },
    },
    el("span", { class: "ov-dot", style: `background:${annColor(a)}` }),
    el("input", { type: "text", value: a.label, title: "Label shown on the image", onchange: (e) => { a.label = e.target.value; renderOverview(); } }),
    select,
    el("button", { class: "icon-btn", title: "Delete mark", onclick: () => deleteAnnotation(o, a.id) }, "✕"));
  });
  return el("div", { class: "ov-list" },
    el("h2", {}, `Marks (${o.annotations.length})`),
    ...(rows.length ? rows : [el("p", { class: "muted small" }, "No marks yet.")]));
}

function deleteAnnotation(o, id) {
  o.annotations = o.annotations.filter((a) => a.id !== id);
  if (ov.selected === id) ov.selected = null;
  renderOverview();
}

function wireStage(svg, o) {
  const toImage = (e) => {
    const r = svg.getBoundingClientRect();
    return {
      x: Math.min(o.w, Math.max(0, ((e.clientX - r.left) / r.width) * o.w)),
      y: Math.min(o.h, Math.max(0, ((e.clientY - r.top) / r.height) * o.h)),
    };
  };
  const redraw = () => { svg.innerHTML = annotationMarkup(o, { selected: ov.selected }); };

  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    const p = toImage(e);
    const hit = e.target.closest("[data-ann]");
    if (hit) {
      const a = o.annotations.find((x) => x.id === hit.dataset.ann);
      ov.selected = a.id;
      ov.drag = { mode: "move", a, start: p, orig: { x: a.x, y: a.y }, moved: false };
    } else {
      const a = { id: `a${o.nextAnn}`, shape: ov.tool, x: p.x, y: p.y, w: 0, h: 0, label: String(o.nextAnn), link: "" };
      o.nextAnn += 1;
      o.annotations.push(a);
      ov.selected = a.id;
      ov.drag = ov.tool === "point"
        ? { mode: "move", a, start: p, orig: { x: a.x, y: a.y }, moved: true }
        : { mode: "draw", a, start: p };
    }
    redraw();
  });
  svg.addEventListener("pointermove", (e) => {
    const d = ov.drag;
    if (!d) return;
    const p = toImage(e);
    if (d.mode === "draw") {
      Object.assign(d.a, {
        x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y),
        w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y),
      });
    } else {
      const w = d.a.w || 0;
      const h = d.a.h || 0;
      d.a.x = Math.min(o.w - w, Math.max(0, d.orig.x + p.x - d.start.x));
      d.a.y = Math.min(o.h - h, Math.max(0, d.orig.y + p.y - d.start.y));
      d.moved = true;
    }
    redraw();
  });
  const finish = () => {
    const d = ov.drag;
    if (!d) return;
    ov.drag = null;
    const min = Math.max(o.w, o.h) * 0.006;
    if (d.mode === "draw" && d.a.w < min && d.a.h < min) {
      // A click without a drag: no mark, just clear the selection.
      o.annotations = o.annotations.filter((x) => x !== d.a);
      o.nextAnn -= 1;
      ov.selected = null;
    }
    renderOverview();
  };
  svg.addEventListener("pointerup", finish);
  svg.addEventListener("pointercancel", finish);
}

document.addEventListener("keydown", (e) => {
  if (state.tab !== "overview" || !ov.selected || e.target.closest("input,select,textarea")) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    const o = currentOverview();
    if (o) deleteAnnotation(o, ov.selected);
  }
});
