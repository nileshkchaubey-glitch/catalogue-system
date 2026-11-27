-- Synthetic collision fixture for an empty, disposable local Supabase project.
-- Retain the original collision fixture and include the policy names, grants
-- and owner index shape observed in the read-only hosted preflight.
-- No hosted data or credentials are used.
create table public.business_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  business_name text not null,
  whatsapp text,
  address text,
  currency text not null default 'INR',
  logo_path text,
  created_at timestamptz not null default now()
);
alter table public.business_profiles enable row level security;
create index business_profiles_owner_idx on public.business_profiles (owner_id);
grant select, insert, update on public.business_profiles to authenticated;
create policy business_profiles_insert on public.business_profiles
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy business_profiles_select on public.business_profiles
  for select to authenticated using (owner_id = (select auth.uid()));
create policy business_profiles_update on public.business_profiles
  for update to authenticated using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy catalogue_profiles_read on public.business_profiles for select using (false);
create policy catalogue_profiles_guard on public.business_profiles as restrictive using (false);
create policy catalogue_profiles_no_client_delete on public.business_profiles for delete using (false);
create policy catalogue_media_no_anon on storage.objects as restrictive using (true);
create policy catalogue_media_owner_guard on storage.objects as restrictive using (true);
create policy catalogue_media_read on storage.objects for select using (false);
create policy catalogue_media_insert on storage.objects for insert with check (false);
create policy catalogue_media_select on storage.objects for select to authenticated
  using (bucket_id = 'catalogue-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy catalogue_media_update on storage.objects for update to authenticated
  using (bucket_id = 'catalogue-media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'catalogue-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy catalogue_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'catalogue-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- Even a separate permissive policy cannot override the new bucket-specific guards.
create policy gate_unrelated_update_policy on storage.objects for update to authenticated
  using (true) with check (true);
create policy gate_unrelated_delete_policy on storage.objects for delete to authenticated using (true);
create policy gate_unrelated_media_policy on storage.objects
  for select to authenticated using (bucket_id = 'unrelated-gate-fixture');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('catalogue-media', 'catalogue-media', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp']);
