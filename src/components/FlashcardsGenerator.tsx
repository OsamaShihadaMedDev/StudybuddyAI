import { useState, useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { History, Loader2, Layers, PenLine } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useFlashcardDeck } from "@/hooks/use-flashcard-deck";
import { useUsageLimit, MAX_DAILY_CARDS } from "@/hooks/use-usage-limit";
import { useCitationUsage } from "@/hooks/use-citation-usage";
import { usePremiumHook } from "@/hooks/use-premium-hook";
import { useModelPreference } from "@/hooks/use-model-preference";
import { useAuth } from "@/hooks/use-auth";
import { callMedicalNotes } from "@/lib/callMedicalNotes";
import { parseFlashcardsFromOutput } from "@/lib/parse-flashcards";
import { fetchBestCitation, type CitationResult } from "@/lib/citation";
import { saveCitationsForTopic } from "@/lib/citation-store";
import CitationCTABanner from "@/components/CitationCTABanner";
import CitationBadgeList from "@/components/CitationBadgeList";
import GoProModal from "@/components/GoProModal";
import AuthModal from "@/components/AuthModal";
import { startTopProgress, finishTopProgress } from "@/components/TopProgressBar";

type CitationState = "idle" | "loading" | "found" | "locked" | "hidden";

export type GeneratedCard = ReturnType<typeof parseFlashcardsFromOutput>[number];

interface FlashcardsGeneratorProps {
  /** Notifies the page when generation starts/stops so the right pane can show skeletons. */
  onGeneratingChange?: (generating: boolean, topic: string) => void;
  /** Called with the freshly saved cards once generation completes. */
  onGenerated?: (cards: GeneratedCard[], topic: string) => void;
}

const RECENT_FLASHCARD_TOPICS_KEY = "sb_recent_flashcard_topics_v1";

const FlashcardsGenerator = ({ onGeneratingChange, onGenerated }: FlashcardsGeneratorProps) => {
  const [topic, setTopic] = useState("");
  const [cardCount, setCardCount] = useState("12");
  const [examMode, setExamMode] = useState("General");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [pendingCards, setPendingCards] = useState<ReturnType<typeof parseFlashcardsFromOutput> | null>(null);
  const [showTextarea, setShowTextarea] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [citationState, setCitationState] = useState<CitationState>("idle");
  const [citations, setCitations] = useState<CitationResult[]>([]);
  const [goProOpen, setGoProOpen] = useState(false);
  const [recentTopics, setRecentTopics] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(RECENT_FLASHCARD_TOPICS_KEY) ?? "[]");
      return Array.isArray(stored) ? stored.slice(0, 5) : [];
    } catch {
      return [];
    }
  });

  const activeTopicRef = useRef("");
  const { toast } = useToast();
  const { saveCards } = useFlashcardDeck();
  const {
    cardsCount,
    isCardsLimited,
    isProUser: pro,
    refresh: refreshUsage,
  } = useUsageLimit();
  const { premiumRemaining, isPremiumHookActive } = usePremiumHook();
  const { preferredModel, setPreferredModel, saving: modelSaving } = useModelPreference();
  const { user, isAnonymous } = useAuth();
  const {
    canUseCitation,
    isLoggedIn,
    incrementCitation,
  } = useCitationUsage();
  const remaining = Math.max(0, MAX_DAILY_CARDS - cardsCount);

  const recordRecentTopic = (t: string) => {
    const trimmed = t.trim().slice(0, 60);
    if (!trimmed) return;
    setRecentTopics((prev) => {
      const next = [
        trimmed,
        ...prev.filter((x) => x.toLowerCase() !== trimmed.toLowerCase()),
      ].slice(0, 5);
      try {
        localStorage.setItem(RECENT_FLASHCARD_TOPICS_KEY, JSON.stringify(next));
      } catch {
        // quota exceeded — recents are a convenience only
      }
      return next;
    });
  };

  const setGenerating = (generating: boolean, t: string) => {
    setLoading(generating);
    onGeneratingChange?.(generating, t);
  };

  const handleGenerate = async (overrideTopic?: string, overrideCardCount?: number) => {
    const activeTopic = overrideTopic ?? topic;
    const activeCardCount = overrideCardCount ?? parseInt(cardCount, 10);
    if (!activeTopic.trim()) {
      toast({ title: "Please enter a topic", variant: "destructive" });
      return;
    }
    if (isCardsLimited) {
      setGoProOpen(true);
      return;
    }
    recordRecentTopic(activeTopic);
    activeTopicRef.current = activeTopic;
    setGenerating(true, activeTopic);
    setCitationState("idle");
    setCitations([]);
    try {
      const response = await callMedicalNotes({
        notes: activeTopic,
        examMode,
        difficulty: "Basic",
        focus: "Quick Revision",
        length: "Concise",
        cardsOnly: true,
        cardCount: activeCardCount,
        userId: user?.id ?? null,
        isAnonymous: isAnonymous ?? false,
        isPro: pro,
        preferredModel: pro ? preferredModel : undefined,
      });

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
            if (content) fullText += content;
          } catch {
            textBuffer = line + "\n" + textBuffer;
            break;
          }
        }
      }

      const parsed = parseFlashcardsFromOutput(fullText, activeTopic);
      setPendingCards(parsed);

      // Citation lookup — runs after cards are saved
      try {
        if (canUseCitation) {
          setCitationState("loading");
          const results = await fetchBestCitation(activeTopic);
          setCitations(results);
          setCitationState(results.length > 0 ? "found" : "hidden");
          if (results.length > 0) {
            saveCitationsForTopic(activeTopic, results);
            try {
              await incrementCitation();
            } catch {
              // ignore — citation already stored
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
      setGenerating(false, "");
      setLoadingMsg("");
      setPendingCards(null);
      toast({
        title: "Error",
        description: e.message || "Failed to generate flashcards",
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
    if (!loading) return;

    const steps = [
      "Identifying key concepts…",
      "Building Q&A pairs…",
      "Calibrating difficulty…",
      "Adding clinical vignettes…",
      "Finalizing your deck…",
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
        setPendingCards((pending) => {
          if (pending !== null) {
            clearInterval(interval);
            (async () => {
              const added = await saveCards(pending);
              localStorage.setItem("sb_first_deck_seen", "1");
              toast({
                title: added > 0 ? `Added ${added} new cards to your deck` : "No new cards (all duplicates)",
              });
              setTopic("");
              setShowTextarea(false);
              setGenerating(false, "");
              setLoadingMsg("");
              window.dispatchEvent(new CustomEvent("studybuddy:deck-saved"));
              onGenerated?.(pending, activeTopicRef.current);
            })();
            return null;
          }
          return pending;
        });
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ topic: string; cardCount?: number }>).detail;
      if (!detail?.topic) return;
      setTopic(detail.topic);
      setShowTextarea(true);
      setCardCount(String(detail.cardCount ?? 5));
      handleGenerate(detail.topic, detail.cardCount ?? 5);
    };
    window.addEventListener("studybuddy:generate-flashcards", handler);
    return () => window.removeEventListener("studybuddy:generate-flashcards", handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card className="glass-card animate-fade-in rounded-xl">
      <CardContent className="px-4 py-5 space-y-4">
        {!isLoggedIn && (
          <CitationCTABanner onSignInClick={() => setAuthModalOpen(true)} />
        )}

        <div className="space-y-1.5">
          <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Topic
          </label>
          {!showTextarea ? (
            <div className="rounded-lg border border-border bg-background p-3 space-y-2.5">
              <p className="text-xs font-medium text-muted-foreground">
                Pick a topic to start — or type your own
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  "Myocardial Infarction",
                  "Pneumonia",
                  "Ischemic Stroke",
                  "Diabetic Ketoacidosis",
                  "Nephrotic Syndrome",
                ].map((label) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => {
                      setTopic(label);
                      setShowTextarea(false);
                      handleGenerate(label);
                    }}
                    className="inline-flex h-7 items-center px-2.5 rounded-md text-xs font-medium border border-border bg-card text-foreground/80 hover:border-primary/50 hover:text-primary transition-colors cursor-pointer"
                  >
                    {label}
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
                placeholder="Enter a topic to drill (e.g., 'DKA', 'Heart failure pharmacology')"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                className="min-h-[80px] resize-y text-sm leading-relaxed"
              />
              {topic && (
                <button
                  type="button"
                  onClick={() => { setTopic(""); setShowTextarea(false); }}
                  className="absolute top-2 right-2 text-muted-foreground/50 hover:text-muted-foreground transition-colors text-lg leading-none"
                  aria-label="Clear"
                >
                  ×
                </button>
              )}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Exam Mode
          </label>
          <div className="flex flex-wrap gap-1.5">
            {[
              { value: "General", label: "General" },
              { value: "USMLE Step 1", label: "Step 1" },
              { value: "USMLE Step 2", label: "Step 2" },
            ].map((opt) => {
              const active = examMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setExamMode(opt.value)}
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

        <div className="space-y-1">
          <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Number of cards
          </label>
          <Select value={cardCount} onValueChange={setCardCount}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5">5 cards</SelectItem>
              <SelectItem value="10">10 cards</SelectItem>
              <SelectItem value="12">12 cards</SelectItem>
              <SelectItem value="15">15 cards</SelectItem>
              <SelectItem value="20">20 cards</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button
          className="w-full h-10 text-sm font-medium rounded-lg"
          onClick={() => handleGenerate()}
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Layers className="mr-2 h-4 w-4" />
              Generate Cards
            </>
          )}
        </Button>

        {!pro && (
          <div className="text-center text-xs text-muted-foreground space-y-1">
            {isCardsLimited ? (
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
              <span className="block">{remaining} / {MAX_DAILY_CARDS} cards generations today · Resets at midnight</span>
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
            ) : !isCardsLimited ? (
              <span className="text-muted-foreground/60 block">Powered by GPT-OSS 20B</span>
            ) : null}
          </div>
        )}
        {pro && (
          <div className="text-center text-xs text-muted-foreground">
            <span className="text-primary font-medium">
              ✦ Powered by {preferredModel === "claude" ? "Claude Haiku 4.5" : "GPT-OSS 20B"}
            </span>
            <span className="mx-2 opacity-40">·</span>
            <button
              type="button"
              className="underline hover:text-foreground transition-colors"
              onClick={() => setPreferredModel(preferredModel === "claude" ? "gpt-oss" : "claude")}
              disabled={modelSaving}
            >
              Switch to {preferredModel === "claude" ? "GPT-OSS 20B" : "Claude Haiku 4.5"}
            </button>
          </div>
        )}

        {recentTopics.length > 0 && (
          <div className="space-y-1.5 pt-1 border-t border-border">
            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground pt-2.5">
              <History className="h-3 w-3" />
              Recent
            </p>
            <div className="flex flex-wrap gap-1.5 max-h-16 overflow-y-auto">
              {recentTopics.map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setTopic(t);
                    setShowTextarea(false);
                    handleGenerate(t);
                  }}
                  className="max-w-full truncate inline-flex h-7 items-center px-2.5 rounded-md text-xs font-medium border border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {citationState !== "idle" && citationState !== "hidden" && (
          <div className="pt-1">
            <CitationBadgeList
              state={citationState}
              citations={citations}
              onLockedClick={() =>
                isLoggedIn ? setGoProOpen(true) : setAuthModalOpen(true)
              }
              isLoggedIn={isLoggedIn}
            />
          </div>
        )}
      </CardContent>
      <AuthModal open={authModalOpen} onOpenChange={setAuthModalOpen} />
      <GoProModal open={goProOpen} onOpenChange={setGoProOpen} />
    </Card>
  );
};

export default FlashcardsGenerator;
