// No export — kept as a script file so triple-slash references work in both sandbox and UI contexts

interface NodeCSS {
  display?: string;
  flexDirection?: string;
  gap?: string;
  padding?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  width?: string;
  height?: string;
  alignItems?: string;
  justifyContent?: string;
  overflow?: string;
  position?: string;
  top?: string;
  left?: string;
  background?: string;
  borderRadius?: string;
  borderTopLeftRadius?: string;
  borderTopRightRadius?: string;
  borderBottomLeftRadius?: string;
  borderBottomRightRadius?: string;
  borderTopWidth?: string;
  borderRightWidth?: string;
  borderBottomWidth?: string;
  borderLeftWidth?: string;
  borderWidth?: string;
  borderStyle?: string;
  borderColor?: string;
  boxShadow?: string;
  opacity?: string;
  backdropFilter?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  textAlign?: string;
  textTransform?: string;
  textDecoration?: string;
  color?: string;
}

interface FillEntry {
  type: string;
  value: string;
}

interface TextRange {
  start: number;
  end: number;
  text: string;
  fontFamily?: string;
  fontWeight?: string;
  fontSize?: string;
  color?: string;
  textDecoration?: string;
}

interface SimpleNode {
  name: string;
  type: string;
  css: NodeCSS;
  context?: NodeContext;    // present on INSTANCE / COMPONENT nodes only
  fills?: FillEntry[];      // present when node has 2+ visible fills; replaces css.background
  characters?: string;
  textRanges?: TextRange[];  // present on TEXT nodes with mixed styles
  svg?: string;
  children?: SimpleNode[];  // omitted when empty
}

interface NodeContext {
  // Root-bundle fields only — omitted on slim inline contexts
  nodeType?: string;
  isComponent?: boolean;
  childCount?: number;
  hasText?: boolean;
  hasVectors?: boolean;
  description?: string;
  componentDescription?: string;

  // Always present (when applicable)
  variantProperties: Record<string, string> | null;
  mainComponentName?: string;
  componentSetName?: string;  // "Button", "Tooltip" etc — or "ID:<nodeId>" when no set parent exists
}

interface ExportBundle {
  meta: {
    id: string;
    name: string;
    type: string;
  };
  context: NodeContext;
  tree: SimpleNode;
  assets: {
    png_base64: string | null;
    svg: string | null;
  };
  aiMetadata?: Record<string, string>;  // componentName → AI metadata string
}

interface ExportOptions {
  includePNG: boolean;
  includeSVG: boolean;
  tokenMode: "resolved" | "raw";  // resolved: inline var(--name, value) CSS; raw: plain values only
  treeDepth: "full" | number;    // "full" = unlimited, number = explicit depth cap
  variantId?: string;   // COMPONENT_SET selection: which visible child to resolve to (defaults to first)
}

// ─── Component export types ───────────────────────────────────────────────────

interface ComponentPropertyDef {
  type: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP";
  defaultValue: string | boolean;
  defaultName?: string;            // INSTANCE_SWAP: resolved component name
}

interface VariantExport {
  name: string;
  properties: Record<string, string>;
  tree: SimpleNode;
}

interface CollectionModes {
  collectionName: string;
  collectionId: string;
  modes: Array<{ id: string; name: string }>;
  activeMode: string;                                    // mode currently applied to the component
  tokens: Record<string, Record<string, string>>;       // tokenName → { modeName: resolvedValue }
}

interface ComponentBundle {
  meta: { id: string; name: string; type: string };
  componentProperties: Record<string, ComponentPropertyDef>;
  componentSet: {
    variantProperties: Record<string, string[]>;
    variantCount: number;
    description?: string;
  };
  variants: VariantExport[];
  variableModes: Record<string, CollectionModes>;       // collectionName → modes + token map
  assets: { png_base64: string | null };
}
