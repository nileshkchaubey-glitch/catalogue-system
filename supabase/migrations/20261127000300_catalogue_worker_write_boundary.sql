-- Close raw workspace mutations while keeping the existing workspace and archive.
revoke insert, update, delete, truncate on public.catalogue_workspaces
  from public, anon, authenticated, service_role;
revoke insert (owner_id, revision, document), update (owner_id, revision, document)
  on public.catalogue_workspaces from public, anon, authenticated, service_role;

drop policy catalogue_workspaces_owner on public.catalogue_workspaces;
create policy catalogue_workspaces_owner_read on public.catalogue_workspaces
  for select to authenticated
  using (owner_id = (select auth.uid()) and (select catalogue_private.has_provisioned_profile()));

-- The JWT can outlive its Auth session. The profile lookup on every Worker
-- request and existing workspace, archive and media policies use this gate.
create function catalogue_private.active_session_owner()
returns uuid language sql stable security definer set search_path = ''
as $$
  select s.user_id
  from auth.sessions as s
  join auth.users as u on u.id = s.user_id
  where s.id = case
      when (select auth.jwt() ->> 'session_id') ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        then (select auth.jwt() ->> 'session_id')::uuid
    end
    and s.user_id = (select auth.uid())
    and (select auth.jwt() ->> 'role') = 'authenticated'
    and (select auth.jwt() ->> 'is_anonymous') = 'false'
    and (s.not_after is null or s.not_after > statement_timestamp())
    and (u.banned_until is null or u.banned_until <= statement_timestamp())
    and u.deleted_at is null;
$$;
revoke all on function catalogue_private.active_session_owner()
  from public, anon, authenticated, service_role;
grant execute on function catalogue_private.active_session_owner() to authenticated;

create policy catalogue_profiles_active_session on public.business_profiles
  as restrictive for select to authenticated
  using (owner_id = (select catalogue_private.active_session_owner()));

-- Set the singleton digest out of band. An empty table disables the save RPC.
create table catalogue_private.workspace_write_key (
  singleton boolean primary key default true check (singleton),
  key_sha256 bytea not null check (octet_length(key_sha256) = 32)
);
revoke all on catalogue_private.workspace_write_key from public, anon, authenticated, service_role;

-- This role can only act inside the private save function. It has no Auth
-- or Storage access and remains subject to workspace RLS.
create role catalogue_workspace_writer nologin noinherit nobypassrls;
-- Older supautils builds crash on CURRENT_USER as a role grantee.
do $$
begin
  execute format('grant catalogue_workspace_writer to %I with inherit false, set true', current_user);
end;
$$;
grant usage on schema public, catalogue_private to catalogue_workspace_writer;
grant execute on function catalogue_private.active_session_owner(),
  catalogue_private.has_workspace_shape(jsonb) to catalogue_workspace_writer;
grant select (key_sha256) on catalogue_private.workspace_write_key to catalogue_workspace_writer;
grant select (owner_id) on public.business_profiles to catalogue_workspace_writer;
grant select (owner_id, revision), insert (owner_id, revision, document), update (revision, document)
  on public.catalogue_workspaces to catalogue_workspace_writer;

create policy catalogue_profiles_writer_read on public.business_profiles
  for select to catalogue_workspace_writer
  using (owner_id = (select catalogue_private.active_session_owner()));
create policy catalogue_workspaces_writer on public.catalogue_workspaces
  for all to catalogue_workspace_writer
  using (owner_id = (select catalogue_private.active_session_owner()))
  with check (owner_id = (select catalogue_private.active_session_owner()));

create function catalogue_private.save_workspace(expected_revision uuid, workspace_document jsonb)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  owner uuid := catalogue_private.active_session_owner();
  write_key text := nullif(current_setting('request.headers', true), '')::jsonb
    ->> 'x-catalogue-workspace-write-key';
  saved_revision uuid;
begin
  if owner is null or (select count(owner_id) from public.business_profiles where owner_id = owner) <> 1
    or write_key is null or write_key !~ '^[a-f0-9]{64}$'
    or not exists (
      select 1 from catalogue_private.workspace_write_key
      where key_sha256 = sha256(convert_to(write_key, 'UTF8'))
    ) then
    raise exception 'Workspace write authorization required' using errcode = '42501';
  end if;

  if expected_revision is null then
    insert into public.catalogue_workspaces (owner_id, revision, document)
    values (owner, gen_random_uuid(), workspace_document)
    on conflict (owner_id) do nothing
    returning revision into saved_revision;
  else
    update public.catalogue_workspaces
    set revision = gen_random_uuid(), document = workspace_document
    where owner_id = owner and revision = expected_revision
    returning revision into saved_revision;
  end if;
  return saved_revision;
end;
$$;
revoke all on function catalogue_private.save_workspace(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function catalogue_private.save_workspace(uuid, jsonb) to authenticated;
grant create on schema catalogue_private to catalogue_workspace_writer;
alter function catalogue_private.save_workspace(uuid, jsonb) owner to catalogue_workspace_writer;
revoke create on schema catalogue_private from catalogue_workspace_writer;

create function public.save_catalogue_workspace(expected_revision uuid, workspace_document jsonb)
returns uuid language sql volatile security invoker set search_path = ''
as $$
  select catalogue_private.save_workspace(expected_revision, workspace_document);
$$;
revoke all on function public.save_catalogue_workspace(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.save_catalogue_workspace(uuid, jsonb) to authenticated;

-- Keep confirmation-only changes narrow at the database boundary too. The
-- Worker validates pricing and the existing trigger protects snapshot history.
create function catalogue_private.guard_quote_catalogue()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if jsonb_array_length(coalesce(new.document -> 'quoteSnapshots', '[]'::jsonb))
      > jsonb_array_length(coalesce(old.document -> 'quoteSnapshots', '[]'::jsonb))
    and (new.document - array['quoteDrafts', 'quoteSnapshots'])
      is distinct from (old.document - array['quoteDrafts', 'quoteSnapshots']) then
    raise exception 'Quote confirmation must preserve catalogue data' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function catalogue_private.guard_quote_catalogue()
  from public, anon, authenticated, service_role;
create trigger catalogue_quote_catalogue
  before update on public.catalogue_workspaces
  for each row execute function catalogue_private.guard_quote_catalogue();
