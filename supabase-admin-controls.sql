-- Apply in the hosted Supabase SQL Editor to enable the admin panel's
-- promote, ban, and unban controls on an existing deployment.
begin;

alter table public.profiles
    add column if not exists banned_until timestamptz;


create or replace function public.is_active_user()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
    select auth.uid() is not null and exists (
        select 1 from public.profiles
        where id = auth.uid()
          and (not is_banned or banned_until is null or banned_until <= now())
    );
$$;
revoke all on function public.is_active_user() from public;
grant execute on function public.is_active_user() to authenticated;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
    select exists (
        select 1 from public.profiles
        where id = auth.uid()
          and role = 'admin'
          and (not is_banned or banned_until is null or banned_until <= now())
    );
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Restrictive rules keep existing ownership/admin permissions while ensuring
-- a banned login cannot continue using a still-valid access token.
do $$
declare table_name text;
begin
    foreach table_name in array array[
        'profiles', 'events', 'event_images', 'event_applications',
        'event_messages', 'event_participant_moderation', 'reports', 'audit_logs'
    ] loop
        execute format('alter table public.%I enable row level security', table_name);
        execute format('drop policy if exists active_accounts_only on public.%I', table_name);
        execute format(
            'create policy active_accounts_only on public.%I as restrictive for all to authenticated using (public.is_active_user()) with check (public.is_active_user())',
            table_name
        );
    end loop;
end
$$;
drop policy if exists active_accounts_only on public.profiles;
create policy active_accounts_only on public.profiles as restrictive
for all to authenticated
using (public.is_active_user() or id = auth.uid())
with check (public.is_active_user());
drop policy if exists "Profiles are visible to authenticated users" on public.profiles;
create policy "Profiles are visible to authenticated users"
on public.profiles for select to authenticated
using (public.is_active_user());
drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
on public.profiles for select to authenticated
using (id = auth.uid());
alter table storage.objects enable row level security;
drop policy if exists active_accounts_only on storage.objects;
create policy active_accounts_only on storage.objects as restrictive
for all to authenticated
using (public.is_active_user())
with check (public.is_active_user());

-- Definer RPCs also need a write guard because they bypass RLS policies.
create or replace function public.reject_banned_account_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is not null and not public.is_active_user() then
        raise exception 'This account is blocked from using Voluntio';
    end if;
    return new;
end;
$$;
do $$
declare table_name text;
begin
    foreach table_name in array array[
        'profiles', 'events', 'event_images', 'event_applications',
        'event_messages', 'event_participant_moderation', 'reports', 'audit_logs'
    ] loop
        execute format('drop trigger if exists active_account_writes on public.%I', table_name);
        execute format('create trigger active_account_writes before insert or update on public.%I for each row execute function public.reject_banned_account_writes()', table_name);
    end loop;
end
$$;

create or replace function public.admin_set_user_role(
    target_user_id uuid,
    target_role public.user_role
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
    if not public.is_admin() then
        raise exception 'Only administrators can change user roles';
    end if;
    if target_user_id is null then
        raise exception 'Select a user';
    end if;
    if target_user_id = auth.uid() and target_role <> 'admin' then
        raise exception 'You cannot remove your own administrator role';
    end if;

    update public.profiles
    set role = target_role
    where id = target_user_id;

    if not found then
        raise exception 'User not found';
    end if;
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'admin_set_role', 'profiles', target_user_id,
        jsonb_build_object('role_to', target_role));
end;
$$;

drop function if exists public.admin_set_user_banned(uuid, boolean);

create or replace function public.admin_set_user_banned(
    target_user_id uuid,
    should_ban boolean,
    ban_hours integer default null
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    ban_expiry timestamptz;
begin
    if not public.is_admin() then
        raise exception 'Only administrators can ban users';
    end if;
    if target_user_id is null then
        raise exception 'Select a user';
    end if;
    if target_user_id = auth.uid() then
        raise exception 'You cannot ban yourself';
    end if;
    if should_ban and ban_hours is not null and ban_hours <= 0 then
        raise exception 'Ban duration must be positive';
    end if;

    ban_expiry := case
        when should_ban then coalesce(now() + make_interval(hours => ban_hours), 'infinity'::timestamptz)
        else null
    end;

    update public.profiles
    set is_banned = should_ban,
        banned_until = ban_expiry
    where id = target_user_id;

    if not found then
        raise exception 'User not found';
    end if;

    -- Keep Supabase Auth in sync so a blocked account cannot keep using its
    -- existing login session. The Auth table is only touched by this definer.
    update auth.users
    set banned_until = ban_expiry
    where id = target_user_id;
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), case when should_ban then 'admin_ban' else 'admin_unban' end, 'profiles', target_user_id,
        jsonb_build_object('is_banned', should_ban, 'banned_until', ban_expiry));
end;
$$;

revoke all on function public.admin_set_user_role(uuid, public.user_role) from public, anon;
revoke all on function public.admin_set_user_banned(uuid, boolean, integer) from public, anon;
grant execute on function public.admin_set_user_role(uuid, public.user_role) to authenticated;
grant execute on function public.admin_set_user_banned(uuid, boolean, integer) to authenticated;

notify pgrst, 'reload schema';
commit;
