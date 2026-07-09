import { useState, useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { History, Loader2, PenLine, Settings2, Sparkles, Stethoscope, X } from "lucide-react";
import SectionSkeleton from "@/components/SectionSkeleton";
import { useToast } from "@/hooks/use-toast";
import OutputSection, { type CitationState } from "@/components/OutputSection";
import { useUsageLimit, MAX_DAILY_SHEETS } from "@/hooks/use-usage-limit";
import { useCitationUsage } from "@/hooks/use-citation-usage";
import { usePremiumHook } from "@/hooks/use-premium-hook";
import { useModelPreference } from "@/hooks/use-model-preference";
import { useAuth } from "@/hooks/use-auth";
import { callMedicalNotes } from "@/lib/callMedicalNotes";
import { useFlashcardDeck } from "@/hooks/use-flashcard-deck";
import { parseFlashcardsFromOutput } from "@/lib/parse-flashcards";
import { sanitizeJsonOutput } from "@/lib/sanitize-json";
import {
  type GeneratedSheet,
  parseStoredSheet,
  isJsonSheet,
} from "@/types/generated-sheet";
import { fetchBestCitation, type CitationResult } from "@/lib/citation";
import CitationCTABanner from "@/components/CitationCTABanner";
import AuthModal from "@/components/AuthModal";
import GoProModal from "@/components/GoProModal";
import { startTopProgress, finishTopProgress } from "@/components/TopProgressBar";
import { useStudyHistory, type StudyHistoryItem } from "@/hooks/use-study-history";
import { timeAgo } from "@/lib/utils";

export interface SheetGeneratorPrefill {
  input: string;
  output: string;
  modeInfo?: StudyHistoryItem["modeInfo"];
}

interface SheetGeneratorProps {
  prefill?: SheetGeneratorPrefill | null;
}

const RECENT_TOPICS_KEY = "sb_recent_topics_v1";

interface PillGroupProps {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}

/** Inline pill toggle group — all options visible, tap to select. */
const PillGroup = ({ label, options, value, onChange }: PillGroupProps) => (
  <div className="space-y-1">
    <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {label}
    </label>
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={`inline-flex h-7 items-center px-2.5 rounded-md border text-xs font-medium transition-colors cursor-pointer ${
              active
                ? "bg-primary/10 border-primary/40 text-primary"
                : "bg-card border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  </div>
);

// ── Right-rail section navigator (lg+ only) ──────────────────────────────────

const SECTION_NAV_ITEMS: { key: string; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "memoryHooks", label: "Memory Hooks" },
  { key: "clinicalApproach", label: "Clinical Approach" },
  { key: "keyPoints", label: "Key Points" },
  { key: "examTraps", label: "Exam Traps" },
  { key: "flashcards", label: "Flashcards" },
  { key: "referenceNote", label: "Reference Note" },
];

/** A section is worth listing only if it actually has content in the sheet. */
function sectionHasContent(sheet: GeneratedSheet, key: string): boolean {
  const v = (sheet as Record<string, unknown>)[key];
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim().length > 0;
  return false;
}

/**
 * Sticky right-rail navigator. Lists the sheet's non-empty sections, smooth-
 * scrolls to a section on click, and highlights the section the reader is on
 * via an IntersectionObserver watching each `[data-section-key]` card.
 */
const SheetSectionNav = ({ sheet }: { sheet: GeneratedSheet }) => {
  const items = SECTION_NAV_ITEMS.filter((it) => sectionHasContent(sheet, it.key));
  const [activeKey, setActiveKey] = useState<string>(items[0]?.key ?? "");

  useEffect(() => {
    const els = SECTION_NAV_ITEMS.map((it) =>
      document.querySelector<HTMLElement>(`[data-section-key="${it.key}"]`)
    ).filter((el): el is HTMLElement => !!el);
    if (!els.length) return;

    // A thin band near the top of the viewport acts as the "you are here" line;
    // whichever section card crosses it (topmost, if several) becomes active.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (!visible.length) return;
        const topmost = visible.reduce((a, b) =>
          a.boundingClientRect.top < b.boundingClientRect.top ? a : b
        );
        const key = topmost.target.getAttribute("data-section-key");
        if (key) setActiveKey(key);
      },
      { rootMargin: "-12% 0px -78% 0px", threshold: 0 }
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sheet]);

  const scrollToSection = (key: string) => {
    document
      .querySelector(`[data-section-key="${key}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (!items.length) return null;

  return (
    <div className="space-y-2">
      <p className="px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        On this sheet
      </p>
      <nav className="flex flex-col">
        {items.map((it) => {
          const active = activeKey === it.key;
          return (
            <button
              key={it.key}
              type="button"
              onClick={() => scrollToSection(it.key)}
              aria-current={active ? "true" : undefined}
              className={`border-l-2 py-1.5 pl-3 text-left text-[13px] leading-tight transition-colors ${
                active
                  ? "border-l-primary font-medium text-primary"
                  : "border-l-border/40 text-muted-foreground hover:text-foreground"
              }`}
            >
              {it.label}
            </button>
          );
        })}
      </nav>
      {/* TODO(Phase 1+): "Saved highlights" subsection — list collapsed
          enhancements with their kind icon, click to jump to the gold mark. */}
    </div>
  );
};

// ── Empty state ──────────────────────────────────────────────────────────────

const QUICKSTART_TOPICS = ["Heart Failure", "Pneumonia", "Diabetic Ketoacidosis"];

const QuickstartChips = ({ onStartTopic }: { onStartTopic: (label: string) => void }) => (
  <div className="flex flex-wrap justify-center gap-2">
    {QUICKSTART_TOPICS.map((label) => (
      <button
        key={label}
        type="button"
        onClick={() => onStartTopic(label)}
        className="cursor-pointer rounded-md border border-border bg-transparent px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
      >
        {label}
      </button>
    ))}
  </div>
);

interface SheetsEmptyStateProps {
  onStartTopic: (label: string) => void;
  onSelectHistory: (item: StudyHistoryItem) => void;
}

/**
 * First-visit empty state. New users see the topic-picker CTA. Returning users
 * with saved sheets see those sheets up front (continue studying) plus a lighter
 * "start fresh" path, so we surface their library instead of only pushing a new
 * generation.
 */
const SheetsEmptyState = ({ onStartTopic, onSelectHistory }: SheetsEmptyStateProps) => {
  const { history, isLoading } = useStudyHistory();

  // While history loads, show skeleton cards only (no separator/chips) so the
  // layout doesn't jump once we know whether there's any history to show.
  if (isLoading) {
    return (
      <div className="animate-fade-in space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Continue studying
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[92px] animate-pulse rounded-xl border border-border bg-muted/40"
            />
          ))}
        </div>
      </div>
    );
  }

  // New users (no history): the original topic-picker empty state.
  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-5 rounded-xl border border-dashed border-border px-6 py-20 text-center animate-fade-in">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <Stethoscope className="h-6 w-6 text-primary" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            Pick a topic to generate your study sheet
          </p>
          <p className="text-xs text-muted-foreground">
            Your sheet will build here, section by section.
          </p>
        </div>
        <QuickstartChips onStartTopic={onStartTopic} />
      </div>
    );
  }

  // Returning users: recent sheets first, then a lighter "start fresh" path.
  const recent = history.slice(0, 4);
  return (
    <div className="animate-fade-in space-y-6">
      <div className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Continue studying
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {recent.map((item) => {
            const chips = [item.modeInfo?.examMode, item.modeInfo?.difficulty]
              .filter(Boolean)
              .join(" · ");
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectHistory(item)}
                className="group flex cursor-pointer flex-col gap-1.5 rounded-xl border border-border bg-card p-4 text-left transition-all hover:border-foreground/20 hover:shadow-sm motion-safe:hover:-translate-y-0.5"
              >
                <p className="truncate text-sm font-medium text-foreground">{item.topic}</p>
                {chips && <p className="truncate text-[11px] text-muted-foreground">{chips}</p>}
                <p className="mt-auto pt-1 text-[11px] text-muted-foreground/70">
                  {timeAgo(item.timestamp)}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          or start fresh
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <QuickstartChips onStartTopic={onStartTopic} />
    </div>
  );
};

const SheetGenerator = ({ prefill }: SheetGeneratorProps) => {
  const [notes, setNotes] = useState(prefill?.input ?? "");
  const [difficulty, setDifficulty] = useState(prefill?.modeInfo?.difficulty ?? "Basic");
  const [focus, setFocus] = useState(prefill?.modeInfo?.focus ?? "Quick Revision");
  const [length, setLength] = useState(prefill?.modeInfo?.length ?? "Concise");
  const [examMode, setExamMode] = useState(prefill?.modeInfo?.examMode ?? "General");
  const [sheet, setSheet] = useState<GeneratedSheet | null>(
    prefill?.output ? parseStoredSheet(prefill.output) : null
  );
  // Legacy fallback: if the prefill is an old text blob, keep it as a
  // plain string for the OutputSection legacy renderer
  const [legacyOutput, setLegacyOutput] = useState<string>(
    prefill?.output && !isJsonSheet(prefill.output) ? prefill.output : ""
  );
  const [modelUsed, setModelUsed] = useState<"flash" | "gpt-oss" | "claude" | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [deckSaved, setDeckSaved] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [pendingOutput, setPendingOutput] = useState<string | null>(null);
  const [showTextarea, setShowTextarea] = useState(false);
  const [citationState, setCitationState] = useState<CitationState>("idle");
  const [citations, setCitations] = useState<CitationResult[]>([]);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [goProOpen, setGoProOpen] = useState(false);
  // Tablet (768–1023px) slide-out configurator drawer
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);
  const [recentTopics, setRecentTopics] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(RECENT_TOPICS_KEY) ?? "[]");
      return Array.isArray(stored) ? stored.slice(0, 5) : [];
    } catch {
      return [];
    }
  });
  const outputRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const recordRecentTopic = (topic: string) => {
    const trimmed = topic.trim().slice(0, 60);
    if (!trimmed) return;
    setRecentTopics((prev) => {
      const next = [
        trimmed,
        ...prev.filter((t) => t.toLowerCase() !== trimmed.toLowerCase()),
      ].slice(0, 5);
      try {
        localStorage.setItem(RECENT_TOPICS_KEY, JSON.stringify(next));
      } catch {
        // quota exceeded — recents are a convenience only
      }
      return next;
    });
  };

  const { sheetCount, isSheetLimited, isProUser: pro, refresh: refreshUsage } = useUsageLimit();
  const { premiumRemaining, isPremiumHookActive } = usePremiumHook();
  const { preferredModel, setPreferredModel, saving: modelSaving } = useModelPreference();
  const { user, isAnonymous } = useAuth();
  const {
    canUseCitation,
    isLoggedIn,
    incrementCitation,
  } = useCitationUsage();
  const { saveCards } = useFlashcardDeck();

  const generate = async (overrideNotes?: string) => {
    const activeNotes = overrideNotes ?? notes;
    if (!activeNotes.trim()) {
      toast({ title: "Please enter medical notes", variant: "destructive" });
      return;
    }
    if (isSheetLimited) {
      setGoProOpen(true);
      return;
    }
    recordRecentTopic(activeNotes);
    setLoading(true);
    setSheet(null);
    setLegacyOutput("");
    setDeckSaved(false);
    setPendingOutput(null);
    setShowTextarea(false);
    setCitationState("idle");
    setCitations([]);

    setTimeout(() => {
      outputRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);

    try {
      const response = await callMedicalNotes({
        notes: activeNotes,
        difficulty,
        focus,
        length,
        examMode,
        userId: user?.id ?? null,
        isAnonymous: isAnonymous ?? false,
        isPro: pro,
        preferredModel: pro ? preferredModel : undefined,
      });

      const xModel = response.headers.get("X-Model-Used") ?? "";
      const resolvedModel = xModel.includes("gpt-oss")
        ? "gpt-oss"
        : xModel.includes("claude-haiku")
        ? "claude"
        : "flash";
      setModelUsed(resolvedModel);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        if (response.status === 429) {
          throw new Error("You've reached today's free limit. It resets at midnight UTC.");
        }
        throw new Error(err.error || `Error: ${response.status}`);
      }

      // Usage was incremented server-side; refresh the displayed count.
      refreshUsage();

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let textBuffer = "";
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        textBuffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = textBuffer.indexOf("\n")) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);

          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              fullText += content;
            }
          } catch {
            textBuffer = line + "\n" + textBuffer;
            break;
          }
        }
      }

      const rawText = fullText || "";
      setPendingOutput(rawText);

      // Citation lookup — runs after stream completes
      try {
        if (canUseCitation) {
          setCitationState("loading");
          const results = await fetchBestCitation(activeNotes);
          setCitations(results);
          setCitationState(results.length > 0 ? "found" : "hidden");
          if (results.length > 0) {
            try {
              await incrementCitation();
            } catch {
              // ignore — citation already shown
            }
          }
        } else if (isLoggedIn) {
          setCitationState("locked");
        } else {
          setCitationState("hidden");
        }
      } catch {
        setCitationState("hidden");
      }
    } catch (e: any) {
      setLoading(false);
      setLoadingMsg("");
      setPendingOutput(null);
      toast({
        title: "Error",
        description: e.message || "Failed to generate study material",
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    if (loading) {
      startTopProgress();
      return () => finishTopProgress();
    }
  }, [loading]);

  useEffect(() => {
    function handleEnhancementSaved(e: Event) {
      const { key, result } = (e as CustomEvent).detail ?? {};
      if (!key || !result) return;
      setSheet((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          enhancements: { ...(prev.enhancements ?? {}), [key]: result },
        };
      });
    }
    window.addEventListener("studybuddy:enhancement-saved", handleEnhancementSaved);
    return () =>
      window.removeEventListener("studybuddy:enhancement-saved", handleEnhancementSaved);
  }, []);

  useEffect(() => {
    if (!loading) return;

    const steps = [
      "Reading topic…",
      "Structuring notes…",
      "Finding exam traps…",
      "Adding memory hooks…",
      "Finalizing your sheet…",
    ];

    let currentStep = 0;
    let allStepsDone = false;
    setLoadingMsg(steps[0]);

    const interval = setInterval(() => {
      currentStep += 1;

      if (currentStep < steps.length) {
        setLoadingMsg(steps[currentStep]);
      } else {
        allStepsDone = true;
        setLoadingMsg(steps[steps.length - 1]);
      }

      if (allStepsDone) {
        setPendingOutput((pending) => {
          if (pending !== null) {
            clearInterval(interval);
            const cleaned = sanitizeJsonOutput(pending);
            try {
              const parsed = JSON.parse(cleaned) as GeneratedSheet;
              setSheet(parsed);
              setLegacyOutput("");
            } catch {
              // JSON parse failed — fall back to legacy text renderer
              setSheet(null);
              setLegacyOutput(pending);
            }
            setLoading(false);
            setLoadingMsg("");
            return null;
          }
          return pending;
        });
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGenerate = () => {
    setDeckSaved(false);
    setConfigDrawerOpen(false);
    generate();
  };

  const startTopic = (label: string) => {
    setNotes(label);
    setShowTextarea(false);
    setDeckSaved(false);
    setConfigDrawerOpen(false);
    generate(label);
  };

  // Load a saved sheet straight from history (no regeneration) — mirrors how the
  // `prefill` prop hydrates the generator on mount.
  const loadHistoryItem = (item: StudyHistoryItem) => {
    if (item.modeInfo) {
      setExamMode(item.modeInfo.examMode || "General");
      setDifficulty(item.modeInfo.difficulty || "Basic");
      setFocus(item.modeInfo.focus || "Quick Revision");
      setLength(item.modeInfo.length || "Concise");
    }
    setNotes(item.input);
    setShowTextarea(false);
    setConfigDrawerOpen(false);
    setDeckSaved(false);
    setModelUsed(undefined);
    setCitationState("idle");
    setCitations([]);
    if (isJsonSheet(item.output)) {
      setSheet(parseStoredSheet(item.output));
      setLegacyOutput("");
    } else {
      setSheet(null);
      setLegacyOutput(item.output);
    }
    setTimeout(() => {
      outputRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  };

  const configurator = (
      <Card className="glass-card animate-fade-in rounded-xl">
        <CardContent className="px-4 py-5 space-y-4">
          {!isLoggedIn && (
            <CitationCTABanner onSignInClick={() => setAuthModalOpen(true)} />
          )}
          <div className="space-y-1.5">
            <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Medical Notes
            </label>
            {!showTextarea ? (
              <div className="rounded-lg border border-border bg-background p-3 space-y-2.5">
                <p className="text-xs font-medium text-muted-foreground">
                  Pick a topic to start — or type your own
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { emoji: "❤️", label: "Heart Failure" },
                    { emoji: "🫁", label: "Pneumonia" },
                    { emoji: "🧠", label: "Ischemic Stroke" },
                    { emoji: "🍬", label: "Diabetic Ketoacidosis" },
                    { emoji: "🫘", label: "Nephrotic Syndrome" },
                  ].map(({ emoji, label }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => startTopic(label)}
                      className="inline-flex h-7 items-center gap-1.5 px-2.5 rounded-md text-xs font-medium border border-border bg-card text-foreground/80 hover:border-primary/50 hover:text-primary transition-colors cursor-pointer"
                    >
                      <span aria-hidden>{emoji}</span>
                      <span>{label}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setShowTextarea(true)}
                    className="inline-flex h-7 items-center gap-1.5 px-2.5 rounded-md text-xs font-medium border border-dashed border-border bg-transparent text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors cursor-pointer"
                  >
                    <PenLine className="h-3.5 w-3.5" />
                    Type my own topic
                  </button>
                </div>
              </div>
            ) : (
              <div className="relative">
                <Textarea
                  autoFocus
                  placeholder="Paste notes, type a topic, or say what you want to study…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="min-h-[100px] resize-y text-sm leading-relaxed"
                />
                {notes && (
                  <button
                    type="button"
                    onClick={() => { setNotes(""); setShowTextarea(false); }}
                    className="absolute top-2 right-2 text-muted-foreground/50 hover:text-muted-foreground transition-colors text-lg leading-none"
                    aria-label="Clear"
                  >
                    ×
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <PillGroup
              label="Exam Mode"
              value={examMode}
              onChange={setExamMode}
              options={[
                { value: "General", label: "General" },
                { value: "USMLE Step 1", label: "Step 1" },
                { value: "USMLE Step 2", label: "Step 2" },
              ]}
            />
            <PillGroup
              label="Difficulty"
              value={difficulty}
              onChange={setDifficulty}
              options={[
                { value: "Basic", label: "Basic" },
                { value: "Medium", label: "Medium" },
                { value: "Advanced", label: "Advanced" },
              ]}
            />
            <PillGroup
              label="Focus"
              value={focus}
              onChange={setFocus}
              options={[
                { value: "Quick Revision", label: "Quick Revision" },
                { value: "Deep Understanding", label: "Deep Understanding" },
                { value: "Clinical Reasoning", label: "Clinical Reasoning" },
              ]}
            />
            <PillGroup
              label="Length"
              value={length}
              onChange={setLength}
              options={[
                { value: "Concise", label: "Concise" },
                { value: "Moderate", label: "Moderate" },
                { value: "Detailed", label: "Detailed" },
              ]}
            />
          </div>

          {pro && (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              <p className="text-sm font-medium text-foreground">
                Unlimited access active
              </p>
            </div>
          )}

          {!pro && (
            <div className="text-center text-xs text-muted-foreground space-y-1">
              {isSheetLimited ? (
                <span className="text-amber-500 dark:text-amber-400 font-medium block">
                  Daily limit reached ·{" "}
                  <button
                    type="button"
                    className="underline hover:text-amber-400 transition-colors"
                    onClick={() => setGoProOpen(true)}
                  >
                    Go Pro for Claude + unlimited
                  </button>
                </span>
              ) : (
                <span>{sheetCount} / {MAX_DAILY_SHEETS} uses today · Resets at midnight</span>
              )}
              {isPremiumHookActive ? (
                <span className="text-violet-400 font-medium block">
                  ✦ {premiumRemaining} Claude generation{premiumRemaining !== 1 ? "s" : ""} left ·{" "}
                  <button
                    type="button"
                    className="underline hover:text-violet-300 transition-colors"
                    onClick={() => setGoProOpen(true)}
                  >
                    Go Pro for unlimited Claude
                  </button>
                </span>
              ) : !isSheetLimited ? (
                <span className="text-muted-foreground/60 block">
                  Powered by GPT-OSS 20B
                </span>
              ) : null}
            </div>
          )}
          {pro && (
            <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground text-center">
                AI Model
              </p>
              <div className="flex items-center justify-center">
                <div className="inline-flex items-center rounded-lg bg-muted p-0.5">
                  <button
                    type="button"
                    onClick={() => setPreferredModel("gpt-oss")}
                    disabled={modelSaving}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      preferredModel !== "claude"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    GPT-OSS 20B
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreferredModel("claude")}
                    disabled={modelSaving}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      preferredModel === "claude"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Claude Haiku 4.5
                  </button>
                </div>
              </div>
              {modelSaving && (
                <p className="text-[11px] text-muted-foreground/50 text-center">Saving preference…</p>
              )}
            </div>
          )}

          <Button
            className="w-full h-10 text-sm font-medium rounded-lg"
            onClick={handleGenerate}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Generate Study Material
              </>
            )}
          </Button>

          {recentTopics.length > 0 && (
            <div className="space-y-1.5 pt-1 border-t border-border">
              <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground pt-2.5">
                <History className="h-3 w-3" />
                Recent
              </p>
              <div className="flex flex-wrap gap-1.5 max-h-16 overflow-y-auto">
                {recentTopics.map((topic) => (
                  <button
                    key={topic}
                    type="button"
                    disabled={loading}
                    onClick={() => startTopic(topic)}
                    className="max-w-full truncate px-2.5 py-1 rounded-md text-xs font-medium border border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
                  >
                    {topic}
                  </button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
  );

  return (
    <>
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-0 lg:items-start">
      {/* ── Left pane: configurator (35% on desktop, drawer on tablet) ── */}
      <div className="min-w-0 md:max-lg:hidden lg:sticky lg:top-6 lg:self-start lg:w-[35%] lg:min-w-[320px] lg:max-w-[480px] lg:shrink-0 lg:pr-5">
        {configurator}
      </div>

      {/* ── 1px divider between config and document ── */}
      <div aria-hidden className="hidden lg:block lg:w-px lg:shrink-0 lg:self-stretch bg-border" />

      {/* ── Middle pane: living document (fluid, fills its lane) ── */}
      <div ref={outputRef} className="min-w-0 lg:flex-1 lg:px-8">
      <div className="w-full space-y-6">
      {loading && !sheet && !legacyOutput && (
        <div className="space-y-6 animate-fade-in">
          <div className="flex items-center gap-2.5 px-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <p className="text-sm font-medium text-foreground transition-all duration-300">
              {loadingMsg}
            </p>
            <p className="text-xs text-muted-foreground/50">
              Takes a little longer during peak hours — hang tight
            </p>
          </div>
          {/* Document structure forming — skeletons mirror the incoming sections */}
          <div className="space-y-6">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="section-reveal"
                style={{ animationDelay: `${i * 150}ms` }}
              >
                <SectionSkeleton variant="sheet-section" />
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && !sheet && !legacyOutput && (
        <SheetsEmptyState onStartTopic={startTopic} onSelectHistory={loadHistoryItem} />
      )}

      {(sheet || legacyOutput) && (
        <OutputSection
          output={sheet ? JSON.stringify(sheet) : legacyOutput}
          inputText={notes}
          modeInfo={{ examMode, difficulty, focus, length }}
          citations={citations}
          citationState={citationState}
          modelUsed={modelUsed}
          isPro={pro}
          userId={user?.id ?? null}
          isAnonymous={isAnonymous ?? false}
          sheetId={notes}
          onCitationLockedClick={() =>
            isLoggedIn ? setGoProOpen(true) : setAuthModalOpen(true)
          }
          citationIsLoggedIn={isLoggedIn}
        />
      )}

      {(sheet || legacyOutput) && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            className="h-9 rounded-lg font-medium text-sm px-5"
            disabled={deckSaved}
            onClick={() => {
              try {
                if (sheet?.flashcards?.length) {
                  const parsed = sheet.flashcards.map((c) => ({
                    question: c.question,
                    answer: c.answer,
                    tag: c.tag,
                    topic: notes.trim().slice(0, 60),
                    topicEmoji: sheet.topicEmoji,
                  }));
                  saveCards(parsed);
                  setDeckSaved(true);
                  toast({ title: `${parsed.length} cards saved to your library` });
                } else if (legacyOutput) {
                  // Legacy fallback for old text-blob sheets
                  const parsed = parseFlashcardsFromOutput(legacyOutput, notes);
                  if (parsed.length) {
                    saveCards(parsed);
                    setDeckSaved(true);
                    toast({ title: `${parsed.length} cards saved to your library` });
                  } else {
                    toast({ title: "No flashcards found in this sheet", variant: "destructive" });
                  }
                } else {
                  toast({ title: "No flashcards found in this sheet", variant: "destructive" });
                }
              } catch {
                toast({ title: "Could not parse flashcards", variant: "destructive" });
              }
            }}
          >
            {deckSaved ? "✓ Deck saved" : "＋ Save deck to library"}
          </Button>
        </div>
      )}
      </div>
      </div>{/* end middle pane */}

      {/* ── Right pane: section navigator. Only at 2xl+ (≥1536px), where the
          content area is wide enough that a third column doesn't squeeze the
          document — below that we stay 2-column (config + fluid document). ── */}
      {sheet && (
        <>
          <div aria-hidden className="hidden 2xl:block 2xl:w-px 2xl:shrink-0 2xl:self-stretch bg-border" />
          <div className="hidden 2xl:block 2xl:w-[240px] 2xl:shrink-0 2xl:sticky 2xl:top-6 2xl:self-start 2xl:pl-6">
            <SheetSectionNav key={sheet.topic ?? "sheet"} sheet={sheet} />
          </div>
        </>
      )}
    </div>

    {/* ── Tablet-only (768–1023px): floating configure button ── */}
    <button
      type="button"
      onClick={() => setConfigDrawerOpen(true)}
      className="hidden md:max-lg:inline-flex fixed bottom-4 left-4 z-40 h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors"
    >
      <Settings2 className="h-3.5 w-3.5" />
      Configure
    </button>

    {/* ── Tablet-only: slide-out configurator drawer ── */}
    <div
      className={`hidden md:max-lg:block fixed inset-0 z-50 ${
        configDrawerOpen ? "" : "pointer-events-none"
      }`}
      aria-hidden={!configDrawerOpen}
    >
      <div
        className={`absolute inset-0 bg-black/50 motion-safe:transition-opacity motion-safe:duration-200 ${
          configDrawerOpen ? "opacity-100" : "opacity-0"
        }`}
        onClick={() => setConfigDrawerOpen(false)}
      />
      <div
        className={`absolute inset-y-0 left-0 w-[320px] overflow-y-auto bg-background border-r border-border p-4 motion-safe:transition-transform motion-safe:duration-[250ms] motion-safe:ease-out ${
          configDrawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between pb-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Configure
          </span>
          <button
            type="button"
            onClick={() => setConfigDrawerOpen(false)}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close configurator"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {configurator}
      </div>
    </div>

    <AuthModal open={authModalOpen} onOpenChange={setAuthModalOpen} />
    <GoProModal open={goProOpen} onOpenChange={setGoProOpen} />
    </>
  );
};

export default SheetGenerator;
