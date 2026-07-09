-- QBank server-side sampling + grading (00 / PR3 / issue #4)
--
-- Stops shipping the answer key to the browser. The client no longer selects
-- correct_option/explanation/teaching_point directly; those columns are revoked
-- from anon/authenticated and only reach the client through the SECURITY DEFINER
-- functions below (which run as the function owner and retain column access).
--
-- Unlike the quota RPCs (called by the edge function via service_role, where
-- auth.uid() is null), these are called from the browser client carrying the
-- user's JWT, so auth.uid() resolves to the user. Anonymous users hold real
-- JWTs with the `authenticated` role, so a single grant covers them too.
--
-- NOTE: questions / qbank_sessions / user_attempts were created in the Supabase
-- dashboard (no CREATE in repo). Verify live column/constraint state before
-- applying. Only additive changes here (new columns, new functions, a policy-
-- neutral column REVOKE) per the additive-only rule.

-- ── Additive columns on qbank_sessions ─────────────────────────────────────
-- status defaults to 'completed' so existing rows remain valid; new sessions
-- start life as 'active'. question_ids preserves the sampled/shuffled order.
alter table public.qbank_sessions
  add column if not exists status text not null default 'completed',
  add column if not exists question_ids uuid[];

-- ── start_qbank_session ─────────────────────────────────────────────────────
-- Samples questions server-side, creates the session row up front, and returns
-- sanitized stems (NO answer fields) in sampled order.
create or replace function public.start_qbank_session(
  p_domains text[],
  p_limit int,
  p_system text,
  p_question_ids uuid[] default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_ids uuid[];
  v_session_id uuid;
  v_questions json;
  v_now timestamptz := now();
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;

  if p_question_ids is not null and array_length(p_question_ids, 1) is not null then
    -- Explicit set (e.g. "redo flagged"): restrict to active questions from the
    -- given ids. Stems are not secret, so accepting caller-supplied ids is safe.
    select array_agg(id) into v_ids
    from (
      select id
      from questions
      where is_active = true
        and id = any(p_question_ids)
      order by random()
      limit least(coalesce(p_limit, 40), 40)
    ) sampled;
  else
    -- Sample ids: active only, optional system + domain filters, capped at 40.
    select array_agg(id) into v_ids
    from (
      select id
      from questions
      where is_active = true
        and (p_system is null or subject = p_system)
        and (
          p_domains is null
          or array_length(p_domains, 1) is null
          or domain = any(p_domains)
        )
      order by random()
      limit least(coalesce(p_limit, 40), 40)
    ) sampled;
  end if;

  if v_ids is null or array_length(v_ids, 1) is null then
    raise exception 'no_questions';
  end if;

  insert into qbank_sessions (
    user_id, started_at, ended_at, score, total, total_time_ms,
    system, status, question_ids
  )
  values (
    v_user, v_now, v_now, 0, 0, 0,
    coalesce(p_system, 'Cardiovascular'), 'active', v_ids
  )
  returning id into v_session_id;

  -- Build sanitized payload, preserving sampled order via WITH ORDINALITY.
  select json_agg(payload order by ord) into v_questions
  from (
    select
      ord.ord as ord,
      json_build_object(
        'id', q.id,
        'subject', q.subject,
        'domain', q.domain,
        'topic', q.topic,
        'difficulty', q.difficulty,
        'competency', q.competency,
        'question_text', q.question_text,
        'option_a', q.option_a,
        'option_b', q.option_b,
        'option_c', q.option_c,
        'option_d', q.option_d,
        'option_e', q.option_e,
        'media', coalesce(m.media, '[]'::json)
      ) as payload
    from unnest(v_ids) with ordinality as ord(qid, ord)
    join questions q on q.id = ord.qid
    left join lateral (
      select json_agg(
        json_build_object(
          'file_url', md.file_url,
          'media_type', md.media_type,
          'caption', qm.caption,
          'attribution', md.attribution,
          'license', md.license,
          'display_context', qm.display_context,
          'display_order', qm.display_order
        ) order by qm.display_order
      ) as media
      from question_media qm
      join media md on md.id = qm.media_id
      where qm.question_id = q.id
    ) m on true
  ) ordered;

  return json_build_object(
    'session_id', v_session_id,
    'questions', coalesce(v_questions, '[]'::json)
  );
end;
$$;

-- ── submit_answer ───────────────────────────────────────────────────────────
-- Grades one answer server-side and records the attempt. Guards (all required):
-- session owned by caller, still active, question belongs to the session, and
-- not already answered (anti-oracle: submit_answer must not be a lookup loop).
create or replace function public.submit_answer(
  p_session uuid,
  p_question uuid,
  p_selected text,
  p_time_ms int
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_session qbank_sessions%rowtype;
  v_correct text;
  v_explanation text;
  v_teaching text;
  v_is_correct boolean;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;

  select * into v_session from qbank_sessions where id = p_session;
  if not found or v_session.user_id <> v_user then
    raise exception 'session_not_found';
  end if;
  if v_session.status <> 'active' then
    raise exception 'session_not_active';
  end if;
  if not (p_question = any(v_session.question_ids)) then
    raise exception 'question_not_in_session';
  end if;
  if exists (
    select 1 from user_attempts
    where session_id = p_session and question_id = p_question
  ) then
    raise exception 'already_answered';
  end if;

  select correct_option, explanation, teaching_point
    into v_correct, v_explanation, v_teaching
  from questions where id = p_question;

  v_is_correct := (p_selected = v_correct);

  insert into user_attempts (
    user_id, question_id, selected_option, is_correct, time_taken_ms, session_id
  )
  values (v_user, p_question, p_selected, v_is_correct, p_time_ms, p_session);

  return json_build_object(
    'is_correct', v_is_correct,
    'correct_option', v_correct,
    'explanation', v_explanation,
    'teaching_point', v_teaching
  );
end;
$$;

-- ── end_qbank_session ───────────────────────────────────────────────────────
-- Marks the session complete and writes the real score/total/time from the
-- recorded attempts. Idempotent-ish: recomputes from user_attempts each call.
create or replace function public.end_qbank_session(p_session uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_session qbank_sessions%rowtype;
  v_score int;
  v_total int;
  v_time bigint;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;

  select * into v_session from qbank_sessions where id = p_session;
  if not found or v_session.user_id <> v_user then
    raise exception 'session_not_found';
  end if;

  select
    count(*) filter (where is_correct),
    count(*),
    coalesce(sum(time_taken_ms), 0)
  into v_score, v_total, v_time
  from user_attempts
  where session_id = p_session;

  update qbank_sessions
    set status = 'completed',
        ended_at = now(),
        score = v_score,
        total = v_total,
        total_time_ms = v_time
    where id = p_session;

  return json_build_object(
    'session_id', p_session,
    'score', v_score,
    'total', v_total,
    'total_time_ms', v_time
  );
end;
$$;

-- ── get_session_review ──────────────────────────────────────────────────────
-- Owner-only. Returns attempts + full question data (incl. answer fields + media)
-- for the ?session=<id> deep-link. Replaces QBankSummary's embedded join.
create or replace function public.get_session_review(p_session uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_session qbank_sessions%rowtype;
  v_result json;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;

  select * into v_session from qbank_sessions where id = p_session;
  if not found or v_session.user_id <> v_user then
    raise exception 'session_not_found';
  end if;

  select json_build_object(
    'session', json_build_object(
      'score', v_session.score,
      'total', v_session.total,
      'total_time_ms', v_session.total_time_ms,
      'started_at', v_session.started_at,
      'ended_at', v_session.ended_at
    ),
    'attempts', coalesce((
      select json_agg(
        json_build_object(
          'question_id', ua.question_id,
          'selected_option', ua.selected_option,
          'is_correct', ua.is_correct,
          'time_taken_ms', ua.time_taken_ms,
          'question', json_build_object(
            'id', q.id,
            'subject', q.subject,
            'domain', q.domain,
            'topic', q.topic,
            'difficulty', q.difficulty,
            'competency', q.competency,
            'question_text', q.question_text,
            'option_a', q.option_a,
            'option_b', q.option_b,
            'option_c', q.option_c,
            'option_d', q.option_d,
            'option_e', q.option_e,
            'correct_option', q.correct_option,
            'explanation', q.explanation,
            'teaching_point', q.teaching_point,
            'media', coalesce(m.media, '[]'::json)
          )
        ) order by ua.attempted_at
      )
      from user_attempts ua
      join questions q on q.id = ua.question_id
      left join lateral (
        select json_agg(
          json_build_object(
            'file_url', md.file_url,
            'media_type', md.media_type,
            'caption', qm.caption,
            'attribution', md.attribution,
            'license', md.license,
            'display_context', qm.display_context,
            'display_order', qm.display_order
          ) order by qm.display_order
        ) as media
        from question_media qm
        join media md on md.id = qm.media_id
        where qm.question_id = q.id
      ) m on true
      where ua.session_id = p_session
    ), '[]'::json),
    'flagged', coalesce((
      select json_agg(question_id)
      from flagged_questions
      where session_id = p_session
    ), '[]'::json)
  ) into v_result;

  return v_result;
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Callable by signed-in users (anonymous users carry the `authenticated` role).
revoke all on function public.start_qbank_session(text[], int, text, uuid[]) from public;
revoke all on function public.submit_answer(uuid, uuid, text, int) from public;
revoke all on function public.end_qbank_session(uuid) from public;
revoke all on function public.get_session_review(uuid) from public;
grant execute on function public.start_qbank_session(text[], int, text, uuid[]) to authenticated;
grant execute on function public.submit_answer(uuid, uuid, text, int) to authenticated;
grant execute on function public.end_qbank_session(uuid) to authenticated;
grant execute on function public.get_session_review(uuid) to authenticated;

-- ── Stop shipping the answer key ────────────────────────────────────────────
-- The client can no longer read these columns directly; they flow only through
-- submit_answer / get_session_review. Landing-page meta queries select explicit
-- columns (subject/domain/id), so they are unaffected — but any `select('*')`
-- on questions from the client will now 403 (see qbank-count fix in the client).
revoke select (correct_option, explanation, teaching_point)
  on public.questions from anon, authenticated;
