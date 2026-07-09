"use strict";
/// <reference path="./types.ts" />
// ── Elements ──────────────────────────────────────────────
const sheetEl = document.querySelector(".sheet");
const progressBar = document.getElementById("progress-bar");
const composeHeader = document.getElementById("compose-header");
const backBtn = document.getElementById("back-btn");
const stageEmpty = document.getElementById("stage-empty");
const stageIcon = document.getElementById("stage-icon");
const stageText = document.getElementById("stage-text");
const stageLoading = document.getElementById("stage-loading");
const stageLoadingText = document.getElementById("stage-loading-text");
const stageErrorEl = document.getElementById("stage-error");
const stageErrorText = document.getElementById("stage-error-text");
const stageMedia = document.getElementById("stage-media");
const stageBadge = document.getElementById("stage-badge");
const fmtSwitch = document.getElementById("fmt-switch");
const fmtSvgBtn = document.getElementById("fmt-svg");
const fmtPngBtn = document.getElementById("fmt-png");
const captionName = document.getElementById("caption-name");
const captionMeta = document.getElementById("caption-meta");
const tagsRow = document.getElementById("tags-row");
const variantRow = document.getElementById("variant-row");
const variantSelect = document.getElementById("variant-select");
const chipsEl = document.getElementById("chips");
const chipPng = document.getElementById("chip-png");
const chipSvg = document.getElementById("chip-svg");
const chipTokens = document.getElementById("chip-tokens");
const depthDec = document.getElementById("depth-dec");
const depthInc = document.getElementById("depth-inc");
const depthVal = document.getElementById("depth-val");
const inspTabs = document.getElementById("insp-tabs");
const inspLabel = document.getElementById("insp-label");
const inspTabTree = document.getElementById("insp-tab-tree");
const inspTabJson = document.getElementById("insp-tab-json");
const inspJsonSize = document.getElementById("insp-json-size");
const treePanel = document.getElementById("tree-panel");
const treeVariantSelect = document.getElementById("tree-variant-select");
const treeList = document.getElementById("tree-list");
const treeResizer = document.getElementById("tree-resizer");
const treeProps = document.getElementById("tree-props");
const treePropsLabel = document.getElementById("tree-props-label");
const treePropsBody = document.getElementById("tree-props-body");
const dataPane = document.getElementById("data-pane");
const ctaPrimary = document.getElementById("cta-primary");
const ctaPrimaryLabel = document.getElementById("cta-primary-label");
const ctaAll = document.getElementById("cta-all");
const ctaDownload = document.getElementById("cta-download");
let selection = {
    isComponent: false, name: null, nodeType: null,
    width: null, height: null, extraCount: 0, variants: null,
};
let mode = "empty";
let errorMessage = null;
let currentBundle = null;
let loadingText = "exporting…";
let lastVariantIndex = null;
let activeInspTab = null;
let displayAssets = null;
let previewLoading = false;
// Frozen at the moment Export is pressed, so the result caption doesn't
// drift if the live Figma selection changes while the export is in flight.
let exportedSnapshot = null;
function sameTarget(a, b) {
    if (!b)
        return false;
    return a.name === b.name && a.nodeType === b.nodeType && a.width === b.width && a.height === b.height;
}
// Flags
let pngOn = true;
let svgOn = false;
let tokensOn = true;
let depth = null; // null = "full"
function syncChip(btn, on) {
    btn.classList.toggle("on", on);
}
chipPng.addEventListener("click", () => { pngOn = !pngOn; syncChip(chipPng, pngOn); });
chipSvg.addEventListener("click", () => { svgOn = !svgOn; syncChip(chipSvg, svgOn); });
chipTokens.addEventListener("click", () => { tokensOn = !tokensOn; syncChip(chipTokens, tokensOn); });
syncChip(chipPng, pngOn);
syncChip(chipSvg, svgOn);
syncChip(chipTokens, tokensOn);
const DEPTH_MAX = 10;
function renderDepth() {
    depthVal.textContent = depth === null ? "Full" : String(depth);
}
depthDec.addEventListener("click", (e) => {
    e.stopPropagation();
    depth = depth === null ? DEPTH_MAX : Math.max(1, depth - 1);
    renderDepth();
});
depthInc.addEventListener("click", (e) => {
    e.stopPropagation();
    if (depth === null)
        return;
    depth = depth + 1 > DEPTH_MAX ? null : depth + 1;
    renderDepth();
});
renderDepth();
// ── Icons ────────────────────────────────────────────────
function dashedIconSvg() {
    return `<svg width="32" height="32" viewBox="0 0 34 34" fill="none">
    <rect x="4" y="4" width="26" height="26" rx="6" stroke="currentColor" stroke-width="1.6" stroke-dasharray="4 4"/>
  </svg>`;
}
function typeIconSvg(nodeType) {
    if (nodeType === "TEXT") {
        return `<svg width="32" height="32" viewBox="0 0 34 34" fill="none">
      <path d="M9 10h16M17 10v14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;
    }
    if (nodeType === "VECTOR" || nodeType === "BOOLEAN_OPERATION") {
        return `<svg width="32" height="32" viewBox="0 0 34 34" fill="none">
      <path d="M8 26 20 8l6 6-12 12H8v-8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
    }
    if (nodeType === "COMPONENT" || nodeType === "COMPONENT_SET" || nodeType === "INSTANCE") {
        return `<svg width="32" height="32" viewBox="0 0 34 34" fill="none">
      <rect x="8" y="8" width="18" height="18" rx="3" transform="rotate(45 17 17)" stroke="currentColor" stroke-width="1.8"/>
    </svg>`;
    }
    return `<svg width="32" height="32" viewBox="0 0 34 34" fill="none">
    <path d="M6 12V6h6M22 6h6v6M28 22v6h-6M12 28H6v-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}
// ── Options ──────────────────────────────────────────────
function getOptions() {
    const options = {
        includePNG: pngOn,
        includeSVG: svgOn,
        tokenMode: tokensOn ? "resolved" : "raw",
        treeDepth: depth === null ? "full" : depth,
    };
    if (!variantRow.hidden && variantSelect.value && variantSelect.value !== ALL_VARIANTS) {
        options.variantId = variantSelect.value;
    }
    return options;
}
function wantsAllVariants() {
    return !variantRow.hidden && variantSelect.value === ALL_VARIANTS;
}
function selectedVariantIndex() {
    const variants = selection.variants;
    if (!variants || variantRow.hidden)
        return null;
    const idx = variants.findIndex((v) => v.id === variantSelect.value);
    return idx === -1 ? null : idx + 1;
}
function describeExport(index) {
    if (index === null)
        return "exporting…";
    const name = selection.variants[index - 1].name;
    return `exporting "${name}" #${index}…`;
}
// ── Variant picker ───────────────────────────────────────
const ALL_VARIANTS = "__all__";
function renderVariantPicker() {
    const variants = selection.variants;
    if (!variants || variants.length < 2) {
        variantRow.hidden = true;
        variantSelect.innerHTML = "";
        return;
    }
    const prevValue = variantSelect.value;
    variantSelect.innerHTML = "";
    variants.forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = v.name;
        variantSelect.appendChild(opt);
    });
    const allOpt = document.createElement("option");
    allOpt.value = ALL_VARIANTS;
    allOpt.textContent = "All variants";
    variantSelect.appendChild(allOpt);
    if (prevValue === ALL_VARIANTS || variants.some((v) => v.id === prevValue)) {
        variantSelect.value = prevValue;
    }
    variantRow.hidden = false;
}
// Switching variants (including to "All") should re-render the hero preview
// to match — not just change what a later Export click would use.
variantSelect.addEventListener("change", () => {
    if (mode === "idle")
        startPreview();
});
// ── Rendering ────────────────────────────────────────────
function setStageLayer(layer) {
    stageEmpty.hidden = layer !== "empty";
    stageLoading.hidden = layer !== "loading";
    stageErrorEl.hidden = layer !== "error";
    stageMedia.hidden = layer !== "media";
}
function resetInsp() {
    activeInspTab = null;
    inspTabTree.classList.remove("active");
    inspTabJson.classList.remove("active");
    inspTabTree.setAttribute("aria-expanded", "false");
    inspTabJson.setAttribute("aria-expanded", "false");
    inspTabs.hidden = true;
    treePanel.hidden = true;
    dataPane.hidden = true;
    sheetEl.classList.remove("json-expanded");
}
function render() {
    composeHeader.hidden = mode !== "result";
    chipsEl.dataset.disabled = mode === "idle" ? "false" : "true";
    progressBar.classList.toggle("scanning", mode === "loading");
    if (mode === "empty") {
        setStageLayer("empty");
        stageEmpty.dataset.ready = "false";
        stageIcon.innerHTML = dashedIconSvg();
        stageText.textContent = "Select a layer in Figma to begin";
        stageBadge.hidden = true;
        fmtSwitch.hidden = true;
        captionName.textContent = "Nothing selected";
        captionName.classList.add("muted");
        captionMeta.textContent = "";
        tagsRow.hidden = true;
        tagsRow.innerHTML = "";
        variantRow.hidden = true;
        resetInsp();
        ctaPrimary.disabled = true;
        ctaPrimaryLabel.textContent = "Export Screen";
        ctaAll.hidden = true;
        ctaDownload.hidden = true;
        return;
    }
    if (mode === "idle") {
        stageBadge.hidden = true;
        if (errorMessage) {
            fmtSwitch.hidden = true;
            setStageLayer("error");
            stageErrorText.textContent = errorMessage;
        }
        else if (previewLoading) {
            fmtSwitch.hidden = true;
            setStageLayer("loading");
            stageLoadingText.textContent = "rendering preview…";
        }
        else if (displayAssets && (displayAssets.png_base64 || displayAssets.svg)) {
            renderStageImage(displayAssets);
        }
        else {
            fmtSwitch.hidden = true;
            setStageLayer("empty");
            stageEmpty.dataset.ready = "true";
            stageIcon.innerHTML = typeIconSvg(selection.nodeType);
            stageText.textContent = "No preview available — press Export to build the full JSON export";
        }
        captionName.textContent = selection.name ?? "Nothing selected";
        captionName.classList.remove("muted");
        const parts = [];
        if (selection.nodeType)
            parts.push(selection.nodeType);
        if (selection.width !== null && selection.height !== null) {
            parts.push(`${selection.width}×${selection.height}`);
        }
        if (selection.extraCount > 0)
            parts.push(`+${selection.extraCount} more`);
        captionMeta.textContent = parts.join(" · ");
        tagsRow.hidden = true;
        tagsRow.innerHTML = "";
        renderVariantPicker();
        resetInsp();
        ctaPrimary.disabled = false;
        ctaPrimaryLabel.textContent = "Export Screen";
        ctaAll.hidden = !selection.isComponent;
        ctaAll.textContent = "Export component for library";
        ctaDownload.hidden = true;
        return;
    }
    if (mode === "loading") {
        setStageLayer("loading");
        stageMedia.innerHTML = ""; // clear the compose-view preview while the full export runs
        stageLoadingText.textContent = loadingText;
        stageBadge.hidden = true;
        fmtSwitch.hidden = true;
        resetInsp();
        ctaPrimary.dataset.loading = "true";
        ctaPrimary.disabled = true;
        ctaAll.hidden = true;
        ctaDownload.hidden = true;
        return;
    }
    // mode === "result"
    ctaPrimary.removeAttribute("data-loading");
    if (currentBundle)
        renderResult(currentBundle);
}
function renderResult(bundle) {
    const isComp = "variants" in bundle;
    const snap = exportedSnapshot;
    // Caption — name/meta frozen from the export request, tags derived from the bundle.
    captionName.textContent = bundle.meta.name;
    captionName.classList.remove("muted");
    const parts = [];
    if (snap?.nodeType)
        parts.push(snap.nodeType);
    if (snap && snap.width !== null && snap.height !== null) {
        parts.push(`${snap.width}×${snap.height}`);
    }
    captionMeta.textContent = parts.join(" · ");
    const tags = buildTags(bundle);
    if (!isComp && lastVariantIndex !== null)
        tags.push(`#${lastVariantIndex}`);
    tagsRow.innerHTML = "";
    tags.forEach((label) => {
        const s = document.createElement("span");
        s.className = "tag";
        s.textContent = label;
        tagsRow.appendChild(s);
    });
    tagsRow.hidden = tags.length === 0;
    variantRow.hidden = true;
    // Stage badge
    if (!isComp && lastVariantIndex !== null) {
        stageBadge.textContent = `#${lastVariantIndex} ${selection.variants ? selection.variants[lastVariantIndex - 1].name : ""}`.trim();
        stageBadge.hidden = false;
    }
    else if (isComp) {
        stageBadge.textContent = `${bundle.variants.length} variants`;
        stageBadge.hidden = false;
    }
    else {
        stageBadge.hidden = true;
    }
    const isSingle = !("variants" in bundle);
    displayAssets = {
        png_base64: bundle.assets.png_base64,
        svg: isSingle ? bundle.assets.svg : null,
    };
    if (displayAssets.png_base64 || displayAssets.svg) {
        renderStageImage(displayAssets);
    }
    else {
        setStageLayer("media");
        stageMedia.innerHTML = "";
        fmtSwitch.hidden = true;
    }
    // JSON pane
    const json = JSON.stringify(bundle, null, 2);
    const LIMIT = 8000;
    const truncated = json.length > LIMIT;
    dataPane.innerHTML = highlight(truncated
        ? json.slice(0, LIMIT) + "\n\n// … truncated — use Download for full output"
        : json);
    inspJsonSize.textContent = `(${formatBytes(json.length)})`;
    // Tree pane
    if (isComp) {
        populateTreeVariantSelect(bundle.variants);
    }
    else {
        treeVariantSelect.hidden = true;
        treeVariantSelect.innerHTML = "";
        renderTree(bundle.tree);
    }
    inspTabs.hidden = false;
    ctaPrimaryLabel.textContent = "Copy";
    ctaPrimary.disabled = false;
    ctaAll.hidden = true;
    ctaDownload.hidden = false;
}
function buildTags(b) {
    if ("variants" in b) {
        const tags = [b.meta.type];
        tags.push(`${b.variants.length} variant${b.variants.length !== 1 ? "s" : ""}`);
        const mc = Object.keys(b.variableModes).length;
        if (mc > 0)
            tags.push(`${mc} mode collection${mc !== 1 ? "s" : ""}`);
        return tags;
    }
    const tags = [b.meta.type];
    const cc = b.context.childCount ?? 0;
    if (cc > 0)
        tags.push(`${cc} child${cc !== 1 ? "ren" : ""}`);
    if (b.context.hasText)
        tags.push("text");
    if (b.context.hasVectors)
        tags.push("vector");
    return tags;
}
// ── Preview (SVG/PNG) ────────────────────────────────────
function renderStageImage(assets) {
    const hasSvg = !!assets.svg;
    const hasPng = !!assets.png_base64;
    fmtSvgBtn.disabled = !hasSvg;
    fmtPngBtn.disabled = !hasPng;
    fmtSwitch.hidden = !(hasSvg && hasPng);
    showPreview(hasSvg ? "svg" : "png");
}
function showPreview(fmt) {
    if (!displayAssets)
        return;
    setStageLayer("media");
    fmtSvgBtn.classList.toggle("active", fmt === "svg");
    fmtPngBtn.classList.toggle("active", fmt === "png");
    stageMedia.innerHTML = "";
    if (fmt === "svg" && displayAssets.svg) {
        const blob = new Blob([displayAssets.svg], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        const img = document.createElement("img");
        img.src = url;
        img.onload = () => URL.revokeObjectURL(url);
        img.onerror = () => URL.revokeObjectURL(url);
        stageMedia.appendChild(img);
    }
    else if (fmt === "png" && displayAssets.png_base64) {
        const img = document.createElement("img");
        img.src = displayAssets.png_base64;
        stageMedia.appendChild(img);
    }
}
fmtSvgBtn.addEventListener("click", () => { if (!fmtSvgBtn.disabled)
    showPreview("svg"); });
fmtPngBtn.addEventListener("click", () => { if (!fmtPngBtn.disabled)
    showPreview("png"); });
// ── Inspector (Tree / JSON tabs) ──────────────────────────
function collapseInsp() {
    activeInspTab = null;
    inspTabTree.classList.remove("active");
    inspTabJson.classList.remove("active");
    inspTabTree.setAttribute("aria-expanded", "false");
    inspTabJson.setAttribute("aria-expanded", "false");
    treePanel.hidden = true;
    dataPane.hidden = true;
    sheetEl.classList.remove("json-expanded");
}
function openInspTab(tab) {
    activeInspTab = tab;
    inspTabTree.classList.toggle("active", tab === "tree");
    inspTabJson.classList.toggle("active", tab === "json");
    inspTabTree.setAttribute("aria-expanded", String(tab === "tree"));
    inspTabJson.setAttribute("aria-expanded", String(tab === "json"));
    treePanel.hidden = tab !== "tree";
    dataPane.hidden = tab !== "json";
    sheetEl.classList.add("json-expanded");
}
inspLabel.addEventListener("click", () => openInspTab("tree"));
inspTabTree.addEventListener("click", () => {
    if (activeInspTab === "tree")
        collapseInsp();
    else
        openInspTab("tree");
});
inspTabJson.addEventListener("click", () => {
    if (activeInspTab === "json")
        collapseInsp();
    else
        openInspTab("json");
});
function dotClassForType(type) {
    if (type === "TEXT")
        return "dot-text";
    if (type === "VECTOR" || type === "BOOLEAN_OPERATION")
        return "dot-vec";
    if (type === "COMPONENT" || type === "COMPONENT_SET" || type === "INSTANCE")
        return "dot-comp";
    return "dot-shape";
}
function renderTreeProps(node) {
    treePropsLabel.textContent = `Properties · ${node.name}`;
    treePropsBody.innerHTML = "";
    const entries = [];
    if (node.characters !== undefined)
        entries.push(["characters", JSON.stringify(node.characters)]);
    Object.entries(node.css).forEach(([k, v]) => { if (v !== undefined)
        entries.push([k, v]); });
    if (node.fills)
        entries.push(["fills", `${node.fills.length} fill${node.fills.length !== 1 ? "s" : ""}`]);
    if (entries.length === 0) {
        entries.push(["—", "no resolved properties"]);
    }
    entries.forEach(([k, v]) => {
        const row = document.createElement("div");
        row.className = "tree-prop-row";
        const kEl = document.createElement("span");
        kEl.className = "k";
        kEl.textContent = k;
        const vEl = document.createElement("span");
        vEl.className = "v";
        vEl.textContent = v;
        vEl.title = v;
        row.appendChild(kEl);
        row.appendChild(vEl);
        treePropsBody.appendChild(row);
    });
}
// Layers 1-5 (depth 0-4) start expanded; a node's children only start
// collapsed once that node itself is at layer 5 (depth 4) or deeper.
const DEFAULT_EXPAND_DEPTH = 4;
function buildTreeRow(node, depth, hasChildren) {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = `${4 + depth * 16}px`;
    const caret = document.createElement("span");
    caret.className = "tree-caret";
    if (hasChildren) {
        caret.classList.add("has-children");
        caret.textContent = "▾";
    }
    row.appendChild(caret);
    const dot = document.createElement("span");
    dot.className = `tree-dot ${dotClassForType(node.type)}`;
    row.appendChild(dot);
    const nameEl = document.createElement("span");
    nameEl.className = "tree-row-name";
    nameEl.textContent = node.name;
    row.appendChild(nameEl);
    const typeEl = document.createElement("span");
    typeEl.className = "tree-row-type";
    typeEl.textContent = node.type;
    row.appendChild(typeEl);
    row.addEventListener("click", () => {
        treeList.querySelectorAll(".tree-row.sel").forEach((r) => r.classList.remove("sel"));
        row.classList.add("sel");
        renderTreeProps(node);
    });
    return row;
}
function renderTree(root) {
    treeList.innerHTML = "";
    let firstRow = null;
    function walk(node, depth, container) {
        const hasChildren = !!(node.children && node.children.length);
        const row = buildTreeRow(node, depth, hasChildren);
        if (!firstRow)
            firstRow = row;
        container.appendChild(row);
        if (hasChildren) {
            const childWrap = document.createElement("div");
            childWrap.className = "tree-children";
            childWrap.hidden = depth >= DEFAULT_EXPAND_DEPTH;
            const caret = row.querySelector(".tree-caret");
            caret.classList.toggle("collapsed", childWrap.hidden);
            caret.addEventListener("click", (e) => {
                e.stopPropagation();
                childWrap.hidden = !childWrap.hidden;
                caret.classList.toggle("collapsed", childWrap.hidden);
            });
            node.children.forEach((child) => walk(child, depth + 1, childWrap));
            container.appendChild(childWrap);
        }
    }
    walk(root, 0, treeList);
    if (firstRow) {
        firstRow.classList.add("sel");
        renderTreeProps(root);
    }
}
function populateTreeVariantSelect(variants) {
    treeVariantSelect.innerHTML = "";
    variants.forEach((v, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = v.name;
        treeVariantSelect.appendChild(opt);
    });
    treeVariantSelect.hidden = variants.length < 2;
    treeVariantSelect.selectedIndex = 0;
    renderTree(variants[0].tree);
}
treeVariantSelect.addEventListener("change", () => {
    if (!currentBundle || !("variants" in currentBundle))
        return;
    renderTree(currentBundle.variants[treeVariantSelect.selectedIndex].tree);
});
// ── Tree / properties resizer ─────────────────────────────
const TREE_PROPS_MIN = 32;
const TREE_LIST_MIN = 32;
let treePropsHeight = 114;
treeProps.style.height = `${treePropsHeight}px`;
let resizeStartY = 0;
let resizeStartHeight = 0;
treeResizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizeStartY = e.clientY;
    resizeStartHeight = treeProps.getBoundingClientRect().height;
    treeResizer.classList.add("dragging");
    treeResizer.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
});
treeResizer.addEventListener("pointermove", (e) => {
    if (!treeResizer.classList.contains("dragging"))
        return;
    const panelHeight = treePanel.getBoundingClientRect().height;
    const resizerHeight = treeResizer.getBoundingClientRect().height;
    const selectHeight = treeVariantSelect.hidden ? 0 : treeVariantSelect.getBoundingClientRect().height + 7;
    const maxPropsHeight = Math.max(TREE_PROPS_MIN, panelHeight - resizerHeight - selectHeight - TREE_LIST_MIN);
    const delta = resizeStartY - e.clientY;
    treePropsHeight = Math.min(maxPropsHeight, Math.max(TREE_PROPS_MIN, resizeStartHeight + delta));
    treeProps.style.height = `${treePropsHeight}px`;
});
function stopResizing() {
    treeResizer.classList.remove("dragging");
    document.body.style.userSelect = "";
}
treeResizer.addEventListener("pointerup", stopResizing);
treeResizer.addEventListener("pointercancel", stopResizing);
// ── CTA actions ──────────────────────────────────────────
ctaPrimary.addEventListener("click", () => {
    if (mode === "idle") {
        startExport(wantsAllVariants());
    }
    else if (mode === "result") {
        copyJSON();
    }
});
ctaAll.addEventListener("click", () => startExport(true));
backBtn.addEventListener("click", () => {
    mode = selection.name ? "idle" : "empty";
    errorMessage = null;
    currentBundle = null;
    render();
});
function startExport(allVariants) {
    errorMessage = null;
    exportedSnapshot = { ...selection };
    mode = "loading";
    if (allVariants) {
        lastVariantIndex = null;
        loadingText = "reading variants and variable modes…";
        render();
        parent.postMessage({ pluginMessage: { type: "EXPORT_COMPONENT", options: getOptions() } }, "*");
    }
    else {
        lastVariantIndex = selectedVariantIndex();
        loadingText = describeExport(lastVariantIndex);
        render();
        parent.postMessage({ pluginMessage: { type: "EXPORT", options: getOptions() } }, "*");
    }
}
// Lightweight, image-only render triggered on selection — never builds the
// JSON tree (that only happens when the user explicitly presses Export) and
// always fetches both formats regardless of the PNG/SVG chips, which only
// govern what the full export embeds, not whether the hero preview renders.
function startPreview() {
    if (!selection.name)
        return;
    previewLoading = true;
    render();
    const req = {
        type: "PREVIEW",
        // Just one format, always PNG — it works uniformly for a single node, a
        // specific variant, or a whole set, so there's no fmtSwitch ambiguity
        // (and no double export work) before the user actually presses Export.
        includePNG: true,
        includeSVG: false,
    };
    if (wantsAllVariants()) {
        req.allVariants = true;
    }
    else if (!variantRow.hidden && variantSelect.value) {
        req.variantId = variantSelect.value;
    }
    parent.postMessage({ pluginMessage: req }, "*");
}
function copyJSON() {
    if (!currentBundle)
        return;
    const text = JSON.stringify(currentBundle, null, 2);
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
}
ctaDownload.addEventListener("click", () => {
    if (!currentBundle)
        return;
    const json = JSON.stringify(currentBundle, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = buildFilename(currentBundle);
    a.click();
    URL.revokeObjectURL(url);
});
function buildFilename(b) {
    const slug = b.meta.name
        .replace(/[^a-z0-9_-]/gi, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase() || "export";
    const date = new Date().toISOString().slice(0, 10);
    const kind = "variants" in b ? "component" : b.meta.type;
    return `${slug}-${kind}-${date}.json`;
}
// ── Sandbox messages ─────────────────────────────────────
window.onmessage = (event) => {
    const msg = event.data.pluginMessage;
    if (!msg)
        return;
    if (msg.type === "SELECTION") {
        selection = {
            isComponent: !!msg.isComponent,
            name: msg.name ?? null,
            nodeType: msg.nodeType ?? null,
            width: msg.width ?? null,
            height: msg.height ?? null,
            extraCount: msg.extraCount ?? 0,
            variants: msg.variants ?? null,
        };
        // Any selection change invalidates whatever's on screen — clear the
        // stage right away and render just a fresh preview image. A full export
        // already in flight for the previous target (if any) keeps running in
        // the background; its result is discarded as stale when it lands.
        currentBundle = null;
        displayAssets = null;
        previewLoading = false;
        errorMessage = null;
        if (!selection.name) {
            mode = "empty";
            render();
            return;
        }
        mode = "idle";
        render();
        startPreview();
        return;
    }
    if (msg.type === "RESULT" || msg.type === "COMPONENT_RESULT") {
        if (!sameTarget(selection, exportedSnapshot)) {
            // Selection moved on while this export was running — SELECTION above
            // already reset the view for the new target, so just drop the stale
            // result. (The mode==="loading" branch is a safety net in case that
            // never happened.)
            if (mode === "loading") {
                mode = selection.name ? "idle" : "empty";
                render();
                startPreview();
            }
            return;
        }
        currentBundle = msg.bundle;
        mode = "result";
        render();
        return;
    }
    if (msg.type === "PREVIEW_RESULT") {
        if (mode === "idle" && msg.name === selection.name && msg.nodeType === selection.nodeType) {
            displayAssets = msg.assets;
            previewLoading = false;
            render();
        }
        return;
    }
    if (msg.type === "ERROR") {
        errorMessage = msg.message;
        mode = selection.name ? "idle" : "empty";
        render();
    }
};
function formatBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
function highlight(json) {
    const safe = json
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    return safe.replace(/("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (m) => {
        let c = "jn";
        if (/^"/.test(m)) {
            c = /:$/.test(m) ? "jk" : "js";
        }
        else if (/true|false/.test(m)) {
            c = "jb";
        }
        else if (m === "null") {
            c = "jl";
        }
        return `<span class="${c}">${m}</span>`;
    });
}
render();
