-- Repair: flagged_questions.session_id drift (00 / PR3 follow-up)
--
-- get_session_review (from 20260708120000) reads
--   select json_agg(question_id) from flagged_questions where session_id = p_session
-- but this prod project is missing flagged_questions.session_id, so the whole
-- function raises `42703 column "session_id" does not exist` and every QBank
-- summary / review deep-link returns 400.
--
-- The column WAS meant to exist: 20260605000000_flagged_questions_session_id.sql
-- adds it and the client writes it on session finalize. That migration is recorded
-- as applied in the remote ledger but its DDL never landed here (migration-history
-- drift — see CLAUDE.md: "the schema has layered history … verify live column/
-- constraint state"), so `db push` will not re-run it. This new file re-applies the
-- same changes idempotently. Purely additive (a new column plus a widened unique
-- constraint); no columns or tables are dropped.

-- Add the session link (idempotent — no-op if a prior run already added it).
alter table public.flagged_questions
  add column if not exists session_id uuid
  references public.qbank_sessions(id) on delete cascade;

-- Widen uniqueness from (user_id, question_id) to (user_id, session_id, question_id)
-- so the same question can be flagged across different sessions. Drop the original
-- 2-column constraint (created by 20260604000000's UNIQUE) if it is still present.
alter table public.flagged_questions
  drop constraint if exists flagged_questions_user_id_question_id_key;

-- ADD CONSTRAINT has no IF NOT EXISTS; guard on pg_constraint so re-runs are safe.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'flagged_questions_user_session_question_key'
      and conrelid = 'public.flagged_questions'::regclass
  ) then
    alter table public.flagged_questions
      add constraint flagged_questions_user_session_question_key
      unique (user_id, session_id, question_id);
  end if;
end $$;

create index if not exists idx_flagged_questions_session
  on public.flagged_questions(session_id);
