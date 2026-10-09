-- Run once in the Supabase SQL Editor for an existing deployment.
-- Also included in supabase-schema.sql for new deployments.
begin;

alter table public.event_images add column if not exists original_storage_path text;
update public.event_images set original_storage_path = storage_path where original_storage_path is null;
alter table public.event_images alter column original_storage_path set not null;

drop policy if exists "Approved event images are public" on public.event_images;
create policy "Approved event images are public"
on public.event_images for select to anon, authenticated
using (exists (
    select 1 from public.events
    where id = event_id and (status in ('approved', 'archived') or creator_id = auth.uid())
) or public.is_admin());

drop policy if exists "Anyone can view approved event images" on storage.objects;
create policy "Anyone can view approved event images"
on storage.objects for select to anon, authenticated
using (bucket_id = 'event-images' and (
    owner_id = auth.uid()::text or exists (
        select 1 from public.event_images image
        join public.events event on event.id = image.event_id
                where (image.storage_path = name or image.original_storage_path = name)
                    and (event.status in ('approved', 'archived') or event.creator_id = auth.uid())
    ) or public.is_admin()
));

-- One transaction commits event fields, image order, additions and removals.
-- On any validation/storage-reference error, the previous event stays intact.
create or replace function public.save_event_with_images(
    target_event_id uuid, event_data jsonb, image_paths text[], original_image_paths text[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    actor uuid := auth.uid();
    existing_creator uuid;
    roles jsonb := event_data->'volunteer_role_requirements';
    latitude_value double precision := nullif(trim(event_data->>'latitude'), '')::double precision;
    longitude_value double precision := nullif(trim(event_data->>'longitude'), '')::double precision;
begin
    if actor is null or not exists (
        select 1 from public.profiles where id = actor and not is_banned
    ) then
        raise exception 'Sign in with an active account to save an event';
    end if;
    if target_event_id is null then raise exception 'Event ID is required'; end if;
    if image_paths is null or original_image_paths is null or cardinality(image_paths) > 5 or
        cardinality(original_image_paths) <> cardinality(image_paths) or
        exists (select 1 from unnest(image_paths) path where path is null) or
        exists (select 1 from unnest(original_image_paths) path where path is null) or
        cardinality(image_paths) <> (select count(distinct path) from unnest(image_paths) path) or
        cardinality(original_image_paths) <> (select count(distinct path) from unnest(original_image_paths) path) then
        raise exception 'Choose at most five different images';
    end if;
    if nullif(trim(event_data->>'category'), '') is null or
        nullif(trim(event_data->>'location'), '') is null or
        nullif(trim(event_data->>'description'), '') is null or
        latitude_value is null or longitude_value is null or
        not (latitude_value between -90 and 90) or not (longitude_value between -180 and 180) then
        raise exception 'Choose a location from the map or search results before saving';
    end if;
    if roles is null or jsonb_typeof(roles) <> 'array' then
        raise exception 'Volunteer roles must be an array';
    end if;
    if jsonb_array_length(roles) = 0 or exists (
        select 1 from jsonb_array_elements(roles) role
        where nullif(trim(role->>'name'), '') is null or
            coalesce(role->>'capacity', '') !~ '^[1-9][0-9]{0,2}$'
    ) then
        raise exception 'Provide at least one role with a capacity from 1 to 999';
    end if;

    -- Serialize retries, including concurrent requests creating the same UUID.
    perform pg_advisory_xact_lock(hashtextextended(target_event_id::text, 0));
    select creator_id into existing_creator from public.events where id = target_event_id for update;
    if found and existing_creator <> actor then
        raise exception 'Only the event creator can edit this event';
    end if;
    if exists (
        select 1 from unnest(image_paths) path
        where split_part(path, '/', 1) <> actor::text or not exists (
            select 1 from storage.objects object
            where object.bucket_id = 'event-images' and object.name = path and object.owner_id = actor::text
        )
    ) or exists (
        select 1 from unnest(original_image_paths) path
        where split_part(path, '/', 1) <> actor::text or not exists (
            select 1 from storage.objects object
            where object.bucket_id = 'event-images' and object.name = path and object.owner_id = actor::text
        )
    ) then
        raise exception 'Upload each image to your own storage before saving';
    end if;

    insert into public.events (id, creator_id, title, category, event_date, location,
        latitude, longitude, volunteer_roles, volunteer_role_requirements, description, whitelist_volunteers, status)
    values (target_event_id, actor, trim(event_data->>'title'), event_data->>'category',
        (event_data->>'event_date')::date, trim(event_data->>'location'),
        latitude_value, longitude_value,
        event_data->>'volunteer_roles', roles, trim(event_data->>'description'),
        coalesce((event_data->>'whitelist_volunteers')::boolean, false), 'pending')
    on conflict (id) do update set
        title = excluded.title, category = excluded.category, event_date = excluded.event_date,
        location = excluded.location, latitude = excluded.latitude, longitude = excluded.longitude,
        volunteer_roles = excluded.volunteer_roles, volunteer_role_requirements = excluded.volunteer_role_requirements,
        description = excluded.description, whitelist_volunteers = excluded.whitelist_volunteers,
        status = case when public.events.status = 'approved'::public.event_status
            then 'approved'::public.event_status else 'pending'::public.event_status end,
        reviewed_by = case when public.events.status = 'approved'::public.event_status then public.events.reviewed_by else null end,
        reviewed_at = case when public.events.status = 'approved'::public.event_status then public.events.reviewed_at else null end;

    delete from public.event_images where event_id = target_event_id;
    insert into public.event_images (event_id, storage_path, original_storage_path, sort_order)
    select target_event_id, images.path, originals.path, (images.position - 1)::smallint
    from unnest(image_paths) with ordinality as images(path, position)
    join unnest(original_image_paths) with ordinality as originals(path, position)
        on originals.position = images.position;
    return target_event_id;
end;
$$;

create or replace function public.save_event_with_images(
    target_event_id uuid, event_data jsonb, image_paths text[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    return public.save_event_with_images(target_event_id, event_data, image_paths, image_paths);
end;
$$;

revoke all on function public.save_event_with_images(uuid, jsonb, text[]), public.save_event_with_images(uuid, jsonb, text[], text[]) from public, anon;
grant execute on function public.save_event_with_images(uuid, jsonb, text[]), public.save_event_with_images(uuid, jsonb, text[], text[]) to authenticated;

commit;
