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
    created_at timestamptz not null default now()
);

create table if not exists public.events (
    id uuid primary key default gen_random_uuid(),
    creator_id uuid not null references public.profiles(id) on delete cascade,
    title text not null check (char_length(title) between 3 and 120),
    category text not null,
    event_date date not null,
    location text not null,
    volunteer_roles text,
    description text not null,
    status public.event_status not null default 'pending',
    reviewed_by uuid references public.profiles(id) on delete set null,
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
);

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

drop policy if exists "Profiles are visible to authenticated users" on public.profiles;
create policy "Profiles are visible to authenticated users"
on public.profiles for select to authenticated using (true);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "Authenticated users can request events" on public.events;
create policy "Authenticated users can request events"
on public.events for insert to authenticated
with check (creator_id = auth.uid() and status = 'pending');

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

-- Promote a trusted account to admin after creating it in Supabase Auth:
-- update public.profiles set role = 'admin' where id = 'AUTH_USER_UUID';

-- Seed test accounts. Run this section with Supabase SQL Editor privileges.
insert into auth.users (
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
)
values
(
    '00000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'admin.test@voluntio.lv',
    crypt('VoluntioTestAdmin2026', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Test Admin"}'::jsonb,
    now(),
    now()
),
(
    '00000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'user.test@voluntio.lv',
    crypt('VoluntioTestUser2026', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Test User"}'::jsonb,
    now(),
    now()
)
on conflict (id) do update set
    email = excluded.email,
    encrypted_password = excluded.encrypted_password,
    email_confirmed_at = excluded.email_confirmed_at,
    raw_user_meta_data = excluded.raw_user_meta_data,
    updated_at = now();

insert into public.profiles (id, full_name, role)
values
    ('00000000-0000-4000-8000-000000000001', 'Test Admin', 'admin'),
    ('00000000-0000-4000-8000-000000000002', 'Test User', 'user')
on conflict (id) do update set
    full_name = excluded.full_name,
    role = excluded.role;
