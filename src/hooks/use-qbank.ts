// Shared QBank types. The session engine lives entirely in
// `src/contexts/QBankContext.tsx`; this file intentionally exports types only.

export type Difficulty = "Easy" | "Medium" | "Hard";
export type OptionKey = "a" | "b" | "c" | "d" | "e";

export interface QuestionMedia {
  file_url: string;
  media_type: string;
  caption: string | null;
  attribution: string | null;
  license: string;
  display_context: 'stem' | 'explanation' | 'both';
  display_order: number;
}

export interface Question {
  id: string;
  subject: string;
  domain: string;
  topic: string;
  difficulty: Difficulty;
  competency: string;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  option_e: string;
  // Answer fields are NOT sent when a session starts — they are populated after
  // grading (from submit_answer) or when loading a completed session for review
  // (get_session_review). Undefined until then.
  correct_option?: OptionKey;
  explanation?: string;
  teaching_point?: string;
  media?: QuestionMedia[];
}

export interface SessionAnswer {
  question_id: string;
  selected_option: OptionKey;
  is_correct: boolean;
  time_taken_ms: number;
}

export interface SessionState {
  // Server session id, created up front by start_qbank_session.
  sessionId: string | null;
  questions: Question[];
  currentIndex: number;
  answers: SessionAnswer[];
  startedAt: number;
  questionStartedAt: number;
  accumulatedMs: number;
  resumedAt: number;
  skippedIds: string[];
  flaggedIds: string[];
}
