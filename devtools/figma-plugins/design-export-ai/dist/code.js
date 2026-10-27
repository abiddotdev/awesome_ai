"use strict";
/// <reference path="./types.ts" />
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
// Figma's QuickJS sandbox lacks TextDecoder — decode UTF-8 bytes manually.
function bytesToUtf8(bytes) {
    let out = "";
    let i = 0;
    const len = bytes.length;
    while (i < len) {
        const b1 = bytes[i++];
        if (b1 < 0x80) {
            out += String.fromCharCode(b1);
        }
        else if ((b1 & 0xe0) === 0xc0) {
            const b2 = bytes[i++] & 0x3f;
            out += String.fromCharCode(((b1 & 0x1f) << 6) | b2);
        }
        else if ((b1 & 0xf0) === 0xe0) {
            const b2 = bytes[i++] & 0x3f;
            const b3 = bytes[i++] & 0x3f;
            out += String.fromCharCode(((b1 & 0x0f) << 12) | (b2 << 6) | b3);
        }
        else if ((b1 & 0xf8) === 0xf0) {
            const b2 = bytes[i++] & 0x3f;
            const b3 = bytes[i++] & 0x3f;
            const b4 = bytes[i++] & 0x3f;
            const cp = (((b1 & 0x07) << 18) | (b2 << 12) | (b3 << 6) | b4) - 0x10000;
            out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        }
    }
    return out;
}
// Skip the UI when Figma loads the plugin for Dev Mode codegen —
// there's no UI context and calling showUI throws "Cannot show UI".
function isComponentType(node) {
    return node.type === "COMPONENT" || node.type === "COMPONENT_SET" || node.type === "INSTANCE";
}
function postSelectionState() {
    const selection = figma.currentPage.selection;
    const node = selection[0];
    // Surface a COMPONENT_SET's visible variants so the UI can offer a picker instead of
    // always resolving to the first one.
    let variants = null;
    if (node && node.type === "COMPONENT_SET" && "children" in node) {
        const visible = node.children.filter((c) => c.visible !== false);
        if (visible.length > 1) {
            variants = visible.map((c) => ({ id: c.id, name: c.name }));
        }
    }
    figma.ui.postMessage({
        type: "SELECTION",
        isComponent: !!node && isComponentType(node),
        name: node ? node.name : null,
        nodeType: node ? node.type : null,
        width: node && "width" in node ? Math.round(node.width) : null,
        height: node && "height" in node ? Math.round(node.height) : null,
        extraCount: Math.max(0, selection.length - 1),
        variants,
    });
}
if (figma.mode !== "codegen") {
    figma.showUI(__html__, { width: 360, height: 640 });
    figma.on("selectionchange", postSelectionState);
    postSelectionState();
    figma.ui.onmessage = (msg) => __awaiter(void 0, void 0, void 0, function* () {
        if (msg.type === "EXPORT") {
            const options = msg.options;
            const node = figma.currentPage.selection[0];
            if (!node) {
                figma.ui.postMessage({ type: "ERROR", message: "No node selected." });
                return;
            }
            try {
                const bundle = yield buildExportBundle(node, options);
                figma.ui.postMessage({ type: "RESULT", bundle });
            }
            catch (err) {
                figma.ui.postMessage({ type: "ERROR", message: String(err) });
            }
        }
        if (msg.type === "EXPORT_COMPONENT") {
            const options = msg.options;
            const node = figma.currentPage.selection[0];
            if (!node) {
                figma.ui.postMessage({ type: "ERROR", message: "No node selected." });
                return;
            }
            try {
                const bundle = yield buildComponentBundle(node, options);
                figma.ui.postMessage({ type: "COMPONENT_RESULT", bundle });
            }
            catch (err) {
                const msg = String(err).includes("Select a component")
                    ? "Use Export Node instead — this node is not a component or instance."
                    : String(err);
                figma.ui.postMessage({ type: "ERROR", message: msg });
            }
        }
        // Lightweight, image-only render for the compose view's hero preview —
        // skips the CSS/token/tree walk that EXPORT and EXPORT_COMPONENT do, so
        // browsing selections in Figma stays cheap until the user actually exports.
        if (msg.type === "PREVIEW") {
            const node = figma.currentPage.selection[0];
            if (!node)
                return;
            try {
                // "All variants" previews the set itself (Figma tiles every visible
                // variant into one image) instead of resolving to a single child.
                const target = msg.allVariants ? node : resolveVariantNode(node, msg.variantId);
                // exportSVG() can't represent a whole set — it silently falls back to
                // just the first variant. Skip it for "all", or that single-variant
                // SVG would outrank the (correct, multi-variant) PNG in the UI.
                const [png, svg] = yield Promise.all([
                    msg.includePNG ? exportPNG(target) : Promise.resolve(null),
                    (msg.includeSVG && !msg.allVariants) ? exportSVG(target) : Promise.resolve(null),
                ]);
                figma.ui.postMessage({
                    type: "PREVIEW_RESULT",
                    // Echo the *originally selected* node's identity (e.g. a
                    // COMPONENT_SET), not the resolved variant's — the UI matches this
                    // against its live selection state to discard stale responses, and
                    // that state describes the selection, not whichever variant it
                    // resolved to.
                    name: node.name,
                    nodeType: node.type,
                    assets: { png_base64: png, svg },
                });
            }
            catch (err) {
                console.warn("Preview render failed:", err);
            }
        }
    });
}
// ─── Dev Mode Codegen ───────────────────────────────────────────────────────
// Auto-emits JSON into Dev Mode's Code section on selection. Preferences come
// from the dropdowns declared in manifest.json → codegenPreferences.
if (typeof figma.codegen !== "undefined") {
    figma.codegen.on("generate", (event) => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b;
        const prefs = (_a = event.propertyValues) !== null && _a !== void 0 ? _a : {};
        const depthRaw = (_b = prefs.depth) !== null && _b !== void 0 ? _b : "full";
        const pngOn = prefs.png === "on";
        const treeDepth = depthRaw === "full" ? "full" : parseInt(depthRaw, 10);
        const options = {
            includePNG: pngOn,
            includeSVG: false,
            tokenMode: "resolved",
            treeDepth,
        };
        try {
            const bundle = yield buildExportBundle(event.node, options);
            // Strip asset blobs — they can't render in the codegen panel
            bundle.assets = { png_base64: null, svg: null };
            return [{
                    title: "DesignExport AI",
                    language: "JSON",
                    code: JSON.stringify(bundle, null, 2),
                }];
        }
        catch (err) {
            return [{
                    title: "DesignExport AI — Error",
                    language: "PLAINTEXT",
                    code: String(err),
                }];
        }
    }));
}
// ─── Utilities ───────────────────────────────────────────────────────────────
function rgbToHex(r, g, b) {
    const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
}
function mapAlignment(value) {
    var _a;
    const map = {
        MIN: "flex-start",
        MAX: "flex-end",
        CENTER: "center",
        SPACE_BETWEEN: "space-between",
        BASELINE: "baseline",
    };
    return (_a = map[value]) !== null && _a !== void 0 ? _a : value;
}
function mapSizing(sizing, px) {
    if (sizing === "FILL")
        return "100%";
    if (sizing === "HUG")
        return "fit-content";
    return `${Math.round(px)}px`;
}
function mapTextAlign(align) {
    return align.toLowerCase();
}
function buildBoxShadow(effect) {
    const { offset, radius, spread, color } = effect;
    const hex = rgbToHex(color.r, color.g, color.b);
    const rgba = hexToRgba(hex, color.a);
    return `${offset.x}px ${offset.y}px ${radius}px ${spread !== null && spread !== void 0 ? spread : 0}px ${rgba}`;
}
function buildLinearGradient(fill) {
    const stops = fill.gradientStops
        .map((s) => `${rgbToHex(s.color.r, s.color.g, s.color.b)} ${Math.round(s.position * 100)}%`)
        .join(", ");
    return `linear-gradient(to right, ${stops})`;
}
function isVariableAlias(v) {
    return typeof v === "object" && v !== null && v.type === "VARIABLE_ALIAS";
}
function resolveVariableValue(value, type) {
    if (type === "COLOR" && typeof value === "object" && value !== null && !isVariableAlias(value)) {
        const c = value;
        const hex = rgbToHex(c.r, c.g, c.b);
        return c.a < 1 ? hexToRgba(hex, c.a) : hex;
    }
    if (typeof value === "number")
        return String(value);
    if (typeof value === "boolean")
        return String(value);
    if (typeof value === "string")
        return value;
    return "unresolved";
}
// Recursively follows VariableAlias chains to get the actual value (max 8 hops).
function resolveTokenValue(raw_1, resolvedType_1) {
    return __awaiter(this, arguments, void 0, function* (raw, resolvedType, depth = 0) {
        if (depth > 8)
            return "unresolved";
        if (!isVariableAlias(raw))
            return resolveVariableValue(raw, resolvedType);
        const aliasVar = yield figma.variables.getVariableByIdAsync(raw.id);
        if (!aliasVar)
            return "unresolved";
        const coll = yield figma.variables.getVariableCollectionByIdAsync(aliasVar.variableCollectionId);
        const modeId = coll === null || coll === void 0 ? void 0 : coll.defaultModeId;
        if (!modeId)
            return "unresolved";
        return resolveTokenValue(aliasVar.valuesByMode[modeId], aliasVar.resolvedType, depth + 1);
    });
}
function fontStyleToWeight(style) {
    if (style.includes("Thin"))
        return "100";
    if (style.includes("ExtraLight") || style.includes("Extra Light"))
        return "200";
    if (style.includes("Light"))
        return "300";
    if (style.includes("Medium"))
        return "500";
    if (style.includes("SemiBold") || style.includes("Semi Bold"))
        return "600";
    if (style.includes("ExtraBold") || style.includes("Extra Bold"))
        return "800";
    if (style.includes("Bold"))
        return "700";
    if (style.includes("Black") || style.includes("Heavy"))
        return "900";
    return "400";
}
function kebabToCamel(s) {
    return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
function figmaPropToCSSProp(figmaProp) {
    var _a;
    const map = {
        fills: "background",
        strokes: "border-color",
        itemSpacing: "gap",
        paddingTop: "padding-top",
        paddingRight: "padding-right",
        paddingBottom: "padding-bottom",
        paddingLeft: "padding-left",
        topLeftRadius: "border-top-left-radius",
        topRightRadius: "border-top-right-radius",
        bottomLeftRadius: "border-bottom-left-radius",
        bottomRightRadius: "border-bottom-right-radius",
        cornerRadius: "border-radius",
        strokeWeight: "border-width",
        strokeTopWeight: "border-top-width",
        strokeRightWeight: "border-right-width",
        strokeBottomWeight: "border-bottom-width",
        strokeLeftWeight: "border-left-width",
        opacity: "opacity",
        fontSize: "font-size",
    };
    return (_a = map[figmaProp]) !== null && _a !== void 0 ? _a : figmaProp;
}
// CSS custom property name for a Figma variable. Must stay identical to
// cssVarName in ../token-export/code.ts, which defines these variables;
// ../check-naming-sync.cjs fails when the two drift. Web code syntax wins,
// otherwise the path is slugged with every other character turned into a dash.
function cssVarName(v) {
    const web = v.codeSyntax ? v.codeSyntax.WEB : undefined;
    if (web) {
        // Accept both `var(--name)` and a bare `--name`.
        const m = web.match(/var\(\s*(--[^,\s)]+)/) || web.match(/^\s*(--[A-Za-z0-9_-]+)\s*$/);
        if (m)
            return m[1];
    }
    return "--" + v.name.toLowerCase()
        .replace(/\//g, "-").replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}
// Slug for mode attributes: data-<collection>="<mode>". Must stay identical to
// slugify in ../token-export/code.ts (also checked by ../check-naming-sync.cjs).
function slugify(str) {
    return str.toLowerCase().trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}
// Class token-export's typography.css gives a text style. Must stay identical
// to textStyleClassName in ../token-export/code.ts (checked by
// ../check-naming-sync.cjs).
function textStyleClassName(name) {
    return "text-" + name.toLowerCase()
        .replace(/\//g, "-").replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}
// Extract the "AI Metadata:" block from a component description, stripping designer notes.
function extractAIMetadata(description) {
    const marker = "AI Metadata:";
    const idx = description.indexOf(marker);
    if (idx === -1)
        return undefined;
    const text = description.slice(idx + marker.length).trim();
    return text || undefined;
}
// Add a px unit to raw numeric values for length-like CSS props.
function withUnit(value, cssProp) {
    if (!/^-?\d+(\.\d+)?$/.test(value))
        return value; // already has unit or is a hex
    if (cssProp === "opacity") {
        const n = parseFloat(value);
        return n > 1 ? String(n / 100) : value; // Figma stores opacity 0–100; CSS expects 0–1
    }
    const unitless = new Set(["font-weight", "line-height"]);
    if (unitless.has(cssProp))
        return value;
    return `${value}px`;
}
// Prune CSS defaults that add noise (0px paddings, gap, radius, opacity 1, display block, etc.)
function pruneCSS(css) {
    const out = {};
    const keepZero = new Set(["top", "left"]);
    for (const [k, v] of Object.entries(css)) {
        if (v === undefined || v === null || v === "")
            continue;
        if (v === "0px" && !keepZero.has(k))
            continue;
        if (k === "opacity" && v === "1")
            continue;
        if (k === "display" && v === "block")
            continue;
        if (k === "gap" && v === "0px")
            continue;
        out[k] = v;
    }
    return out;
}
// Collapse 4 padding props → shorthand when possible:
//   all 4 equal            → "padding": value
//   top===bottom, left===right → "padding": "vertical horizontal"
function collapsePaddingShorthand(css) {
    const t = css.paddingTop;
    const r = css.paddingRight;
    const b = css.paddingBottom;
    const l = css.paddingLeft;
    if (!t || !r || !b || !l)
        return;
    if (t === r && r === b && b === l) {
        css.padding = t;
    }
    else if (t === b && r === l) {
        css.padding = `${t} ${r}`;
    }
    else {
        return;
    }
    delete css.paddingTop;
    delete css.paddingRight;
    delete css.paddingBottom;
    delete css.paddingLeft;
}
function collapseRadiusShorthand(css) {
    const tl = css.borderTopLeftRadius;
    const tr = css.borderTopRightRadius;
    const br = css.borderBottomRightRadius;
    const bl = css.borderBottomLeftRadius;
    if (!tl || !tr || !br || !bl)
        return;
    if (tl === tr && tr === br && br === bl) {
        css.borderRadius = tl;
    }
    else if (tl === br && tr === bl) {
        css.borderRadius = `${tl} ${tr}`;
    }
    else {
        css.borderRadius = `${tl} ${tr} ${br} ${bl}`;
    }
    delete css.borderTopLeftRadius;
    delete css.borderTopRightRadius;
    delete css.borderBottomRightRadius;
    delete css.borderBottomLeftRadius;
}
function collapseBorderWidthShorthand(css) {
    const t = css.borderTopWidth;
    const r = css.borderRightWidth;
    const b = css.borderBottomWidth;
    const l = css.borderLeftWidth;
    if (!t || !r || !b || !l)
        return;
    if (t === r && r === b && b === l) {
        css.borderWidth = t;
    }
    else if (t === b && r === l) {
        css.borderWidth = `${t} ${r}`;
    }
    else {
        return;
    }
    delete css.borderTopWidth;
    delete css.borderRightWidth;
    delete css.borderBottomWidth;
    delete css.borderLeftWidth;
}
// ─── CSS Extractor ───────────────────────────────────────────────────────────
function extractCSS(node) {
    var _a;
    const css = {};
    // Layout
    if ("layoutMode" in node) {
        if (node.layoutMode !== "NONE") {
            css.display = "flex";
            css.flexDirection = node.layoutMode === "HORIZONTAL" ? "row" : "column";
            css.gap = `${node.itemSpacing}px`;
            css.alignItems = mapAlignment(node.counterAxisAlignItems);
            css.justifyContent = mapAlignment(node.primaryAxisAlignItems);
        }
        else {
            css.display = "block";
        }
    }
    // Padding
    if ("paddingTop" in node) {
        css.paddingTop = `${node.paddingTop}px`;
        css.paddingRight = `${node.paddingRight}px`;
        css.paddingBottom = `${node.paddingBottom}px`;
        css.paddingLeft = `${node.paddingLeft}px`;
    }
    // Size
    if ("layoutSizingHorizontal" in node) {
        css.width = mapSizing(node.layoutSizingHorizontal, node.width);
        css.height = mapSizing(node.layoutSizingVertical, node.height);
    }
    else if ("width" in node) {
        css.width = `${Math.round(node.width)}px`;
        css.height = `${Math.round(node.height)}px`;
    }
    // Overflow / clipping
    if ("clipsContent" in node && node.clipsContent) {
        css.overflow = "hidden";
    }
    // Corner radius — always individual props; collapseRadiusShorthand folds them later
    if ("topLeftRadius" in node) {
        css.borderTopLeftRadius = `${node.topLeftRadius}px`;
        css.borderTopRightRadius = `${node.topRightRadius}px`;
        css.borderBottomLeftRadius = `${node.bottomLeftRadius}px`;
        css.borderBottomRightRadius = `${node.bottomRightRadius}px`;
    }
    else if ("cornerRadius" in node && typeof node.cornerRadius === "number") {
        css.borderRadius = `${node.cornerRadius}px`;
    }
    // Opacity
    if ("opacity" in node && node.opacity !== 1) {
        css.opacity = String(node.opacity);
    }
    // Absolute position — explicit overlay in auto-layout, or child of a fixed-layout frame
    if ("x" in node && "y" in node) {
        const par = node.parent;
        const isExplicitAbsolute = "layoutPositioning" in node &&
            node.layoutPositioning === "ABSOLUTE";
        const inFixedFrame = !!par && "layoutMode" in par && par.layoutMode === "NONE" && par.type !== "PAGE";
        if (isExplicitAbsolute || inFixedFrame) {
            css.position = "absolute";
            css.top = `${Math.round(node.y)}px`;
            css.left = `${Math.round(node.x)}px`;
        }
    }
    // Fills (background / color)
    if ("fills" in node && Array.isArray(node.fills) && node.fills.length > 0) {
        const fill = node.fills[0];
        if (fill.type === "SOLID") {
            const c = fill.color;
            const a = (_a = fill.opacity) !== null && _a !== void 0 ? _a : 1;
            const hex = rgbToHex(c.r, c.g, c.b);
            if (node.type === "TEXT") {
                css.color = a < 1 ? hexToRgba(hex, a) : hex;
            }
            else {
                css.background = a < 1 ? hexToRgba(hex, a) : hex;
            }
        }
        else if (fill.type === "GRADIENT_LINEAR") {
            css.background = buildLinearGradient(fill);
        }
    }
    // Strokes (border)
    if ("strokes" in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
        const stroke = node.strokes[0];
        if (stroke.type === "SOLID") {
            // Individual weights — collapseBorderWidthShorthand folds them later
            if ("strokeTopWeight" in node) {
                css.borderTopWidth = `${node.strokeTopWeight}px`;
                css.borderRightWidth = `${node.strokeRightWeight}px`;
                css.borderBottomWidth = `${node.strokeBottomWeight}px`;
                css.borderLeftWidth = `${node.strokeLeftWeight}px`;
            }
            else {
                const weight = "strokeWeight" in node && typeof node.strokeWeight === "number" ? node.strokeWeight : 1;
                css.borderWidth = `${weight}px`;
            }
            css.borderStyle = "solid";
            css.borderColor = rgbToHex(stroke.color.r, stroke.color.g, stroke.color.b);
        }
    }
    // Effects (shadows, blur)
    if ("effects" in node && Array.isArray(node.effects)) {
        const shadows = node.effects.filter((e) => e.type === "DROP_SHADOW" && e.visible !== false);
        if (shadows.length > 0) {
            css.boxShadow = shadows.map(buildBoxShadow).join(", ");
        }
        const blur = node.effects.find((e) => e.type === "BACKGROUND_BLUR" && e.visible !== false);
        if (blur) {
            css.backdropFilter = `blur(${blur.radius}px)`;
        }
    }
    // Typography
    if (node.type === "TEXT") {
        const fontName = node.getRangeFontName(0, 1);
        if (fontName !== figma.mixed) {
            css.fontFamily = `"${fontName.family}"`;
            css.fontWeight = fontStyleToWeight(fontName.style);
        }
        const fontSize = node.getRangeFontSize(0, 1);
        if (fontSize !== figma.mixed) {
            css.fontSize = `${fontSize}px`;
        }
        const lh = node.getRangeLineHeight(0, 1);
        if (lh !== figma.mixed) {
            if (lh.unit === "PIXELS")
                css.lineHeight = `${lh.value}px`;
            else if (lh.unit === "PERCENT")
                css.lineHeight = `${lh.value / 100}`;
        }
        const ls = node.getRangeLetterSpacing(0, 1);
        if (ls !== figma.mixed) {
            if (ls.unit === "PIXELS")
                css.letterSpacing = `${ls.value}px`;
            else if (ls.unit === "PERCENT")
                css.letterSpacing = `${ls.value / 100}em`;
        }
        css.textAlign = mapTextAlign(node.textAlignHorizontal);
        const decoration = node.getRangeTextDecoration(0, 1);
        if (decoration !== figma.mixed) {
            if (decoration === "UNDERLINE")
                css.textDecoration = "underline";
            if (decoration === "STRIKETHROUGH")
                css.textDecoration = "line-through";
        }
    }
    return css;
}
// ─── Token Resolver ──────────────────────────────────────────────────────────
// Resolve each bound variable to "var(--name, resolvedValue)" and return a map of
// cssProp → that string, ready to overwrite the raw CSS value.
function extractInlineTokenCSS(node) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const result = {};
        const bindings = (_a = node.boundVariables) !== null && _a !== void 0 ? _a : {};
        for (const [prop, binding] of Object.entries(bindings)) {
            const varBinding = Array.isArray(binding) ? binding[0] : binding;
            if (!varBinding || typeof varBinding.id !== "string")
                continue;
            const variable = yield figma.variables.getVariableByIdAsync(varBinding.id);
            if (!variable)
                continue;
            const collection = yield figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
            const modeId = collection === null || collection === void 0 ? void 0 : collection.defaultModeId;
            const rawValue = modeId ? variable.valuesByMode[modeId] : undefined;
            // A text node's fill is its text colour, which extractCSS writes to `color`.
            const cssPropKebab = prop === "fills" && node.type === "TEXT"
                ? "color"
                : figmaPropToCSSProp(prop); // kebab-case for withUnit logic
            const cssProp = kebabToCamel(cssPropKebab); // camelCase to match NodeCSS keys
            const resolved = yield resolveTokenValue(rawValue, variable.resolvedType);
            const cssVarBase = `var(${cssVarName(variable)}`; // "var(--name"
            result[cssProp] = `${cssVarBase}, ${withUnit(resolved, cssPropKebab)})`;
        }
        return result;
    });
}
// ─── Fill Array Builder ───────────────────────────────────────────────────────
function buildFillsArray(node) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        if (!("fills" in node) || !Array.isArray(node.fills))
            return [];
        const visibleFills = node.fills.filter((f) => f.visible !== false);
        if (visibleFills.length < 2)
            return [];
        const bindings = (_a = node.boundVariables) !== null && _a !== void 0 ? _a : {};
        const rawFillBindings = bindings.fills;
        const fillBindings = Array.isArray(rawFillBindings)
            ? rawFillBindings
            : rawFillBindings ? [rawFillBindings] : [];
        const result = [];
        for (let i = 0; i < visibleFills.length; i++) {
            const fill = visibleFills[i];
            let value = "";
            if (fill.type === "SOLID") {
                const hex = rgbToHex(fill.color.r, fill.color.g, fill.color.b);
                const a = (_b = fill.opacity) !== null && _b !== void 0 ? _b : 1;
                value = a < 1 ? hexToRgba(hex, a) : hex;
            }
            else if (fill.type === "GRADIENT_LINEAR") {
                value = buildLinearGradient(fill);
            }
            else {
                continue;
            }
            const binding = fillBindings[i];
            if (binding === null || binding === void 0 ? void 0 : binding.id) {
                const variable = yield figma.variables.getVariableByIdAsync(binding.id);
                if (variable) {
                    const cssVarBase = `var(${cssVarName(variable)}`; // "var(--name"
                    value = `${cssVarBase}, ${value})`;
                }
            }
            result.push({ type: fill.type, value });
        }
        return result;
    });
}
// ─── Tree Builder ─────────────────────────────────────────────────────────────
// Resolve a COMPONENT_SET to one concrete variant — callers need a single renderable
// state, not a family of states to pick between at generation time. `variantId` lets
// the UI's variant picker override the default (first visible child).
function resolveVariantNode(node, variantId) {
    if (node.type === "COMPONENT_SET" && "children" in node) {
        const children = node.children;
        if (variantId) {
            const chosen = children.find((c) => c.id === variantId && c.visible !== false);
            if (chosen)
                return chosen;
        }
        const visible = children.find((c) => c.visible !== false);
        if (visible)
            return visible;
    }
    return node;
}
function buildTree(node_1, options_1) {
    return __awaiter(this, arguments, void 0, function* (node, options, depth = 0, aiMetadataMap) {
        if (node.type === "COMPONENT_SET") {
            return buildTree(resolveVariantNode(node), options, depth, aiMetadataMap);
        }
        const css = pruneCSS(extractCSS(node));
        if (options.tokenMode !== "raw") {
            const tokenCSS = yield extractInlineTokenCSS(node);
            for (const [cssProp, value] of Object.entries(tokenCSS)) {
                // Only overwrite props that survived pruning (eliminates zero-value token noise)
                if (cssProp in css)
                    css[cssProp] = value;
            }
        }
        collapsePaddingShorthand(css);
        collapseRadiusShorthand(css);
        collapseBorderWidthShorthand(css);
        const simpleNode = {
            name: node.name,
            type: node.type,
            css,
        };
        if (depth > 0 && (node.type === "INSTANCE" || node.type === "COMPONENT")) {
            simpleNode.context = yield buildContext(node, false, aiMetadataMap);
        }
        // Multiple fills — structured array replaces css.background
        if (node.type !== "TEXT" && "fills" in node && Array.isArray(node.fills)) {
            const visibleFills = node.fills.filter((f) => f.visible !== false);
            if (visibleFills.length >= 2) {
                const fillsArr = yield buildFillsArray(node);
                if (fillsArr.length > 0) {
                    simpleNode.fills = fillsArr;
                    delete simpleNode.css.background;
                }
            }
        }
        if (node.type === "TEXT") {
            simpleNode.characters = node.characters;
            // One text style across the whole node maps to a single typography class.
            // Mixed styles are left to textRanges below.
            if (typeof node.textStyleId === "string" && node.textStyleId) {
                try {
                    const style = yield figma.getStyleByIdAsync(node.textStyleId);
                    if (style)
                        simpleNode.textClass = textStyleClassName(style.name);
                }
                catch (_) {
                    // Style not readable (e.g. a remote library): omit the class.
                }
            }
            // Mixed text styles — emit per-range breakdown
            if (node.characters.length > 0 && "getStyledTextSegments" in node) {
                const isMixed = node.getRangeFontName(0, node.characters.length) === figma.mixed ||
                    node.getRangeFontSize(0, node.characters.length) === figma.mixed ||
                    node.getRangeFills(0, node.characters.length) === figma.mixed;
                if (isMixed) {
                    const segments = node.getStyledTextSegments(["fontName", "fontSize", "fills", "textDecoration"]);
                    simpleNode.textRanges = segments.map((seg) => {
                        var _a;
                        const range = { start: seg.start, end: seg.end, text: seg.characters };
                        if (seg.fontName) {
                            range.fontFamily = `"${seg.fontName.family}"`;
                            range.fontWeight = fontStyleToWeight(seg.fontName.style);
                        }
                        if (seg.fontSize)
                            range.fontSize = `${seg.fontSize}px`;
                        if (((_a = seg.fills) === null || _a === void 0 ? void 0 : _a.length) > 0 && seg.fills[0].type === "SOLID") {
                            const c = seg.fills[0].color;
                            range.color = rgbToHex(c.r, c.g, c.b);
                        }
                        if (seg.textDecoration === "UNDERLINE")
                            range.textDecoration = "underline";
                        if (seg.textDecoration === "STRIKETHROUGH")
                            range.textDecoration = "line-through";
                        return range;
                    });
                }
            }
        }
        if (node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION") {
            try {
                const svgBytes = yield node.exportAsync({ format: "SVG" });
                simpleNode.svg = bytesToUtf8(svgBytes);
            }
            catch (_) { }
        }
        const maxDepth = typeof options.treeDepth === "number" ? options.treeDepth : Infinity;
        if ("children" in node && depth < maxDepth) {
            const visibleChildren = node.children.filter((c) => c.visible !== false);
            if (visibleChildren.length > 0) {
                simpleNode.children = yield Promise.all(visibleChildren.map((child) => buildTree(child, options, depth + 1, aiMetadataMap)));
            }
        }
        return simpleNode;
    });
}
// ─── Context Builder ─────────────────────────────────────────────────────────
// `expanded` distinguishes the bundle-root context (full walk stats, for the UI's
// meta card) from the slim inline context nested on INSTANCE/COMPONENT nodes deeper
// in the tree (variant props + component name only).
function buildContext(node, expanded, aiMetadataMap) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        if (!expanded) {
            let mainComponentName;
            let componentSetName;
            if (node.type === "INSTANCE") {
                try {
                    const main = yield node.getMainComponentAsync();
                    if (main) {
                        mainComponentName = main.name;
                        if (((_a = main.parent) === null || _a === void 0 ? void 0 : _a.type) === "COMPONENT_SET") {
                            componentSetName = main.parent.name;
                        }
                        if (aiMetadataMap && main.description) {
                            const metadata = extractAIMetadata(main.description);
                            if (metadata) {
                                if (!componentSetName) {
                                    // No component set — synthesise a stable key from the node ID so the
                                    // REST API can later resolve it to a real name via /files/:key/nodes?ids=
                                    componentSetName = `ID:${main.id}`;
                                }
                                aiMetadataMap.set(componentSetName, metadata);
                            }
                        }
                    }
                }
                catch (_) { }
            }
            const ctx = {
                variantProperties: "variantProperties" in node
                    ? node.variantProperties
                    : null,
            };
            if (mainComponentName)
                ctx.mainComponentName = mainComponentName;
            if (componentSetName)
                ctx.componentSetName = componentSetName;
            return ctx;
        }
        // ── Bundle-root context — full stats for the UI's meta card ──────────────
        let hasText = false;
        let hasVectors = false;
        let childCount = 0;
        function walk(n) {
            if (n.type === "TEXT")
                hasText = true;
            if (n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION")
                hasVectors = true;
            if ("children" in n) {
                childCount += n.children.length;
                n.children.forEach(walk);
            }
        }
        walk(node);
        let mainComponentName;
        let componentSetName;
        let componentDescription;
        if (node.type === "INSTANCE") {
            try {
                const main = yield node.getMainComponentAsync();
                if (main) {
                    mainComponentName = main.name;
                    componentDescription = main.description || undefined;
                    if (((_b = main.parent) === null || _b === void 0 ? void 0 : _b.type) === "COMPONENT_SET") {
                        componentSetName = main.parent.name;
                    }
                }
            }
            catch (_) { }
        }
        return {
            nodeType: node.type,
            isComponent: node.type === "COMPONENT" || node.type === "INSTANCE",
            variantProperties: "variantProperties" in node
                ? node.variantProperties
                : null,
            mainComponentName,
            componentSetName,
            componentDescription,
            childCount,
            hasText,
            hasVectors,
            description: "description" in node ? node.description : "",
        };
    });
}
// ─── Asset Exporters ─────────────────────────────────────────────────────────
function exportPNG(node) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const bytes = yield node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
            const base64 = figma.base64Encode(bytes);
            return `data:image/png;base64,${base64}`;
        }
        catch (err) {
            console.warn("PNG export failed:", err);
            return null;
        }
    });
}
function exportSVG(node) {
    return __awaiter(this, void 0, void 0, function* () {
        // COMPONENT_SET cannot be SVG-exported directly — fall back to first visible variant.
        const target = resolveVariantNode(node);
        try {
            const bytes = yield target.exportAsync({ format: "SVG" });
            return bytesToUtf8(bytes);
        }
        catch (err) {
            console.warn("SVG export failed:", err);
            return null;
        }
    });
}
// ─── Component Bundle Helpers ────────────────────────────────────────────────
// Recursively collect every bound-variable ID in a subtree.
function collectBoundVarIds(node, ids) {
    var _a;
    const bv = (_a = node.boundVariables) !== null && _a !== void 0 ? _a : {};
    for (const binding of Object.values(bv)) {
        const b = Array.isArray(binding) ? binding[0] : binding;
        if (b && typeof b.id === "string") {
            ids.add(b.id);
        }
    }
    if ("children" in node) {
        for (const child of node.children) {
            collectBoundVarIds(child, ids);
        }
    }
}
// Follow VariableAlias chains across all modes to collect every referenced variable ID.
function collectAllReferencedVarIds(seedIds) {
    return __awaiter(this, void 0, void 0, function* () {
        const result = new Set();
        const queue = [...seedIds];
        while (queue.length > 0) {
            const varId = queue.pop();
            if (result.has(varId))
                continue;
            result.add(varId);
            const variable = yield figma.variables.getVariableByIdAsync(varId);
            if (!variable)
                continue;
            for (const value of Object.values(variable.valuesByMode)) {
                if (isVariableAlias(value) && !result.has(value.id)) {
                    queue.push(value.id);
                }
            }
        }
        return result;
    });
}
// Walk up ancestors to find explicit variable-mode overrides (collectionId → modeId).
// More-specific (deeper) nodes take priority.
function getActiveModeMap(node) {
    var _a;
    const modes = {};
    let current = node;
    while (current) {
        if ("explicitVariableModes" in current) {
            const evm = (_a = current.explicitVariableModes) !== null && _a !== void 0 ? _a : {};
            for (const [collId, modeId] of Object.entries(evm)) {
                if (!(collId in modes))
                    modes[collId] = modeId;
            }
        }
        current = current.parent;
    }
    return modes;
}
// Resolve the component-set root from any selected node type.
function resolveComponentRoot(node) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        if (node.type === "COMPONENT_SET")
            return node;
        if (node.type === "COMPONENT") {
            return ((_a = node.parent) === null || _a === void 0 ? void 0 : _a.type) === "COMPONENT_SET"
                ? node.parent
                : node;
        }
        if (node.type === "INSTANCE") {
            const main = yield node.getMainComponentAsync();
            if (!main)
                throw new Error("Instance has no main component — may be from an external library.");
            return ((_b = main.parent) === null || _b === void 0 ? void 0 : _b.type) === "COMPONENT_SET"
                ? main.parent
                : main;
        }
        throw new Error("Select a component, instance, or component set.");
    });
}
// ─── Component Bundle Assembler ──────────────────────────────────────────────
function buildComponentBundle(node, options) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e, _f, _g;
        const root = yield resolveComponentRoot(node);
        // Collect variant nodes (all children of a set, or just the component itself).
        const isSet = root.type === "COMPONENT_SET";
        const variantNodes = isSet
            ? root.children.filter((c) => c.type === "COMPONENT" && c.visible !== false)
            : [root];
        // Build variant property matrix (property → unique values).
        const propMatrix = {};
        for (const v of variantNodes) {
            for (const [key, val] of Object.entries((_a = v.variantProperties) !== null && _a !== void 0 ? _a : {})) {
                if (!propMatrix[key])
                    propMatrix[key] = [];
                if (!propMatrix[key].includes(val))
                    propMatrix[key].push(val);
            }
        }
        // Export full CSS + token tree for every variant.
        const variants = [];
        for (const v of variantNodes) {
            variants.push({
                name: v.name,
                properties: (_b = v.variantProperties) !== null && _b !== void 0 ? _b : {},
                tree: yield buildTree(v, options),
            });
        }
        // Component properties: boolean toggles, text slots, instance swaps.
        const rawProps = (_c = root.componentPropertyDefinitions) !== null && _c !== void 0 ? _c : {};
        const componentProperties = {};
        for (const [key, def] of Object.entries(rawProps)) {
            if (def.type === "VARIANT")
                continue; // already in variantProperties
            const cleanKey = key.replace(/#\d+:\d+$/, "").trim();
            const entry = {
                type: def.type,
                defaultValue: def.defaultValue,
            };
            if (def.type === "INSTANCE_SWAP") {
                try {
                    const comp = yield figma.getNodeByIdAsync(def.defaultValue);
                    if (comp)
                        entry.defaultName = comp.name;
                }
                catch (_) { }
            }
            componentProperties[cleanKey] = entry;
        }
        // Collect every bound variable ID used across all variants.
        const directVarIds = new Set();
        for (const v of variantNodes)
            collectBoundVarIds(v, directVarIds);
        // Expand through alias chains to capture all referenced collections
        // (e.g. style, color, direction which are only reached via theme→style→color aliases).
        const usedVarIds = yield collectAllReferencedVarIds(directVarIds);
        // Detect which mode is active on the selected node's ancestor chain.
        const activeModeMap = getActiveModeMap(node);
        // For each variable: resolve its value in every mode of its collection.
        const variableModes = {};
        for (const varId of usedVarIds) {
            const variable = yield figma.variables.getVariableByIdAsync(varId);
            if (!variable)
                continue;
            const collection = yield figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
            if (!collection)
                continue;
            const cName = collection.name;
            if (!variableModes[cName]) {
                const activeModeId = (_d = activeModeMap[collection.id]) !== null && _d !== void 0 ? _d : collection.defaultModeId;
                const activeModeName = (_f = (_e = collection.modes.find((m) => m.modeId === activeModeId)) === null || _e === void 0 ? void 0 : _e.name) !== null && _f !== void 0 ? _f : activeModeId;
                variableModes[cName] = Object.assign(Object.assign({ collectionName: cName, collectionId: collection.id }, (collection.modes.length > 1 ? { dataAttribute: `data-${slugify(cName)}` } : {})), { modes: collection.modes.map((m) => ({ id: m.modeId, name: m.name, value: slugify(m.name) })), activeMode: activeModeName, tokens: {}, cssVars: {} });
            }
            // Resolve this token's value for every mode in its collection.
            const resolutions = {};
            for (const mode of collection.modes) {
                const rawVal = variable.valuesByMode[mode.modeId];
                resolutions[mode.name] = rawVal !== undefined
                    ? yield resolveTokenValue(rawVal, variable.resolvedType)
                    : "unset";
            }
            variableModes[cName].tokens[variable.name] = resolutions;
            variableModes[cName].cssVars[variable.name] = cssVarName(variable);
        }
        const png = options.includePNG ? yield exportPNG(root) : null;
        const setDescription = (_g = root.description) !== null && _g !== void 0 ? _g : "";
        const componentSet = {
            variantProperties: propMatrix,
            variantCount: variantNodes.length,
        };
        // Empty description omitted instead of emitted as noise.
        if (setDescription) {
            componentSet.description = setDescription;
        }
        return {
            meta: { id: root.id, name: root.name, type: root.type },
            componentProperties,
            componentSet,
            variants,
            variableModes,
            assets: { png_base64: png },
        };
    });
}
// ─── Bundle Assembler ─────────────────────────────────────────────────────────
function buildExportBundle(node, options) {
    return __awaiter(this, void 0, void 0, function* () {
        // Resolve a selected COMPONENT_SET to one concrete variant up front, so meta/context/
        // assets all describe the same resolved state as the tree — not the whole family.
        // options.variantId lets the UI's variant picker override the default (first visible child).
        const resolvedNode = resolveVariantNode(node, options.variantId);
        // Collect aiMetadata strings into a shared map (componentName → metadata) so each
        // unique string appears once at the bundle root instead of on every instance.
        const aiMetadataMap = new Map();
        const [tree, png, svg] = yield Promise.all([
            buildTree(resolvedNode, options, 0, aiMetadataMap),
            options.includePNG ? exportPNG(resolvedNode) : Promise.resolve(null),
            options.includeSVG ? exportSVG(resolvedNode) : Promise.resolve(null),
        ]);
        const bundle = {
            meta: { id: resolvedNode.id, name: resolvedNode.name, type: resolvedNode.type },
            // Root context always uses the full stats walk — needed by the UI metadata display.
            context: yield buildContext(resolvedNode, true),
            tree,
            assets: { png_base64: png, svg },
        };
        if (aiMetadataMap.size > 0) {
            bundle.aiMetadata = Object.fromEntries(aiMetadataMap);
        }
        return bundle;
    });
}
