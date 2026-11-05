-- Crossing Mall — Smart Parking: Supabase schema
-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query).
-- Safe to re-run: every statement is guarded with IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS.

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ============================================================
-- 0. Cleanup — drop tables from earlier, since-abandoned schema versions
-- (the original card-UID-lookup model, and the booking+chat model) if this
-- project ever ran either. Safe no-ops if they were never created.
-- ============================================================
drop table if exists public.rfid_cards cascade;
drop table if exists public.parking_sessions cascade; -- old shape (int slot ids) — recreated below
drop table if exists public.gate_events cascade;
drop table if exists public.parking_slots cascade;
drop table if exists public.bookings cascade;
drop table if exists public.chats cascade;
drop table if exists public.chat_meta cascade;
drop table if exists public.staff cascade;
drop view if exists public.slot_holds;
-- the old boom_gates had an int id (1/2); this schema's has a text id
-- ('entry'/'exit') — incompatible shapes, so drop and recreate below.
drop table if exists public.boom_gates cascade;
-- the very first schema version named its profiles policies differently
-- (profiles_select_own_or_admin / profiles_update_own). Postgres combines
-- multiple permissive policies with OR, so leaving these in place alongside
-- the current ones doesn't just duplicate logic — that old policy's raw
-- "EXISTS (SELECT ... FROM profiles WHERE role = 'admin')" subquery (not
-- routed through the RLS-bypassing is_admin() function) triggers genuine
-- infinite recursion (Postgres error 42P17) the moment any profiles row is
-- read. Drop them unconditionally before the current policies are created.
drop policy if exists profiles_select_own_or_admin on public.profiles;
drop policy if exists profiles_update_own on public.profiles;

-- ============================================================
-- 1. Tables
-- ============================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  email text,
  card text unique,
  role text not null default 'user' check (role in ('user', 'admin')),
  points integer not null default 0,
  created_at timestamptz not null default now()
);

-- in case `profiles` already existed from an earlier schema version
-- (different columns / role check / role default), bring it up to this
-- exact shape. The role DEFAULT in particular is easy to miss: fixing only
-- the CHECK constraint still leaves new rows failing it via the old default.
alter table public.profiles add column if not exists name text;
alter table public.profiles add column if not exists card text;
alter table public.profiles add column if not exists points integer not null default 0;
alter table public.profiles drop column if exists plate;
alter table public.profiles drop column if exists full_name;
alter table public.profiles alter column email drop not null;
alter table public.profiles drop constraint if exists profiles_card_key;
alter table public.profiles add constraint profiles_card_key unique (card);
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('user', 'admin'));
alter table public.profiles alter column role set default 'user';
update public.profiles set role = 'user' where role not in ('user', 'admin');
update public.profiles set name = coalesce(name, email) where name is null;

-- one row per entry->exit visit. No advance booking, no assigned bay — the
-- driver just taps when they arrive and taps again when they leave.
create table if not exists public.parking_sessions (
  id uuid primary key default gen_random_uuid(),
  uid uuid not null references public.profiles(id) on delete cascade,
  card text not null,
  entry_time timestamptz not null default now(),
  exit_time timestamptz,
  duration_minutes integer,
  points_earned integer not null default 0,
  status text not null default 'active' check (status in ('active', 'completed'))
);
create index if not exists parking_sessions_uid_idx on public.parking_sessions(uid);
create index if not exists parking_sessions_card_idx on public.parking_sessions(card);

-- live bay occupancy — written by fn_set_slot whenever an IR sensor flips.
create table if not exists public.sensors (
  slot text primary key,
  occupied boolean not null default false,
  distance double precision,
  t bigint
);

create table if not exists public.rfid (
  reader text primary key,
  card text,
  t bigint
);

create table if not exists public.card_taps (
  card text primary key,
  reader text,
  t bigint
);

create table if not exists public.taps (
  id uuid primary key default gen_random_uuid(),
  reader text,
  card text,
  t bigint not null default (extract(epoch from now()) * 1000)::bigint
);
create index if not exists taps_t_idx on public.taps(t desc);

create table if not exists public.logs (
  id uuid primary key default gen_random_uuid(),
  slot text,
  card text,
  name text,
  type text check (type in ('IN', 'OUT')),
  t bigint not null default (extract(epoch from now()) * 1000)::bigint
);
create index if not exists logs_t_idx on public.logs(t);

-- "device online" heartbeat, one row per physical reader/gate unit.
create table if not exists public.device_heartbeat (
  id text primary key,
  t bigint
);

-- boom-gate maintenance: lets an admin force a gate shut for servicing —
-- fn_gate_tap checks this before ever "opening" that gate.
create table if not exists public.boom_gates (
  id text primary key,
  label text not null,
  maintenance boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.boom_gates (id, label) values ('entry', 'Entry Gate'), ('exit', 'Exit Gate')
  on conflict (id) do nothing;

-- flame sensor emergency log — the ESP32 opens both gates and sounds the
-- buzzer locally the instant it detects flame, then calls fn_flame_alert
-- (below) just to put this on the admin dashboard.
create table if not exists public.flame_alerts (
  id uuid primary key default gen_random_uuid(),
  triggered_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  notes text
);

-- ============================================================
-- 2. Role helpers + account bootstrap
-- ============================================================

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- auto-create a profile row the moment someone signs up
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', new.email), new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- backfill: catches any auth user who signed up before this trigger existed
-- (or before this schema was first applied) and would otherwise have no
-- profiles row at all, silently breaking every profile-scoped query for them.
insert into public.profiles (id, name, email)
select u.id, coalesce(u.raw_user_meta_data ->> 'name', u.email), u.email
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;

-- stop non-admins from granting themselves admin via a profile update.
-- the service_role key (used by scripts/grant-role.js) always bypasses this,
-- since that's the only supported way to grant the very first admin.
create or replace function public.protect_role_column() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' and not public.is_admin() and new.role is distinct from old.role then
    new.role := old.role;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_profiles_protect_role on public.profiles;
create trigger trg_profiles_protect_role before update on public.profiles
  for each row execute function public.protect_role_column();

-- hardware/sensor tables are always timestamped by the server, so the ESP32
-- never needs NTP for these to be trustworthy.
create or replace function public.set_server_ms() returns trigger
language plpgsql as $$
begin
  new.t := (extract(epoch from now()) * 1000)::bigint;
  return new;
end;
$$;
drop trigger if exists trg_sensors_t on public.sensors;
create trigger trg_sensors_t before insert or update on public.sensors for each row execute function public.set_server_ms();
drop trigger if exists trg_device_heartbeat_t on public.device_heartbeat;
create trigger trg_device_heartbeat_t before insert or update on public.device_heartbeat for each row execute function public.set_server_ms();
drop trigger if exists trg_rfid_t on public.rfid;
create trigger trg_rfid_t before insert or update on public.rfid for each row execute function public.set_server_ms();
drop trigger if exists trg_card_taps_t on public.card_taps;
create trigger trg_card_taps_t before insert or update on public.card_taps for each row execute function public.set_server_ms();
drop trigger if exists trg_taps_t on public.taps;
create trigger trg_taps_t before insert on public.taps for each row execute function public.set_server_ms();
-- logs.t is NOT forced server-side so a live hardware write can simply omit
-- `t` and get the column default (now, in ms).

-- ============================================================
-- 3. Hardware RPCs — the ESP32 calls these directly with the publishable
-- key, no device login needed (SECURITY DEFINER does the privileged
-- reads/writes; each function only does the one narrow thing its name says).
-- ============================================================

-- Called on every RFID tap. Whether it opens the entry or exit gate is
-- decided here, by whether this card already has an 'active' (parked)
-- session: no session -> entry (start one, +0 pts yet); active session ->
-- exit (close it, award points). Either way, a gate under maintenance
-- refuses to open.
create or replace function public.fn_gate_tap(p_card text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_name text;
  v_active public.parking_sessions;
  v_gate_id text;
  v_gate public.boom_gates;
  v_minutes integer;
  v_points integer;
begin
  select id, name into v_uid, v_name from public.profiles where card = p_card;

  if v_uid is null then
    return jsonb_build_object('ok', false, 'open', false, 'message', 'Unknown card');
  end if;

  select * into v_active from public.parking_sessions where card = p_card and status = 'active' limit 1;
  v_gate_id := case when v_active.id is null then 'entry' else 'exit' end;

  select * into v_gate from public.boom_gates where id = v_gate_id;
  if v_gate.maintenance then
    return jsonb_build_object('ok', false, 'open', false, 'message', v_gate.label || ' under maintenance');
  end if;

  -- feeds the admin dashboard's live RFID feed and "last tap" per card/reader
  insert into public.taps (reader, card) values ('GATE', p_card);
  insert into public.rfid (reader, card) values ('GATE', p_card)
    on conflict (reader) do update set card = excluded.card;
  insert into public.card_taps (card, reader) values (p_card, 'GATE')
    on conflict (card) do update set reader = excluded.reader;

  if v_active.id is null then
    insert into public.parking_sessions (uid, card) values (v_uid, p_card);
    return jsonb_build_object('ok', true, 'open', true, 'gate', 'entry', 'message', 'Welcome ' || v_name, 'name', v_name);
  end if;

  v_minutes := greatest(1, round(extract(epoch from (now() - v_active.entry_time)) / 60));
  v_points := 10; -- keep in sync with POINTS_PER_VISIT in src/lib.js

  update public.parking_sessions
    set status = 'completed', exit_time = now(), duration_minutes = v_minutes, points_earned = v_points
    where id = v_active.id;
  update public.profiles set points = points + v_points where id = v_uid;

  return jsonb_build_object('ok', true, 'open', true, 'gate', 'exit', 'message', 'Bye ' || v_name || ' +' || v_points || 'pts', 'name', v_name);
end;
$$;
grant execute on function public.fn_gate_tap(text) to anon, authenticated;

-- Called with each stable IR sensor state. Writes `sensors` (what the live
-- bay cards watch) and appends an IN/OUT row only when an existing bay's
-- occupancy changes, so startup syncs and retries do not duplicate events.
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
begin
  if upper(btrim(coalesce(p_slot, ''))) in ('P1', 'P3') then
    return jsonb_build_object('ok', true, 'disabled', true);
  end if;

  select occupied into v_previous
    from public.sensors
    where slot = p_slot;
  v_has_previous := found;

  insert into public.sensors (slot, occupied, distance) values (p_slot, p_occupied, p_distance)
    on conflict (slot) do update set occupied = excluded.occupied, distance = excluded.distance;

  if v_has_previous and v_previous is distinct from p_occupied then
    insert into public.logs (slot, card, name, type)
      values (p_slot, p_card, p_name, case when p_occupied then 'IN' else 'OUT' end);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.fn_set_slot(text, boolean, numeric, text, text) to anon, authenticated;

-- Legacy: originally called by the ESP32 the instant its own flame sensor
-- tripped. That sensor is gone — emergencies are now triggered manually
-- from the admin dashboard, which inserts into flame_alerts directly (it
-- already has RLS write access). Kept for compatibility; nothing calls it
-- anymore.
create or replace function public.fn_flame_alert() returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.flame_alerts default values;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.fn_flame_alert() to anon, authenticated;

-- Polled by the ESP32 (no flame sensor anymore) to find out whether an
-- admin has hit the Emergency button on the dashboard. True for as long as
-- the most recent flame_alerts row is unresolved; false again the instant
-- an admin marks it resolved — the device reacts to both transitions.
create or replace function public.fn_check_emergency() returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('active', exists (select 1 from public.flame_alerts where resolved_at is null));
$$;
grant execute on function public.fn_check_emergency() to anon, authenticated;

-- ============================================================
-- 4. Row Level Security
-- ============================================================

alter table public.profiles enable row level security;
alter table public.parking_sessions enable row level security;
alter table public.sensors enable row level security;
alter table public.rfid enable row level security;
alter table public.card_taps enable row level security;
alter table public.taps enable row level security;
alter table public.logs enable row level security;
alter table public.device_heartbeat enable row level security;
alter table public.boom_gates enable row level security;
alter table public.flame_alerts enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (auth.uid() = id or is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update using (auth.uid() = id or is_admin());

drop policy if exists parking_sessions_select on public.parking_sessions;
create policy parking_sessions_select on public.parking_sessions for select using (uid = auth.uid() or is_admin());

drop policy if exists sensors_select on public.sensors;
create policy sensors_select on public.sensors for select using (auth.uid() is not null);
drop policy if exists sensors_write on public.sensors;
create policy sensors_write on public.sensors for all using (is_admin()) with check (is_admin());

drop policy if exists rfid_select on public.rfid;
create policy rfid_select on public.rfid for select using (is_admin());
drop policy if exists rfid_write on public.rfid;
create policy rfid_write on public.rfid for all using (is_admin()) with check (is_admin());

drop policy if exists card_taps_select on public.card_taps;
create policy card_taps_select on public.card_taps for select using (
  is_admin() or card = (select card from public.profiles where id = auth.uid())
);
drop policy if exists card_taps_write on public.card_taps;
create policy card_taps_write on public.card_taps for all using (is_admin()) with check (is_admin());

drop policy if exists taps_select on public.taps;
create policy taps_select on public.taps for select using (is_admin());
drop policy if exists taps_write on public.taps;
create policy taps_write on public.taps for all using (is_admin()) with check (is_admin());

drop policy if exists logs_select on public.logs;
create policy logs_select on public.logs for select using (is_admin());
drop policy if exists logs_write on public.logs;
create policy logs_write on public.logs for all using (is_admin()) with check (is_admin());

drop policy if exists device_heartbeat_select on public.device_heartbeat;
create policy device_heartbeat_select on public.device_heartbeat for select using (is_admin());
drop policy if exists device_heartbeat_write on public.device_heartbeat;
create policy device_heartbeat_write on public.device_heartbeat for all using (is_admin()) with check (is_admin());

drop policy if exists boom_gates_select on public.boom_gates;
create policy boom_gates_select on public.boom_gates for select using (auth.uid() is not null);
drop policy if exists boom_gates_write on public.boom_gates;
create policy boom_gates_write on public.boom_gates for update using (is_admin());

drop policy if exists flame_alerts_all on public.flame_alerts;
create policy flame_alerts_all on public.flame_alerts for all using (is_admin()) with check (is_admin());

-- ============================================================
-- 5. Realtime (Postgres change feed the client subscribes to)
-- ============================================================
-- ALTER PUBLICATION ... ADD TABLE errors if the table is already a member, so
-- (unlike everything else in this file) it isn't idempotent on its own — this
-- loop skips any table already in the publication, making re-runs safe.
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'parking_sessions', 'sensors', 'rfid', 'card_taps', 'taps',
    'logs', 'device_heartbeat', 'boom_gates', 'flame_alerts'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;