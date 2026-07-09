-- Server-side daily quota enforcement (00 / PR2 / issue #3)
--
-- Moves usage counting off the client. The medical-notes edge function is now
-- the only writer of usage_records, via consume_usage / refund_usage. The client
-- keeps SELECT for display only.
--
-- Signature note: the PRD specifies consume_usage(p_kind, p_cap) relying on
-- auth.uid(). The edge function calls these via the service-role client, under
-- which auth.uid() is NULL, so the verified user id is passed explicitly as
-- p_user instead. EXECUTE is revoked from anon/authenticated, so only trusted
-- server code (service_role) can call them — passing the id is safe.

-- Atomic consume: increments only while strictly under the cap, in a single
-- upsert. Two parallel requests at count = cap-1 serialize on the row lock and
-- resolve to exactly one 'allowed:true'.
create or replace function public.consume_usage(p_user uuid, p_kind text, p_cap int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into usage_records (user_id, kind, usage_date, count)
    values (p_user, p_kind, current_date, 1)
  on conflict (user_id, kind, usage_date)
    do update set count = usage_records.count + 1
      where usage_records.count < p_cap
  returning count into v_count;

  -- No row returned => the conflicting row was already at/over cap (DO UPDATE
  -- WHERE evaluated false). Read the current value for the response.
  if v_count is null then
    select count into v_count
      from usage_records
      where user_id = p_user and kind = p_kind and usage_date = current_date;
    return jsonb_build_object('allowed', false, 'count', coalesce(v_count, p_cap));
  end if;

  return jsonb_build_object('allowed', true, 'count', v_count);
end;
$$;

-- Refund one consumed unit when the downstream generation fails, so failed
-- generations never burn quota. Floors at 0.
create or replace function public.refund_usage(p_user uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update usage_records
    set count = greatest(count - 1, 0)
    where user_id = p_user and kind = p_kind and usage_date = current_date;
end;
$$;

-- Only the service role (edge function) may call these.
revoke all on function public.consume_usage(uuid, text, int) from public, anon, authenticated;
revoke all on function public.refund_usage(uuid, text) from public, anon, authenticated;
grant execute on function public.consume_usage(uuid, text, int) to service_role;
grant execute on function public.refund_usage(uuid, text) to service_role;

-- Remove client write access to usage_records; keep the SELECT policy so the UI
-- can still display today's counts. (Dropping policies is allowed under the
-- additive-only rule — policies are not columns or tables.)
drop policy if exists "Users can insert own usage" on public.usage_records;
drop policy if exists "Users can update own usage" on public.usage_records;
