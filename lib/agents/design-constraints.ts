/**
 * Machine contract for the Design Agent — the compact, per-build CONSTRAINTS
 * block appended to the design user message.
 *
 * Why this exists: the system prompt is ~30k tokens of accumulated prose rules,
 * and per-rule compliance is probabilistic — with ~15 independent static gates,
 * even 95-98% per-rule compliance multiplies out to a ~50% retry rate (measured:
 * 2 of 3 paid builds retried; 28% of historical comps shipped duplicate-logo
 * defects, 10% drew the logo by hand). Models comply far better with short,
 * local, checkable constraints stated next to the task than with prohibitions
 * buried mid-prompt. This block states, as data, exactly what the build-time
 * gates will reject — so the first pass can simply not violate them.
 *
 * Everything here mirrors a deterministic check in pipeline.ts/quality-gates.ts;
 * when a gate changes, update the corresponding line here (and vice versa).
 */
import type { AspectRatio } from "./quality-gates";

/**
 * Icons the agent may import from lucide-react, every one verified against the
 * installed package by design-constraints.test.ts — so the list can never
 * drift into hallucination territory. Deliberately curated, not exhaustive:
 * generic concepts only. lucide-react ships ZERO brand/company logos (no
 * Slack/Github/Figma — the #1 icon hallucination, which compiles clean and
 * crashes at render), and Sparkles/Sparkle are excluded because the
 * decorative-filler gate flags them.
 */
export const ALLOWED_LUCIDE_ICONS = [
  "Activity", "AlertCircle", "AlertTriangle", "ArrowDown", "ArrowLeft",
  "ArrowRight", "ArrowUp", "ArrowUpRight", "BadgeCheck", "BarChart3", "Bell",
  "Blocks", "BookOpen", "Box", "Boxes", "Braces", "Brain", "Briefcase",
  "Building2", "Calendar", "Check", "CheckCircle2", "CheckSquare",
  "ChevronDown", "ChevronLeft", "ChevronRight", "ChevronUp", "Circle",
  "CircleDot", "Clock", "Cloud", "Code", "Code2", "Cog", "Compass", "Cpu",
  "CreditCard", "Database", "Download", "Eye", "FileText", "Filter",
  "Fingerprint", "Flag", "FlaskConical", "Folder", "Gauge", "Gift",
  "GitBranch", "GitCommit", "GitMerge", "GitPullRequest", "Globe",
  "GraduationCap", "Hammer", "HardDrive", "Hash", "Headphones", "Heart",
  "HelpCircle", "Home", "Inbox", "Infinity", "Key", "Landmark", "Layers",
  "Layout", "LayoutDashboard", "LayoutGrid", "Leaf", "Lightbulb", "LineChart",
  "Link", "List", "Lock", "Mail", "Map", "MapPin", "Megaphone",
  "MessageCircle", "MessageSquare", "Mic", "Monitor", "Moon", "Network",
  "Package", "Paintbrush", "Palette", "Pause", "PenTool", "Phone", "PieChart",
  "Play", "Plug", "Plus", "Quote", "Radar", "Receipt", "RefreshCw", "Repeat",
  "Rocket", "Route", "Scale", "Search", "Send", "Server", "Settings",
  "Share2", "Shield", "ShieldCheck", "ShoppingBag", "ShoppingCart", "Signal",
  "Smartphone", "Square", "Star", "Sun", "Table", "Tag", "Target", "Terminal",
  "Timer", "TrendingDown", "TrendingUp", "Trophy", "Truck", "Unlock",
  "Upload", "User", "UserCheck", "Users", "Video", "Wallet", "Wand2", "Waves",
  "Wifi", "Workflow", "Wrench", "X", "XCircle", "Zap", "ZoomIn",
] as const;

const CANVAS: Record<AspectRatio, { w: number; h: number; safe: number }> = {
  "16:9": { w: 1920, h: 1080, safe: 1760 },
  "9:16": { w: 1080, h: 1920, safe: 920 },
  "1:1": { w: 1080, h: 1080, safe: 920 },
};

/**
 * Build the CONSTRAINTS block for one build. `hasLogo` switches the logo
 * decision table between the real-logo and wordmark-only contracts;
 * `signatureMissing` (deliberately-monochrome brands) is handled by the
 * palette block in buildDesignUserMessage, not here.
 */
export const buildDesignConstraints = (
  aspect: AspectRatio,
  opts: { hasLogo: boolean },
): string => {
  const c = CANVAS[aspect];
  const logoTable = opts.hasLogo
    ? [
        "LOGO (a real logo IS provided — these three rows are the ONLY valid patterns):",
        "  default scene        → the logo appears ONLY inside <BrandChrome logoSrc={LOGO_SRC} …/>. Zero other logo renders.",
        "  hero opening or CTA  → ONE hero <Img src={LOGO_SRC} …/> in the section PLUS showCornerLogo={false} on that scene's BrandChrome.",
        "  any scene, any time  → NEVER draw the brand mark yourself (no <svg> logo replicas, no monogram components). REJECTED by a static check that detects logo-named SVG components.",
      ]
    : [
        "LOGO (NO real logo exists for this brand):",
        "  every scene          → the brand mark is the WORDMARK TEXT rendered by BrandChrome (omit logoSrc). NEVER invent/draw a mark — geometric stand-ins are REJECTED.",
      ];

  return [
    "## CONSTRAINTS — machine-checked; violations trigger a rejected build (verbatim contract, not guidance)",
    "",
    `CANVAS: ${c.w}x${c.h} (${aspect}). Primary content elements ≤ ${c.safe}px wide; a left-anchored element must satisfy left+width ≤ ${c.w}. Anchor real content (CTA row, meta footer, chart base) into the lower third (top ≥ ${Math.round(c.h * 0.62)}px) — an empty lower band is flagged.`,
    "",
    ...logoTable,
    "",
    "BRANDCHROME: provided at ./BrandChrome — import { BrandChrome } from \"./BrandChrome\". Defining your own BrandChrome (const/function/class) is REJECTED by a static check.",
    "",
    `ICONS: lucide-react contains NO brand/company logos — importing one (Slack, Github, Figma, …) compiles but crashes the render and is auto-rejected. Import ONLY from this verified list: ${ALLOWED_LUCIDE_ICONS.join(", ")}.`,
    "",
    "TEXT FLOORS: any <p> with an inline fontSize must be ≥ 24px and any <li> ≥ 18px — smaller body type is unreadable in the rendered video. Mono/eyebrow caption chrome is exempt only when it reads as chrome: letterSpacing ≥ 0.12em, uppercase, or a mono fontFamily.",
    "",
    "ACCENT DISCIPLINE: the SIGNATURE brand color may border AT MOST 4 elements per section. It marks THE focal element — six identical accent-bordered cards is decoration, not emphasis; give non-focal containers neutral hairlines.",
    "",
    "TEXT DWELL (checked on the animation pass): every text element must finish entering with reading time left — animation-delay + duration + max(1.2s, words × 0.3s) must fit inside the scene's duration. Never land a headline or lede in the final moments of a scene; late beats belong on decoration.",
    "",
    "TASTE CONTRACT (reviewed scene-by-scene, not yet machine-checked — treat as the same contract): in any grid of 3+ same-size cards, exactly ONE must be featured (larger, live, or visually dominant — never a uniform grid); a card interior is canvas too — no card may be a mostly-empty box, every card carries real content; the CTA pill label must NOT repeat the headline text verbatim; a chart ships only with axis/label context and at a size where the data is readable (roughly a quarter of the canvas or more) — otherwise omit it.",
    "",
    "ALSO MACHINE-CHECKED: every rendered JSX component must be imported or locally defined (undefined components crash); text/background contrast ≥ 3:1 (hard) and ≥ 4.5:1 (target); text entrance animations ≤ 1.0s; no numeric claims absent from the provided content (invented stats are rejected); the per-scene eyebrow text must NOT repeat in the chrome category pill.",
  ].join("\n");
};
