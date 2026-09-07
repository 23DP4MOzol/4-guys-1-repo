-- Voluntio Supabase schema
-- Run this in Supabase SQL Editor before connecting the frontend.

create type public.user_role as enum ('user', 'admin');
create type public.event_status as enum ('pending', 'approved', 'rejected', 'archived');
create type public.application_status as enum ('pending', 'approved', 'rejected');

create table public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    full_name text not null,
    role public.user_role not null default 'user',
    created_at timestamptz not null default now()
);

create table public.events (
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

create table public.event_images (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events(id) on delete cascade,
    storage_path text not null unique,
    sort_order smallint not null default 0 check (sort_order between 0 and 4),
    created_at timestamptz not null default now()
);

create table public.event_applications (
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

create trigger event_image_limit
before insert on public.event_images
for each row execute procedure public.enforce_event_image_limit();

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.event_images enable row level security;
alter table public.event_applications enable row level security;

create policy "Profiles are visible to authenticated users"
on public.profiles for select to authenticated using (true);

create policy "Users can update their own profile"
on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid());

create policy "Authenticated users can request events"
on public.events for insert to authenticated
with check (creator_id = auth.uid() and status = 'pending');

create policy "Everyone can view approved events"
on public.events for select to anon, authenticated
using (status = 'approved' or creator_id = auth.uid() or public.is_admin());

create policy "Creators can update pending events"
on public.events for update to authenticated
using (creator_id = auth.uid() and status = 'pending')
with check (creator_id = auth.uid() and status = 'pending');

create policy "Admins can manage all events"
on public.events for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "Approved event images are public"
on public.event_images for select to anon, authenticated
using (exists (select 1 from public.events where id = event_id and status = 'approved') or public.is_admin());

create policy "Creators can add images to their pending event"
on public.event_images for insert to authenticated
with check (exists (
    select 1 from public.events
    where id = event_id and creator_id = auth.uid() and status = 'pending'
));

create policy "Creators and admins can delete event images"
on public.event_images for delete to authenticated
using (public.is_admin() or exists (
    select 1 from public.events
    where id = event_id and creator_id = auth.uid() and status = 'pending'
));

create policy "Users can apply to approved events"
on public.event_applications for insert to authenticated
with check (
    volunteer_id = auth.uid()
    and exists (select 1 from public.events where id = event_id and status = 'approved')
);

create policy "Volunteers see their applications, creators see event applications"
on public.event_applications for select to authenticated
using (
    volunteer_id = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.events where id = event_id and creator_id = auth.uid())
);

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

create policy "Authenticated users upload event images"
on storage.objects for insert to authenticated
with check (bucket_id = 'event-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users delete their uploaded event images"
on storage.objects for delete to authenticated
using (bucket_id = 'event-images' and owner_id = auth.uid()::text);

-- Promote a trusted account to admin after creating it in Supabase Auth:
-- update public.profiles set role = 'admin' where id = 'AUTH_USER_UUID';
