import { createContext, useContext, useState, useCallback, useMemo, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Question, OptionKey, SessionAnswer, SessionState } from "@/hooks/use-qbank";

const STORAGE_KEY = "sb_qbank_session";

export interface SessionConfig {
  domains: string[];
  limit: number;
  system?: string;
  questionIds?: string[];
}

interface SessionSummary {
  questions: Question[];
  answers: SessionAnswer[];
  totalTime: number;
  score: number;
  total: number;
  flaggedIds: string[];
}

interface QBankContextValue {
  questionCount: number;
  availableSystems: string[];
  allDomainMeta: { subject: string; domain: string }[];
  allQuestionMeta: { id: string; domain: string; subject: string }[];
  session: SessionState | null;
  currentQuestion: Question | null;
  currentIndex: number;
  totalQuestions: number;
  isLastQuestion: boolean;
  progress: number;
  startSession: (config?: SessionConfig) => Promise<void>;
  submitAnswer: (key: OptionKey) => Promise<{ is_correct: boolean; correct_option: OptionKey } | undefined>;
  nextQuestion: () => void;
  endSession: () => Promise<SessionSummary | null>;
  resetSession: () => void;
  lastSummary: SessionSummary | null;
  reviewIndex: number | null;
  setReviewIndex: (index: number | null) => void;
  enterSummaryReview: (index: number) => void;
  displayQuestion: Question | null;
  displayAnswer: SessionAnswer | null;
  isReviewing: boolean;
  loadSummary: (data: SessionSummary) => void;
  restoreSession: () => boolean;
  snapshotTimer: () => void;
  elapsedMs: number;
  flaggedIds: Set<string>;
  toggleFlag: (questionId: string) => Promise<void>;
  isFlagLoading: boolean;
  skipQuestion: () => void;
  goToQuestion: (index: number) => void;
  unansweredCount: number;
}

const QBankContext = createContext<QBankContextValue | null>(null);

export const QBankProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionState | null>(null);
  const [lastSummary, setLastSummary] = useState<SessionSummary | null>(null);
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);

  const { data: questionCount = 0 } = useQuery({
    queryKey: ["qbank-count"],
    queryFn: async (): Promise<number> => {
      // select("id") not "*": answer columns are REVOKE'd, so a `*` count 403s.
      const { count, error } = await supabase
        .from("questions")
        .select("id", { count: "exact", head: true })
        .eq("is_active", true);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const { data: availableSystems = [] } = useQuery({
    queryKey: ["qbank-systems"],
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from("questions")
        .select("subject")
        .eq("is_active", true);
      if (error) throw error;
      const unique = [...new Set((data ?? []).map((r: { subject: string }) => r.subject))].sort();
      return unique;
    },
  });

  const { data: allDomainMeta = [] } = useQuery({
    queryKey: ["qbank-domain-meta"],
    queryFn: async (): Promise<{ subject: string; domain: string }[]> => {
      const { data, error } = await supabase
        .from("questions")
        .select("subject, domain")
        .eq("is_active", true);
      if (error) throw error;
      return (data ?? []) as { subject: string; domain: string }[];
    },
  });

  const { data: allQuestionMeta = [] } = useQuery({
    queryKey: ["qbank-meta"],
    queryFn: async (): Promise<{ id: string; domain: string; subject: string }[]> => {
      const { data, error } = await supabase
        .from("questions")
        .select("id, domain, subject")
        .eq("is_active", true);
      if (error) throw error;
      return (data ?? []) as { id: string; domain: string; subject: string }[];
    },
  });

  const flaggedIds: Set<string> = useMemo(
    () => new Set(session?.flaggedIds ?? []),
    [session?.flaggedIds]
  );

  const isFlagLoading = false;

  const saveSessionToStorage = useCallback((s: SessionState) => {
    const firstUnanswered = s.questions.findIndex(
      (q) => !s.answers.some((a) => a.question_id === q.id)
    );
    const persistIndex = firstUnanswered === -1 ? s.currentIndex : firstUnanswered;

    const payload = {
      sessionId: s.sessionId,
      questions: s.questions,
      currentIndex: persistIndex,
      answers: s.answers,
      startedAt: s.startedAt,
      accumulatedMs: s.accumulatedMs + (Date.now() - s.resumedAt),
      skippedIds: s.skippedIds,
      flaggedIds: s.flaggedIds,
      savedAt: Date.now(),
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // localStorage full or unavailable — fail silently
    }
  }, []);

  const clearSessionStorage = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // fail silently
    }
  }, []);

  const restoreSession = useCallback((): boolean => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;

      const parsed = JSON.parse(raw);

      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
      if (!parsed.savedAt || Date.now() - parsed.savedAt > TWENTY_FOUR_HOURS) {
        localStorage.removeItem(STORAGE_KEY);
        return false;
      }

      if (
        typeof parsed.sessionId !== "string" ||
        !Array.isArray(parsed.questions) ||
        parsed.questions.length === 0 ||
        typeof parsed.currentIndex !== "number" ||
        !Array.isArray(parsed.answers) ||
        typeof parsed.startedAt !== "number"
      ) {
        // Missing sessionId => stale pre-server-grading cache; can't resume (the
        // server session it maps to doesn't exist). Discard.
        localStorage.removeItem(STORAGE_KEY);
        return false;
      }

      setReviewIndex(null);
      setSession({
        sessionId: parsed.sessionId,
        questions: parsed.questions,
        currentIndex: parsed.currentIndex,
        answers: parsed.answers,
        startedAt: parsed.startedAt,
        questionStartedAt: Date.now(),
        accumulatedMs: typeof parsed.accumulatedMs === "number" ? parsed.accumulatedMs : 0,
        resumedAt: Date.now(),
        skippedIds: Array.isArray(parsed.skippedIds) ? parsed.skippedIds : [],
        flaggedIds: Array.isArray(parsed.flaggedIds) ? parsed.flaggedIds : [],
      });

      return true;
    } catch {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return false;
    }
  }, []);

  const startSession = useCallback(async (config?: SessionConfig) => {
    setReviewIndex(null);
    const { data, error } = await supabase.rpc("start_qbank_session", {
      p_domains:
        config?.domains && config.domains.length > 0 ? config.domains : null,
      p_limit: config?.limit ?? 40,
      p_system: config?.system ?? null,
      p_question_ids:
        config?.questionIds && config.questionIds.length > 0
          ? config.questionIds
          : null,
    });
    if (error) throw error;

    const result = data as { session_id: string; questions: Question[] } | null;
    const questions = (result?.questions ?? []) as Question[];
    const now = Date.now();
    const newSession: SessionState = {
      sessionId: result?.session_id ?? null,
      questions,
      currentIndex: 0,
      answers: [],
      startedAt: now,
      questionStartedAt: now,
      accumulatedMs: 0,
      resumedAt: now,
      skippedIds: [],
      flaggedIds: [],
    };
    setSession(newSession);
    saveSessionToStorage(newSession);
  }, [saveSessionToStorage]);

  const submitAnswer = useCallback(
    async (selectedOption: OptionKey) => {
      if (!session || !session.sessionId) return undefined;
      const question = session.questions[session.currentIndex];
      const time_taken_ms = Date.now() - session.questionStartedAt;

      // Grade server-side. The answer key never reaches the client until this
      // returns it for the answered question.
      const { data, error } = await supabase.rpc("submit_answer", {
        p_session: session.sessionId,
        p_question: question.id,
        p_selected: selectedOption,
        p_time_ms: time_taken_ms,
      });
      if (error || !data) {
        console.error("submit_answer failed:", error);
        return undefined;
      }
      const graded = data as {
        is_correct: boolean;
        correct_option: OptionKey;
        explanation: string;
        teaching_point: string;
      };

      const answer: SessionAnswer = {
        question_id: question.id,
        selected_option: selectedOption,
        is_correct: graded.is_correct,
        time_taken_ms,
      };

      // Merge the graded fields onto the cached question so the explanation
      // panel (which reads displayQuestion.explanation / .correct_option) can
      // render, and so a resumed/reviewed session shows the answered state.
      const updatedQuestions = session.questions.map((q) =>
        q.id === question.id
          ? {
              ...q,
              correct_option: graded.correct_option,
              explanation: graded.explanation,
              teaching_point: graded.teaching_point,
            }
          : q
      );

      const updatedSession: SessionState = {
        ...session,
        questions: updatedQuestions,
        answers: [...session.answers, answer],
      };
      setSession(updatedSession);
      saveSessionToStorage(updatedSession);

      return { is_correct: graded.is_correct, correct_option: graded.correct_option };
    },
    [session, saveSessionToStorage]
  );

  const nextQuestion = useCallback(() => {
    setReviewIndex(null);
    setSession((prev) =>
      prev
        ? { ...prev, currentIndex: prev.currentIndex + 1, questionStartedAt: Date.now() }
        : null
    );
    if (session) {
      const nextIndex = session.currentIndex + 1;
      saveSessionToStorage({
        ...session,
        currentIndex: nextIndex,
        questionStartedAt: Date.now(),
      });
    }
  }, [session, saveSessionToStorage]);

  const endSession = useCallback(async () => {
    if (!session) return null;

    const endedAt = Date.now();
    const score = session.answers.filter((a) => a.is_correct).length;
    const total = session.answers.length;
    const totalTime = session.accumulatedMs + (endedAt - session.resumedAt);

    const sessionId = session.sessionId;

    // Attempts were already recorded per-answer by submit_answer. Finalize the
    // session server-side (status + real score/total/time) and record flags.
    if (sessionId) {
      try {
        const { error: endError } = await supabase.rpc("end_qbank_session", {
          p_session: sessionId,
        });
        if (endError) {
          console.error("end_qbank_session failed:", endError);
        } else {
          queryClient.invalidateQueries({ queryKey: ["qbank-sessions"] });

          if (session.flaggedIds.length > 0 && user?.id) {
            const flagRows = session.flaggedIds.map((questionId) => ({
              user_id: user.id,
              question_id: questionId,
              session_id: sessionId,
            }));
            await supabase.from("flagged_questions").insert(flagRows);
          }
        }
      } catch (err) {
        console.error("Failed to finalize session:", err);
      }
    }

    const summary: SessionSummary = {
      questions: session.questions.slice(0, total),
      answers: session.answers,
      totalTime,
      score,
      total,
      flaggedIds: session.flaggedIds,
    };

    setLastSummary(summary);
    clearSessionStorage();
    setSession(null);
    setReviewIndex(null);

    if (sessionId) {
      navigate(`/qbank/summary?session=${sessionId}`);
    } else {
      navigate("/qbank/summary");
    }

    return summary;
  }, [session, user, navigate, clearSessionStorage, queryClient]);

  const resetSession = useCallback(() => {
    clearSessionStorage();
    setSession(null);
  }, [clearSessionStorage]);

  const toggleFlag = useCallback(async (questionId: string) => {
    setSession((prev) => {
      if (!prev) return prev;
      const alreadyFlagged = prev.flaggedIds.includes(questionId);
      const updated: SessionState = {
        ...prev,
        flaggedIds: alreadyFlagged
          ? prev.flaggedIds.filter((id) => id !== questionId)
          : [...prev.flaggedIds, questionId],
      };

      const firstUnanswered = updated.questions.findIndex(
        (q) => !updated.answers.some((a) => a.question_id === q.id)
      );
      const persistIndex = firstUnanswered === -1 ? updated.currentIndex : firstUnanswered;

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          sessionId: updated.sessionId,
          questions: updated.questions,
          currentIndex: persistIndex,
          answers: updated.answers,
          startedAt: updated.startedAt,
          accumulatedMs: updated.accumulatedMs + (Date.now() - updated.resumedAt),
          skippedIds: updated.skippedIds,
          flaggedIds: updated.flaggedIds,
          savedAt: Date.now(),
        }));
      } catch { /* fail silently */ }

      return updated;
    });
  }, []);

  const skipQuestion = useCallback(() => {
    setSession((prev) => {
      if (!prev) return prev;
      const currentQ = prev.questions[prev.currentIndex];
      if (!currentQ) return prev;
      if (prev.currentIndex >= prev.questions.length - 1) return prev;

      const updated: SessionState = {
        ...prev,
        currentIndex: prev.currentIndex + 1,
        questionStartedAt: Date.now(),
        skippedIds: prev.skippedIds.includes(currentQ.id)
          ? prev.skippedIds
          : [...prev.skippedIds, currentQ.id],
      };

      saveSessionToStorage(updated);
      return updated;
    });
  }, [saveSessionToStorage]);

  const goToQuestion = useCallback((index: number) => {
    setReviewIndex(null);
    setSession((prev) => {
      if (!prev) return prev;
      if (index < 0 || index >= prev.questions.length) return prev;
      if (index === prev.currentIndex) return prev;

      const updated: SessionState = {
        ...prev,
        currentIndex: index,
        questionStartedAt: Date.now(),
      };

      saveSessionToStorage(updated);
      return updated;
    });
  }, [saveSessionToStorage]);

  const snapshotTimer = useCallback(() => {
    setSession((prev) => {
      if (!prev) return prev;
      const now = Date.now();
      const banked = prev.accumulatedMs + (now - prev.resumedAt);
      const updated: SessionState = {
        ...prev,
        accumulatedMs: banked,
        resumedAt: now,
      };

      const firstUnanswered = updated.questions.findIndex(
        (q) => !updated.answers.some((a) => a.question_id === q.id)
      );
      const persistIndex = firstUnanswered === -1 ? updated.currentIndex : firstUnanswered;

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          sessionId: updated.sessionId,
          questions: updated.questions,
          currentIndex: persistIndex,
          answers: updated.answers,
          startedAt: updated.startedAt,
          accumulatedMs: banked,
          skippedIds: updated.skippedIds,
          flaggedIds: updated.flaggedIds,
          savedAt: now,
        }));
      } catch { /* fail silently */ }

      return updated;
    });
  }, []);

  const enterSummaryReview = useCallback((index: number) => {
    setReviewIndex(index);
  }, []);

  const loadSummary = useCallback((data: SessionSummary) => {
    setLastSummary(data);
  }, []);

  const elapsedMs = session ? session.accumulatedMs + (Date.now() - session.resumedAt) : 0;

  const unansweredCount = session
    ? session.questions.filter(
        (q) => !session.answers.find((a) => a.question_id === q.id)
      ).length
    : 0;

  const currentQuestion = session ? session.questions[session.currentIndex] : null;
  const isLastQuestion = session
    ? session.currentIndex === session.questions.length - 1
    : false;
  const progress = session ? session.currentIndex / session.questions.length : 0;

  const isReviewing = reviewIndex !== null;

  const displayQuestion: Question | null = isReviewing
    ? (
        session?.questions[reviewIndex!] ??
        lastSummary?.questions[reviewIndex!] ??
        null
      )
    : currentQuestion;

  const displayAnswer: SessionAnswer | null = isReviewing
    ? (
        session?.answers.find(
          (a) => a.question_id === session?.questions[reviewIndex!]?.id
        ) ??
        lastSummary?.answers.find(
          (a) => a.question_id === lastSummary?.questions[reviewIndex!]?.id
        ) ??
        null
      )
    : null;

  return (
    <QBankContext.Provider
      value={{
        questionCount,
        availableSystems,
        allDomainMeta,
        allQuestionMeta,
        session,
        currentQuestion,
        currentIndex: session?.currentIndex ?? 0,
        totalQuestions: session?.questions.length ?? 0,
        isLastQuestion,
        progress,
        startSession,
        submitAnswer,
        nextQuestion,
        endSession,
        resetSession,
        lastSummary,
        reviewIndex,
        setReviewIndex,
        enterSummaryReview,
        displayQuestion,
        displayAnswer,
        isReviewing,
        loadSummary,
        restoreSession,
        snapshotTimer,
        elapsedMs,
        flaggedIds,
        toggleFlag,
        isFlagLoading,
        skipQuestion,
        goToQuestion,
        unansweredCount,
      }}
    >
      {children}
    </QBankContext.Provider>
  );
};

export const useQBankContext = () => {
  const ctx = useContext(QBankContext);
  if (!ctx) throw new Error("useQBankContext must be used inside QBankProvider");
  return ctx;
};
