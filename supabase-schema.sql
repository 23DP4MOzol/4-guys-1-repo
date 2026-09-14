-- Voluntio Supabase schema
-- Run this in Supabase SQL Editor before connecting the frontend.

create extension if not exists pgcrypto;

do $$
begin
    create type public.user_role as enum ('user', 'admin');
exception
    when duplicate_object then null;
end
$$;

do $$
begin
    create type public.event_status as enum ('pending', 'approved', 'rejected', 'archived');
exception
    when duplicate_object then null;
end
$$;

do $$
begin
    create type public.application_status as enum ('pending', 'approved', 'rejected');
exception
    when duplicate_object then null;
end
$$;

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    full_name text not null,
    role public.user_role not null default 'user',
    is_banned boolean not null default false,
    created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists is_banned boolean not null default false;

create table if not exists public.events (
    id uuid primary key default gen_random_uuid(),
    creator_id uuid not null references public.profiles(id) on delete cascade,
    title text not null check (char_length(title) between 3 and 120),
    category text not null,
    event_date date not null,
    location text not null,
    volunteer_roles text,
    description text not null,
    whitelist_volunteers boolean not null default false,
    status public.event_status not null default 'pending',
    reviewed_by uuid references public.profiles(id) on delete set null,
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
);

alter table public.events add column if not exists whitelist_volunteers boolean not null default false;

create table if not exists public.event_images (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    storage_path text not null unique,
    sort_order smallint not null default 0 check (sort_order between 0 and 4),
    created_at timestamptz not null default now()
);

create table if not exists public.event_applications (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    volunteer_id uuid not null references public.profiles(id) on delete cascade,
    message text,
    status public.application_status not null default 'pending',
    created_at timestamptz not null default now(),
    unique (event_id, volunteer_id)
);

create table if not exists public.event_messages (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    sender_id uuid not null references public.profiles(id) on delete cascade,
    message text not null check (char_length(message) between 1 and 1000),
    created_at timestamptz not null default now()
);

create table if not exists public.reports (
    id uuid primary key default gen_random_uuid(),
    reporter_id uuid not null references public.profiles(id) on delete cascade,
    reported_user_id uuid references public.profiles(id) on delete set null,
    event_id uuid references public.events(id) on delete set null,
    reason text not null check (reason in ('fake_event', 'harassment', 'scam', 'inappropriate', 'dangerous_location', 'other')),
    evidence text,
    priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
    status text not null default 'open' check (status in ('open', 'investigating', 'resolved', 'dismissed')),
    resolution text,
    created_at timestamptz not null default now(),
    resolved_at timestamptz,
    resolved_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.audit_logs (
    id uuid primary key default gen_random_uuid(),
    actor_id uuid references public.profiles(id) on delete set null,
    action text not null,
    entity_type text not null,
    entity_id uuid,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
    select exists (
        select 1 from public.profiles
        where id = auth.uid() and role = 'admin'
    );
$$;

create or replace function public.admin_set_user_role(target_user_id uuid, target_role public.user_role)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
    if not public.is_admin() then
        raise exception 'Only administrators can change user roles';
    end if;
    if target_user_id = auth.uid() and target_role <> 'admin' then
        raise exception 'You cannot remove your own administrator role';
    end if;
    update public.profiles set role = target_role where id = target_user_id;
end;
$$;

create or replace function public.admin_set_user_banned(target_user_id uuid, should_ban boolean)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
    if not public.is_admin() then
        raise exception 'Only administrators can ban users';
    end if;
    if target_user_id = auth.uid() then
        raise exception 'You cannot ban yourself';
    end if;
    update public.profiles set is_banned = should_ban where id = target_user_id;
    update auth.users
    set banned_until = case when should_ban then 'infinity'::timestamptz else null end
    where id = target_user_id;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, full_name)
    values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)));
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.enforce_event_image_limit()
returns trigger
language plpgsql
as $$
begin
    if (select count(*) from public.event_images where event_id = new.event_id) >= 5 then
        raise exception 'An event can have at most 5 images';
    end if;
    return new;
end;
$$;

drop trigger if exists event_image_limit on public.event_images;
create trigger event_image_limit
before insert on public.event_images
for each row execute procedure public.enforce_event_image_limit();

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.event_images enable row level security;
alter table public.event_applications enable row level security;
alter table public.event_messages enable row level security;
alter table public.reports enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "Profiles are visible to authenticated users" on public.profiles;
create policy "Profiles are visible to authenticated users"
on public.profiles for select to authenticated using (true);

drop policy if exists "Users can update their own profile" on public.profiles;

create or replace function public.update_my_profile(new_full_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if char_length(trim(new_full_name)) < 2 or char_length(trim(new_full_name)) > 120 then
        raise exception 'Name must be between 2 and 120 characters';
    end if;
    update public.profiles set full_name = trim(new_full_name) where id = auth.uid();
end;
$$;

create or replace function public.export_my_data()
returns jsonb
language sql
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'profile', (select to_jsonb(profile) from public.profiles profile where profile.id = auth.uid()),
        'events', coalesce((select jsonb_agg(to_jsonb(event_record)) from public.events event_record where event_record.creator_id = auth.uid()), '[]'::jsonb),
        'applications', coalesce((select jsonb_agg(to_jsonb(application_record)) from public.event_applications application_record where application_record.volunteer_id = auth.uid()), '[]'::jsonb)
    );
$$;

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
    delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.update_my_profile(text) from public;
revoke execute on function public.export_my_data() from public;
revoke execute on function public.delete_my_account() from public;
grant execute on function public.update_my_profile(text) to authenticated;
grant execute on function public.export_my_data() to authenticated;
grant execute on function public.delete_my_account() to authenticated;

drop policy if exists "Authenticated users can request events" on public.events;
create policy "Authenticated users can request events"
on public.events for insert to authenticated
with check (creator_id = auth.uid() and status = 'pending');

drop policy if exists "Creators can manage their events" on public.events;
create policy "Creators can manage their events"
on public.events for update to authenticated
using (creator_id = auth.uid()) with check (creator_id = auth.uid());

drop policy if exists "Everyone can view approved events" on public.events;
create policy "Everyone can view approved events"
on public.events for select to anon, authenticated
using (status = 'approved' or creator_id = auth.uid() or public.is_admin());

drop policy if exists "Creators can update pending events" on public.events;
create policy "Creators can update pending events"
on public.events for update to authenticated
using (creator_id = auth.uid() and status = 'pending')
with check (creator_id = auth.uid() and status = 'pending');

drop policy if exists "Admins can manage all events" on public.events;
create policy "Admins can manage all events"
on public.events for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Approved event images are public" on public.event_images;
create policy "Approved event images are public"
on public.event_images for select to anon, authenticated
using (exists (select 1 from public.events where id = event_id and status = 'approved') or public.is_admin());

drop policy if exists "Creators can add images to their pending event" on public.event_images;
create policy "Creators can add images to their pending event"
on public.event_images for insert to authenticated
with check (exists (
    select 1 from public.events
    where id = event_id and creator_id = auth.uid() and status = 'pending'
));

drop policy if exists "Creators and admins can delete event images" on public.event_images;
create policy "Creators and admins can delete event images"
on public.event_images for delete to authenticated
using (public.is_admin() or exists (
    select 1 from public.events
    where id = event_id and creator_id = auth.uid() and status = 'pending'
));

drop policy if exists "Users can apply to approved events" on public.event_applications;
create policy "Users can apply to approved events"
on public.event_applications for insert to authenticated
with check (
    volunteer_id = auth.uid()
    and exists (select 1 from public.events where id = event_id and status = 'approved')
);

drop policy if exists "Volunteers see their applications, creators see event applications" on public.event_applications;
create policy "Volunteers see their applications, creators see event applications"
on public.event_applications for select to authenticated
using (
    volunteer_id = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.events where id = event_id and creator_id = auth.uid())
);

drop policy if exists "Admins and event creators can update applications" on public.event_applications;
create policy "Admins and event creators can update applications"
on public.event_applications for update to authenticated
using (
    public.is_admin()
    or exists (select 1 from public.events where id = event_id and creator_id = auth.uid())
)
with check (true);

drop policy if exists "Event participants can read messages" on public.event_messages;
create policy "Event participants can read messages"
on public.event_messages for select to authenticated
using (
    sender_id = auth.uid()
    or exists (select 1 from public.events where id = event_id and creator_id = auth.uid())
    or exists (select 1 from public.event_applications where event_id = event_messages.event_id and volunteer_id = auth.uid() and status = 'approved')
);

drop policy if exists "Event participants can send messages" on public.event_messages;
create policy "Event participants can send messages"
on public.event_messages for insert to authenticated
with check (
    sender_id = auth.uid()
    and (exists (select 1 from public.events where id = event_id and creator_id = auth.uid())
    or exists (select 1 from public.event_applications where event_id = event_messages.event_id and volunteer_id = auth.uid() and status = 'approved'))
);

drop policy if exists "Organizers can remove messages" on public.event_messages;
create policy "Organizers can remove messages"
on public.event_messages for delete to authenticated
using (exists (select 1 from public.events where id = event_id and creator_id = auth.uid()));

drop policy if exists "Users can submit reports" on public.reports;
create policy "Users can submit reports"
on public.reports for insert to authenticated
with check (reporter_id = auth.uid());

drop policy if exists "Reporters see their reports" on public.reports;
create policy "Reporters see their reports"
on public.reports for select to authenticated
using (reporter_id = auth.uid() or public.is_admin());

drop policy if exists "Admins manage reports" on public.reports;
create policy "Admins manage reports"
on public.reports for update to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins view audit logs" on public.audit_logs;
create policy "Admins view audit logs"
on public.audit_logs for select to authenticated
using (public.is_admin());

drop policy if exists "Authenticated users create audit logs" on public.audit_logs;
create policy "Authenticated users create audit logs"
on public.audit_logs for insert to authenticated
with check (actor_id = auth.uid());

insert into storage.buckets (id, name, public)
values ('event-images', 'event-images', true)
on conflict (id) do nothing;

drop policy if exists "Anyone can view approved event images" on storage.objects;
create policy "Anyone can view approved event images"
on storage.objects for select to anon, authenticated
using (
    bucket_id = 'event-images'
    and exists (
        select 1 from public.event_images image
        join public.events event on event.id = image.event_id
        where image.storage_path = name and event.status = 'approved'
    )
);

drop policy if exists "Authenticated users upload event images" on storage.objects;
create policy "Authenticated users upload event images"
on storage.objects for insert to authenticated
with check (bucket_id = 'event-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users delete their uploaded event images" on storage.objects;
create policy "Users delete their uploaded event images"
on storage.objects for delete to authenticated
using (bucket_id = 'event-images' and owner_id = auth.uid()::text);

-- Create Auth users from Supabase Dashboard > Authentication > Users.
-- Do not insert directly into auth.users; Supabase Auth manages that table.
-- After creating an account, promote it with:
-- update public.profiles set role = 'admin'
-- where id = (select id from auth.users where email = 'admin@example.com');
