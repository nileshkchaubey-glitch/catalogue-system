-- Synthetic collision fixture for an empty, disposable local Supabase project.
-- These policy bodies are deliberately minimal. The legacy names are the contract
-- exercised here; the fixture is independent of hosted policy contents and data.
create table public.business_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users (id) on delete cascade,
  business_name text not null,
  whatsapp text,
  address text,
  currency text not null default 'INR',
  logo_path text,
  created_at timestamptz not null default now()
);
alter table public.business_profiles enable row level security;

create policy catalogue_profiles_read on public.business_profiles for select using (false);
create policy catalogue_profiles_guard on public.business_profiles as restrictive using (false);
create policy catalogue_profiles_no_client_delete on public.business_profiles for delete using (false);
create policy catalogue_media_no_anon on storage.objects as restrictive using (true);
create policy catalogue_media_owner_guard on storage.objects as restrictive using (true);
create policy catalogue_media_read on storage.objects for select using (false);
create policy catalogue_media_insert on storage.objects for insert with check (false);
create policy gate_unrelated_media_policy on storage.objects
  for select to authenticated using (bucket_id = 'unrelated-gate-fixture');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('catalogue-media', 'catalogue-media', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp']);
