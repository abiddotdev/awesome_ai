figma.showUI(__html__, { width: 320, height: 480 });

// ═══════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════

function toHex(n: number): string {
  return Math.round(n * 255).toString(16).padStart(2, '0').toUpperCase();
}

function formatColor(c: RGB | RGBA) {
  const a = 'a' in c ? c.a : 1;
  return {
    colorSpace: 'srgb',
    components: [c.r, c.g, c.b],
    alpha: a,
    hex: `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`,
  };
}

function resolvedTypeToW3C(type: VariableResolvedDataType): string {
  switch (type) {
    case 'COLOR':   return 'color';
    case 'FLOAT':   return 'number';
    case 'STRING':  return 'string';
    case 'BOOLEAN': return 'boolean';
  }
}

function isAlias(v: VariableValue): v is VariableAlias {
  return v !== null && typeof v === 'object' && 'type' in v && v.type === 'VARIABLE_ALIAS';
}

function isColor(v: VariableValue): v is RGB | RGBA {
  return v !== null && typeof v === 'object' && 'r' in v;
}

function resolveAlias(
  alias: VariableAlias,
  varMap: Map<string, Variable>
): VariableValue {
  const target = varMap.get(alias.id);
  if (!target) return alias;
  for (const modeValue of Object.values(target.valuesByMode)) {
    if (isAlias(modeValue)) return resolveAlias(modeValue, varMap);
    return modeValue;
  }
  return alias;
}

function setDeep(obj: Record<string, unknown>, path: string[], value: unknown) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof cur[path[i]] !== 'object' || cur[path[i]] === null) cur[path[i]] = {};
    cur = cur[path[i]] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

// ═══════════════════════════════════════════════════════════
// CSS / Markdown conversion (ported from json-tokens-to-css.js)
// ═══════════════════════════════════════════════════════════

const CSS_CONFIG = {
  modeDataAttr: (slug: string) => `data-${slug}`,
  numberUnits: {
    unitless: ['z-index', 'opacity', 'scale', 'ratio', 'columns', 'count', 'level'],
    ms: ['motion', 'duration', 'delay', 'transition'],
  },
  fontWeights: {
    thin: 100, hairline: 100,
    'extra-light': 200, 'ultra-light': 200, extralight: 200,
    light: 300,
    regular: 400, normal: 400,
    medium: 500,
    'semi-bold': 600, semibold: 600, 'demi-bold': 600, demibold: 600,
    bold: 700,
    'extra-bold': 800, 'ultra-bold': 800, extrabold: 800,
    black: 900, heavy: 900,
    italic: 400,
  } as Record<string, number>,
};

const SCOPE_LABELS: Record<string, string> = {
  ALL_FILLS:     'fills',
  STROKE_COLOR:  'strokes',
  EFFECT_COLOR:  'effect color',
  EFFECT_FLOAT:  'effect value',
  GAP:           'gap / spacing',
  CORNER_RADIUS: 'corner radius',
  STROKE_FLOAT:  'stroke width',
  WIDTH_HEIGHT:  'width / height',
  OPACITY:       'opacity',
  FONT_FAMILY:   'font family',
  FONT_STYLE:    'font weight / style',
  FONT_SIZE:     'font size',
  TEXT_CONTENT:   'text content',
  ALL_SCOPES:    'any property',
};

function slugify(str: string): string {
  return str.toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Figma descriptions sometimes arrive HTML-encoded (and occasionally double-
// encoded, e.g. `&amp;quot;`). Markdown does not need entity escaping, so
// decode in passes until stable.
function decodeHtmlEntities(s: string): string {
  if (!s) return '';
  let prev = s;
  for (let i = 0; i < 3; i++) {
    const next = prev
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

// Many tokens carry collection-level authoring guidance after an "AI Metadata:"
// (or "AI metadata:") sentinel. Split the description so the suffix can be
// hoisted once per collection instead of repeated per token.
function splitDescription(desc: string): { primary: string; aiMetadata: string } {
  const decoded = decodeHtmlEntities(desc).trim();
  if (!decoded) return { primary: '', aiMetadata: '' };
  const m = decoded.match(/\bAI\s+Metadata\s*:/i);
  if (!m || m.index === undefined) return { primary: decoded, aiMetadata: '' };
  const primary = decoded.slice(0, m.index).trim().replace(/[.\s]+$/, '');
  const aiMetadata = decoded.slice(m.index + m[0].length).trim();
  return { primary, aiMetadata };
}

function cssVarName(v: Variable): string {
  const web = v.codeSyntax ? (v.codeSyntax as Record<string, string>).WEB : undefined;
  if (web) {
    const m = web.match(/var\((--[^)]+)\)/);
    if (m) return m[1];
  }
  return '--' + v.name.toLowerCase()
    .replace(/\//g, '-').replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function simplifyHex(hex: string): string {
  if (/^#[0-9a-fA-F]{8}$/i.test(hex) && hex.slice(-2).toLowerCase() === 'ff') {
    return hex.slice(0, 7);
  }
  return hex;
}

function inferUnit(varName: string, value: number): string {
  if (value === 0) return '0';
  const lower = varName.toLowerCase();
  for (const seg of CSS_CONFIG.numberUnits.unitless) {
    if (lower.includes(seg)) return String(value);
  }
  for (const seg of CSS_CONFIG.numberUnits.ms) {
    if (lower.includes(seg)) return `${value}ms`;
  }
  return `${value}px`;
}

function colorToCSS(c: RGB | RGBA): string {
  const a = 'a' in c ? c.a : 1;
  const alpha = parseFloat(a.toFixed(4));
  if (alpha >= 1) {
    return simplifyHex(`#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`);
  }
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${alpha})`;
}

function formatCSSDecl(
  varName: string,
  type: VariableResolvedDataType,
  rawValue: VariableValue,
  varNameMap: Map<string, string>
): string {
  // Alias → var(--target)
  if (isAlias(rawValue)) {
    const target = varNameMap.get(rawValue.id);
    if (target) return `${varName}: var(${target})`;
  }
  // Color
  if (isColor(rawValue)) return `${varName}: ${colorToCSS(rawValue)}`;
  // Number
  if (typeof rawValue === 'number') return `${varName}: ${inferUnit(varName, rawValue)}`;
  // String
  if (typeof rawValue === 'string') {
    const wk = rawValue.toLowerCase().trim();
    if (CSS_CONFIG.fontWeights[wk] !== undefined) {
      return `${varName}: ${CSS_CONFIG.fontWeights[wk]}`;
    }
    return `${varName}: ${rawValue}`;
  }
  // Boolean
  return `${varName}: ${rawValue}`;
}

// ── CSS generation ───────────────────────────────────────

interface AliasWarning {
  sourceCssVar: string;
  target: string;
  collection: string;
}

interface DuplicateWarning {
  cssVar: string;
  collection: string;
  mode: string;
  occurrences: number;
}

function generateCSS(
  selectedIds: string[],
  collections: VariableCollection[],
  variables: Variable[],
  varNameMap: Map<string, string>,
  cascadeMode: 'flat' | 'layered' = 'flat'
): { files: Array<{ name: string; content: string }>; warnings: AliasWarning[]; duplicates: DuplicateWarning[] } {
  const files: Array<{ name: string; content: string }> = [];
  const duplicates: DuplicateWarning[] = [];

  for (const col of collections) {
    if (!selectedIds.includes(col.id)) continue;
    const colVars = variables.filter(v => v.variableCollectionId === col.id);
    if (colVars.length === 0) continue;

    const collectionSlug = slugify(col.name);
    const dataAttr = CSS_CONFIG.modeDataAttr(collectionSlug);
    const isMultiMode = col.modes.length > 1;
    const lines: string[] = [];
    const body: string[] = [];

    // Header
    lines.push(`/* ${'='.repeat(54)}`);
    lines.push(` * ${col.name}`);
    if (isMultiMode) {
      lines.push(` * Modes: ${col.modes.map(m => m.name).join(', ')}`);
      lines.push(` * Default: :root, [${dataAttr}="${slugify(col.modes[0].name)}"]`);
    }
    if (cascadeMode === 'layered') {
      lines.push(` * Cascade layer: ${collectionSlug}`);
    }
    lines.push(` * Generated by figma-vars plugin`);
    lines.push(` * ${'='.repeat(54)} */`);
    lines.push('');

    for (let i = 0; i < col.modes.length; i++) {
      const mode = col.modes[i];
      const modeSlug = slugify(mode.name);
      const selector = i === 0 && isMultiMode
        ? `:root,\n[${dataAttr}="${modeSlug}"]`
        : i === 0
        ? ':root'
        : `[${dataAttr}="${modeSlug}"]`;

      // Count occurrences of each CSS var name in this mode block
      const varCounts = new Map<string, number>();
      for (const v of colVars) {
        if (v.valuesByMode[mode.modeId] === undefined) continue;
        const vName = cssVarName(v);
        varCounts.set(vName, (varCounts.get(vName) ?? 0) + 1);
      }
      for (const [cssVar, count] of varCounts) {
        if (count > 1) {
          duplicates.push({ cssVar, collection: col.name, mode: mode.name, occurrences: count });
        }
      }

      if (isMultiMode) {
        body.push(`/* -- Mode: ${mode.name} ${'─'.repeat(Math.max(0, 44 - mode.name.length))} */`);
      }
      body.push(`${selector} {`);

      let lastGroup = '';
      let lastScopeStr = '';
      for (const v of colVars) {
        const rawValue = v.valuesByMode[mode.modeId];
        if (rawValue === undefined) continue;
        const vName = cssVarName(v);

        // Blank line between top-level groups
        const parts = v.name.split('/');
        const group = parts.length > 1 ? parts[0] : '';
        if (lastGroup && group !== lastGroup) body.push('');
        lastGroup = group;

        // Scope comment
        if (v.scopes && v.scopes.length > 0 && v.scopes.indexOf('ALL_SCOPES' as VariableScope) === -1) {
          const scopeStr = v.scopes.map(s => SCOPE_LABELS[s] || s).join(', ');
          if (scopeStr !== lastScopeStr) {
            body.push(`  /* ${scopeStr} */`);
            lastScopeStr = scopeStr;
          }
        } else {
          lastScopeStr = '';
        }

        body.push(`  ${formatCSSDecl(vName, v.resolvedType, rawValue, varNameMap)};`);
      }

      body.push('}');
      body.push('');
    }

    if (cascadeMode === 'layered') {
      lines.push(`@layer ${collectionSlug} {`);
      for (const ln of body) {
        if (ln === '') { lines.push(''); continue; }
        // Selector strings can contain embedded newlines (e.g. ":root,\n[data-x=…]");
        // indent every sub-line so the @layer block stays visually aligned.
        for (const sub of ln.split('\n')) {
          lines.push(sub === '' ? '' : `  ${sub}`);
        }
      }
      lines.push('}');
      lines.push('');
    } else {
      lines.push(...body);
    }

    files.push({ name: `${collectionSlug}.css`, content: lines.join('\n') });
  }

  // index.css
  if (files.length > 0) {
    const idx = [
      `/* ${'='.repeat(54)}`,
      ` * Design System Tokens`,
      ` * Import this single file to load all token layers.`,
      ` * Generated by figma-vars plugin`,
      ` * ${'='.repeat(54)} */`,
      '',
      ...files.map(f => `@import './${f.name}';`),
      '',
    ].join('\n');
    files.push({ name: 'index.css', content: idx });
  }

  // Collect unresolved alias warnings
  const definedCssVars = new Set<string>();
  for (const col of collections) {
    if (!selectedIds.includes(col.id)) continue;
    for (const v of variables.filter(v => v.variableCollectionId === col.id)) {
      definedCssVars.add(cssVarName(v));
    }
  }

  const warnings: AliasWarning[] = [];
  const seen = new Set<string>();
  for (const col of collections) {
    if (!selectedIds.includes(col.id)) continue;
    for (const v of variables.filter(v => v.variableCollectionId === col.id)) {
      // Only check the default mode to avoid duplicate warnings per variable
      const rawValue = v.valuesByMode[Object.keys(v.valuesByMode)[0]];
      if (!isAlias(rawValue)) continue;
      const targetCssVar = varNameMap.get(rawValue.id) ?? null;
      if (targetCssVar !== null && definedCssVars.has(targetCssVar)) continue;
      const sourceCssVar = cssVarName(v);
      const key = `${sourceCssVar}::${col.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push({
        sourceCssVar,
        target: targetCssVar ?? `external library variable (${rawValue.id})`,
        collection: col.name,
      });
    }
  }

  return { files, warnings, duplicates };
}

// ── Markdown generation ──────────────────────────────────

interface MdVar {
  varName: string;
  scopes: VariableScope[];
  description: string;
  hidden: boolean;
  aliasTargetVar: string | null;
}

function findCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
}

function buildTokenGroups(vars: MdVar[]) {
  // Group by all-but-last segment of the var name
  const prefixMap = new Map<string, {
    suffixes: string[];
    scopes: Set<string>;
    aliases: Set<string>;
    descs: string[];
  }>();

  for (const v of vars) {
    const parts = v.varName.replace(/^--/, '').split('-');
    const prefix = parts.slice(0, -1).join('-');
    const suffix = parts[parts.length - 1];

    if (!prefixMap.has(prefix)) {
      prefixMap.set(prefix, { suffixes: [], scopes: new Set(), aliases: new Set(), descs: [] });
    }
    const g = prefixMap.get(prefix)!;
    g.suffixes.push(suffix);
    for (const s of v.scopes) g.scopes.add(s);
    if (v.description) g.descs.push(v.description);
    if (v.aliasTargetVar) g.aliases.add(v.aliasTargetVar);
  }

  // Pass 2: merge sibling groups with same suffix sets
  const parentBuckets = new Map<string, Array<{
    mid: string; suffixKey: string; suffixes: string[];
    scopes: Set<string>; aliases: Set<string>; descs: string[]; fullPrefix: string;
  }>>();
  const merged = new Set<string>();

  for (const [prefix, g] of prefixMap) {
    const pp = prefix.split('-');
    if (pp.length < 2) continue;
    const parent = pp.slice(0, -1).join('-');
    const mid = pp[pp.length - 1];
    if (!parentBuckets.has(parent)) parentBuckets.set(parent, []);
    parentBuckets.get(parent)!.push({
      mid,
      suffixKey: g.suffixes.slice().sort().join(','),
      suffixes: g.suffixes,
      scopes: g.scopes,
      aliases: g.aliases,
      descs: g.descs,
      fullPrefix: prefix,
    });
  }

  const result: Array<{ token: string; scopes: string; alias: string | null; desc: string; note?: string }> = [];

  for (const [parent, children] of parentBuckets) {
    const bySuffixKey = new Map<string, typeof children>();
    for (const c of children) {
      if (!bySuffixKey.has(c.suffixKey)) bySuffixKey.set(c.suffixKey, []);
      bySuffixKey.get(c.suffixKey)!.push(c);
    }
    for (const [, group] of bySuffixKey) {
      if (group.length < 3) continue;
      const mids = group.map(g => g.mid);
      const suffixes = group[0].suffixes;
      const scopes = new Set<string>();
      group.forEach(g => g.scopes.forEach(s => scopes.add(s)));
      const scopeStr = [...scopes].filter(s => s !== 'ALL_SCOPES')
        .map(s => SCOPE_LABELS[s] || s).join(', ');
      const allDescs = ([] as string[]).concat(...group.map(g => g.descs));
      result.push({
        token: `--${parent}-{${mids.join(', ')}}-{${suffixes.join(', ')}}`,
        scopes: scopeStr,
        alias: null,
        desc: allDescs.find(d => !!d) || '',
      });
      group.forEach(g => merged.add(g.fullPrefix));
    }
  }

  // Non-merged singles
  const singles: Array<{ token: string; scopes: string; alias: string | null; desc: string; prefix: string | null }> = [];
  for (const [prefix, g] of prefixMap) {
    if (merged.has(prefix)) continue;
    const scopeStr = [...g.scopes].filter(s => s !== 'ALL_SCOPES')
      .map(s => SCOPE_LABELS[s] || s).join(', ');

    if (g.suffixes.length <= 2) {
      const aliasArr = [...g.aliases];
      for (let i = 0; i < g.suffixes.length; i++) {
        singles.push({
          token: `--${prefix}-${g.suffixes[i]}`,
          scopes: scopeStr,
          alias: aliasArr[i] || aliasArr[0] || null,
          desc: g.descs[i] || g.descs[0] || '',
          prefix,
        });
      }
    } else {
      const allNum = g.suffixes.every(s => /^\d+$/.test(s));
      const sStr = allNum
        ? `{${g.suffixes.map(Number).sort((a, b) => a - b).join(', ')}}`
        : `{${g.suffixes.join(', ')}}`;
      let aliasNote: string | null = null;
      if (g.aliases.size > 0) {
        const ap = findCommonPrefix([...g.aliases]);
        if (ap.length > 4) aliasNote = `${ap}*`;
      }
      singles.push({
        token: `--${prefix}-${sStr}`, scopes: scopeStr, alias: aliasNote,
        desc: g.descs.find(d => !!d) || '', prefix: null,
      });
    }
  }

  // Pass 3: collapse deep groups
  const deepBuckets = new Map<string, typeof singles>();
  for (const s of singles) {
    if (!s.prefix) { result.push(s); continue; }
    const pp = s.prefix.split('-');
    const key = pp.slice(0, Math.min(4, pp.length)).join('-');
    if (!deepBuckets.has(key)) deepBuckets.set(key, []);
    deepBuckets.get(key)!.push(s);
  }

  const emitted = new Set<string>();
  const leftover: typeof singles = [];
  for (const [deepKey, items] of deepBuckets) {
    if (items.length >= 6) {
      const scopeStrs = [...new Set(items.map(i => i.scopes).filter(Boolean))];
      result.push({
        token: `--${deepKey}-{...}`,
        scopes: scopeStrs.join(', '),
        alias: null,
        desc: '',
        note: `${items.length} sub-tokens`,
      });
      items.forEach(i => emitted.add(i.token));
    } else {
      leftover.push(...items);
    }
  }

  const shallowBuckets = new Map<string, typeof singles>();
  for (const s of leftover) {
    if (emitted.has(s.token)) continue;
    const pp = (s.prefix || '').split('-');
    const key3 = pp.slice(0, Math.min(3, pp.length)).join('-');
    if (!shallowBuckets.has(key3)) shallowBuckets.set(key3, []);
    shallowBuckets.get(key3)!.push(s);
  }

  for (const [key3, items] of shallowBuckets) {
    if (items.length >= 6) {
      const scopeStrs = [...new Set(items.map(i => i.scopes).filter(Boolean))];
      result.push({
        token: `--${key3}-{...}`,
        scopes: scopeStrs.join(', '),
        alias: null,
        desc: '',
        note: `${items.length} sub-tokens`,
      });
    } else {
      result.push(...items);
    }
  }

  return result;
}

function generateMarkdown(
  selectedIds: string[],
  collections: VariableCollection[],
  variables: Variable[],
  varNameMap: Map<string, string>,
  varMap: Map<string, Variable>,
  textStyles: TextStyle[],
  cascadeMode: 'flat' | 'layered' = 'flat',
  importOrder: string[] = [],
  tierMap: Map<string, 'component' | 'semantic' | 'primitive'> = new Map()
): string {
  const md: string[] = [];

  md.push('# Design System Token Reference');
  md.push('');
  md.push('> Auto-generated by figma-vars plugin. Use as context when building components —');
  md.push('> pick the right tokens, respect the alias hierarchy, never hard-code values.');
  md.push('');

  // Architecture layers
  const layers = { component: [] as string[], semantic: [] as string[], primitive: [] as string[] };
  for (const col of collections) {
    if (!selectedIds.includes(col.id)) continue;
    if (variables.filter(v => v.variableCollectionId === col.id).length === 0) continue;
    layers[tierMap.get(col.id) ?? 'primitive'].push(col.name);
  }

  md.push('## Architecture');
  md.push('');
  md.push('```');
  if (layers.component.length)
    md.push(`Component  (${layers.component.join(', ')})  <- use these`);
  if (layers.semantic.length) {
    md.push('    ^ aliases');
    md.push(`Semantic   (${layers.semantic.join(', ')})`);
  }
  if (layers.primitive.length) {
    md.push('    ^ aliases');
    md.push(`Primitive  (${layers.primitive.join(', ')})  <- never use directly`);
  }
  md.push('```');
  md.push('');

  // Rules
  md.push('## Rules');
  md.push('');
  md.push('1. Never hard-code colour or size values — always `var(--token)`.');
  // Build layer preference from actual detected layers
  const layerNames = [
    ...(layers.component.length ? ['Component'] : []),
    ...(layers.semantic.length ? ['Semantic'] : []),
    ...(layers.primitive.length ? ['Primitive'] : []),
  ];
  if (layerNames.length > 1) {
    md.push(`2. Prefer the highest-layer token. ${layerNames.join(' > ')}.`);
  } else {
    md.push('2. Prefer the highest-layer token available.');
  }
  md.push('3. Respect scopes — a token scoped to `gap / spacing` is for gap/padding/margin only.');
  md.push('4. Tokens marked hidden/internal are primitives; do not reference them in components.');
  md.push('');

  // Mode co-location rule (only when multiple multi-mode collections exist)
  // Sort by tier so the chain diagram reads component → semantic → primitive (top to bottom).
  const tierRankMd: Record<string, number> = { component: 0, semantic: 1, primitive: 2 };
  const multiModeCollections = collections
    .filter(c => selectedIds.includes(c.id) && c.modes.length > 1)
    .sort((a, b) => (tierRankMd[tierMap.get(a.id) ?? 'primitive'] ?? 2) - (tierRankMd[tierMap.get(b.id) ?? 'primitive'] ?? 2));
  if (multiModeCollections.length > 1) {
    md.push('## Mode co-location rule');
    md.push('');
    md.push('The token chain for a component crosses multiple collections:');
    md.push('');
    md.push('```');
    // Build chain from the multi-mode collections in order
    for (let i = 0; i < multiModeCollections.length; i++) {
      const col = multiModeCollections[i];
      const attr = CSS_CONFIG.modeDataAttr(slugify(col.name));
      const varPrefix = `--${slugify(col.name)}-*`;
      md.push(`${attr}  →  ${varPrefix}`);
      if (i < multiModeCollections.length - 1) {
        md.push('                   ↓  var()');
      }
    }
    // Primitive layer at the bottom
    const primNames = collections
      .filter(c => selectedIds.includes(c.id) && c.modes.length <= 1)
      .map(c => `--${slugify(c.name)}-*`);
    if (primNames.length > 0) {
      md.push('                   ↓  var()');
      md.push(`               ${primNames.join(' / ')}  (concrete value)`);
    }
    md.push('```');
    md.push('');
    md.push('Each `var()` reference is resolved in the **inherited scope of the element that uses it**.');
    md.push('When mode attributes sit on different ancestors, an intermediate reference can resolve');
    md.push('against the wrong ancestor\'s scope and silently fall back to the default palette.');
    md.push('');
    const attrs = multiModeCollections.map(c => CSS_CONFIG.modeDataAttr(slugify(c.name)));
    // Use the first mode of each collection as example values
    const attrExamples = multiModeCollections.map(c => {
      const attr = CSS_CONFIG.modeDataAttr(slugify(c.name));
      const exampleMode = slugify(c.modes[0].name);
      return `${attr}="${exampleMode}"`;
    });
    md.push('**Rule: place all mode attributes that a component depends on on the same ancestor element.**');
    md.push('');
    md.push('```html');
    md.push(`<!-- correct — all on the same wrapper -->`);
    md.push(`<div ${attrExamples.join(' ')}>`);
    md.push('  <button>Action</button>');
    md.push('</div>');
    md.push('');
    md.push(`<!-- broken — attributes on different ancestors -->`);
    md.push(`<div ${attrExamples.slice(0, -1).join(' ')}>`);
    md.push(`  <div ${attrExamples[attrExamples.length - 1]}>`);
    md.push('    <button>Action</button>');
    md.push('  </div>');
    md.push('</div>');
    md.push('```');
    md.push('');

    // Dependency note: for each multi-mode collection, check if another
    // collection's tokens alias into it — if so, warn that modes are coupled.
    // Detect pairs where one collection's modes are only meaningful when
    // paired with specific modes of another collection.
    for (const col of multiModeCollections) {
      const colSlug = slugify(col.name);
      const colAttr = CSS_CONFIG.modeDataAttr(colSlug);
      const modeNames = col.modes.map(m => slugify(m.name));

      // Find another collection whose modes reference this one's tokens
      for (const other of multiModeCollections) {
        if (other.id === col.id) continue;
        const otherSlug = slugify(other.name);
        const otherAttr = CSS_CONFIG.modeDataAttr(otherSlug);
        const otherVars = variables.filter(v => v.variableCollectionId === other.id);

        // Check if any of other's variables alias into col's variables
        const aliasesIntoCol = otherVars.some(v => {
          for (const val of Object.values(v.valuesByMode)) {
            if (isAlias(val)) {
              const target = varMap.get(val.id);
              if (target && target.variableCollectionId === col.id) return true;
            }
          }
          return false;
        });

        if (aliasesIntoCol) {
          // Find modes that are "passthrough" (ignore col) vs "active" (depend on col)
          const activeModes = other.modes.filter(m => {
            const mVars = otherVars.filter(v => {
              const val = v.valuesByMode[m.modeId];
              if (!isAlias(val)) return false;
              const target = varMap.get(val.id);
              return target && target.variableCollectionId === col.id;
            });
            return mVars.length > 0;
          });
          const activeModeIds = new Set(activeModes.map(m => m.modeId));
          const passiveModes = other.modes.filter(m => !activeModeIds.has(m.modeId));

          if (activeModes.length > 0 && passiveModes.length > 0) {
            const activeNames = activeModes.map(m => `\`${slugify(m.name)}\``).join(', ');
            const passiveNames = passiveModes.map(m => `\`${slugify(m.name)}\``).join(', ');
            md.push(`**\`${colAttr}\` is only meaningful when \`${otherAttr}\` is set to ${activeNames}.**`);
            md.push(`\`${otherAttr}\` in ${passiveNames} mode does not reference \`${colAttr}\` tokens.`);
            md.push(`If changing \`${colAttr}\` has no visible effect, check that \`${otherAttr}\` uses one of ${activeNames} on the same element.`);
            md.push('');
          }
        }
      }
    }

    // Component-boundary guidance. The co-location rule above tells you to
    // put all mode attrs on the same element. Once the consumer is a
    // component (React, Angular, Vue, Lit, custom element, etc.), "the same
    // element" must be the element where var() is resolved — not a
    // page-level wrapper. Stays framework-agnostic deliberately.
    md.push('## Component boundaries and the token chain');
    md.push('');
    md.push('When tokens are consumed inside a component (React, Angular, Vue, Lit,');
    md.push('custom elements, or any other model with encapsulated styles), the');
    md.push('co-location rule extends with two failure modes:');
    md.push('');
    md.push('1. **`var()` resolves in the consuming element\'s own computed scope, not its');
    md.push('   ancestors\'.** When a mode attribute lives on a page-level wrapper,');
    md.push('   intermediate `var()` hops in the chain are sealed using the wrapper\'s');
    md.push('   scope (where most mode attributes are absent). The component inherits an');
    md.push('   already-resolved value, so its own data-* rules are never consulted and');
    md.push('   the chain falls back to the default palette even though the component');
    md.push('   carries the right attribute.');
    md.push('');
    md.push('2. **Encapsulated style trees (shadow DOM, scoped styles) only invalidate');
    md.push('   when the component\'s own attributes change.** Toggling a mode attribute');
    md.push('   on a page-level wrapper does not propagate into the component. It keeps');
    md.push('   showing stale values until the component\'s own root attributes change.');
    md.push('');
    md.push('### Mirror the mode attribute onto the consuming element');
    md.push('');
    md.push('For each mode attribute the component depends on, the value must end up on');
    md.push('the component\'s own root element — read it from the nearest ancestor that');
    md.push('defines it, apply it on the component, and re-apply when the ancestor');
    md.push('changes. The mechanism varies by framework; the requirement does not. After');
    md.push('this, the component carries every data-* the chain needs and the');
    md.push('co-location rule is satisfied regardless of where the semantic mode');
    md.push('attributes live in the page.');
    md.push('');
    md.push('### Failure trace');
    md.push('');
    md.push('What "falls back to the default palette" looks like when one mode attribute');
    md.push('sits on the parent and another sits on the component, using collections');
    md.push('from this design system:');
    md.push('');
    // Find a pair (A→B) where A's variables alias into B, so the trace is accurate.
    // Fall back to [0]/[1] if no such pair exists among multi-mode collections.
    let traceA = multiModeCollections[0];
    let traceB = multiModeCollections[1];
    outer: for (const a of multiModeCollections) {
      for (const b of multiModeCollections) {
        if (a.id === b.id) continue;
        const aliasesIntoB = variables
          .filter(v => v.variableCollectionId === a.id)
          .some(v => Object.values(v.valuesByMode).some(val => {
            if (!isAlias(val)) return false;
            const target = varMap.get(val.id);
            return target !== undefined && target.variableCollectionId === b.id;
          }));
        if (aliasesIntoB) { traceA = a; traceB = b; break outer; }
      }
    }
    const traceASlug = slugify(traceA.name);
    const traceBSlug = slugify(traceB.name);
    const traceAMode = slugify(traceA.modes[0].name);
    const traceBMode = slugify(traceB.modes[0].name);
    md.push('```');
    md.push(`Parent     (data-${traceASlug}="${traceAMode}"):`);
    md.push(`  --${traceASlug}-* references --${traceBSlug}-* in its definition`);
    md.push(`  resolves --${traceBSlug}-* in the parent's scope`);
    md.push(`    parent has no data-${traceBSlug} -> :root default applies`);
    md.push('    -> concrete value, sealed at the parent');
    md.push(`Component  (data-${traceBSlug}="${traceBMode}"):`);
    md.push(`  inherits --${traceASlug}-* = <concrete default>  (already sealed)`);
    md.push(`  component's own --${traceBSlug}-* rule is defined but never consulted`);
    md.push('```');
    md.push('');
    md.push('The component\'s rules are correct; they are just never read, because the');
    md.push('upstream chain already collapsed to a concrete value at the parent.');
    md.push('');
    md.push('### Rule of thumb');
    md.push('');
    md.push('Never rely on CSS custom property inheritance to bridge a multi-hop `var()`');
    md.push('chain across elements. Each hop must resolve in the same element\'s computed');
    md.push('scope. **Mirror the mode attribute to the element that needs it.**');
    md.push('');

    // Parent-scoped themes and component fallback (always emitted when 2+
    // multi-mode collections exist, regardless of cascadeMode — @layer fixes
    // priority but not the inheritance leak).
    md.push('## Parent-scoped themes and component fallback');
    md.push('');
    md.push('Mirroring solves the chain. There is still a related case worth calling out:');
    md.push('a **legitimate** parent + child split where an outer mode attribute scopes a');
    md.push('region (e.g. a section\'s theme) and an inner mode attribute applies a state to');
    md.push('one element inside it (e.g. an item\'s color). This pattern is fine, but the');
    md.push('inner element only re-binds the tokens the inner axis owns. Tokens the inner');
    md.push('axis does **not** re-bind continue to inherit the outer scope\'s values — a');
    md.push('half-state element where some properties follow the inner axis and others');
    md.push('still follow the outer one. Often this is what you want; sometimes it is not,');
    md.push('and CSS gives no signal either way.');
    md.push('');
    md.push('Component-level pattern when the inner axis should win across the board:');
    md.push('declare an explicit fallback chain on the component for the tokens you care');
    md.push('about, so the inner axis is tried first and the outer axis is the fallback:');
    md.push('');
    md.push('```css');
    md.push('.consumer {');
    md.push('  /* prefer inner-axis token, fall back to outer-axis token */');
    md.push('  background:   var(--<inner-axis>-background, var(--<outer-axis>-background));');
    md.push('  border-color: var(--<inner-axis>-border,     var(--<outer-axis>-border));');
    md.push('}');
    md.push('```');
    md.push('');
    md.push('This makes the resolution order an explicit authoring choice on the component,');
    md.push('independent of which mode attribute lives on which ancestor. Cascade layers do');
    md.push('not fix this — layers re-order priority between matching declarations, but');
    md.push('they do not change which custom properties each axis chooses to re-bind.');
    md.push('');
  }

  // Cascade strategy guidance (always emitted when at least 2 collections are
  // exported — the order between them is meaningful in both modes).
  const exportedCollections = collections.filter(c => selectedIds.includes(c.id));
  if (exportedCollections.length >= 2) {
    const orderedSlugs = (importOrder.length > 0 ? importOrder : exportedCollections.map(c => c.id))
      .map(id => exportedCollections.find(c => c.id === id))
      .filter((c): c is VariableCollection => Boolean(c))
      .map(c => slugify(c.name));

    if (cascadeMode === 'flat') {
      md.push('## File load order');
      md.push('');
      md.push('In flat mode the generator emits each collection as a top-level stylesheet');
      md.push('with no `@layer` wrapping. When two collections re-bind the same custom');
      md.push('property name, specificity is equal across `[data-*]` selectors, so **the');
      md.push('file imported last wins**. Reordering the imports, bundling files in a');
      md.push('different order, or inserting a stylesheet between them silently changes');
      md.push('which axis "wins" — there is no console signal.');
      md.push('');
      md.push('The generated `index.css` declares the chosen order:');
      md.push('');
      md.push('```css');
      for (const slug of orderedSlugs) md.push(`@import './${slug}.css';`);
      md.push('```');
      md.push('');
      md.push('Files later in the list override earlier ones for any shared variable name.');
      md.push('Consume the design system through this `index.css` — do not reshuffle the');
      md.push('imports in your bundle. To change priority, re-export with a different order.');
      md.push('');
    } else {
      md.push('## Cascade layers');
      md.push('');
      md.push('In layered mode the generator wraps each collection in a named CSS cascade');
      md.push('layer (`@layer <slug> { … }`) and declares the layer order at the top of');
      md.push('`index.css`. Cascade priority is **explicit and order-independent within the');
      md.push('`@import` lines** — later layers in the declared order beat earlier ones,');
      md.push('regardless of which file the consumer\'s bundler emits last.');
      md.push('');
      md.push('The generated `index.css` declares:');
      md.push('');
      md.push('```css');
      md.push(`@layer ${orderedSlugs.join(', ')};`);
      md.push('');
      for (const slug of orderedSlugs) md.push(`@import './${slug}.css';`);
      md.push('```');
      md.push('');
      md.push('Within a single layer, normal CSS specificity rules still apply. Anything');
      md.push('declared **outside** any `@layer` (legacy stylesheets, third-party CSS) has');
      md.push('higher priority than every named layer — keep the design-system imports');
      md.push('ahead of un-layered overrides if you want tokens to win.');
      md.push('');
      md.push('`@layer` does not fix the parent-scoped / inner-state inheritance leak');
      md.push('described above; that is a tokens-not-rebound problem, not a priority one.');
      md.push('Use the component-level fallback chain there.');
      md.push('');
    }
  }

  // Modes table
  md.push('## Modes');
  md.push('');
  md.push('| Collection | Attribute | Values | Default |');
  md.push('|---|---|---|---|');
  for (const col of collections) {
    if (!selectedIds.includes(col.id)) continue;
    if (col.modes.length <= 1) continue;
    const slug = slugify(col.name);
    const attr = CSS_CONFIG.modeDataAttr(slug);
    const modes = col.modes.map(m => slugify(m.name)).join(', ');
    const defMode = slugify(col.modes[0].name);
    md.push(`| ${col.name} | \`${attr}\` | ${modes} | ${defMode} |`);
  }
  md.push('');

  // Per-token catalog lives in a separate file to keep skill.md loadable as
  // agent context. Point readers there rather than inlining ~1000+ bullets.
  md.push('---');
  md.push('');
  md.push('## Token reference');
  md.push('');
  md.push('The full per-token catalog — exact names, aliases, scopes, descriptions, and');
  md.push('per-collection authoring guidance — lives in [`tokens.md`](./tokens.md).');
  md.push('Open that file when you need to look up a specific token. Use this file');
  md.push('(`skill.md`) for the rules of the system.');
  md.push('');

  // Typography
  if (textStyles.length > 0) {
    md.push('---');
    md.push('');
    md.push('## Typography');
    md.push('');
    md.push(`\`typography.css\` | ${textStyles.length} text style${textStyles.length !== 1 ? 's' : ''}`);
    md.push('');
    md.push('Apply these classes to text elements. Each class sets font-family, size, weight, line-height, and letter-spacing together.');
    md.push('');
    md.push('| Class | Family | Size | Weight | Line height | Letter spacing |');
    md.push('|---|---|---|---|---|---|');
    for (const ts of textStyles) {
      const cls = textStyleClassName(ts.name);
      const { weight, italic } = parseFontWeight(ts.fontName.style);
      const lh = cssLineHeight(ts.lineHeight);
      const ls = cssLetterSpacing(ts.letterSpacing);
      const wStr = italic ? `${weight} italic` : String(weight);
      md.push(`| \`.${cls}\` | ${ts.fontName.family} | ${ts.fontSize}px | ${wStr} | ${lh} | ${ls} |`);
    }
    md.push('');
  }

  return md.join('\n');
}

// Per-token reference catalog. Emitted as a separate file so skill.md stays
// small enough to load as agent context. Per-collection AI Metadata snippets
// are deduplicated and hoisted above the token list; per-token descriptions
// keep only the unique pre-"AI Metadata:" portion, with HTML entities decoded.
function generateTokensMarkdown(
  selectedIds: string[],
  collections: VariableCollection[],
  variables: Variable[],
  varNameMap: Map<string, string>
): string {
  const md: string[] = [];
  md.push('# Token Catalog');
  md.push('');
  md.push('> Per-token reference for the design system. Look up a token by name here.');
  md.push('> The rules of the system live in [`skill.md`](./skill.md).');
  md.push('');

  for (const col of collections) {
    if (!selectedIds.includes(col.id)) continue;
    const colVars = variables.filter(v => v.variableCollectionId === col.id);
    if (colVars.length === 0) continue;

    const allHidden = colVars.every(v => v.hiddenFromPublishing);
    const slug = slugify(col.name);

    md.push(`## ${col.name}`);
    md.push('');

    const meta = [`\`${slug}.css\``];
    if (col.modes.length > 1) meta.push(`${col.modes.length} modes`);
    meta.push(`${colVars.length} tokens`);
    if (allHidden) meta.push('**internal**');
    md.push(meta.join(' | '));
    md.push('');

    if (allHidden) {
      md.push('> Do not use directly in components. These are aliased by higher-layer tokens.');
      md.push('');
    }

    // Pre-pass: split each variable's description, dedupe AI Metadata snippets
    // for collection-level hoisting, and stash the cleaned primary text.
    const cleanedDescs = new Map<string, string>(); // variableId → primary
    const aiSnippets: string[] = [];
    const aiSeen = new Set<string>();
    for (const v of colVars) {
      const { primary, aiMetadata } = splitDescription(v.description);
      if (primary) cleanedDescs.set(v.id, primary);
      if (aiMetadata && !aiSeen.has(aiMetadata)) {
        aiSeen.add(aiMetadata);
        aiSnippets.push(aiMetadata);
      }
    }

    if (aiSnippets.length > 0) {
      md.push('**Authoring guidance:**');
      md.push('');
      for (const s of aiSnippets) md.push(`- ${s}`);
      md.push('');
    }

    // Build flat var list for grouping, using cleaned primary descriptions.
    const mdVars: MdVar[] = colVars.map(v => {
      const defaultVal = v.valuesByMode[col.defaultModeId];
      let aliasTarget: string | null = null;
      if (defaultVal && isAlias(defaultVal)) {
        aliasTarget = varNameMap.get(defaultVal.id) || null;
      }
      return {
        varName: cssVarName(v),
        scopes: v.scopes,
        description: cleanedDescs.get(v.id) || '',
        hidden: v.hiddenFromPublishing,
        aliasTargetVar: aliasTarget,
      };
    });

    const groups = buildTokenGroups(mdVars);
    for (const g of groups) {
      let line = `- \`${g.token}\``;
      if (g.alias) line += ` → \`${g.alias}\``;
      if (g.note) line += ` *(${g.note})*`;
      if (g.scopes) line += ` — ${g.scopes}`;
      md.push(line);
      if (g.desc && !g.note) {
        const desc = g.desc.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
        if (desc) md.push(`  ${desc}`);
      }
    }
    md.push('');
  }

  return md.join('\n');
}

// ═══════════════════════════════════════════════════════════
// Typography (text styles)
// ═══════════════════════════════════════════════════════════

function textStyleClassName(name: string): string {
  return 'text-' + name.toLowerCase()
    .replace(/\//g, '-').replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseFontWeight(style: string): { weight: number; italic: boolean } {
  const lower = style.toLowerCase().trim();
  const italic = lower.includes('italic');
  const base = lower.replace(/italic/g, '').replace(/\s+/g, ' ').trim().replace(/\s+/g, '-') || 'regular';
  const weight = CSS_CONFIG.fontWeights[base]
    ?? CSS_CONFIG.fontWeights[base.replace(/-/g, ' ')]
    ?? 400;
  return { weight, italic };
}

function cssLineHeight(lh: LineHeight): string {
  if (lh.unit === 'AUTO') return 'normal';
  if (lh.unit === 'PERCENT') return String(parseFloat((lh.value / 100).toFixed(4)));
  return `${lh.value}px`;
}

function cssLetterSpacing(ls: LetterSpacing): string {
  if (ls.value === 0) return '0';
  if (ls.unit === 'PERCENT') return `${parseFloat((ls.value / 100).toFixed(4))}em`;
  return `${ls.value}px`;
}

function generateTypographyCSS(
  textStyles: TextStyle[]
): { file: { name: string; content: string } | null } {
  if (textStyles.length === 0) return { file: null };

  const lines: string[] = [
    `/* ${'='.repeat(54)}`,
    ` * Typography`,
    ` * ${textStyles.length} text style${textStyles.length !== 1 ? 's' : ''}`,
    ` * Generated by figma-vars plugin`,
    ` * ${'='.repeat(54)} */`,
    '',
  ];

  let lastGroup = '';

  for (const ts of textStyles) {
    const cls = textStyleClassName(ts.name);
    const { weight, italic } = parseFontWeight(ts.fontName.style);
    const lineHeight = cssLineHeight(ts.lineHeight);
    const letterSpacing = cssLetterSpacing(ts.letterSpacing);

    let textDecoration = '';
    if (ts.textDecoration === 'UNDERLINE') textDecoration = 'underline';
    else if (ts.textDecoration === 'STRIKETHROUGH') textDecoration = 'line-through';

    let textTransform = '';
    if (ts.textCase === 'UPPER') textTransform = 'uppercase';
    else if (ts.textCase === 'LOWER') textTransform = 'lowercase';
    else if (ts.textCase === 'TITLE') textTransform = 'capitalize';

    const fontVariant = (ts.textCase === 'SMALL_CAPS' || ts.textCase === 'SMALL_CAPS_FORCED')
      ? 'small-caps' : '';

    const group = ts.name.includes('/') ? ts.name.split('/')[0] : '';
    if (lastGroup && group !== lastGroup) lines.push('');
    lastGroup = group;

    if (ts.description) lines.push(`/* ${ts.description} */`);
    lines.push(`.${cls} {`);
    lines.push(`  font-family: "${ts.fontName.family}", sans-serif;`);
    lines.push(`  font-size: ${ts.fontSize}px;`);
    lines.push(`  font-weight: ${weight};`);
    if (italic) lines.push(`  font-style: italic;`);
    lines.push(`  line-height: ${lineHeight};`);
    if (letterSpacing !== '0') lines.push(`  letter-spacing: ${letterSpacing};`);
    if (textDecoration) lines.push(`  text-decoration: ${textDecoration};`);
    if (textTransform) lines.push(`  text-transform: ${textTransform};`);
    if (fontVariant) lines.push(`  font-variant: ${fontVariant};`);
    lines.push('}');
  }

  lines.push('');
  return { file: { name: 'typography.css', content: lines.join('\n') } };
}

// ═══════════════════════════════════════════════════════════
// JSON export (existing)
// ═══════════════════════════════════════════════════════════

function buildModeTokens(
  col: VariableCollection,
  modeId: string,
  colVars: Variable[],
  colMap: Map<string, VariableCollection>,
  varMap: Map<string, Variable>
): Record<string, unknown> {
  const root: Record<string, unknown> = {};

  for (const v of colVars) {
    const rawValue = v.valuesByMode[modeId];

    let $value: unknown;
    if (isAlias(rawValue)) {
      const resolved = resolveAlias(rawValue, varMap);
      $value = isColor(resolved) ? formatColor(resolved) : resolved;
    } else {
      $value = isColor(rawValue) ? formatColor(rawValue) : rawValue;
    }

    const $extensions: Record<string, unknown> = {
      'com.figma.variableId': v.id,
      'com.figma.scopes': v.scopes,
      'com.figma.codeSyntax': v.codeSyntax,
    };

    if (isAlias(rawValue)) {
      const targetVar = varMap.get(rawValue.id);
      const targetCol = targetVar ? colMap.get(targetVar.variableCollectionId) : undefined;
      $extensions['com.figma.aliasData'] = {
        targetVariableId: rawValue.id,
        targetVariableName: targetVar ? targetVar.name : '',
        targetVariableSetId: targetCol ? targetCol.id : '',
        targetVariableSetName: targetCol ? targetCol.name : '',
      };
      $extensions['com.figma.isOverride'] = true;
    }

    const token: Record<string, unknown> = {
      $type: resolvedTypeToW3C(v.resolvedType),
      $value,
    };
    if (v.description) token.$description = v.description;
    token.$extensions = $extensions;

    setDeep(root, v.name.split('/'), token);
  }

  return root;
}

function buildTypographyTokens(textStyles: TextStyle[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const ts of textStyles) {
    const { weight, italic } = parseFontWeight(ts.fontName.style);
    const value: Record<string, unknown> = {
      fontFamily: ts.fontName.family,
      fontSize: `${ts.fontSize}px`,
      fontWeight: weight,
      lineHeight: cssLineHeight(ts.lineHeight),
      letterSpacing: cssLetterSpacing(ts.letterSpacing),
    };
    if (italic) value.fontStyle = 'italic';
    if (ts.textDecoration === 'UNDERLINE') value.textDecoration = 'underline';
    else if (ts.textDecoration === 'STRIKETHROUGH') value.textDecoration = 'line-through';
    if (ts.textCase === 'UPPER') value.textTransform = 'uppercase';
    else if (ts.textCase === 'LOWER') value.textTransform = 'lowercase';
    else if (ts.textCase === 'TITLE') value.textTransform = 'capitalize';
    if (ts.textCase === 'SMALL_CAPS' || ts.textCase === 'SMALL_CAPS_FORCED') value.fontVariant = 'small-caps';

    const token: Record<string, unknown> = { $type: 'typography', $value: value };
    if (ts.description) token.$description = ts.description;
    token.$extensions = { 'com.figma.textStyleId': ts.id };

    setDeep(root, ts.name.split('/'), token);
  }
  return root;
}

// ═══════════════════════════════════════════════════════════
// Init + message handler
// ═══════════════════════════════════════════════════════════

function buildTierMap(
  selectedIds: string[],
  collections: VariableCollection[],
  variables: Variable[]
): Map<string, 'component' | 'semantic' | 'primitive'> {
  const selectedSet = new Set(selectedIds);
  const varMap = new Map(variables.map(v => [v.id, v]));
  const hasOutbound = new Set<string>();
  const hasInbound = new Set<string>();

  for (const col of collections) {
    if (!selectedSet.has(col.id)) continue;
    for (const v of variables.filter(v2 => v2.variableCollectionId === col.id)) {
      for (const val of Object.values(v.valuesByMode)) {
        if (!isAlias(val)) continue;
        const target = varMap.get(val.id);
        if (!target || target.variableCollectionId === col.id) continue;
        if (!selectedSet.has(target.variableCollectionId)) continue;
        hasOutbound.add(col.id);
        hasInbound.add(target.variableCollectionId);
      }
    }
  }

  const result = new Map<string, 'component' | 'semantic' | 'primitive'>();
  for (const col of collections) {
    if (!selectedSet.has(col.id)) continue;
    const out = hasOutbound.has(col.id);
    const inn = hasInbound.has(col.id);
    result.set(col.id, out && !inn ? 'component' : out && inn ? 'semantic' : 'primitive');
  }
  return result;
}

async function main() {
  const [collections, variables, textStyles] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
    figma.getLocalTextStylesAsync(),
  ]);
  const allTierMap = buildTierMap(collections.map(c => c.id), collections, variables);
  figma.ui.postMessage({
    type: 'collections',
    data: collections.map(c => ({
      id: c.id,
      name: c.name,
      tier: allTierMap.get(c.id) ?? 'primitive',
    })),
    fileName: figma.root.name,
    textStyleCount: textStyles.length,
  });
}

figma.ui.onmessage = async (msg) => {
  if (msg.type !== 'export') return;

  const selectedIds: string[] = msg.collectionIds;
  const output: string = msg.output;
  const cascadeMode: 'flat' | 'layered' = msg.cascadeMode === 'flat' ? 'flat' : 'layered';

  const [collections, variables, textStyles] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
    figma.getLocalTextStylesAsync(),
  ]);

  const colMap = new Map(collections.map(c => [c.id, c]));
  const varMap = new Map(variables.map(v => [v.id, v]));

  // Build varNameMap: variableId → CSS var name (used by CSS/MD)
  const varNameMap = new Map<string, string>();
  for (const v of variables) {
    varNameMap.set(v.id, cssVarName(v));
  }

  // Resolve importOrder: prefer the user-supplied one, else default to
  // architecture-tier order (primitives → semantic → component, so later
  // layers/files win for component overrides). Filter out unknown ids and
  // append any selected ids the caller forgot.
  const tierRank: Record<'primitive' | 'semantic' | 'component', number> = {
    primitive: 0, semantic: 1, component: 2,
  };
  const tierMap = buildTierMap(selectedIds, collections, variables);
  const rawOverrides: Record<string, string> = msg.tierOverrides && typeof msg.tierOverrides === 'object' ? msg.tierOverrides : {};
  const validTiers = new Set(['component', 'semantic', 'primitive']);
  for (const [id, tier] of Object.entries(rawOverrides)) {
    if (validTiers.has(tier)) tierMap.set(id, tier as 'component' | 'semantic' | 'primitive');
  }

  const defaultOrderedIds = selectedIds
    .map(id => colMap.get(id))
    .filter((c): c is VariableCollection => Boolean(c))
    .map(c => ({ id: c.id, tier: tierMap.get(c.id) ?? 'primitive' }))
    .sort((a, b) => tierRank[a.tier] - tierRank[b.tier])
    .map(x => x.id);
  const requestedOrder: string[] = Array.isArray(msg.importOrder) ? msg.importOrder : [];
  const seen = new Set<string>();
  const importOrder: string[] = [];
  for (const id of requestedOrder) {
    if (selectedIds.includes(id) && !seen.has(id)) { importOrder.push(id); seen.add(id); }
  }
  for (const id of defaultOrderedIds) {
    if (!seen.has(id)) { importOrder.push(id); seen.add(id); }
  }

  if (output === 'css-md') {
    const { files: cssFiles, warnings, duplicates } = generateCSS(selectedIds, collections, variables, varNameMap, cascadeMode);
    const { file: typoFile } = generateTypographyCSS(textStyles);
    const mdContent = generateMarkdown(selectedIds, collections, variables, varNameMap, varMap, textStyles, cascadeMode, importOrder, tierMap);
    const tokensMdContent = generateTokensMarkdown(selectedIds, collections, variables, varNameMap);

    // Assemble CSS files: typography first, then token files in importOrder, then rebuilt index.css
    const tokenFileMap = new Map(cssFiles.filter(f => f.name !== 'index.css').map(f => [f.name, f]));
    const orderedTokenFiles: { name: string; content: string }[] = [];
    for (const id of importOrder) {
      const col = colMap.get(id);
      if (!col) continue;
      const f = tokenFileMap.get(`${slugify(col.name)}.css`);
      if (f) orderedTokenFiles.push(f);
    }
    const contentFiles: { name: string; content: string }[] = [];
    if (typoFile) contentFiles.push(typoFile);
    contentFiles.push(...orderedTokenFiles);
    if (contentFiles.length > 0) {
      const layerSlugs = importOrder
        .map(id => colMap.get(id))
        .filter((c): c is VariableCollection => Boolean(c))
        .map(c => slugify(c.name));
      const indexLines: string[] = [
        `/* ${'='.repeat(54)}`,
        ` * Design System Tokens`,
        ` * Import this single file to load all token layers.`,
        ` * Cascade mode: ${cascadeMode}`,
        ` * Generated by figma-vars plugin`,
        ` * ${'='.repeat(54)} */`,
        '',
      ];
      if (cascadeMode === 'layered' && layerSlugs.length > 0) {
        indexLines.push(`@layer ${layerSlugs.join(', ')};`);
        indexLines.push('');
      }
      indexLines.push(...contentFiles.map(f => `@import './${f.name}';`));
      indexLines.push('');
      contentFiles.push({ name: 'index.css', content: indexLines.join('\n') });
    }

    const allFiles: { name: string; content: string }[] = [
      ...contentFiles,
      { name: 'skill.md', content: mdContent },
      { name: 'tokens.md', content: tokensMdContent },
    ];
    if (warnings.length > 0) {
      const lines: string[] = [
        '# Unresolved Alias Targets',
        '',
        `> ${warnings.length} token${warnings.length > 1 ? 's' : ''} alias a variable not included in this export.`,
        '> These `var()` references will silently fall back to the browser default.',
        '> Either export the missing collections or replace the alias with a hardcoded value.',
        '',
        '| Source token | Points to | Collection |',
        '|---|---|---|',
        ...warnings.map(w => `| \`${w.sourceCssVar}\` | \`${w.target}\` | ${w.collection} |`),
        '',
      ];
      allFiles.push({ name: '_unresolved-aliases.md', content: lines.join('\n') });
    }
    if (duplicates.length > 0) {
      const lines: string[] = [
        '# Duplicate CSS Variable Declarations',
        '',
        `> ${duplicates.length} CSS variable${duplicates.length > 1 ? 's are' : ' is'} declared more than once in the same selector block.`,
        '> In CSS the last declaration wins, which may produce unexpected values.',
        '> Check that multiple Figma variables do not share the same `codeSyntax.WEB` name within one collection.',
        '',
        '| CSS variable | Collection | Mode | Occurrences |',
        '|---|---|---|---|',
        ...duplicates.map(d => `| \`${d.cssVar}\` | ${d.collection} | ${d.mode} | ${d.occurrences} |`),
        '',
      ];
      allFiles.push({ name: '_duplicates.md', content: lines.join('\n') });
    }
    figma.ui.postMessage({ type: 'export-data', output: 'css-md', files: allFiles, warnings, duplicates });

  } else if (output === 'single') {
    const single: Record<string, unknown> = {};
    for (const col of collections) {
      if (!selectedIds.includes(col.id)) continue;
      const colVars = variables.filter(v => v.variableCollectionId === col.id);
      single[col.name] = {};
      for (const mode of col.modes) {
        (single[col.name] as Record<string, unknown>)[mode.name] =
          buildModeTokens(col, mode.modeId, colVars, colMap, varMap);
      }
    }
    if (textStyles.length > 0) single['typography'] = buildTypographyTokens(textStyles);
    figma.ui.postMessage({ type: 'export-data', output: 'single', data: single });

  } else {
    // per-mode (default)
    const files: { name: string; data: unknown }[] = [];
    for (const col of collections) {
      if (!selectedIds.includes(col.id)) continue;
      const colVars = variables.filter(v => v.variableCollectionId === col.id);
      for (const mode of col.modes) {
        files.push({
          name: `${mode.name}.tokens.json`,
          data: buildModeTokens(col, mode.modeId, colVars, colMap, varMap),
        });
      }
    }
    if (textStyles.length > 0) files.push({ name: 'typography.tokens.json', data: buildTypographyTokens(textStyles) });
    figma.ui.postMessage({ type: 'export-data', output: 'per-mode', files });
  }
};

main();
