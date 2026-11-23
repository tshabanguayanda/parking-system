-- Crossing Mall — Smart Parking: live bay fix
-- Run this in the Supabase SQL editor (Project > SQL Editor > New query).
--
-- Brings ONLY the IR-sensor / bay-name path up to date with schema.sql, without the
-- table drops at the top of schema.sql (so no parking sessions, profiles or
-- logs are lost). Safe to re-run.

-- 1. Remove every old fn_set_slot overload. An older two-argument version
-- was still live, and leftover overloads make PostgREST pick the wrong one.
do $$
declare
  f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'fn_set_slot'
  loop
    execute 'drop function ' || f;
  end loop;
end $$;

-- 2. The sensors table + server timestamp trigger.
create table if not exists public.sensors (
  slot text primary key,
  occupied boolean not null default false,
  distance double precision,
  t bigint
);
create or replace function public.set_server_ms() returns trigger
language plpgsql as $$
begin
  new.t := (extract(epoch from now()) * 1000)::bigint;
  return new;
end;
$$;
drop trigger if exists trg_sensors_t on public.sensors;
create trigger trg_sensors_t before insert or update on public.sensors for each row execute function public.set_server_ms();

-- 3. Remember which bay each active parking session is in, so the
-- dashboard can show the driver's name on that bay.
alter table public.parking_sessions add column if not exists slot text;

-- 3b. The current fn_set_slot (same as schema.sql).
create or replace function public.fn_set_slot(
  p_slot text, p_occupied boolean, p_distance numeric default null,
  p_card text default null, p_name text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous boolean;
  v_has_previous boolean;
  v_session uuid;
  v_card text := nullif(btrim(coalesce(p_card, '')), '');
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if upper(btrim(coalesce(p_slot, ''))) = 'P1' then
    return jsonb_build_object('ok', true, 'disabled', true);
  end if;

  select occupied into v_previous
    from public.sensors
    where slot = p_slot;
  v_has_previous := found;

  insert into public.sensors (slot, occupied, distance) values (p_slot, p_occupied, p_distance)
    on conflict (slot) do update set occupied = excluded.occupied, distance = excluded.distance;

  if v_has_previous and v_previous is distinct from p_occupied then
    if p_occupied then
      -- a car just parked: it belongs to the card the ESP32 paired with it,
      -- or else to the most recent driver who tapped in and has no bay yet
      select id, card into v_session, v_card
        from public.parking_sessions
        where status = 'active'
          and (case when v_card is not null then card = v_card else slot is null end)
        order by entry_time desc
        limit 1;
      if v_session is not null then
        update public.parking_sessions set slot = p_slot where id = v_session;
      end if;
      v_card := coalesce(v_card, nullif(btrim(coalesce(p_card, '')), ''));
    else
      -- the car left the bay: free it (the session itself ends at the exit gate)
      select card into v_card from public.parking_sessions
        where status = 'active' and slot = p_slot order by entry_time desc limit 1;
      update public.parking_sessions set slot = null where status = 'active' and slot = p_slot;
    end if;

    if v_name is null and v_card is not null then
      select name into v_name from public.profiles where card = v_card;
    end if;

    insert into public.logs (slot, card, name, type)
      values (p_slot, v_card, v_name, case when p_occupied then 'IN' else 'OUT' end);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.fn_set_slot(text, boolean, numeric, text, text) to anon, authenticated;

-- 4. Signed-in users (the admin dashboard) can read bay state.
alter table public.sensors enable row level security;
drop policy if exists sensors_select on public.sensors;
create policy sensors_select on public.sensors for select using (auth.uid() is not null);

-- 5. Realtime: make sure the dashboard is told about sensor and log changes.
do $$
declare
  t text;
begin
  foreach t in array array['sensors', 'logs', 'parking_sessions'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 6. Tell PostgREST about the new function signature right away.
notify pgrst, 'reload schema';

-- Check: should list P2/P3 with the latest readings once the ESP32 is on.
select slot, occupied, to_timestamp(t / 1000.0) as updated_at from public.sensors order by slot;
