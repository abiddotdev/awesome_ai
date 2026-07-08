/// <reference path="./types.ts" />

// Figma's QuickJS sandbox lacks TextDecoder — decode UTF-8 bytes manually.
function bytesToUtf8(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  const len = bytes.length;
  while (i < len) {
    const b1 = bytes[i++];
    if (b1 < 0x80) {
      out += String.fromCharCode(b1);
    } else if ((b1 & 0xe0) === 0xc0) {
      const b2 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b1 & 0x1f) << 6) | b2);
    } else if ((b1 & 0xf0) === 0xe0) {
      const b2 = bytes[i++] & 0x3f;
      const b3 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b1 & 0x0f) << 12) | (b2 << 6) | b3);
    } else if ((b1 & 0xf8) === 0xf0) {
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
function isComponentType(node: SceneNode): boolean {
  return node.type === "COMPONENT" || node.type === "COMPONENT_SET" || node.type === "INSTANCE";
}

function postSelectionState() {
  const selection = figma.currentPage.selection;
  const node = selection[0];

  // Surface a COMPONENT_SET's visible variants so the UI can offer a picker instead of
  // always resolving to the first one.
  let variants: Array<{ id: string; name: string }> | null = null;
  if (node && node.type === "COMPONENT_SET" && "children" in node) {
    const visible = (node.children as SceneNode[]).filter((c) => c.visible !== false);
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

  figma.ui.onmessage = async (msg) => {
    if (msg.type === "EXPORT") {
      const options: ExportOptions = msg.options;
      const node = figma.currentPage.selection[0];

      if (!node) {
        figma.ui.postMessage({ type: "ERROR", message: "No node selected." });
        return;
      }

      try {
        const bundle = await buildExportBundle(node, options);
        figma.ui.postMessage({ type: "RESULT", bundle });
      } catch (err) {
        figma.ui.postMessage({ type: "ERROR", message: String(err) });
      }
    }

    if (msg.type === "EXPORT_COMPONENT") {
      const options: ExportOptions = msg.options;
      const node = figma.currentPage.selection[0];

      if (!node) {
        figma.ui.postMessage({ type: "ERROR", message: "No node selected." });
        return;
      }

      try {
        const bundle = await buildComponentBundle(node, options);
        figma.ui.postMessage({ type: "COMPONENT_RESULT", bundle });
      } catch (err) {
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
      if (!node) return;

      try {
        // "All variants" previews the set itself (Figma tiles every visible
        // variant into one image) instead of resolving to a single child.
        const target = msg.allVariants ? node : resolveVariantNode(node, msg.variantId);
        // exportSVG() can't represent a whole set — it silently falls back to
        // just the first variant. Skip it for "all", or that single-variant
        // SVG would outrank the (correct, multi-variant) PNG in the UI.
        const [png, svg] = await Promise.all([
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
      } catch (err) {
        console.warn("Preview render failed:", err);
      }
    }
  };
}

// ─── Dev Mode Codegen ───────────────────────────────────────────────────────
// Auto-emits JSON into Dev Mode's Code section on selection. Preferences come
// from the dropdowns declared in manifest.json → codegenPreferences.
if (typeof figma.codegen !== "undefined") {
  figma.codegen.on("generate", async (event) => {
    const prefs = (event as unknown as { propertyValues?: Record<string, string> }).propertyValues ?? {};
    const depthRaw   = prefs.depth ?? "full";
    const pngOn      = prefs.png === "on";
    const treeDepth: "full" | number = depthRaw === "full" ? "full" : parseInt(depthRaw, 10);

    const options: ExportOptions = {
      includePNG: pngOn,
      includeSVG: false,
      tokenMode: "resolved",
      treeDepth,
    };

    try {
      const bundle = await buildExportBundle(event.node, options);
      // Strip asset blobs — they can't render in the codegen panel
      bundle.assets = { png_base64: null, svg: null };

      return [{
        title: "DesignExport AI",
        language: "JSON",
        code: JSON.stringify(bundle, null, 2),
      }];
    } catch (err) {
      return [{
        title: "DesignExport AI — Error",
        language: "PLAINTEXT",
        code: String(err),
      }];
    }
  });
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
}

function mapAlignment(value: string): string {
  const map: Record<string, string> = {
    MIN: "flex-start",
    MAX: "flex-end",
    CENTER: "center",
    SPACE_BETWEEN: "space-between",
    BASELINE: "baseline",
  };
  return map[value] ?? value;
}

function mapSizing(sizing: string, px: number): string {
  if (sizing === "FILL") return "100%";
  if (sizing === "HUG") return "fit-content";
  return `${Math.round(px)}px`;
}

function mapTextAlign(align: string): string {
  return align.toLowerCase();
}

function buildBoxShadow(effect: DropShadowEffect): string {
  const { offset, radius, spread, color } = effect;
  const hex = rgbToHex(color.r, color.g, color.b);
  const rgba = hexToRgba(hex, color.a);
  return `${offset.x}px ${offset.y}px ${radius}px ${spread ?? 0}px ${rgba}`;
}

function buildLinearGradient(fill: GradientPaint): string {
  const stops = fill.gradientStops
    .map((s) => `${rgbToHex(s.color.r, s.color.g, s.color.b)} ${Math.round(s.position * 100)}%`)
    .join(", ");
  return `linear-gradient(to right, ${stops})`;
}

function isVariableAlias(v: unknown): v is VariableAlias {
  return typeof v === "object" && v !== null && (v as VariableAlias).type === "VARIABLE_ALIAS";
}

function resolveVariableValue(value: unknown, type: string): string {
  if (type === "COLOR" && typeof value === "object" && value !== null && !isVariableAlias(value)) {
    const c = value as RGBA;
    return rgbToHex(c.r, c.g, c.b);
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  return "unresolved";
}

// Recursively follows VariableAlias chains to get the actual value (max 8 hops).
async function resolveTokenValue(raw: unknown, resolvedType: string, depth = 0): Promise<string> {
  if (depth > 8) return "unresolved";
  if (!isVariableAlias(raw)) return resolveVariableValue(raw, resolvedType);

  const aliasVar = await figma.variables.getVariableByIdAsync(raw.id);
  if (!aliasVar) return "unresolved";

  const coll = await figma.variables.getVariableCollectionByIdAsync(aliasVar.variableCollectionId);
  const modeId = coll?.defaultModeId;
  if (!modeId) return "unresolved";

  return resolveTokenValue(aliasVar.valuesByMode[modeId], aliasVar.resolvedType, depth + 1);
}

function fontStyleToWeight(style: string): string {
  if (style.includes("Thin")) return "100";
  if (style.includes("ExtraLight") || style.includes("Extra Light")) return "200";
  if (style.includes("Light")) return "300";
  if (style.includes("Medium")) return "500";
  if (style.includes("SemiBold") || style.includes("Semi Bold")) return "600";
  if (style.includes("ExtraBold") || style.includes("Extra Bold")) return "800";
  if (style.includes("Bold")) return "700";
  if (style.includes("Black") || style.includes("Heavy")) return "900";
  return "400";
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function figmaPropToCSSProp(figmaProp: string): string {
  const map: Record<string, string> = {
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
  return map[figmaProp] ?? figmaProp;
}

// Convert a token path like "ds-utils/gap" → CSS custom property "--ds-utils-gap"
function tokenNameToCssVar(name: string): string {
  const cleaned = name
    .replace(/[\s/]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toLowerCase();
  return `var(--${cleaned})`;
}

// Extract the "AI Metadata:" block from a component description, stripping designer notes.
function extractAIMetadata(description: string): string | undefined {
  const marker = "AI Metadata:";
  const idx = description.indexOf(marker);
  if (idx === -1) return undefined;
  const text = description.slice(idx + marker.length).trim();
  return text || undefined;
}

// Add a px unit to raw numeric values for length-like CSS props.
function withUnit(value: string, cssProp: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;  // already has unit or is a hex
  if (cssProp === "opacity") {
    const n = parseFloat(value);
    return n > 1 ? String(n / 100) : value;  // Figma stores opacity 0–100; CSS expects 0–1
  }
  const unitless = new Set(["font-weight", "line-height"]);
  if (unitless.has(cssProp)) return value;
  return `${value}px`;
}

// Prune CSS defaults that add noise (0px paddings, gap, radius, opacity 1, display block, etc.)
function pruneCSS(css: NodeCSS): NodeCSS {
  const out: NodeCSS = {};
  const keepZero = new Set(["top", "left"]);
  for (const [k, v] of Object.entries(css)) {
    if (v === undefined || v === null || v === "") continue;
    if (v === "0px" && !keepZero.has(k)) continue;
    if (k === "opacity" && v === "1") continue;
    if (k === "display" && v === "block") continue;
    if (k === "gap" && v === "0px") continue;
    (out as Record<string, string>)[k] = v as string;
  }
  return out;
}

// Collapse 4 padding props → shorthand when possible:
//   all 4 equal            → "padding": value
//   top===bottom, left===right → "padding": "vertical horizontal"
function collapsePaddingShorthand(css: Record<string, string>): void {
  const t = css.paddingTop;
  const r = css.paddingRight;
  const b = css.paddingBottom;
  const l = css.paddingLeft;
  if (!t || !r || !b || !l) return;

  if (t === r && r === b && b === l) {
    css.padding = t;
  } else if (t === b && r === l) {
    css.padding = `${t} ${r}`;
  } else {
    return;
  }

  delete css.paddingTop;
  delete css.paddingRight;
  delete css.paddingBottom;
  delete css.paddingLeft;
}

function collapseRadiusShorthand(css: Record<string, string>): void {
  const tl = css.borderTopLeftRadius;
  const tr = css.borderTopRightRadius;
  const br = css.borderBottomRightRadius;
  const bl = css.borderBottomLeftRadius;
  if (!tl || !tr || !br || !bl) return;

  if (tl === tr && tr === br && br === bl) {
    css.borderRadius = tl;
  } else if (tl === br && tr === bl) {
    css.borderRadius = `${tl} ${tr}`;
  } else {
    css.borderRadius = `${tl} ${tr} ${br} ${bl}`;
  }

  delete css.borderTopLeftRadius;
  delete css.borderTopRightRadius;
  delete css.borderBottomRightRadius;
  delete css.borderBottomLeftRadius;
}

function collapseBorderWidthShorthand(css: Record<string, string>): void {
  const t = css.borderTopWidth;
  const r = css.borderRightWidth;
  const b = css.borderBottomWidth;
  const l = css.borderLeftWidth;
  if (!t || !r || !b || !l) return;

  if (t === r && r === b && b === l) {
    css.borderWidth = t;
  } else if (t === b && r === l) {
    css.borderWidth = `${t} ${r}`;
  } else {
    return;
  }

  delete css.borderTopWidth;
  delete css.borderRightWidth;
  delete css.borderBottomWidth;
  delete css.borderLeftWidth;
}

// ─── CSS Extractor ───────────────────────────────────────────────────────────

function extractCSS(node: SceneNode): NodeCSS {
  const css: NodeCSS = {};

  // Layout
  if ("layoutMode" in node) {
    if (node.layoutMode !== "NONE") {
      css.display = "flex";
      css.flexDirection = node.layoutMode === "HORIZONTAL" ? "row" : "column";
      css.gap = `${node.itemSpacing}px`;
      css.alignItems = mapAlignment(node.counterAxisAlignItems);
      css.justifyContent = mapAlignment(node.primaryAxisAlignItems);
    } else {
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
  } else if ("width" in node) {
    css.width = `${Math.round(node.width)}px`;
    css.height = `${Math.round(node.height)}px`;
  }

  // Overflow / clipping
  if ("clipsContent" in node && node.clipsContent) {
    css.overflow = "hidden";
  }

  // Corner radius — always individual props; collapseRadiusShorthand folds them later
  if ("topLeftRadius" in node) {
    css.borderTopLeftRadius = `${(node as FrameNode).topLeftRadius}px`;
    css.borderTopRightRadius = `${(node as FrameNode).topRightRadius}px`;
    css.borderBottomLeftRadius = `${(node as FrameNode).bottomLeftRadius}px`;
    css.borderBottomRightRadius = `${(node as FrameNode).bottomRightRadius}px`;
  } else if ("cornerRadius" in node && typeof node.cornerRadius === "number") {
    css.borderRadius = `${node.cornerRadius}px`;
  }

  // Opacity
  if ("opacity" in node && node.opacity !== 1) {
    css.opacity = String(node.opacity);
  }

  // Absolute position — explicit overlay in auto-layout, or child of a fixed-layout frame
  if ("x" in node && "y" in node) {
    const par = node.parent as (BaseNode & { layoutMode?: string }) | null;
    const isExplicitAbsolute = "layoutPositioning" in node &&
      (node as SceneNode & { layoutPositioning?: string }).layoutPositioning === "ABSOLUTE";
    const inFixedFrame = !!par && "layoutMode" in par && par.layoutMode === "NONE" && par.type !== "PAGE";
    if (isExplicitAbsolute || inFixedFrame) {
      css.position = "absolute";
      css.top = `${Math.round((node as SceneNode & { y: number }).y)}px`;
      css.left = `${Math.round((node as SceneNode & { x: number }).x)}px`;
    }
  }

  // Fills (background / color)
  if ("fills" in node && Array.isArray(node.fills) && node.fills.length > 0) {
    const fill = (node.fills as Paint[])[0];
    if (fill.type === "SOLID") {
      const c = fill.color;
      const a = fill.opacity ?? 1;
      const hex = rgbToHex(c.r, c.g, c.b);
      if (node.type === "TEXT") {
        css.color = a < 1 ? hexToRgba(hex, a) : hex;
      } else {
        css.background = a < 1 ? hexToRgba(hex, a) : hex;
      }
    } else if (fill.type === "GRADIENT_LINEAR") {
      css.background = buildLinearGradient(fill);
    }
  }

  // Strokes (border)
  if ("strokes" in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
    const stroke = (node.strokes as Paint[])[0];
    if (stroke.type === "SOLID") {
      // Individual weights — collapseBorderWidthShorthand folds them later
      if ("strokeTopWeight" in node) {
        css.borderTopWidth    = `${(node as FrameNode).strokeTopWeight}px`;
        css.borderRightWidth  = `${(node as FrameNode).strokeRightWeight}px`;
        css.borderBottomWidth = `${(node as FrameNode).strokeBottomWeight}px`;
        css.borderLeftWidth   = `${(node as FrameNode).strokeLeftWeight}px`;
      } else {
        const weight = "strokeWeight" in node && typeof node.strokeWeight === "number" ? node.strokeWeight : 1;
        css.borderWidth = `${weight}px`;
      }
      css.borderStyle = "solid";
      css.borderColor = rgbToHex(stroke.color.r, stroke.color.g, stroke.color.b);
    }
  }

  // Effects (shadows, blur)
  if ("effects" in node && Array.isArray(node.effects)) {
    const shadows = (node.effects as Effect[]).filter(
      (e) => e.type === "DROP_SHADOW" && e.visible !== false
    ) as DropShadowEffect[];

    if (shadows.length > 0) {
      css.boxShadow = shadows.map(buildBoxShadow).join(", ");
    }

    const blur = (node.effects as Effect[]).find(
      (e) => e.type === "BACKGROUND_BLUR" && e.visible !== false
    ) as BlurEffect | undefined;

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
      if (lh.unit === "PIXELS") css.lineHeight = `${lh.value}px`;
      else if (lh.unit === "PERCENT") css.lineHeight = `${lh.value / 100}`;
    }

    const ls = node.getRangeLetterSpacing(0, 1);
    if (ls !== figma.mixed) {
      if (ls.unit === "PIXELS") css.letterSpacing = `${ls.value}px`;
      else if (ls.unit === "PERCENT") css.letterSpacing = `${ls.value / 100}em`;
    }

    css.textAlign = mapTextAlign(node.textAlignHorizontal);

    const decoration = node.getRangeTextDecoration(0, 1);
    if (decoration !== figma.mixed) {
      if (decoration === "UNDERLINE") css.textDecoration = "underline";
      if (decoration === "STRIKETHROUGH") css.textDecoration = "line-through";
    }
  }

  return css;
}

// ─── Token Resolver ──────────────────────────────────────────────────────────

// Resolve each bound variable to "var(--name, resolvedValue)" and return a map of
// cssProp → that string, ready to overwrite the raw CSS value.
async function extractInlineTokenCSS(node: SceneNode): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const bindings = (node as SceneNode & { boundVariables?: Record<string, VariableAlias | VariableAlias[]> }).boundVariables ?? {};

  for (const [prop, binding] of Object.entries(bindings)) {
    const varBinding = Array.isArray(binding) ? binding[0] : binding;
    if (!varBinding || typeof (varBinding as VariableAlias).id !== "string") continue;

    const variable = await figma.variables.getVariableByIdAsync((varBinding as VariableAlias).id);
    if (!variable) continue;

    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    const modeId = collection?.defaultModeId;
    const rawValue = modeId ? variable.valuesByMode[modeId] : undefined;
    const cssPropKebab = figmaPropToCSSProp(prop);              // kebab-case for withUnit logic
    const cssProp      = kebabToCamel(cssPropKebab);            // camelCase to match NodeCSS keys
    const resolved = await resolveTokenValue(rawValue, variable.resolvedType);
    const cssVarBase = tokenNameToCssVar(variable.name).slice(0, -1); // "var(--name"
    result[cssProp] = `${cssVarBase}, ${withUnit(resolved, cssPropKebab)})`;
  }

  return result;
}

// ─── Fill Array Builder ───────────────────────────────────────────────────────

async function buildFillsArray(node: SceneNode): Promise<FillEntry[]> {
  if (!("fills" in node) || !Array.isArray(node.fills)) return [];
  const visibleFills = (node.fills as Paint[]).filter((f) => f.visible !== false);
  if (visibleFills.length < 2) return [];

  const bindings = (node as SceneNode & {
    boundVariables?: Record<string, VariableAlias | VariableAlias[]>;
  }).boundVariables ?? {};
  const rawFillBindings = bindings.fills;
  const fillBindings: (VariableAlias | null)[] = Array.isArray(rawFillBindings)
    ? rawFillBindings
    : rawFillBindings ? [rawFillBindings as VariableAlias] : [];

  const result: FillEntry[] = [];
  for (let i = 0; i < visibleFills.length; i++) {
    const fill = visibleFills[i];
    let value = "";

    if (fill.type === "SOLID") {
      const hex = rgbToHex(fill.color.r, fill.color.g, fill.color.b);
      const a = fill.opacity ?? 1;
      value = a < 1 ? hexToRgba(hex, a) : hex;
    } else if (fill.type === "GRADIENT_LINEAR") {
      value = buildLinearGradient(fill);
    } else {
      continue;
    }

    const binding = fillBindings[i];
    if (binding?.id) {
      const variable = await figma.variables.getVariableByIdAsync(binding.id);
      if (variable) {
        const cssVarBase = tokenNameToCssVar(variable.name).slice(0, -1); // "var(--name"
        value = `${cssVarBase}, ${value})`;
      }
    }

    result.push({ type: fill.type, value });
  }
  return result;
}

// ─── Tree Builder ─────────────────────────────────────────────────────────────

// Resolve a COMPONENT_SET to one concrete variant — callers need a single renderable
// state, not a family of states to pick between at generation time. `variantId` lets
// the UI's variant picker override the default (first visible child).
function resolveVariantNode(node: SceneNode, variantId?: string): SceneNode {
  if (node.type === "COMPONENT_SET" && "children" in node) {
    const children = node.children as SceneNode[];
    if (variantId) {
      const chosen = children.find((c) => c.id === variantId && c.visible !== false);
      if (chosen) return chosen;
    }
    const visible = children.find((c) => c.visible !== false);
    if (visible) return visible;
  }
  return node;
}

async function buildTree(
  node: SceneNode,
  options: ExportOptions,
  depth = 0,
  aiMetadataMap?: Map<string, string>
): Promise<SimpleNode> {
  if (node.type === "COMPONENT_SET") {
    return buildTree(resolveVariantNode(node), options, depth, aiMetadataMap);
  }

  const css = pruneCSS(extractCSS(node));

  if (options.tokenMode !== "raw") {
    const tokenCSS = await extractInlineTokenCSS(node);
    for (const [cssProp, value] of Object.entries(tokenCSS)) {
      // Only overwrite props that survived pruning (eliminates zero-value token noise)
      if (cssProp in css) (css as Record<string, string>)[cssProp] = value;
    }
  }

  collapsePaddingShorthand(css as Record<string, string>);
  collapseRadiusShorthand(css as Record<string, string>);
  collapseBorderWidthShorthand(css as Record<string, string>);

  const simpleNode: SimpleNode = {
    name: node.name,
    type: node.type,
    css,
  };

  if (depth > 0 && (node.type === "INSTANCE" || node.type === "COMPONENT")) {
    simpleNode.context = await buildContext(node, false, aiMetadataMap);
  }

  // Multiple fills — structured array replaces css.background
  if (node.type !== "TEXT" && "fills" in node && Array.isArray(node.fills)) {
    const visibleFills = (node.fills as Paint[]).filter((f) => f.visible !== false);
    if (visibleFills.length >= 2) {
      const fillsArr = await buildFillsArray(node);
      if (fillsArr.length > 0) {
        simpleNode.fills = fillsArr;
        delete (simpleNode.css as Record<string, unknown>).background;
      }
    }
  }

  if (node.type === "TEXT") {
    simpleNode.characters = node.characters;

    // Mixed text styles — emit per-range breakdown
    if (node.characters.length > 0 && "getStyledTextSegments" in node) {
      const isMixed =
        node.getRangeFontName(0, node.characters.length) === figma.mixed ||
        node.getRangeFontSize(0, node.characters.length) === figma.mixed ||
        node.getRangeFills(0, node.characters.length) === figma.mixed;

      if (isMixed) {
        type Segment = {
          start: number; end: number; characters: string;
          fontName: FontName; fontSize: number;
          fills: Paint[]; textDecoration: TextDecoration;
        };
        const segments = (node as unknown as {
          getStyledTextSegments(fields: string[]): Segment[];
        }).getStyledTextSegments(["fontName", "fontSize", "fills", "textDecoration"]);

        simpleNode.textRanges = segments.map((seg) => {
          const range: TextRange = { start: seg.start, end: seg.end, text: seg.characters };
          if (seg.fontName) {
            range.fontFamily = `"${seg.fontName.family}"`;
            range.fontWeight = fontStyleToWeight(seg.fontName.style);
          }
          if (seg.fontSize) range.fontSize = `${seg.fontSize}px`;
          if (seg.fills?.length > 0 && seg.fills[0].type === "SOLID") {
            const c = (seg.fills[0] as SolidPaint).color;
            range.color = rgbToHex(c.r, c.g, c.b);
          }
          if (seg.textDecoration === "UNDERLINE") range.textDecoration = "underline";
          if (seg.textDecoration === "STRIKETHROUGH") range.textDecoration = "line-through";
          return range;
        });
      }
    }
  }

  if (node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION") {
    try {
      const svgBytes = await node.exportAsync({ format: "SVG" });
      simpleNode.svg = bytesToUtf8(svgBytes);
    } catch (_) {}
  }

  const maxDepth = typeof options.treeDepth === "number" ? options.treeDepth : Infinity;

  if ("children" in node && depth < maxDepth) {
    const visibleChildren = (node.children as SceneNode[]).filter((c) => c.visible !== false);

    if (visibleChildren.length > 0) {
      simpleNode.children = await Promise.all(
        visibleChildren.map((child) => buildTree(child, options, depth + 1, aiMetadataMap))
      );
    }
  }

  return simpleNode;
}

// ─── Context Builder ─────────────────────────────────────────────────────────

// `expanded` distinguishes the bundle-root context (full walk stats, for the UI's
// meta card) from the slim inline context nested on INSTANCE/COMPONENT nodes deeper
// in the tree (variant props + component name only).
async function buildContext(
  node: SceneNode,
  expanded: boolean,
  aiMetadataMap?: Map<string, string>
): Promise<NodeContext> {
  if (!expanded) {
    let mainComponentName: string | undefined;
    let componentSetName: string | undefined;

    if (node.type === "INSTANCE") {
      try {
        const main = await (node as InstanceNode).getMainComponentAsync();
        if (main) {
          mainComponentName = main.name;
          if (main.parent?.type === "COMPONENT_SET") {
            componentSetName = (main.parent as ComponentSetNode).name;
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
      } catch (_) {}
    }

    const ctx: NodeContext = {
      variantProperties:
        "variantProperties" in node
          ? (node as ComponentNode | InstanceNode).variantProperties
          : null,
    };
    if (mainComponentName) ctx.mainComponentName = mainComponentName;
    if (componentSetName)  ctx.componentSetName  = componentSetName;
    return ctx;
  }

  // ── Bundle-root context — full stats for the UI's meta card ──────────────

  let hasText = false;
  let hasVectors = false;
  let childCount = 0;

  function walk(n: SceneNode) {
    if (n.type === "TEXT") hasText = true;
    if (n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION") hasVectors = true;
    if ("children" in n) {
      childCount += n.children.length;
      (n.children as SceneNode[]).forEach(walk);
    }
  }
  walk(node);

  let mainComponentName: string | undefined;
  let componentSetName: string | undefined;
  let componentDescription: string | undefined;
  if (node.type === "INSTANCE") {
    try {
      const main = await (node as InstanceNode).getMainComponentAsync();
      if (main) {
        mainComponentName = main.name;
        componentDescription = main.description || undefined;
        if (main.parent?.type === "COMPONENT_SET") {
          componentSetName = (main.parent as ComponentSetNode).name;
        }
      }
    } catch (_) {}
  }

  return {
    nodeType: node.type,
    isComponent: node.type === "COMPONENT" || node.type === "INSTANCE",
    variantProperties:
      "variantProperties" in node
        ? (node as ComponentNode | InstanceNode).variantProperties
        : null,
    mainComponentName,
    componentSetName,
    componentDescription,
    childCount,
    hasText,
    hasVectors,
    description: "description" in node ? (node as ComponentNode).description : "",
  };
}

// ─── Asset Exporters ─────────────────────────────────────────────────────────

async function exportPNG(node: SceneNode): Promise<string | null> {
  try {
    const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    const base64 = figma.base64Encode(bytes);
    return `data:image/png;base64,${base64}`;
  } catch (err) {
    console.warn("PNG export failed:", err);
    return null;
  }
}

async function exportSVG(node: SceneNode): Promise<string | null> {
  // COMPONENT_SET cannot be SVG-exported directly — fall back to first visible variant.
  const target = resolveVariantNode(node);

  try {
    const bytes = await target.exportAsync({ format: "SVG" });
    return bytesToUtf8(bytes);
  } catch (err) {
    console.warn("SVG export failed:", err);
    return null;
  }
}

// ─── Component Bundle Helpers ────────────────────────────────────────────────

// Recursively collect every bound-variable ID in a subtree.
function collectBoundVarIds(node: SceneNode, ids: Set<string>): void {
  const bv = (node as SceneNode & {
    boundVariables?: Record<string, VariableAlias | VariableAlias[]>;
  }).boundVariables ?? {};

  for (const binding of Object.values(bv)) {
    const b = Array.isArray(binding) ? binding[0] : binding;
    if (b && typeof (b as VariableAlias).id === "string") {
      ids.add((b as VariableAlias).id);
    }
  }
  if ("children" in node) {
    for (const child of node.children as SceneNode[]) {
      collectBoundVarIds(child, ids);
    }
  }
}

// Follow VariableAlias chains across all modes to collect every referenced variable ID.
async function collectAllReferencedVarIds(seedIds: Set<string>): Promise<Set<string>> {
  const result = new Set<string>();
  const queue = [...seedIds];
  while (queue.length > 0) {
    const varId = queue.pop()!;
    if (result.has(varId)) continue;
    result.add(varId);
    const variable = await figma.variables.getVariableByIdAsync(varId);
    if (!variable) continue;
    for (const value of Object.values(variable.valuesByMode)) {
      if (isVariableAlias(value) && !result.has(value.id)) {
        queue.push(value.id);
      }
    }
  }
  return result;
}

// Walk up ancestors to find explicit variable-mode overrides (collectionId → modeId).
// More-specific (deeper) nodes take priority.
function getActiveModeMap(node: SceneNode): Record<string, string> {
  const modes: Record<string, string> = {};
  let current: BaseNode | null = node;
  while (current) {
    if ("explicitVariableModes" in current) {
      const evm = (current as FrameNode).explicitVariableModes ?? {};
      for (const [collId, modeId] of Object.entries(evm)) {
        if (!(collId in modes)) modes[collId] = modeId;
      }
    }
    current = current.parent;
  }
  return modes;
}

// Resolve the component-set root from any selected node type.
async function resolveComponentRoot(
  node: SceneNode
): Promise<ComponentSetNode | ComponentNode> {
  if (node.type === "COMPONENT_SET") return node as ComponentSetNode;

  if (node.type === "COMPONENT") {
    return node.parent?.type === "COMPONENT_SET"
      ? (node.parent as ComponentSetNode)
      : (node as ComponentNode);
  }

  if (node.type === "INSTANCE") {
    const main = await (node as InstanceNode).getMainComponentAsync();
    if (!main) throw new Error("Instance has no main component — may be from an external library.");
    return main.parent?.type === "COMPONENT_SET"
      ? (main.parent as ComponentSetNode)
      : main;
  }

  throw new Error("Select a component, instance, or component set.");
}

// ─── Component Bundle Assembler ──────────────────────────────────────────────

async function buildComponentBundle(
  node: SceneNode,
  options: ExportOptions
): Promise<ComponentBundle> {
  const root = await resolveComponentRoot(node);

  // Collect variant nodes (all children of a set, or just the component itself).
  const isSet = root.type === "COMPONENT_SET";
  const variantNodes: ComponentNode[] = isSet
    ? ((root as ComponentSetNode).children as SceneNode[]).filter(
        (c): c is ComponentNode => c.type === "COMPONENT" && c.visible !== false
      )
    : [root as ComponentNode];

  // Build variant property matrix (property → unique values).
  const propMatrix: Record<string, string[]> = {};
  for (const v of variantNodes) {
    for (const [key, val] of Object.entries(v.variantProperties ?? {})) {
      if (!propMatrix[key]) propMatrix[key] = [];
      if (!propMatrix[key].includes(val)) propMatrix[key].push(val);
    }
  }

  // Export full CSS + token tree for every variant.
  const variants: VariantExport[] = [];
  for (const v of variantNodes) {
    variants.push({
      name: v.name,
      properties: v.variantProperties ?? {},
      tree: await buildTree(v, options),
    });
  }

  // Component properties: boolean toggles, text slots, instance swaps.
  const rawProps = (root as ComponentSetNode).componentPropertyDefinitions ?? {};
  const componentProperties: Record<string, ComponentPropertyDef> = {};
  for (const [key, def] of Object.entries(rawProps)) {
    if ((def as { type: string }).type === "VARIANT") continue;  // already in variantProperties
    const cleanKey = key.replace(/#\d+:\d+$/, "").trim();
    const entry: ComponentPropertyDef = {
      type: (def as { type: string }).type as "BOOLEAN" | "TEXT" | "INSTANCE_SWAP",
      defaultValue: def.defaultValue as string | boolean,
    };
    if ((def as { type: string }).type === "INSTANCE_SWAP") {
      try {
        const comp = await figma.getNodeByIdAsync(def.defaultValue as string);
        if (comp) entry.defaultName = comp.name;
      } catch (_) {}
    }
    componentProperties[cleanKey] = entry;
  }

  // Collect every bound variable ID used across all variants.
  const directVarIds = new Set<string>();
  for (const v of variantNodes) collectBoundVarIds(v as SceneNode, directVarIds);

  // Expand through alias chains to capture all referenced collections
  // (e.g. style, color, direction which are only reached via theme→style→color aliases).
  const usedVarIds = await collectAllReferencedVarIds(directVarIds);

  // Detect which mode is active on the selected node's ancestor chain.
  const activeModeMap = getActiveModeMap(node);

  // For each variable: resolve its value in every mode of its collection.
  const variableModes: Record<string, CollectionModes> = {};

  for (const varId of usedVarIds) {
    const variable = await figma.variables.getVariableByIdAsync(varId);
    if (!variable) continue;

    const collection = await figma.variables.getVariableCollectionByIdAsync(
      variable.variableCollectionId
    );
    if (!collection) continue;

    const cName = collection.name;
    if (!variableModes[cName]) {
      const activeModeId = activeModeMap[collection.id] ?? collection.defaultModeId;
      const activeModeName =
        collection.modes.find((m) => m.modeId === activeModeId)?.name ?? activeModeId;

      variableModes[cName] = {
        collectionName: cName,
        collectionId: collection.id,
        modes: collection.modes.map((m) => ({ id: m.modeId, name: m.name })),
        activeMode: activeModeName,
        tokens: {},
      };
    }

    // Resolve this token's value for every mode in its collection.
    const resolutions: Record<string, string> = {};
    for (const mode of collection.modes) {
      const rawVal = variable.valuesByMode[mode.modeId];
      resolutions[mode.name] = rawVal !== undefined
        ? await resolveTokenValue(rawVal, variable.resolvedType)
        : "unset";
    }

    variableModes[cName].tokens[variable.name] = resolutions;
  }

  const png = options.includePNG ? await exportPNG(root as SceneNode) : null;

  const setDescription = (root as ComponentSetNode).description ?? "";
  const componentSet: ComponentBundle["componentSet"] = {
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
}

// ─── Bundle Assembler ─────────────────────────────────────────────────────────

async function buildExportBundle(
  node: SceneNode,
  options: ExportOptions
): Promise<ExportBundle> {
  // Resolve a selected COMPONENT_SET to one concrete variant up front, so meta/context/
  // assets all describe the same resolved state as the tree — not the whole family.
  // options.variantId lets the UI's variant picker override the default (first visible child).
  const resolvedNode = resolveVariantNode(node, options.variantId);

  // Collect aiMetadata strings into a shared map (componentName → metadata) so each
  // unique string appears once at the bundle root instead of on every instance.
  const aiMetadataMap = new Map<string, string>();

  const [tree, png, svg] = await Promise.all([
    buildTree(resolvedNode, options, 0, aiMetadataMap),
    options.includePNG ? exportPNG(resolvedNode) : Promise.resolve(null),
    options.includeSVG ? exportSVG(resolvedNode) : Promise.resolve(null),
  ]);

  const bundle: ExportBundle = {
    meta: { id: resolvedNode.id, name: resolvedNode.name, type: resolvedNode.type },
    // Root context always uses the full stats walk — needed by the UI metadata display.
    context: await buildContext(resolvedNode, true),
    tree,
    assets: { png_base64: png, svg },
  };

  if (aiMetadataMap.size > 0) {
    bundle.aiMetadata = Object.fromEntries(aiMetadataMap);
  }

  return bundle;
}
