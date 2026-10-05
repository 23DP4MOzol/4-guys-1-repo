-- Apply after the base schema and supabase-event-images.sql.
begin;

-- Only the organizer RPC can change moderation state.
alter table public.event_participant_moderation enable row level security;

create or replace function public.event_today()
returns date language sql stable set search_path = public
as $$ select (now() at time zone 'Europe/Riga')::date $$;

create or replace function public.organizer_set_participant_state(event_id uuid, participant_id uuid, action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    target_event_id alias for $1;
    target_participant_id alias for $2;
    requested_action text := lower(btrim(action));
    application_record public.event_applications%rowtype;
    event_record public.events%rowtype;
begin
    if requested_action not in ('kick', 'mute', 'unmute') then
        raise exception 'Action must be kick, mute, or unmute';
    end if;

    -- Lock in the same application-then-event order as application approval
    -- to avoid a deadlock when an organizer reviews and moderates together.
    select * into application_record
    from public.event_applications application
    where application.event_id = target_event_id
      and application.volunteer_id = target_participant_id
    for update;
    if not found or application_record.status <> 'approved'::public.application_status then
        raise exception 'Only approved participants can be moderated';
    end if;

    select * into event_record
    from public.events event_record_source
    where event_record_source.id = application_record.event_id
    for update;
    if not found then
        raise exception 'Event not found';
    end if;

    if event_record.creator_id is distinct from auth.uid() then
        raise exception 'Only this event organizer can moderate participants';
    end if;

    if target_participant_id = event_record.creator_id then
        raise exception 'The event organizer cannot be moderated as a participant';
    end if;

    if requested_action = 'kick' then
        update public.event_applications
        set status = 'rejected'::public.application_status
        where id = application_record.id;
    elsif requested_action = 'mute' then
        insert into public.event_participant_moderation (
            event_id, participant_id, is_muted, muted_at, muted_by, updated_at
        ) values (
            event_record.id, target_participant_id, true, now(), auth.uid(), now()
        )
        on conflict on constraint event_participant_moderation_pkey do update
        set is_muted = true,
            muted_at = now(),
            muted_by = auth.uid(),
            updated_at = now();
    else
        insert into public.event_participant_moderation (
            event_id, participant_id, is_muted, muted_at, muted_by, updated_at
        ) values (
            event_record.id, target_participant_id, false, null, auth.uid(), now()
        )
        on conflict on constraint event_participant_moderation_pkey do update
        set is_muted = false,
            muted_at = null,
            muted_by = auth.uid(),
            updated_at = now();
    end if;

    insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
    values (
        auth.uid(),
        'event_participant_' || requested_action,
        'event_participant',
        target_participant_id,
        jsonb_build_object('event_id', event_record.id, 'participant_id', target_participant_id)
    );
end;
$$;

create or replace function public.set_event_application_status(application_id uuid, new_status public.application_status)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    application_record public.event_applications%rowtype;
    event_record public.events%rowtype;
    role_capacity integer;
    filled_count integer;
begin
    select * into application_record from public.event_applications where id = application_id for update;
    if not found then raise exception 'Application not found'; end if;
    select * into event_record from public.events where id = application_record.event_id for update;
    if event_record.creator_id is distinct from auth.uid() then raise exception 'Only the event organizer can review applications'; end if;
    if new_status = 'approved' then
        if event_record.status = 'archived' or event_record.event_date < public.event_today() then raise exception 'Pasākums ir beidzies vai atcelts'; end if;
        if application_record.requested_role is null or btrim(application_record.requested_role) = '' then
            raise exception 'The volunteer must select a role';
        end if;
        select nullif(role_item ->> 'capacity', '')::integer into role_capacity
        from jsonb_array_elements(event_record.volunteer_role_requirements) role_item
        where role_item ->> 'name' = application_record.requested_role;
        if coalesce(role_capacity, 0) < 1 then raise exception 'This role is no longer available'; end if;
        select count(*) into filled_count from public.event_applications
        where event_id = event_record.id and requested_role = application_record.requested_role and status = 'approved'
        and id <> application_record.id;
        if filled_count >= role_capacity then raise exception 'All places for this role are already filled'; end if;
    end if;
    update public.event_applications set status = new_status where id = application_id;
end;
$$;

create or replace function public.enforce_future_event_date()
returns trigger language plpgsql set search_path = public
as $$
begin
    if new.event_date is null or new.event_date < public.event_today() then
        raise exception 'Pasākuma datumam jābūt šodien vai nākotnē.';
    end if;
    return new;
end;
$$;
drop trigger if exists event_date_must_not_be_past on public.events;
create trigger event_date_must_not_be_past before insert or update of event_date on public.events
for each row execute function public.enforce_future_event_date();

drop policy if exists "Users can apply to approved events" on public.event_applications;
create policy "Users can apply to approved events" on public.event_applications for insert to authenticated
with check (volunteer_id = auth.uid() and status = 'pending' and exists (
    select 1 from public.events where id = event_id and status = 'approved'
    and event_date >= public.event_today() and creator_id <> auth.uid()
) and exists (select 1 from public.profiles where id = auth.uid() and not is_banned));

-- One RLS-safe source of chat permissions, shared by the UI and message policies.
create or replace function public.event_chat_access(target_event_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp stable
as $$
declare
    event_record public.events%rowtype;
    application_status public.application_status;
    muted boolean;
begin
    if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid() and not is_banned) then
        return jsonb_build_object('can_read', false, 'can_write', false, 'reason', 'sign_in');
    end if;
    select * into event_record from public.events where id = target_event_id;
    if not found or event_record.status = 'archived' or event_record.event_date < public.event_today() then
        return jsonb_build_object('can_read', false, 'can_write', false, 'reason', 'ended');
    end if;
    if event_record.creator_id = auth.uid() then
        return jsonb_build_object('can_read', true, 'can_write', true, 'reason', 'organizer');
    end if;
    select status into application_status from public.event_applications
    where event_id = target_event_id and volunteer_id = auth.uid();
    if application_status is distinct from 'approved'::public.application_status then
        return jsonb_build_object('can_read', false, 'can_write', false, 'reason', coalesce(application_status::text, 'not_joined'));
    end if;
    select coalesce(is_muted, false) into muted from public.event_participant_moderation
    where event_id = target_event_id and participant_id = auth.uid();
    return jsonb_build_object('can_read', true, 'can_write', not coalesce(muted, false), 'reason', case when muted then 'muted' else 'participant' end);
end;
$$;
revoke all on function public.event_chat_access(uuid) from public, anon;
grant execute on function public.event_chat_access(uuid) to authenticated;

drop policy if exists "Event participants can read messages" on public.event_messages;
create policy "Event participants can read messages" on public.event_messages for select to authenticated
using ((public.event_chat_access(event_id)->>'can_read')::boolean);
drop policy if exists "Event participants can send messages" on public.event_messages;
create policy "Event participants can send messages" on public.event_messages for insert to authenticated
with check (sender_id = auth.uid() and (public.event_chat_access(event_id)->>'can_write')::boolean);

create or replace function public.validate_event_message()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
    -- Serialize sends with event cancellation so a late send cannot recreate its chat.
    perform 1 from public.events where id = new.event_id for share;
    if new.sender_id is distinct from auth.uid() or not (public.event_chat_access(new.event_id)->>'can_write')::boolean then
        raise exception 'Tev nav atļauts rakstīt šī pasākuma čatā.';
    end if;
    new.message := btrim(new.message);
    if new.message is null or char_length(new.message) not between 1 and 1000 then
        raise exception 'Ziņai jābūt no 1 līdz 1000 rakstzīmēm.';
    end if;
    return new;
end;
$$;
drop trigger if exists validate_event_message on public.event_messages;
create trigger validate_event_message before insert on public.event_messages
for each row execute function public.validate_event_message();

create or replace function public.clear_closed_event_chat()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
    if new.status = 'archived' or new.event_date < public.event_today() then
        delete from public.event_messages where event_id = new.id;
    end if;
    return new;
end;
$$;
drop trigger if exists clear_closed_event_chat on public.events;
create trigger clear_closed_event_chat after update of status, event_date on public.events
for each row execute function public.clear_closed_event_chat();
-- Hard deletion already cascades through event_messages.event_id.

create index if not exists audit_logs_actor_created_idx on public.audit_logs(actor_id, created_at desc, id desc);
create index if not exists audit_logs_created_idx on public.audit_logs(created_at);
create index if not exists event_messages_event_created_idx on public.event_messages(event_id, created_at);

-- Store concise activity metadata, not copies of message bodies or report evidence.
create or replace function public.record_user_activity()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare
    before_record jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
    after_record jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
    record_data jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
    changed text[];
begin
    if auth.uid() is null then return null; end if;
    if tg_table_name = 'event_messages' and tg_op = 'DELETE' and not exists (
        select 1 from public.events where id = (record_data->>'event_id')::uuid
        and status <> 'archived' and event_date >= public.event_today()
    ) then return null; end if;
    select array_agg(key order by key) into changed from jsonb_object_keys(after_record || before_record) key
    where after_record->key is distinct from before_record->key;
    if tg_op = 'UPDATE' and changed is null then return null; end if;
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), tg_op, tg_table_name, (record_data->>'id')::uuid,
        jsonb_strip_nulls(jsonb_build_object('title', record_data->>'title', 'event_id', record_data->>'event_id',
        'status_from', before_record->>'status', 'status_to', after_record->>'status', 'changed_fields', to_jsonb(changed))));
    return null;
end;
$$;
do $$
declare table_name text;
begin
    foreach table_name in array array['events', 'event_applications', 'event_messages', 'profiles', 'reports'] loop
        execute format('drop trigger if exists record_user_activity on public.%I', table_name);
        execute format('create trigger record_user_activity after insert or update or delete on public.%I for each row execute function public.record_user_activity()', table_name);
    end loop;
end;
$$;
drop policy if exists "Authenticated users create audit logs" on public.audit_logs;
-- Audit records are written by trusted triggers/functions, never arbitrary browser inserts.

create or replace function public.admin_clear_user_audit(target_user_id uuid)
returns bigint language plpgsql security definer set search_path = public, pg_temp
as $$
declare deleted_count bigint;
begin
    if not public.is_admin() or not exists (select 1 from public.profiles where id = auth.uid() and not is_banned) then
        raise exception 'Only administrators can clear audit logs';
    end if;
    if target_user_id is null then raise exception 'Select a user'; end if;
    delete from public.audit_logs where actor_id = target_user_id;
    get diagnostics deleted_count = row_count;
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'cleared_user_audit', 'audit', target_user_id, jsonb_build_object('deleted_count', deleted_count));
    return deleted_count;
end;
$$;
revoke all on function public.admin_clear_user_audit(uuid) from public, anon;
grant execute on function public.admin_clear_user_audit(uuid) to authenticated;

create or replace function public.cleanup_event_data()
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
    delete from public.event_messages message using public.events event
    where message.event_id = event.id and (event.status = 'archived' or event.event_date < public.event_today());
    delete from public.audit_logs where created_at < now() - interval '14 days';
end;
$$;
revoke all on function public.cleanup_event_data() from public, anon, authenticated;
-- SQL Editor/job owner only. Apply retention immediately to existing records, too.
select public.cleanup_event_data();

alter table public.event_messages replica identity full;
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') and not exists (
        select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'event_messages'
    ) then
        alter publication supabase_realtime add table public.event_messages;
    end if;
end;
$$;
commit;
