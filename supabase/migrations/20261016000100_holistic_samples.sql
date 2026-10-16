alter table public.sign_samples
  drop constraint if exists sign_samples_format_version_check;

alter table public.sign_samples
  add constraint sign_samples_format_version_check
  check (format_version in (1, 2));

alter table public.sign_samples
  add column if not exists required_components jsonb not null
  default '{"left":true,"right":false,"face":false}'::jsonb;

update public.sign_samples
set required_components = case
  when handedness = 'Right'
    then '{"left":false,"right":true,"face":false}'::jsonb
  else '{"left":true,"right":false,"face":false}'::jsonb
end
where format_version = 1;

alter table public.sign_samples
  add constraint sign_samples_required_components_check
  check (
    jsonb_typeof(required_components) = 'object' and
    required_components ? 'left' and
    required_components ? 'right' and
    required_components ? 'face' and
    jsonb_typeof(required_components -> 'left') = 'boolean' and
    jsonb_typeof(required_components -> 'right') = 'boolean' and
    jsonb_typeof(required_components -> 'face') = 'boolean' and
    (required_components -> 'left' = 'true'::jsonb or
     required_components -> 'right' = 'true'::jsonb or
     required_components -> 'face' = 'true'::jsonb)
  );

alter table public.sign_samples
  drop constraint if exists sign_samples_hand_count_check;

alter table public.sign_samples
  add constraint sign_samples_hand_count_check
  check (hand_count between 0 and 2);

alter table public.sign_samples
  drop constraint if exists sign_samples_check2,
  drop constraint if exists sign_samples_payload_check;

alter table public.sign_samples
  add constraint sign_samples_payload_format_check
  check (payload is null or (
    jsonb_typeof(payload) = 'object' and
    payload ? 'formatVersion' and
    payload ->> 'formatVersion' = format_version::text
  ));

alter table public.user_settings
  drop column if exists use_basic_gestures;

update storage.buckets
set file_size_limit = 12582912
where id = 'sign-samples';
