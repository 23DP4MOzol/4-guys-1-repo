-- Run this in the Supabase SQL Editor with the project database role.
-- The anon key cannot create Auth users.

create extension if not exists pgcrypto;

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

select id, email, email_confirmed_at
from auth.users
where email in ('admin.test@voluntio.lv', 'user.test@voluntio.lv')
order by email;
