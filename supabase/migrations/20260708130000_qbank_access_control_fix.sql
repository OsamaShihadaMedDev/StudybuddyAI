-- QBank access-control fix (00 / PR3 follow-up)
--
-- Fixes two access-control bugs found while verifying PR3
-- (20260708120000_qbank_server_grading.sql):
--
--   1. questions: the previous column-level `REVOKE SELECT (correct_option,
--      explanation, teaching_point)` was a NO-OP. Postgres column privileges do
--      not subtract from an existing table-level SELECT grant, so anon/
--      authenticated could still read the answer key via `select=*` or by naming
--      the columns directly. The correct pattern is to REVOKE the table-level
--      SELECT first, then GRANT SELECT back on only the safe (non-answer) columns.
--
--   2. user_attempts: the client held a direct INSERT privilege, so a user could
--      forge attempt rows with is_correct = true (bypassing submit_answer's
--      server-side grading) and inflate their own score. Direct INSERT is revoked
--      here; the only remaining writer is submit_answer, which is SECURITY
--      DEFINER and runs as the table owner, so it is unaffected.
--
-- Only additive / privilege changes here (no dropped columns or tables), and the
-- SECURITY DEFINER RPCs (start_qbank_session, submit_answer, end_qbank_session,
-- get_session_review) retain full column access as the function owner, so none of
-- them are affected by these grant changes.

-- ── 1. questions: hide the answer key for real ──────────────────────────────
-- Clear any table-level SELECT (which implicitly covers every column, including
-- correct_option / explanation / teaching_point) before granting the safe subset.
revoke select on public.questions from anon, authenticated;

-- Grant back only the columns the client legitimately needs. This deliberately
-- OMITS correct_option, explanation, and teaching_point — those reach the client
-- exclusively through submit_answer / get_session_review. `is_active` is included
-- because the client's count/meta queries filter on it (a WHERE column requires
-- its own SELECT privilege in Postgres). Question images are served via the
-- question_media / media tables, not a column on questions.
grant select (
  id,
  subject,
  domain,
  topic,
  difficulty,
  competency,
  question_text,
  option_a,
  option_b,
  option_c,
  option_d,
  option_e,
  is_active
) on public.questions to anon, authenticated;

-- ── 2. user_attempts: only submit_answer may write ──────────────────────────
-- Revoke direct INSERT so grading cannot be forged from the client. submit_answer
-- (SECURITY DEFINER) still inserts as the table owner. SELECT/DELETE are left as
-- they were (the client still reads its own attempts and clears a session's
-- attempts on reset); UPDATE was already blocked by RLS.
revoke insert on public.user_attempts from anon, authenticated;
