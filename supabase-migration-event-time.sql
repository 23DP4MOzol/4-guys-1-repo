-- Run this once in the live Supabase SQL Editor before using the updated frontend.
-- Existing events receive a 09:00-10:00 schedule.
begin;

alter table public.events
    add column if not exists event_start_time time not null default '09:00';

alter table public.events
    add column if not exists event_end_time time not null default '10:00';

alter table public.events
    add column if not exists event_started_at timestamptz;

alter table public.events
    drop constraint if exists events_schedule_check;

alter table public.events
    add constraint events_schedule_check check (
        event_start_time between '00:00'::time and '23:00'::time
        and event_end_time between '00:00'::time and '23:00'::time
        and event_end_time > event_start_time
    );

drop function if exists public.public_user_profile_summary(uuid);

create or replace function public.public_user_profile_summary(target_user_id uuid)
returns table(
    id uuid,
    full_name text,
    avatar_path text,
    role public.user_role,
    created_at timestamptz,
    completed_tasks bigint,
    events_count bigint,
    public_summary text
)
language sql
security definer
set search_path = public
stable
as $$
    select
        profile_record.id,
        profile_record.full_name,
        profile_record.avatar_path,
        profile_record.role,
        profile_record.created_at,
        coalesce((select count(*)
            from public.event_applications application
            where application.volunteer_id = profile_record.id
              and application.status = 'approved'), 0)::bigint,
        coalesce((select count(*)
            from public.events event_record
            where event_record.creator_id = profile_record.id
              and event_record.status = 'approved'), 0)::bigint,
        case
            when exists (select 1
                from public.event_applications application
                where application.volunteer_id = profile_record.id
                  and application.status = 'approved')
                then 'Aktīvi palīdz kopienas pasākumos un iesaistās labas lietas veidošanā.'
            else 'Jaunais kopienas biedrs — vēl tikai gaida savu pirmo pasākumu.'
        end
    from public.profiles profile_record
    where profile_record.id = target_user_id
      and (not profile_record.is_banned
        or profile_record.banned_until is null
        or profile_record.banned_until <= now());
$$;

revoke execute on function public.public_user_profile_summary(uuid) from public;
grant execute on function public.public_user_profile_summary(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
