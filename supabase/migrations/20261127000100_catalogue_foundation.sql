-- Recreate the stated foundation on a fresh local Supabase stack. Existing
-- profile rows and bucket settings are retained. Abort if the media contract differs.
create table if not exists public.business_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  business_name text not null,
  whatsapp text,
  address text,
  currency text not null default 'INR',
  logo_path text,
  created_at timestamptz not null default now()
);

create index if not exists catalogue_profile_owner_idx
  on public.business_profiles (owner_id);
alter table public.business_profiles enable row level security;

-- The hosted legacy foundation has only a non-unique owner index.
-- Refuse a duplicate-owner inventory rather than silently merging records.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.business_profiles'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (owner_id)'
  ) then
    alter table public.business_profiles
      add constraint catalogue_profile_owner_unique unique (owner_id);
  end if;
end;
$$;

revoke all on public.business_profiles from public, anon, authenticated;
grant select on public.business_profiles to authenticated;

-- The pre-versioned foundation already used these names. Replace them in this
-- migration transaction so the old guards and new definitions switch together.
drop policy if exists catalogue_profiles_read on public.business_profiles;
drop policy if exists catalogue_profiles_guard on public.business_profiles;
drop policy if exists catalogue_profiles_no_client_delete on public.business_profiles;
-- The existing hosted foundation used these alternative policy names.
drop policy if exists business_profiles_insert on public.business_profiles;
drop policy if exists business_profiles_select on public.business_profiles;
drop policy if exists business_profiles_update on public.business_profiles;

create policy catalogue_profiles_read on public.business_profiles
  for select to authenticated using (owner_id = (select auth.uid()));
create policy catalogue_profiles_guard on public.business_profiles
  as restrictive for all to anon, authenticated
  using (
    owner_id = (select auth.uid())
    and (select auth.jwt() ->> 'is_anonymous') = 'false'
  ) with check (false);
create policy catalogue_profiles_no_client_delete on public.business_profiles
  as restrictive for delete to anon, authenticated using (false);

create schema catalogue_private;
revoke all on schema catalogue_private from public, anon, authenticated;
grant usage on schema catalogue_private to authenticated;

create function catalogue_private.has_provisioned_profile()
returns boolean language sql stable security invoker set search_path = ''
as $$
  select (select auth.jwt() ->> 'is_anonymous') = 'false'
    and (select count(*) from public.business_profiles
      where owner_id = (select auth.uid())) = 1;
$$;
revoke all on function catalogue_private.has_provisioned_profile()
  from public, anon, authenticated, service_role;
grant execute on function catalogue_private.has_provisioned_profile() to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('catalogue-media', 'catalogue-media', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from storage.buckets
    where id = 'catalogue-media' and name = 'catalogue-media' and public = false
      and file_size_limit = 5242880
      and allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp']
      and allowed_mime_types <@ array['image/jpeg', 'image/png', 'image/webp']
  ) then
    raise exception 'Existing catalogue-media bucket differs from the private 5 MiB image foundation';
  end if;
end;
$$;

-- Restrictive policies protect this bucket even when an existing permissive
-- policy also matches. Other buckets retain their existing policy behavior.
drop policy if exists catalogue_media_no_anon on storage.objects;
drop policy if exists catalogue_media_owner_guard on storage.objects;
drop policy if exists catalogue_media_read on storage.objects;
drop policy if exists catalogue_media_insert on storage.objects;
drop policy if exists catalogue_media_select on storage.objects;
drop policy if exists catalogue_media_update on storage.objects;
drop policy if exists catalogue_media_delete on storage.objects;

create policy catalogue_media_no_anon on storage.objects
  as restrictive for all to anon
  using (bucket_id <> 'catalogue-media') with check (bucket_id <> 'catalogue-media');
create policy catalogue_media_owner_guard on storage.objects
  as restrictive for all to authenticated
  using (
    bucket_id <> 'catalogue-media' or (
      (storage.foldername(name))[1] = (select auth.uid())::text
      and (select catalogue_private.has_provisioned_profile())
    )
  ) with check (
    bucket_id <> 'catalogue-media' or (
      (storage.foldername(name))[1] = (select auth.uid())::text
      and (select catalogue_private.has_provisioned_profile())
    )
  );
-- A content-addressed image must not be replaced or removed by an owner.
-- Scope the restrictive guards to this bucket; other buckets are unchanged.
create policy catalogue_media_no_client_update on storage.objects
  as restrictive for update to authenticated
  using (bucket_id <> 'catalogue-media') with check (bucket_id <> 'catalogue-media');
create policy catalogue_media_no_client_delete on storage.objects
  as restrictive for delete to authenticated
  using (bucket_id <> 'catalogue-media');
create policy catalogue_media_read on storage.objects
  for select to authenticated using (bucket_id = 'catalogue-media');
create policy catalogue_media_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'catalogue-media');
