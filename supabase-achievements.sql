-- Verified volunteer completion, hours and achievements.
-- Apply after supabase-schema.sql and supabase-event-workflows.sql.
begin;

alter table public.events
    add column if not exists volunteer_hours numeric(5,2) not null default 1
    check (volunteer_hours > 0 and volunteer_hours <= 24);

do $$
begin
    create type public.completion_status as enum ('pending', 'approved', 'rejected');
exception
    when duplicate_object then null;
end
$$;

create table if not exists public.event_completions (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null unique references public.events(id) on delete cascade,
    requested_by uuid not null references public.profiles(id) on delete cascade,
    requested_at timestamptz not null default now(),
    reviewed_by uuid references public.profiles(id) on delete set null,
    reviewed_at timestamptz,
    status public.completion_status not null default 'pending',
    notes text
);

create table if not exists public.volunteer_hours (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    volunteer_id uuid not null references public.profiles(id) on delete cascade,
    hours numeric(5,2) not null check (hours > 0 and hours <= 24),
    awarded_at timestamptz not null default now(),
    completion_id uuid not null references public.event_completions(id) on delete cascade,
    unique (event_id, volunteer_id)
);

create table if not exists public.volunteer_achievements (
    id uuid primary key default gen_random_uuid(),
    volunteer_id uuid not null references public.profiles(id) on delete cascade,
    code text not null,
    title text not null,
    description text not null,
    earned_at timestamptz not null default now(),
    unique (volunteer_id, code)
);

alter table public.event_completions enable row level security;
alter table public.volunteer_hours enable row level security;
alter table public.volunteer_achievements enable row level security;

-- The full setup defines this in supabase-admin-controls.sql. Keep this
-- migration safe for deployments that apply the component files separately.
create or replace function public.is_active_user()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
    select auth.uid() is not null and exists (
        select 1 from public.profiles
        where id = auth.uid() and (not is_banned or banned_until is null or banned_until <= now())
    )
$$;
revoke all on function public.is_active_user() from public, anon;
grant execute on function public.is_active_user() to authenticated;

do $$
declare table_name text;
begin
    foreach table_name in array array['event_completions', 'volunteer_hours', 'volunteer_achievements'] loop
        execute format('drop policy if exists active_accounts_only on public.%I', table_name);
        execute format('create policy active_accounts_only on public.%I as restrictive for all to authenticated using (public.is_active_user()) with check (public.is_active_user())', table_name);
    end loop;
end
$$;

drop policy if exists "Completion requests are visible to owners and admins" on public.event_completions;
create policy "Completion requests are visible to owners and admins"
on public.event_completions for select to authenticated
using (requested_by = auth.uid() or public.is_admin());

drop policy if exists "Volunteers can view their awarded hours" on public.volunteer_hours;
create policy "Volunteers can view their awarded hours"
on public.volunteer_hours for select to authenticated
using (volunteer_id = auth.uid() or public.is_admin());

drop policy if exists "Volunteers can view their achievements" on public.volunteer_achievements;
create policy "Volunteers can view their achievements"
on public.volunteer_achievements for select to authenticated
using (volunteer_id = auth.uid() or public.is_admin());

grant select on public.event_completions, public.volunteer_hours, public.volunteer_achievements to authenticated;

create or replace function public.request_event_completion(target_event_id uuid)
returns public.event_completions
language plpgsql
security definer
set search_path = public
as $$
declare
    event_record public.events%rowtype;
    completion_record public.event_completions%rowtype;
begin
    select * into event_record from public.events where id = target_event_id for update;
    if not found then raise exception 'Pasākums nav atrasts'; end if;
    if event_record.creator_id is distinct from auth.uid() then
        raise exception 'Tikai pasākuma organizators var pieteikt noslēgšanu';
    end if;
    if event_record.status <> 'approved'::public.event_status then
        raise exception 'Pasākumam jābūt apstiprinātam';
    end if;
    if event_record.event_date >= (now() at time zone 'Europe/Riga')::date then
        raise exception 'Pasākumu var noslēgt tikai pēc tā norises datuma';
    end if;

    insert into public.event_completions (event_id, requested_by, status, reviewed_by, reviewed_at, notes)
    values (target_event_id, auth.uid(), 'pending', null, null, null)
    on conflict (event_id) do update set
        requested_by = excluded.requested_by,
        requested_at = now(),
        reviewed_by = null,
        reviewed_at = null,
        status = 'pending',
        notes = null
    returning * into completion_record;
    return completion_record;
end;
$$;

create or replace function public.admin_review_event_completion(
    target_completion_id uuid,
    decision public.completion_status,
    review_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    completion_record public.event_completions%rowtype;
    event_record public.events%rowtype;
    volunteer_record record;
    total_hours numeric(7,2);
begin
    if not public.is_admin() then raise exception 'Tikai administrators var pārbaudīt pasākuma noslēgšanu'; end if;
    if decision not in ('approved'::public.completion_status, 'rejected'::public.completion_status) then
        raise exception 'Nederīgs pārbaudes statuss';
    end if;

    select * into completion_record from public.event_completions where id = target_completion_id for update;
    if not found then raise exception 'Noslēgšanas pieprasījums nav atrasts'; end if;
    select * into event_record from public.events where id = completion_record.event_id for update;
    if event_record.status <> 'approved'::public.event_status then raise exception 'Pasākums vairs nav apstiprināts'; end if;
    if event_record.event_date >= (now() at time zone 'Europe/Riga')::date then raise exception 'Pasākuma datums vēl nav pagājis'; end if;

    update public.event_completions
    set status = decision, reviewed_by = auth.uid(), reviewed_at = now(), notes = nullif(btrim(review_notes), '')
    where id = target_completion_id;

    if decision = 'approved'::public.completion_status then
        insert into public.volunteer_hours (event_id, volunteer_id, hours, completion_id)
        select event_record.id, application.volunteer_id, event_record.volunteer_hours, target_completion_id
        from public.event_applications application
        where application.event_id = event_record.id and application.status = 'approved'
        on conflict (event_id, volunteer_id) do nothing;

        for volunteer_record in
            select distinct volunteer_id from public.volunteer_hours where event_id = event_record.id
        loop
            select coalesce(sum(hours), 0) into total_hours
            from public.volunteer_hours where volunteer_id = volunteer_record.volunteer_id;

            if total_hours >= 1 then
                insert into public.volunteer_achievements (volunteer_id, code, title, description)
                values (volunteer_record.volunteer_id, 'first-task', 'Pirmais labais darbs', 'Pabeidzi savu pirmo pārbaudīto pasākumu.')
                on conflict (volunteer_id, code) do nothing;
            end if;
            if total_hours >= 10 then
                insert into public.volunteer_achievements (volunteer_id, code, title, description)
                values (volunteer_record.volunteer_id, 'ten-hours', 'Desmit stundas', 'Sakrāji vismaz 10 pārbaudītas brīvprātīgā darba stundas.')
                on conflict (volunteer_id, code) do nothing;
            end if;
            if total_hours >= 25 then
                insert into public.volunteer_achievements (volunteer_id, code, title, description)
                values (volunteer_record.volunteer_id, 'twenty-five-hours', 'Kopienas balsts', 'Sakrāji vismaz 25 pārbaudītas brīvprātīgā darba stundas.')
                on conflict (volunteer_id, code) do nothing;
            end if;
        end loop;
    end if;
end;
$$;

create or replace function public.my_volunteer_summary()
returns table(total_hours numeric, completed_tasks bigint, achievements jsonb)
language sql
security definer
set search_path = public
stable
as $$
    select
        coalesce((select sum(hours) from public.volunteer_hours where volunteer_id = auth.uid()), 0),
        (select count(*) from public.volunteer_hours where volunteer_id = auth.uid()),
        coalesce((select jsonb_agg(to_jsonb(achievement) order by achievement.earned_at desc)
            from public.volunteer_achievements achievement where achievement.volunteer_id = auth.uid()), '[]'::jsonb)
$$;

revoke all on function public.request_event_completion(uuid) from public, anon;
revoke all on function public.admin_review_event_completion(uuid, public.completion_status, text) from public, anon;
revoke all on function public.my_volunteer_summary() from public, anon;
grant execute on function public.request_event_completion(uuid) to authenticated;
grant execute on function public.admin_review_event_completion(uuid, public.completion_status, text) to authenticated;
grant execute on function public.my_volunteer_summary() to authenticated;

notify pgrst, 'reload schema';
commit;
