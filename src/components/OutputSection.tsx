import { useRef, useEffect, useState, useCallback } from "react";
import { callMedicalNotes } from "@/lib/callMedicalNotes";
import {
  BookOpen,
  Check,
  List,
  HelpCircle,
  FileText,
  Stethoscope,
  Settings2,
  AlertTriangle,
  Lightbulb,
  Layers,
  Zap,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Sparkles,
  RotateCcw,
  X,
} from "lucide-react";
import CopyButton from "@/components/CopyButton";
import FlashcardsSection from "@/components/FlashcardsSection";
import SaveButton from "@/components/SaveButton";
import CitationBadgeList from "@/components/CitationBadgeList";
import { startTopProgress, finishTopProgress } from "@/components/TopProgressBar";
import type { CitationResult } from "@/lib/citation";
import {
  type GeneratedSheet,
  type EnhancementResult,
  parseStoredSheet,
  isJsonSheet,
} from "@/types/generated-sheet";

type EnhanceKind = "enhance" | "expand" | "clinical";

interface ActiveEnhancement {
  sourceText: string;
  kind: EnhanceKind;
  anchor: string; // "sectionKey:lineIdx" | "sectionKey:end" | "saved"
  /** When true, render the source text as a golden highlight instead of the inline block. */
  isCollapsed?: boolean;
  /** Pre-loaded result from a saved sheet, so the inline block renders without re-calling the AI. */
  savedResult?: string;
}

/** Lightweight ref to a collapsed enhancement, used when wrapping its source text in a golden mark. */
interface CollapsedRef {
  key: string;
  sourceText: string;
}

/** Golden highlight styling for the source text of a collapsed enhancement. */
const ENH_MARK_STYLE: React.CSSProperties = {
  background: "rgba(234, 179, 8, 0.18)",
  borderBottom: "1.5px solid rgba(234, 179, 8, 0.5)",
  borderRadius: "2px",
  padding: "0 2px",
  cursor: "pointer",
};

/** Section card chrome — shared by the legacy and JSON renderers. */
const SECTION_CARD_STYLE: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderLeft: "3px solid var(--accent)",
  borderRadius: "var(--radius-md)",
  background: "var(--bg-elevated)",
  overflow: "hidden",
};

const SECTION_HEADER_STYLE: React.CSSProperties = {
  padding: "20px 24px 8px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const SECTION_BODY_STYLE: React.CSSProperties = { padding: "4px 24px 20px" };

const SECTION_ICON_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border)",
  background: "var(--bg)",
  flexShrink: 0,
};

const SECTION_TITLE_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: "-0.004em",
  color: "var(--fg)",
  margin: 0,
};

const MODE_BAR_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 500,
  color: "var(--fg-muted)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  padding: "6px 12px",
  background: "var(--bg-elevated)",
  letterSpacing: "0.04em",
};

/** Mode info bar — same markup in both renderers. */
const ModeInfoBar = ({
  modeInfo,
}: {
  modeInfo: { examMode: string; difficulty: string; focus: string; length: string };
}) => {
  const dot = (
    <span style={{ margin: "0 6px", opacity: 0.3, color: "var(--fg)" }}>·</span>
  );
  return (
    <div style={MODE_BAR_STYLE}>
      <Settings2 style={{ width: 13, height: 13, color: "var(--accent)" }} />
      <span>
        <span style={{ color: "var(--fg)" }}>{modeInfo.examMode}</span>
        {dot}
        <span>{modeInfo.difficulty}</span>
        {dot}
        <span>{modeInfo.focus}</span>
        {dot}
        <span>{modeInfo.length}</span>
      </span>
    </div>
  );
};

/** Backend mode for a presentational kind — the edge function only knows expand/clinical. */
const kindToMode = (kind: EnhanceKind): "expand" | "clinical" =>
  kind === "clinical" ? "clinical" : "expand";

const kindLabel: Record<EnhanceKind, string> = {
  enhance: "✦ Enhancement",
  expand: "↗ Expansion",
  clinical: "🔗 Clinical Tie",
};

function makeEnhancementKey(sourceText: string, kind: EnhanceKind): string {
  const snippet = sourceText.trim().slice(0, 40).replace(/\s+/g, "_");
  return `${kind}:${snippet}`;
}

export type CitationState = "idle" | "loading" | "found" | "locked" | "hidden";

interface OutputSectionProps {
  output: string;
  inputText?: string;
  modeInfo?: {
    examMode: string;
    difficulty: string;
    focus: string;
    length: string;
  };
  citations?: CitationResult[];
  citationState?: CitationState;
  onCitationLockedClick?: () => void;
  citationIsLoggedIn?: boolean;
  modelUsed?: "flash" | "gpt-oss" | "claude";
  isPro?: boolean;
  userId?: string | null;
  isAnonymous?: boolean;
  sheetId?: string;
}

// ─── Legacy renderer helpers (kept for old text-blob sheets) ───────────────

const sectionConfig = {
  SUMMARY: { icon: BookOpen, label: "📋 Summary", className: "section-summary" },
  "MEMORY HOOKS": { icon: Lightbulb, label: "🧠 Memory Hooks", className: "section-memoryhooks" },
  "CLINICAL APPROACH": { icon: Stethoscope, label: "🩺 Clinical Approach", className: "section-clinical" },
  "KEY POINTS": { icon: List, label: "📌 Key Points", className: "section-keypoints" },
  "EXAM TRAPS": { icon: AlertTriangle, label: "⚠️ Exam Traps", className: "section-examtraps" },
  FLASHCARDS: { icon: HelpCircle, label: "❓ Flashcards", className: "section-flashcards" },
  "REFERENCE NOTE": { icon: FileText, label: "📚 Reference Note", className: "section-reference" },
};

type SectionKey = keyof typeof sectionConfig;

const EVIDENCE_SECTIONS_LEGACY: ReadonlyArray<SectionKey> = [
  "SUMMARY",
  "CLINICAL APPROACH",
  "KEY POINTS",
];

function parseSections(text: string) {
  const sections: { title: SectionKey; content: string }[] = [];
  const keys = Object.keys(sectionConfig) as SectionKey[];
  const sortedKeys = [...keys].sort((a, b) => b.length - a.length);
  const regex = new RegExp(
    `(${sortedKeys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*\\n`,
    "g"
  );

  let lastKey: SectionKey | null = null;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (lastKey !== null) {
      sections.push({ title: lastKey, content: text.slice(lastIndex, match.index).trim() });
    }
    lastKey = match[1] as SectionKey;
    lastIndex = match.index + match[0].length;
  }

  if (lastKey !== null) {
    sections.push({ title: lastKey, content: text.slice(lastIndex).trim() });
  }

  return sections;
}

function renderFormattedContent(content: string) {
  const parts = content.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

// ─── JSON renderer helpers ─────────────────────────────────────────────────

const JSON_SECTION_CONFIG = {
  overview: { icon: BookOpen, label: "📋 Overview", className: "section-summary", evidenceBacked: true },
  memoryHooks: { icon: Lightbulb, label: "🧠 Memory Hooks", className: "section-memoryhooks", evidenceBacked: false },
  clinicalApproach: { icon: Stethoscope, label: "🩺 Clinical Approach", className: "section-clinical", evidenceBacked: true },
  keyPoints: { icon: List, label: "📌 Key Points", className: "section-keypoints", evidenceBacked: true },
  examTraps: { icon: AlertTriangle, label: "⚠️ Exam Traps", className: "section-examtraps", evidenceBacked: false },
  flashcards: { icon: HelpCircle, label: "❓ Flashcards", className: "section-flashcards", evidenceBacked: false },
  referenceNote: { icon: FileText, label: "📚 Reference Note", className: "section-reference", evidenceBacked: false },
} as const;

type JsonSectionKey = keyof typeof JSON_SECTION_CONFIG;

const SECTION_LABEL_RE = /^(Mechanism|Pathophysiology|Key associations|Definition|Key Associations(?:\s*\/\s*Features)?|Diagnosis|Management|Prognosis|Complications?|Workup|Avoid|Follow[- ]?up)(\s*[:：])/i;

type KeywordClickHandler = (keyword: string, rect: DOMRect, anchor: string) => void;

function anchorFromElement(el: Element | null): string {
  const anchorEl = el?.closest("[data-enh-anchor]");
  if (anchorEl) return anchorEl.getAttribute("data-enh-anchor") ?? "end";
  const sectionEl = el?.closest("[data-enh-section]");
  if (sectionEl) return `${sectionEl.getAttribute("data-enh-section")}:end`;
  return "end";
}

function renderBoldKeyword(
  text: string,
  i: number,
  onKeywordClick?: KeywordClickHandler
) {
  if (!onKeywordClick) {
    return (
      <strong key={i} className="font-semibold text-foreground">
        {text}
      </strong>
    );
  }
  return (
    <span
      key={i}
      className="font-semibold text-foreground cursor-pointer underline-offset-2 hover:underline hover:text-primary/90 transition-colors"
      // Stop propagation so the open menu's outside-click dismissal (a document
      // mousedown listener) doesn't immediately close the menu we're opening.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        const el = e.currentTarget as HTMLElement;
        onKeywordClick(text, el.getBoundingClientRect(), anchorFromElement(el));
      }}
    >
      {text}
    </span>
  );
}

/**
 * Locate a collapsed enhancement's source text inside a line's visible text.
 * Falls back to the longest word-bounded prefix when the full selection spans
 * past this line (selections anchor to their *start* line).
 */
function findNeedleMatch(
  visibleLower: string,
  sourceLower: string
): { idx: number; len: number } | null {
  const needle = sourceLower.trim();
  if (!needle) return null;
  let idx = visibleLower.indexOf(needle);
  if (idx >= 0) return { idx, len: needle.length };
  const words = needle.split(/\s+/);
  for (let w = words.length - 1; w >= 1; w--) {
    const prefix = words.slice(0, w).join(" ");
    if (prefix.length < 3) break;
    idx = visibleLower.indexOf(prefix);
    if (idx >= 0) return { idx, len: prefix.length };
  }
  return null;
}

/**
 * Render a line of text with `**bold**` keywords AND a golden highlight wrapped
 * around the source text of the first matching collapsed enhancement. Clicking
 * the highlight re-opens the enhancement inline.
 */
function renderRich(
  text: string,
  baseKey: string,
  onKeywordClick: KeywordClickHandler | undefined,
  collapsed: CollapsedRef[],
  onReopen: ((key: string) => void) | undefined
): React.ReactNode {
  const rawParts = text.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== "");
  const tokens = rawParts.map((part) => {
    const isBold = part.startsWith("**") && part.endsWith("**");
    return { isBold, visible: isBold ? part.slice(2, -2) : part };
  });

  const renderToken = (
    tok: { isBold: boolean; visible: string },
    key: string
  ): React.ReactNode =>
    tok.isBold ? (
      renderBoldKeyword(tok.visible, key as unknown as number, onKeywordClick)
    ) : (
      <span key={key}>{tok.visible}</span>
    );

  // Find the first collapsed source text present in this line.
  let range: { start: number; end: number; key: string } | null = null;
  if (collapsed.length && onReopen) {
    const visible = tokens.map((t) => t.visible).join("");
    const lower = visible.toLowerCase();
    for (const c of collapsed) {
      const m = findNeedleMatch(lower, c.sourceText.toLowerCase());
      if (m) {
        range = { start: m.idx, end: m.idx + m.len, key: c.key };
        break;
      }
    }
  }

  if (!range) {
    return tokens.map((t, i) => renderToken(t, `${baseKey}-${i}`));
  }

  const before: React.ReactNode[] = [];
  const inside: React.ReactNode[] = [];
  const after: React.ReactNode[] = [];
  let offset = 0;
  tokens.forEach((tok, i) => {
    const tStart = offset;
    const tEnd = offset + tok.visible.length;
    offset = tEnd;
    if (tEnd <= range!.start) {
      before.push(renderToken(tok, `${baseKey}-b${i}`));
      return;
    }
    if (tStart >= range!.end) {
      after.push(renderToken(tok, `${baseKey}-a${i}`));
      return;
    }
    if (tok.isBold) {
      // Keep bold tokens atomic — drop them whole inside the highlight.
      inside.push(
        <strong key={`${baseKey}-i${i}`} className="font-semibold text-foreground">
          {tok.visible}
        </strong>
      );
      return;
    }
    const ls = Math.max(0, range!.start - tStart);
    const le = Math.min(tok.visible.length, range!.end - tStart);
    const pre = tok.visible.slice(0, ls);
    const mid = tok.visible.slice(ls, le);
    const post = tok.visible.slice(le);
    if (pre) before.push(<span key={`${baseKey}-bp${i}`}>{pre}</span>);
    if (mid) inside.push(<span key={`${baseKey}-m${i}`}>{mid}</span>);
    if (post) after.push(<span key={`${baseKey}-ap${i}`}>{post}</span>);
  });

  return (
    <>
      {before}
      <mark
        style={ENH_MARK_STYLE}
        className="sb-enh-mark text-foreground"
        role="button"
        tabIndex={0}
        title="Re-open enhancement"
        onClick={(e) => {
          e.stopPropagation();
          onReopen!(range!.key);
        }}
      >
        {inside}
        <sup
          aria-hidden
          style={{ fontSize: "0.6em", color: "rgba(234,179,8,0.95)", marginLeft: "1px" }}
        >
          ✦
        </sup>
      </mark>
      {after}
    </>
  );
}

function renderJsonText(
  text: string,
  anchorPrefix: string,
  onKeywordClick?: KeywordClickHandler,
  renderInline?: (anchor: string) => React.ReactNode,
  collapsedByAnchor?: Record<string, CollapsedRef[]>,
  onReopen?: (key: string) => void
) {
  const lines = text.split("\n");

  return lines.map((line, lineIdx) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return <span key={lineIdx} className="block h-2" />;
    }

    const anchor = `${anchorPrefix}:${lineIdx}`;
    const collapsed = collapsedByAnchor?.[anchor] ?? [];
    const labelMatch = trimmed.match(SECTION_LABEL_RE);

    let lineNode: React.ReactNode;
    if (labelMatch) {
      const labelPart = labelMatch[1] + labelMatch[2];
      const rest = trimmed.slice(labelPart.length);

      lineNode = (
        <span
          data-enh-anchor={anchor}
          className={`block text-sm leading-relaxed ${lineIdx === 0 ? "mt-0" : "mt-3"}`}
        >
          <span className="font-semibold text-foreground/90">{labelPart}</span>
          <span className="text-muted-foreground">
            {renderRich(rest, `${anchor}-r`, onKeywordClick, collapsed, onReopen)}
          </span>
        </span>
      );
    } else {
      lineNode = (
        <span
          data-enh-anchor={anchor}
          className="block text-sm text-muted-foreground leading-relaxed"
        >
          {renderRich(trimmed, anchor, onKeywordClick, collapsed, onReopen)}
        </span>
      );
    }

    return (
      <span key={lineIdx} className="block">
        {lineNode}
        {renderInline?.(anchor)}
      </span>
    );
  });
}

// Render an array section (memoryHooks, keyPoints, examTraps)
function renderArraySection(
  items: string[],
  sectionKey?: string,
  renderInline?: (anchor: string) => React.ReactNode,
  collapsedByAnchor?: Record<string, CollapsedRef[]>,
  onReopen?: (key: string) => void
) {
  if (!Array.isArray(items) || items.length === 0) return null;

  return (
    <ol className="space-y-2">
      {items.map((item, i) => {
        const anchor = sectionKey ? `${sectionKey}:${i}` : "";
        const collapsed = (sectionKey && collapsedByAnchor?.[anchor]) || [];
        return (
          <li
            key={i}
            data-enh-anchor={sectionKey ? anchor : undefined}
            className="text-sm text-muted-foreground leading-relaxed"
          >
            <span className="flex gap-2.5">
              <span
                style={{
                  flexShrink: 0,
                  fontFamily: "var(--font-mono)",
                  fontWeight: 500,
                  fontSize: 12,
                  color: "var(--accent)",
                  opacity: 0.7,
                  width: 20,
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {i + 1}.
              </span>
              <span className="flex-1">
                {renderRich(item, `${sectionKey ?? "arr"}-${i}`, undefined, collapsed, onReopen)}
              </span>
            </span>
            {sectionKey && renderInline?.(anchor)}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Resolve a saved enhancement (which stores only sourceText) to an inline anchor
 * by locating its source text within the sheet's sections. Returns null if the
 * text can't be found (e.g. the sheet was edited after the enhancement was made).
 */
function resolveSavedAnchor(sheet: GeneratedSheet, sourceText: string): string | null {
  const needle = sourceText.trim().toLowerCase();
  if (!needle) return null;
  const strip = (s: string) => s.replace(/\*\*/g, "").toLowerCase();
  const match = (haystack: string) =>
    findNeedleMatch(strip(haystack), needle) !== null;

  const stringSections: [string, string][] = [
    ["overview", sheet.overview ?? ""],
    ["clinicalApproach", sheet.clinicalApproach ?? ""],
  ];
  for (const [key, value] of stringSections) {
    const lines = value.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() && match(lines[i])) return `${key}:${i}`;
    }
  }

  const arraySections: [string, string[]][] = [
    ["memoryHooks", sheet.memoryHooks ?? []],
    ["keyPoints", sheet.keyPoints ?? []],
    ["examTraps", sheet.examTraps ?? []],
  ];
  for (const [key, items] of arraySections) {
    for (let i = 0; i < items.length; i++) {
      if (match(items[i])) return `${key}:${i}`;
    }
  }
  return null;
}

// ─── Shared sub-components ─────────────────────────────────────────────────

function ModelBadge({ model, isPro }: { model: "flash" | "gpt-oss" | "claude"; isPro: boolean }) {
  const label =
    isPro && model === "claude"
      ? "Claude Haiku 4.5"
      : isPro && model === "gpt-oss"
      ? "GPT-OSS 20B"
      : model === "claude"
      ? "Premium AI"
      : "GPT-OSS 20B";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: "var(--radius-pill)",
        border: "1px solid var(--border-strong)",
        background: "var(--bg)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 500,
        color: "var(--fg-muted)",
        marginLeft: 8,
      }}
    >
      <Zap style={{ width: 10, height: 10 }} />
      {label}
    </span>
  );
}

function EvidenceBadge({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="This section is backed by peer-reviewed sources — see below"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: "var(--radius-pill)",
        border: "1px solid var(--border)",
        borderLeft: "2px solid var(--accent)",
        background: "var(--accent-soft)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 500,
        color: "var(--accent)",
        cursor: "pointer",
        marginLeft: 8,
        transition: "background var(--dur-micro) var(--ease-out)",
      }}
    >
      <Zap style={{ width: 10, height: 10 }} />
      Evidence-backed
    </button>
  );
}

function RegenerateButton({ sectionKey }: { sectionKey: string }) {
  return (
    <button
      type="button"
      title="Regenerate this section"
      className="h-7 w-7 flex items-center justify-center rounded-lg text-muted-foreground/40 hover:text-muted-foreground hover:bg-secondary/60 transition-colors"
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      <RefreshCw className="h-3.5 w-3.5" />
    </button>
  );
}

// ─── Floating enhance bubble ───────────────────────────────────────────────

interface EnhanceBubbleProps {
  /** Position relative to the document container (which scrolls with content). */
  top: number;
  left: number;
  onAction: (kind: EnhanceKind) => void;
  innerRef?: React.Ref<HTMLDivElement>;
}

// Anchored to the scrolling document container (its parent is `position: relative`),
// so the menu travels with the source text as the user scrolls — no scroll listeners.
const BUBBLE_BUTTON_STYLE: React.CSSProperties = {
  height: 24,
  padding: "0 8px",
  borderRadius: "var(--radius-pill)",
  border: "none",
  background: "transparent",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background var(--dur-micro) var(--ease-out)",
};

const BubbleDivider = () => (
  <span
    style={{ width: 1, height: 14, background: "var(--border-strong)" }}
    aria-hidden
  />
);

const EnhanceBubble = ({ top, left, onAction, innerRef }: EnhanceBubbleProps) => (
  <div
    ref={innerRef}
    style={{
      position: "absolute",
      top,
      left,
      transform: "translateX(-50%)",
      zIndex: 60,
      display: "flex",
      alignItems: "center",
      height: 32,
      gap: 2,
      borderRadius: "var(--radius-pill)",
      border: "1px solid var(--border-strong)",
      background: "var(--bg-elevated)",
      padding: "0 6px",
      boxShadow: "var(--shadow-2)",
    }}
    className="enhance-bubble-in"
    onMouseDown={(e) => e.stopPropagation()}
  >
    <button
      type="button"
      onClick={() => onAction("enhance")}
      style={{ ...BUBBLE_BUTTON_STYLE, color: "var(--accent)" }}
    >
      ✦ Enhance
    </button>
    <BubbleDivider />
    <button
      type="button"
      onClick={() => onAction("expand")}
      style={{ ...BUBBLE_BUTTON_STYLE, color: "var(--fg)" }}
    >
      ↗ Expand
    </button>
    <BubbleDivider />
    <button
      type="button"
      onClick={() => onAction("clinical")}
      style={{ ...BUBBLE_BUTTON_STYLE, color: "var(--accent)" }}
    >
      🔗 Clinical
    </button>
  </div>
);

// ─── Inline enhancement block ──────────────────────────────────────────────

interface InlineEnhancementProps {
  enhKey: string;
  enhancement: ActiveEnhancement;
  topic: string;
  isPro: boolean;
  userId: string | null;
  isAnonymous: boolean;
  sheetId?: string;
  /** Pre-loaded result from a saved sheet — when present, render it without re-calling the AI. */
  savedResult?: string;
  onResult?: (key: string, result: EnhancementResult) => void;
  onClose: (key: string) => void;
}

const InlineEnhancement = ({
  enhKey,
  enhancement,
  topic,
  isPro,
  userId,
  isAnonymous,
  sheetId,
  savedResult,
  onResult,
  onClose,
}: InlineEnhancementProps) => {
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const cacheKey = `sb_enhance:${sheetId ?? "unsaved"}:${enhKey}`;
  const mode = kindToMode(enhancement.kind);

  const runEnhance = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const response = await callMedicalNotes(
        {
          enhanceMode: mode,
          itemText: enhancement.sourceText,
          sectionKey: enhancement.anchor,
          sectionItems: [],
          enhanceTopic: topic,
          isPro,
          userId,
          isAnonymous,
          notes: enhancement.sourceText,
        },
        { signal: abortRef.current.signal }
      );

      if (!response.ok) throw new Error("Enhancement failed");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let accumulated = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            const text = parsed?.choices?.[0]?.delta?.content;
            if (typeof text === "string") {
              accumulated += text;
              setResult(accumulated);
            }
          } catch {
            // skip unparseable chunks
          }
        }
      }

      if (accumulated) {
        try {
          localStorage.setItem(cacheKey, accumulated);
        } catch {
          // quota exceeded
        }
        onResult?.(enhKey, {
          mode,
          sourceText: enhancement.sourceText,
          result: accumulated,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError("Enhancement failed. Try again.");
    } finally {
      setLoading(false);
    }
  }, [enhKey, enhancement, mode, topic, isPro, userId, isAnonymous, cacheKey, onResult]);

  useEffect(() => {
    if (loading) {
      startTopProgress();
      return () => finishTopProgress();
    }
  }, [loading]);

  // On mount: prefer a saved result, then the local cache, only call the AI as a last resort.
  useEffect(() => {
    if (savedResult) {
      setResult(savedResult);
      return;
    }
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      setResult(cached);
      return;
    }
    runEnhance();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => onClose(enhKey), 160);
  };

  return (
    <span
      className={`block mt-3 ${closing ? "inline-enh-exit" : "inline-enh-enter"}`}
    >
      <span
        className="block"
        style={{
          borderLeft: "3px solid var(--accent)",
          borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
          background: "var(--accent-soft)",
          padding: "10px 16px 12px",
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--accent)",
            }}
          >
            {kindLabel[enhancement.kind]}
          </span>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Dismiss enhancement"
            style={{
              flexShrink: 0,
              marginTop: -2,
              marginRight: -4,
              padding: 4,
              borderRadius: "var(--radius-sm)",
              background: "transparent",
              border: "none",
              color: "var(--fg-muted)",
              cursor: "pointer",
              opacity: 0.6,
              transition: "opacity var(--dur-micro) var(--ease-out)",
            }}
          >
            <X style={{ width: 12, height: 12 }} />
          </button>
        </span>

        {loading && !result && (
          <span className="block space-y-2 pt-1">
            <span
              className="block animate-pulse rounded"
              style={{ height: 10, width: "91.666%", background: "var(--border-strong)" }}
            />
            <span
              className="block animate-pulse rounded"
              style={{ height: 10, width: "75%", background: "var(--border-strong)" }}
            />
            <span
              className="block animate-pulse rounded"
              style={{ height: 10, width: "83.333%", background: "var(--border-strong)" }}
            />
          </span>
        )}
        {result && (
          <span
            style={{
              display: "block",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              color: "var(--fg-muted)",
              lineHeight: 1.6,
              paddingTop: 4,
            }}
          >
            {renderFormattedContent(result)}
          </span>
        )}
        {error && !loading && (
          <span style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 6 }}>
            <span style={{ fontSize: 12, color: "var(--signal)", flex: 1 }}>{error}</span>
            <button
              type="button"
              onClick={runEnhance}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 12,
                color: "var(--accent)",
                background: "none",
                border: "none",
                cursor: "pointer",
                textDecoration: "underline",
                flexShrink: 0,
              }}
            >
              <RotateCcw style={{ width: 11, height: 11 }} /> Retry
            </button>
          </span>
        )}
      </span>
    </span>
  );
};

// ─── Main component ───────────────────────────────────────────────────────

const OutputSection = ({
  output,
  inputText,
  modeInfo,
  citations,
  citationState,
  onCitationLockedClick,
  citationIsLoggedIn,
  modelUsed,
  isPro = false,
  userId,
  isAnonymous,
  sheetId,
}: OutputSectionProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const referenceNoteRef = useRef<HTMLDivElement>(null);
  const [showNudge, setShowNudge] = useState(() => !localStorage.getItem("sb_first_sheet_seen"));
  const [disclaimerCollapsed, setDisclaimerCollapsed] = useState(() =>
    sessionStorage.getItem("sb_disclaimer_collapsed") === "1"
  );

  // Inline enhancement state
  const [activeEnhancements, setActiveEnhancements] = useState<Record<string, ActiveEnhancement>>(() => {
    // Pre-populate from saved sheet enhancements if present. Each saved
    // enhancement is resolved back to the line it came from and rendered as a
    // collapsed golden highlight, so saved sheets look exactly like the live
    // generator. Unresolvable ones fall back to an expanded block at the end.
    if (!isJsonSheet(output)) return {};
    const parsed = parseStoredSheet(output);
    if (!parsed?.enhancements) return {};
    return Object.fromEntries(
      Object.entries(parsed.enhancements).map(([key, r]) => {
        const resolved = resolveSavedAnchor(parsed, r.sourceText);
        return [
          key,
          {
            sourceText: r.sourceText,
            kind: r.mode,
            anchor: resolved ?? "referenceNote:end",
            isCollapsed: resolved !== null,
            savedResult: r.result,
          } as ActiveEnhancement,
        ];
      })
    );
  });

  const sheet: GeneratedSheet | null = isJsonSheet(output) ? parseStoredSheet(output) : null;
  if (sheet && sheet.overview === undefined && (sheet as { summary?: string }).summary !== undefined) {
    sheet.overview = (sheet as { summary?: string }).summary as string;
  }
  const isJson = sheet !== null;

  // Keyword-click menu state — only used in JSON renderer. `top`/`left` are
  // relative to the document container so the menu scrolls with the content.
  const [keywordPicker, setKeywordPicker] = useState<{ text: string; anchor: string; top: number; left: number } | null>(null);
  const keywordPickerRef = useRef<HTMLDivElement>(null);

  // Convert a viewport rect into a position below the source, relative to the
  // (position: relative) document container, with horizontal clamping so the
  // ~250px menu never spills past the container edges.
  const anchorMenuPos = useCallback((rect: DOMRect) => {
    const c = ref.current?.getBoundingClientRect();
    const rawLeft = rect.left + rect.width / 2 - (c?.left ?? 0);
    return {
      top: rect.bottom - (c?.top ?? 0) + 6,
      left: Math.min(Math.max(125, rawLeft), (c?.width ?? rawLeft + 125) - 125),
    };
  }, []);

  const handleKeywordClick = useCallback(
    (keyword: string, rect: DOMRect, anchor: string) => {
      setKeywordPicker({ text: keyword, anchor, ...anchorMenuPos(rect) });
    },
    [anchorMenuPos]
  );

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (keywordPickerRef.current && !keywordPickerRef.current.contains(e.target as Node)) {
        setKeywordPicker(null);
      }
    }
    if (keywordPicker) {
      document.addEventListener("mousedown", handleOutsideClick);
      return () => document.removeEventListener("mousedown", handleOutsideClick);
    }
  }, [keywordPicker]);

  const addEnhancement = (sourceText: string, kind: EnhanceKind, anchor: string) => {
    const key = makeEnhancementKey(sourceText, kind);
    setActiveEnhancements((prev) => ({
      ...prev,
      [key]: { sourceText, kind, anchor },
    }));
  };

  const fireKeywordEnhance = (kind: EnhanceKind) => {
    if (!keywordPicker) return;
    addEnhancement(keywordPicker.text, kind, keywordPicker.anchor);
    setKeywordPicker(null);
  };

  // Selection-to-enhance state. `top`/`left` are container-relative (see above).
  const [selection, setSelection] = useState<{ text: string; anchor: string; top: number; left: number } | null>(null);
  const selectionTooltipRef = useRef<HTMLDivElement>(null);

  const handleSelectionChange = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      setSelection(null);
      return;
    }
    const text = sel.toString().trim();
    if (text.split(/\s+/).length < 3) {
      setSelection(null);
      return;
    }
    if (!ref.current) return;
    const range = sel.getRangeAt(0);
    if (!ref.current.contains(range.commonAncestorContainer)) {
      setSelection(null);
      return;
    }
    const startEl =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const rect = range.getBoundingClientRect();
    setSelection({ text, anchor: anchorFromElement(startEl), ...anchorMenuPos(rect) });
  }, [anchorMenuPos]);

  const fireSelectionEnhance = (kind: EnhanceKind) => {
    if (!selection) return;
    addEnhancement(selection.text, kind, selection.anchor);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  useEffect(() => {
    function handleOutsideSelectionClick(e: MouseEvent) {
      if (
        selectionTooltipRef.current &&
        !selectionTooltipRef.current.contains(e.target as Node)
      ) {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) setSelection(null);
      }
    }
    if (selection) {
      document.addEventListener("mousedown", handleOutsideSelectionClick);
      return () => document.removeEventListener("mousedown", handleOutsideSelectionClick);
    }
  }, [selection]);

  // Escape dismisses any open bubble
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setSelection(null);
        setKeywordPicker(null);
      }
    }
    if (selection || keywordPicker) {
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }
  }, [selection, keywordPicker]);

  // Dismissing an enhancement collapses it into a golden highlight on its source
  // text rather than deleting it, so students never lose track of what they enhanced.
  const closeEnhancement = (key: string) => {
    setActiveEnhancements((prev) => {
      if (!prev[key]) return prev;
      return { ...prev, [key]: { ...prev[key], isCollapsed: true } };
    });
  };

  // Clicking a golden highlight re-opens the enhancement inline.
  const reopenEnhancement = (key: string) => {
    setActiveEnhancements((prev) => {
      if (!prev[key]) return prev;
      return { ...prev, [key]: { ...prev[key], isCollapsed: false } };
    });
  };

  const handleEnhancementResult = useCallback(
    (key: string, result: EnhancementResult) => {
      window.dispatchEvent(
        new CustomEvent("studybuddy:enhancement-saved", {
          detail: { key, result },
        })
      );
    },
    []
  );

  const toggleDisclaimer = () => {
    setDisclaimerCollapsed((prev) => {
      const next = !prev;
      sessionStorage.setItem("sb_disclaimer_collapsed", next ? "1" : "0");
      return next;
    });
  };

  const scrollToReference = () => {
    referenceNoteRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    if (showNudge) localStorage.setItem("sb_first_sheet_seen", "1");
  }, [showNudge]);

  // Tracks the identity of the *core* sheet content (ignoring enhancements) so we
  // only scroll-to-top for a genuinely new sheet — not when an enhancement is
  // saved into the sheet (which also mutates `output`).
  const sheetIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    const hasContent = isJson ? !!sheet : parseSections(output).length > 0;
    if (!hasContent) return;
    const identity = isJson ? `${sheet?.topic ?? ""}::${sheet?.overview ?? ""}` : output;
    const isNewSheet = sheetIdentityRef.current !== identity;
    sheetIdentityRef.current = identity;
    if (isNewSheet) {
      setDisclaimerCollapsed(false);
      sessionStorage.removeItem("sb_disclaimer_collapsed");
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [output]);

  // ── Legacy renderer ──────────────────────────────────────────────────────
  if (!isJson) {
    const sections = parseSections(output);

    if (sections.length === 0) {
      return (
        <div ref={ref}>
          <div
            className="animate-fade-in"
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              background: "var(--bg-elevated)",
              padding: 24,
            }}
          >
            <div className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
              {output}
            </div>
          </div>
        </div>
      );
    }

    const hasReferenceSection = sections.some((s) => s.title === "REFERENCE NOTE");

    return (
      <div ref={ref} className="space-y-4">
        <div className="animate-fade-in flex items-center justify-between">
          {modeInfo && <ModeInfoBar modeInfo={modeInfo} />}
          <SaveButton input={inputText || ""} output={output} modeInfo={modeInfo} />
        </div>

        {sections.map(({ title, content }, idx) => {
          const config = sectionConfig[title];
          const Icon = config.icon;
          const isReference = title === "REFERENCE NOTE";
          const showEvidenceBadge =
            citationState === "found" && EVIDENCE_SECTIONS_LEGACY.includes(title);

          return (
            <div
              key={title}
              ref={isReference ? referenceNoteRef : undefined}
              className="animate-fade-in"
              style={{
                ...SECTION_CARD_STYLE,
                animationDelay: `${idx * 200}ms`,
                animationFillMode: "backwards",
              }}
            >
              <div style={SECTION_HEADER_STYLE}>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <div style={SECTION_ICON_STYLE}>
                    <Icon style={{ width: 14, height: 14, color: "var(--accent)" }} />
                  </div>
                  <h3 style={SECTION_TITLE_STYLE}>{config.label}</h3>
                  {showEvidenceBadge && <EvidenceBadge onClick={scrollToReference} />}
                  {title === "SUMMARY" && modelUsed && (
                    <ModelBadge model={modelUsed} isPro={isPro} />
                  )}
                </div>
                <CopyButton text={content} />
              </div>
              <div style={SECTION_BODY_STYLE}>
                {title === "FLASHCARDS" ? (
                  <FlashcardsSection content={content} />
                ) : (
                  <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                    {renderFormattedContent(content)}
                  </div>
                )}
                {isReference && citationState && citationState !== "idle" && citationState !== "hidden" && (
                  <div className="mt-3">
                    <CitationBadgeList
                      state={citationState}
                      citations={citations}
                      onLockedClick={onCitationLockedClick}
                      isLoggedIn={citationIsLoggedIn}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {!hasReferenceSection && citationState && citationState !== "idle" && citationState !== "hidden" && (
          <div className="animate-fade-in" style={SECTION_CARD_STYLE}>
            <div style={SECTION_HEADER_STYLE}>
              <div className="flex items-center gap-2.5">
                <div style={SECTION_ICON_STYLE}>
                  <FileText style={{ width: 14, height: 14, color: "var(--accent)" }} />
                </div>
                <h3 style={SECTION_TITLE_STYLE}>📚 Reference Note</h3>
              </div>
            </div>
            <div style={SECTION_BODY_STYLE}>
              <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                Based on standard medical references and clinical guidelines.
              </p>
              <CitationBadgeList
                state={citationState}
                citations={citations}
                onLockedClick={onCitationLockedClick}
                isLoggedIn={citationIsLoggedIn}
              />
            </div>
          </div>
        )}

        {renderNudgeAndDisclaimer(showNudge, setShowNudge, inputText, disclaimerCollapsed, toggleDisclaimer)}
      </div>
    );
  }

  // ── JSON renderer ────────────────────────────────────────────────────────
  const JSON_SECTION_ORDER: JsonSectionKey[] = [
    "overview",
    "memoryHooks",
    "clinicalApproach",
    "keyPoints",
    "examTraps",
    "flashcards",
    "referenceNote",
  ];

  // Group active enhancements by anchor so they can be injected inline.
  // Open ones render as inline blocks; collapsed ones render as golden
  // highlights wrapped around their source text.
  const enhancementsByAnchor: Record<string, [string, ActiveEnhancement][]> = {};
  const collapsedByAnchor: Record<string, CollapsedRef[]> = {};
  for (const [key, enh] of Object.entries(activeEnhancements)) {
    (enhancementsByAnchor[enh.anchor] ??= []).push([key, enh]);
    if (enh.isCollapsed) {
      (collapsedByAnchor[enh.anchor] ??= []).push({ key, sourceText: enh.sourceText });
    }
  }

  const renderInline = (anchor: string): React.ReactNode => {
    const entries = enhancementsByAnchor[anchor];
    if (!entries?.length) return null;
    return entries
      .filter(([, enh]) => !enh.isCollapsed)
      .map(([key, enh]) => (
        <InlineEnhancement
          key={key}
          enhKey={key}
          enhancement={enh}
          topic={sheet.topic ?? inputText ?? ""}
          isPro={isPro}
          userId={userId ?? null}
          isAnonymous={isAnonymous ?? false}
          sheetId={sheetId ?? inputText}
          savedResult={enh.savedResult}
          onResult={handleEnhancementResult}
          onClose={closeEnhancement}
        />
      ));
  };

  return (
    <div
      ref={ref}
      className="relative space-y-4"
      onMouseUp={handleSelectionChange}
      onTouchEnd={handleSelectionChange}
    >
      {/* Persistent highlight-to-enhance hint — sticky below the top nav */}
      <div
        className="sticky animate-fade-in"
        style={{
          top: "var(--nav-h, 64px)",
          zIndex: 20,
          display: "flex",
          alignItems: "center",
          gap: 6,
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border)",
          background: "color-mix(in srgb, var(--bg) 90%, transparent)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          padding: "6px 12px",
          marginBottom: 4,
        }}
      >
        <Sparkles style={{ width: 12, height: 12, color: "var(--accent)", flexShrink: 0 }} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--fg-muted)",
            letterSpacing: "0.02em",
          }}
        >
          Highlight any text to expand or get a clinical tie
        </span>
      </div>

      {/* Mode header + Save */}
      <div className="animate-fade-in flex items-center justify-between">
        {modeInfo && <ModeInfoBar modeInfo={modeInfo} />}
        <SaveButton input={inputText || ""} output={output} modeInfo={modeInfo} />
      </div>

      {JSON_SECTION_ORDER.map((key, idx) => {
        const config = JSON_SECTION_CONFIG[key];
        const Icon = config.icon;
        const isReference = key === "referenceNote";
        const showEvidenceBadge = citationState === "found" && config.evidenceBacked;

        const copyText =
          key === "flashcards"
            ? sheet.flashcards.map((c) => `Q: [${c.tag}] ${c.question}\nA: ${c.answer}`).join("\n\n")
            : Array.isArray(sheet[key])
            ? (sheet[key] as string[]).map((item, i) => `${i + 1}. ${item}`).join("\n")
            : (sheet[key] as string) ?? "";

        return (
          <div
            key={key}
            ref={isReference ? referenceNoteRef : undefined}
            data-section-key={key}
            className="animate-fade-in scroll-mt-20"
            style={{
              ...SECTION_CARD_STYLE,
              animationDelay: `${idx * 200}ms`,
              animationFillMode: "backwards",
            }}
          >
            <div style={SECTION_HEADER_STYLE}>
              <div className="flex items-center gap-2.5 flex-wrap">
                <div style={SECTION_ICON_STYLE}>
                  <Icon style={{ width: 14, height: 14, color: "var(--accent)" }} />
                </div>
                <h3 style={SECTION_TITLE_STYLE}>
                  {config.label}
                  {key === "overview" && sheet.topicEmoji && (
                    <span className="ml-2 text-base">{sheet.topicEmoji}</span>
                  )}
                </h3>
                {showEvidenceBadge && <EvidenceBadge onClick={scrollToReference} />}
                {key === "overview" && modelUsed && (
                  <ModelBadge model={modelUsed} isPro={isPro} />
                )}
              </div>
              <div className="flex items-center gap-1">
                <Check
                  aria-label="Section loaded"
                  className="h-3.5 w-3.5 text-primary/50 animate-fade-in"
                  style={{ animationDelay: `${idx * 200 + 350}ms`, animationFillMode: "backwards" }}
                />
                {key !== "referenceNote" && key !== "flashcards" && (
                  <RegenerateButton sectionKey={key} />
                )}
                <CopyButton text={copyText} />
              </div>
            </div>

            <div style={SECTION_BODY_STYLE} data-enh-section={key}>
              {key === "flashcards" ? (
                <FlashcardsSection cards={sheet.flashcards} />
              ) : key === "overview" || key === "clinicalApproach" ? (
                <div className="text-sm text-muted-foreground leading-relaxed">
                  {renderJsonText(
                    sheet[key] as string,
                    key,
                    handleKeywordClick,
                    renderInline,
                    collapsedByAnchor,
                    reopenEnhancement
                  )}
                </div>
              ) : key === "referenceNote" ? (
                <>
                  <div className="text-sm text-muted-foreground leading-relaxed">
                    {sheet.referenceNote}
                  </div>
                  {citationState && citationState !== "idle" && citationState !== "hidden" && (
                    <div className="mt-3">
                      <CitationBadgeList
                        state={citationState}
                        citations={citations}
                        onLockedClick={onCitationLockedClick}
                        isLoggedIn={citationIsLoggedIn}
                      />
                    </div>
                  )}
                </>
              ) : (
                renderArraySection(
                  sheet[key] as string[],
                  key,
                  renderInline,
                  collapsedByAnchor,
                  reopenEnhancement
                )
              )}
              {renderInline(`${key}:end`)}
            </div>
          </div>
        );
      })}

      {/* Fallback: selections that couldn't be anchored to a specific line */}
      {enhancementsByAnchor["end"]?.length ? (
        <div className="space-y-1">{renderInline("end")}</div>
      ) : null}

      {renderNudgeAndDisclaimer(showNudge, setShowNudge, inputText, disclaimerCollapsed, toggleDisclaimer)}

      {/* Anchored action menu — selection (below the highlighted text) */}
      {selection && (
        <EnhanceBubble
          innerRef={selectionTooltipRef}
          top={selection.top}
          left={selection.left}
          onAction={fireSelectionEnhance}
        />
      )}

      {/* Anchored action menu — bold keyword click (below the keyword) */}
      {keywordPicker && !selection && (
        <EnhanceBubble
          innerRef={keywordPickerRef}
          top={keywordPicker.top}
          left={keywordPicker.left}
          onAction={fireKeywordEnhance}
        />
      )}
    </div>
  );
};

// ─── Shared nudge + disclaimer (used by both renderers) ────────────────────

function renderNudgeAndDisclaimer(
  showNudge: boolean,
  setShowNudge: (v: boolean) => void,
  inputText: string | undefined,
  disclaimerCollapsed: boolean,
  toggleDisclaimer: () => void
) {
  return (
    <>
      {showNudge && (
        <div className="mt-4 animate-fade-in">
          <div
            style={{
              borderRadius: "var(--radius-lg)",
              border: "1px solid var(--border)",
              borderLeft: "3px solid var(--accent)",
              background: "var(--bg-elevated)",
              padding: "20px 24px",
              textAlign: "center",
            }}
          >
            <p
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 14,
                fontWeight: 500,
                color: "var(--fg)",
                marginBottom: 6,
              }}
            >
              Your first sheet is ready
            </p>
            <p
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                color: "var(--fg-muted)",
                lineHeight: 1.55,
                marginBottom: 16,
              }}
            >
              Now lock it in — generate a flashcard deck and start drilling with spaced
              repetition.
            </p>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                justifyContent: "center",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  const topic = (inputText || "").trim();
                  if (!topic) return;
                  setShowNudge(false);
                  window.dispatchEvent(
                    new CustomEvent("studybuddy:generate-flashcards", {
                      detail: { topic, cardCount: 5 },
                    })
                  );
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 36,
                  padding: "0 20px",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid transparent",
                  background: "var(--fg)",
                  color: "var(--bg)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                <Layers style={{ width: 14, height: 14 }} />
                Generate flashcards
              </button>
              <button
                type="button"
                onClick={() => setShowNudge(false)}
                style={{
                  height: 36,
                  padding: "0 16px",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--fg-muted)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Maybe later
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        className="animate-fade-in"
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
          paddingTop: 4,
          marginTop: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            style={{
              width: 13,
              height: 13,
              color: "var(--fg-subtle)",
              marginTop: 1,
              flexShrink: 0,
            }}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {!disclaimerCollapsed && (
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--fg-subtle)",
                lineHeight: 1.5,
                letterSpacing: "0.04em",
              }}
            >
              AI-generated · May contain errors · Not a substitute for clinical judgment
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={toggleDisclaimer}
          aria-label={disclaimerCollapsed ? "Expand disclaimer" : "Collapse disclaimer"}
          style={{
            flexShrink: 0,
            background: "none",
            border: "none",
            color: "var(--fg-subtle)",
            cursor: "pointer",
            padding: 2,
          }}
        >
          {disclaimerCollapsed ? (
            <ChevronDown style={{ width: 13, height: 13 }} />
          ) : (
            <ChevronUp style={{ width: 13, height: 13 }} />
          )}
        </button>
      </div>
    </>
  );
}

export default OutputSection;
