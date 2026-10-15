create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

insert into public.profiles (id, display_name)
select id, coalesce(raw_user_meta_data ->> 'display_name', '')
from auth.users
on conflict (id) do nothing;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.signs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  kind text not null check (kind in ('static', 'motion')),
  sign_language text not null default 'LSC' check (length(btrim(sign_language)) between 1 and 32),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  unique (owner_id, name, kind, sign_language)
);

create table if not exists public.sign_samples (
  id uuid primary key default gen_random_uuid(),
  sign_id uuid not null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  client_id text not null check (length(client_id) between 1 and 128),
  hand_count smallint not null default 1 check (hand_count between 1 and 2),
  face_available boolean not null default false,
  format_version smallint not null check (format_version = 1),
  mediapipe_model text not null default 'hand_landmarker_float16_v1',
  processing jsonb not null default '{}'::jsonb,
  handedness text check (handedness in ('Left', 'Right')),
  coordinate_space text not null default 'mediapipe-normalized-image-v1',
  mirrored_display boolean not null default true,
  image_width integer check (image_width is null or image_width > 0),
  image_height integer check (image_height is null or image_height > 0),
  captured_at timestamptz not null default now(),
  payload jsonb,
  storage_path text,
  created_at timestamptz not null default now(),
  foreign key (sign_id, owner_id) references public.signs (id, owner_id) on delete cascade,
  check ((payload is null) <> (storage_path is null)),
  check (storage_path is null or storage_path like (owner_id::text || '/%')),
  check (payload is null or (jsonb_typeof(payload) = 'object' and payload ->> 'formatVersion' = '1')),
  unique (owner_id, client_id)
);

create unique index if not exists sign_samples_storage_path_idx
  on public.sign_samples (storage_path) where storage_path is not null;

create index if not exists signs_owner_idx on public.signs (owner_id);
create index if not exists sign_samples_sign_idx on public.sign_samples (sign_id);
create index if not exists sign_samples_owner_idx on public.sign_samples (owner_id);
create index if not exists sign_samples_captured_idx on public.sign_samples (captured_at desc);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  filter_model text not null default 'first' check (filter_model in ('off', 'first', 'second')),
  tau double precision not null default 0.06 check (tau between 0.01 and 0.3),
  zeta double precision not null default 0.9 check (zeta between 0.2 and 2),
  omega_n double precision not null default 14 check (omega_n between 2 and 30),
  static_tolerance double precision not null default 0.8 check (static_tolerance between 0.3 and 1.5),
  motion_tolerance double precision not null default 0.7 check (motion_tolerance between 0.2 and 2),
  capture_duration double precision not null default 2 check (capture_duration between 1 and 3.5),
  speech_enabled boolean not null default true,
  use_basic_gestures boolean not null default true,
  show_raw_points boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute procedure public.set_updated_at();
drop trigger if exists signs_set_updated_at on public.signs;
create trigger signs_set_updated_at before update on public.signs
  for each row execute procedure public.set_updated_at();
drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at before update on public.user_settings
  for each row execute procedure public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.signs enable row level security;
alter table public.sign_samples enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists "signs_select_own" on public.signs;
create policy "signs_select_own" on public.signs
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists "signs_insert_own" on public.signs;
create policy "signs_insert_own" on public.signs
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists "signs_update_own" on public.signs;
create policy "signs_update_own" on public.signs
  for update to authenticated using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
drop policy if exists "signs_delete_own" on public.signs;
create policy "signs_delete_own" on public.signs
  for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "sign_samples_select_own" on public.sign_samples;
create policy "sign_samples_select_own" on public.sign_samples
  for select to authenticated using (
    (select auth.uid()) = owner_id and exists (
      select 1 from public.signs s where s.id = sign_id and s.owner_id = (select auth.uid())
    )
  );
drop policy if exists "sign_samples_insert_own" on public.sign_samples;
create policy "sign_samples_insert_own" on public.sign_samples
  for insert to authenticated with check (
    (select auth.uid()) = owner_id and exists (
      select 1 from public.signs s where s.id = sign_id and s.owner_id = (select auth.uid())
    )
  );
drop policy if exists "sign_samples_update_own" on public.sign_samples;
create policy "sign_samples_update_own" on public.sign_samples
  for update to authenticated using (
    (select auth.uid()) = owner_id and exists (
      select 1 from public.signs s where s.id = sign_id and s.owner_id = (select auth.uid())
    )
  ) with check (
    (select auth.uid()) = owner_id and exists (
      select 1 from public.signs s where s.id = sign_id and s.owner_id = (select auth.uid())
    )
  );
drop policy if exists "sign_samples_delete_own" on public.sign_samples;
create policy "sign_samples_delete_own" on public.sign_samples
  for delete to authenticated using (
    (select auth.uid()) = owner_id and exists (
      select 1 from public.signs s where s.id = sign_id and s.owner_id = (select auth.uid())
    )
  );

drop policy if exists "user_settings_select_own" on public.user_settings;
create policy "user_settings_select_own" on public.user_settings
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "user_settings_insert_own" on public.user_settings;
create policy "user_settings_insert_own" on public.user_settings
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "user_settings_update_own" on public.user_settings;
create policy "user_settings_update_own" on public.user_settings
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sign-samples', 'sign-samples', false, 4194304, array['application/json'])
on conflict (id) do update set public = false, file_size_limit = 4194304,
  allowed_mime_types = array['application/json'];

drop policy if exists "sign_sample_objects_select_own" on storage.objects;
create policy "sign_sample_objects_select_own" on storage.objects
  for select to authenticated using (
    bucket_id = 'sign-samples' and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "sign_sample_objects_insert_own" on storage.objects;
create policy "sign_sample_objects_insert_own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'sign-samples' and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "sign_sample_objects_delete_own" on storage.objects;
create policy "sign_sample_objects_delete_own" on storage.objects
  for delete to authenticated using (
    bucket_id = 'sign-samples' and (storage.foldername(name))[1] = (select auth.uid())::text
  );

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.signs to authenticated;
grant select, insert, update, delete on public.sign_samples to authenticated;
grant select, insert, update on public.user_settings to authenticated;
