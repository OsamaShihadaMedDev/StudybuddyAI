import { BookOpen, Lightbulb, Stethoscope, List, AlertTriangle, HelpCircle, FileText, Loader2 } from "lucide-react";
import SectionSkeleton from "@/components/SectionSkeleton";
import type { PartialSheet } from "@/lib/stream-sheet-parser";
import type { Flashcard } from "@/types/generated-sheet";

/**
 * Progressive renderer shown while the sheet streams in. Section order and
 * labels mirror OutputSection's JSON_SECTION_ORDER / JSON_SECTION_CONFIG so the
 * swap to OutputSection on stream close is visually seamless.
 */

const SECTION_META: Record<string, { icon: React.ElementType; label: string }> = {
  overview:        { icon: BookOpen,      label: "📋 Overview" },
  memoryHooks:     { icon: Lightbulb,     label: "🧠 Memory Hooks" },
  clinicalApproach:{ icon: Stethoscope,   label: "🩺 Clinical Approach" },
  keyPoints:       { icon: List,          label: "📌 Key Points" },
  examTraps:       { icon: AlertTriangle, label: "⚠️ Exam Traps" },
  flashcards:      { icon: HelpCircle,    label: "❓ Flashcards" },
  referenceNote:   { icon: FileText,      label: "📚 Reference Note" },
};

const SECTION_ORDER = [
  "overview", "memoryHooks", "clinicalApproach",
  "keyPoints", "examTraps", "flashcards", "referenceNote",
] as const;

interface Props {
  partial: PartialSheet | null;
}

export default function StreamingSheetView({ partial }: Props) {
  if (!partial) {
    // Nothing yet — show the initial spinner + 5 skeletons
    return (
      <div className="space-y-6 animate-fade-in">
        <LoadingHeader />
        <div className="space-y-6">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="section-reveal" style={{ animationDelay: `${i * 150}ms` }}>
              <SectionSkeleton variant="sheet-section" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const arrivedCount = SECTION_ORDER.filter((k) => k in partial).length;

  return (
    <div className="space-y-6 animate-fade-in">
      <LoadingHeader />
      <div className="space-y-6">
        {SECTION_ORDER.map((key, idx) => {
          const value = (partial as Record<string, unknown>)[key];
          const arrived = value !== undefined;
          const meta = SECTION_META[key];
          const Icon = meta.icon;

          if (!arrived) {
            // Sections that haven't arrived yet:
            // - If it's the next expected section → pulsing "receiving" skeleton
            // - Everything beyond that → normal skeleton
            const isNext = idx === arrivedCount;
            return (
              <div
                key={key}
                className="section-reveal"
                style={{ animationDelay: `${idx * 80}ms` }}
              >
                {isNext ? (
                  <ReceivingSkeleton label={meta.label} Icon={Icon} />
                ) : (
                  <SectionSkeleton variant="sheet-section" />
                )}
              </div>
            );
          }

          // Section arrived — render its content
          return (
            <div
              key={key}
              className="animate-fade-in"
              style={{
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                background: "var(--bg-elevated)",
                overflow: "hidden",
              }}
            >
              {/* Section header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 24,
                    height: 24,
                    borderRadius: "var(--radius-sm)",
                    background: "var(--accent-soft)",
                  }}
                >
                  <Icon style={{ width: 13, height: 13, color: "var(--accent)" }} />
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--fg)",
                  }}
                >
                  {meta.label}
                  {key === "overview" && partial.topicEmoji && (
                    <span className="ml-2">{partial.topicEmoji}</span>
                  )}
                </span>
              </div>

              {/* Section body */}
              <div style={{ padding: "14px 16px" }}>
                <SectionContent sectionKey={key} value={value} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function LoadingHeader() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 4px" }}>
      <Loader2
        className="animate-spin"
        style={{ width: 14, height: 14, color: "var(--accent)", flexShrink: 0 }}
      />
      <p
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 14,
          fontWeight: 500,
          color: "var(--fg)",
        }}
      >
        Building your sheet…
      </p>
      <p style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
        Sections appear as they arrive
      </p>
    </div>
  );
}

function ReceivingSkeleton({ label, Icon }: { label: string; Icon: React.ElementType }) {
  return (
    <div
      style={{
        border: "1px solid var(--accent)",
        borderRadius: "var(--radius-lg)",
        background: "var(--bg-elevated)",
        overflow: "hidden",
        opacity: 0.7,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <Loader2
          className="animate-spin"
          style={{ width: 13, height: 13, color: "var(--accent)", flexShrink: 0 }}
        />
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--accent)",
          }}
        >
          {label}
        </span>
      </div>
      <div style={{ padding: "14px 16px" }}>
        <SectionSkeleton variant="sheet-section" />
      </div>
    </div>
  );
}

function SectionContent({ sectionKey, value }: { sectionKey: string; value: unknown }) {
  const textStyle: React.CSSProperties = {
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    lineHeight: 1.65,
    color: "var(--fg-muted)",
    whiteSpace: "pre-wrap",
  };

  if (sectionKey === "flashcards" && Array.isArray(value)) {
    return (
      <div className="space-y-3">
        {(value as Flashcard[]).map((card, i) => (
          <div
            key={i}
            style={{
              padding: "10px 12px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border)",
              background: "var(--bg)",
            }}
          >
            <p style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>
              [{card.tag}]
            </p>
            <p style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)", marginBottom: 6 }}>
              {card.question}
            </p>
            <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>{card.answer}</p>
          </div>
        ))}
      </div>
    );
  }

  if (Array.isArray(value)) {
    return (
      <ul className="space-y-2">
        {(value as string[]).map((item, i) => (
          <li key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ color: "var(--accent)", marginTop: 2, flexShrink: 0 }}>·</span>
            <span style={textStyle}>{item}</span>
          </li>
        ))}
      </ul>
    );
  }

  return <p style={textStyle}>{String(value ?? "")}</p>;
}
