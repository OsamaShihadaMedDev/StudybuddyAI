import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FlaskConical, CheckCircle, XCircle, Clock, RotateCcw, ChevronRight, Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import DashboardLayout from "@/components/dashboard/DashboardLayout";
import PageLoader from "@/components/PageLoader";
import { useQBankContext } from "@/contexts/QBankContext";
import { supabase } from "@/integrations/supabase/client";
import type { Question, QuestionMedia, SessionAnswer } from "@/hooks/use-qbank";

interface SummaryData {
  questions: Question[];
  answers: SessionAnswer[];
  totalTime: number;
  score: number;
  total: number;
  flaggedIds: string[];
}

// Raw shapes returned by the get_session_review RPC (before mapping to app types).
interface ReviewMedia {
  file_url: string;
  media_type: string;
  caption: string | null;
  attribution: string | null;
  license: string;
  display_context: string;
  display_order: number;
}

interface ReviewQuestion {
  id: string;
  subject: string;
  domain: string;
  topic: string;
  difficulty: string;
  competency: string;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  option_e: string;
  correct_option: string;
  explanation: string;
  teaching_point: string;
  media: ReviewMedia[] | null;
}

const ScoreRing = ({ score, total }: { score: number; total: number }) => {
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  const color = pct >= 80 ? "#059669" : pct >= 60 ? "#d97706" : "#dc2626";

  return (
    <div className="relative flex items-center justify-center w-36 h-36">
      <svg width="144" height="144" viewBox="0 0 144 144" className="-rotate-90">
        <circle cx="72" cy="72" r={radius} fill="none" stroke="hsl(var(--border))" strokeWidth="10" />
        <circle cx="72" cy="72" r={radius} fill="none" stroke={color} strokeWidth="10"
          strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.8s ease-out" }} />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-3xl font-semibold tabular-nums tracking-tight" style={{ color }}>{pct}%</span>
        <span className="text-xs text-muted-foreground font-medium">{score} / {total}</span>
      </div>
    </div>
  );
};

const formatTime = (ms: number): string => {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
};

const performanceLabel = (pct: number): { text: string; color: string } => {
  if (pct >= 80) return { text: "Strong performance", color: "#059669" };
  if (pct >= 60) return { text: "Good effort", color: "#d97706" };
  if (pct >= 40) return { text: "Keep practicing", color: "#ea580c" };
  return { text: "Review the material", color: "#dc2626" };
};

const QBankSummary = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session");

  const { lastSummary, startSession, enterSummaryReview, setReviewIndex, loadSummary } = useQBankContext();

  const [summaryData, setSummaryData] = useState<SummaryData | null>(null);
  const [summaryFlaggedIds, setSummaryFlaggedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      if (sessionId) {
        try {
          // Answer fields are REVOKE'd from direct table selects; the owner-only
          // RPC returns the graded questions + attempts for this session.
          const { data, error } = await supabase.rpc("get_session_review", {
            p_session: sessionId,
          });

          if (!error && data) {
            const review = data as {
              session: {
                score: number;
                total: number;
                total_time_ms: number;
                started_at: string;
                ended_at: string;
              };
              attempts: Array<{
                question_id: string;
                selected_option: string;
                is_correct: boolean;
                time_taken_ms: number | null;
                question: ReviewQuestion | null;
              }>;
              flagged: string[];
            };

            const questions: Question[] = review.attempts
              .map((a) => {
                const q = a.question;
                if (!q) return null;
                const media: QuestionMedia[] = (q.media ?? []).map((m: ReviewMedia) => ({
                  file_url: m.file_url,
                  media_type: m.media_type,
                  caption: m.caption ?? null,
                  license: m.license ?? null,
                  attribution: m.attribution ?? null,
                  display_context: m.display_context as
                    | "stem"
                    | "explanation"
                    | "both",
                  display_order: m.display_order ?? 0,
                }));
                return { ...q, media } as Question;
              })
              .filter(Boolean) as Question[];

            const answers: SessionAnswer[] = review.attempts.map((a) => ({
              question_id: a.question_id,
              selected_option: a.selected_option as SessionAnswer["selected_option"],
              is_correct: a.is_correct,
              time_taken_ms: a.time_taken_ms ?? 0,
            }));

            const flagSet = new Set(review.flagged ?? []);

            const loaded = {
              questions,
              answers,
              totalTime: review.session.total_time_ms,
              score: review.session.score,
              total: review.session.total,
              flaggedIds: [...flagSet],
            };
            setSummaryData(loaded);
            setSummaryFlaggedIds(flagSet);
            loadSummary(loaded);
            setLoading(false);
            return;
          }
        } catch (err) {
          console.error("Failed to load session review, falling back to memory:", err);
        }
      }

      if (lastSummary) {
        setSummaryData(lastSummary);
        setSummaryFlaggedIds(new Set(lastSummary.flaggedIds ?? []));
        setLoading(false);
        return;
      }

      navigate("/qbank");
    };

    load();
  }, [sessionId, lastSummary, navigate, loadSummary]);

  if (loading) {
    return (
      <DashboardLayout>
        <PageLoader context="qbank" />
      </DashboardLayout>
    );
  }

  if (!summaryData) return null;

  const { questions, answers, totalTime, score, total } = summaryData;
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const perf = performanceLabel(pct);
  const avgTime = total > 0
    ? Math.round(answers.reduce((s, a) => s + (a.time_taken_ms ?? 0), 0) / total / 1000)
    : 0;

  const difficultyBreakdown = ["Easy", "Medium", "Hard"].map((diff) => {
    const qs = questions.filter((q) => q.difficulty === diff);
    const correct = qs.filter((q) => answers.find((a) => a.question_id === q.id)?.is_correct).length;
    return { diff, correct, total: qs.length };
  }).filter((d) => d.total > 0);

  const handleTryAgain = async () => {
    await startSession();
    navigate("/qbank/session");
  };

  const handleReviewQuestion = (index: number) => {
    if (sessionId) {
      setReviewIndex(index);
      navigate(`/qbank/session?session=${sessionId}&review=${index}`);
    } else {
      enterSummaryReview(index);
      navigate("/qbank/session");
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-8 animate-fade-in">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card">
            <FlaskConical className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Session Complete</h1>
            <p className="text-xs text-muted-foreground">Cardiovascular System · {total} questions</p>
          </div>
        </div>

        <div className="glass-card rounded-xl p-6">
          <div className="flex flex-col sm:flex-row items-center gap-6">
            <ScoreRing score={score} total={total} />
            <div className="flex-1 space-y-4 text-center sm:text-left">
              <div>
                <p className="text-lg font-semibold tracking-tight" style={{ color: perf.color }}>{perf.text}</p>
                <p className="text-sm text-muted-foreground mt-0.5">{score} correct out of {total} questions</p>
              </div>
              <div className="flex flex-wrap gap-3 justify-center sm:justify-start">
                <div className="flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1.5">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground tabular-nums">{formatTime(totalTime)} total</span>
                </div>
                <div className="flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1.5">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground tabular-nums">~{avgTime}s per question</span>
                </div>
              </div>
            </div>
          </div>

          {difficultyBreakdown.length > 0 && (
            <div className="mt-5 pt-5 border-t border-border">
              <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase mb-3">By difficulty</p>
              <div className="flex gap-3 flex-wrap">
                {difficultyBreakdown.map(({ diff, correct, total: t }) => {
                  const diffPct = t > 0 ? Math.round((correct / t) * 100) : 0;
                  const diffColor = diff === "Easy" ? "#059669" : diff === "Medium" ? "#d97706" : "#dc2626";
                  return (
                    <div key={diff} className="flex-1 min-w-[80px] rounded-lg border border-border bg-background p-3 text-center">
                      <p className="text-base font-semibold tabular-nums" style={{ color: diffColor }}>{diffPct}%</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{diff}</p>
                      <p className="text-[10px] text-muted-foreground/60">{correct}/{t}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase pl-1">
            Question breakdown
          </p>
          {questions.some((q) => summaryFlaggedIds.has(q.id)) && (
            <div className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-600 dark:text-amber-400 w-fit">
              <Flag className="h-3 w-3" fill="currentColor" />
              {questions.filter((q) => summaryFlaggedIds.has(q.id)).length} flagged for review
            </div>
          )}
          <div className="space-y-1.5">
            {questions.map((q, i) => {
              const ans = answers.find((a) => a.question_id === q.id);
              const isCorrect = ans?.is_correct ?? false;
              const diffColor = q.difficulty === "Easy" ? "#059669" : q.difficulty === "Medium" ? "#d97706" : "#dc2626";
              const stemSnippet = q.question_text.length > 80
                ? q.question_text.slice(0, 80).trimEnd() + "…"
                : q.question_text;

              return (
                <button
                  key={q.id}
                  onClick={() => handleReviewQuestion(i)}
                  className="w-full flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left hover:border-foreground/20 transition-colors group"
                >
                  <div className="shrink-0 mt-0.5">
                    {isCorrect
                      ? <CheckCircle className="text-emerald-600 dark:text-emerald-400" style={{ width: 15, height: 15 }} />
                      : <XCircle className="text-red-600 dark:text-red-400" style={{ width: 15, height: 15 }} />
                    }
                  </div>
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold tabular-nums text-muted-foreground shrink-0">Q{i + 1}</span>
                      {summaryFlaggedIds.has(q.id) && (
                        <Flag className="h-3 w-3 text-amber-500 shrink-0" fill="currentColor" />
                      )}
                      <span className="text-[11px] text-muted-foreground">{q.domain}</span>
                      <span className="text-[11px] font-semibold shrink-0" style={{ color: diffColor }}>{q.difficulty}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground/60 leading-snug truncate">{stemSnippet}</p>
                  </div>
                  <div className="shrink-0 flex items-center gap-2 mt-0.5">
                    {!isCorrect && ans && (
                      <span className="text-[10px] text-red-600 dark:text-red-400 font-medium">
                        {ans.selected_option.toUpperCase()} → {q.correct_option.toUpperCase()}
                      </span>
                    )}
                    {ans && (
                      <span className="text-[10px] text-muted-foreground/50">
                        {Math.round((ans.time_taken_ms ?? 0) / 1000)}s
                      </span>
                    )}
                    <ChevronRight className="h-3 w-3 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors" />
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 pb-8">
          <Button onClick={handleTryAgain} className="flex-1 h-10 text-sm font-medium rounded-lg gap-2">
            <RotateCcw className="h-4 w-4" />
            Try Again
          </Button>
          <Button variant="outline" onClick={() => navigate("/qbank")}
            className="flex-1 h-10 text-sm font-medium rounded-lg gap-2">
            Back to QBank
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default QBankSummary;
