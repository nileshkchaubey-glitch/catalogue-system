-- Whole-workspace schema 3 sandbox and a separate append-only import archive.
-- Neither table changes R2 or activates an imported workspace.
create function catalogue_private.has_workspace_shape(document jsonb)
returns boolean language sql immutable security invoker set search_path = ''
as $$
  select (
    jsonb_typeof(document) = 'object'
    and document -> 'schema' = '3'::jsonb
    and jsonb_typeof(document -> 'departments') = 'object'
    and jsonb_typeof(document -> 'collections') = 'array'
    and jsonb_typeof(document -> 'families') = 'array'
    and jsonb_typeof(document -> 'customers') = 'array'
    and (not (document ? 'quoteDrafts') or jsonb_typeof(document -> 'quoteDrafts') = 'array')
    and (not (document ? 'quoteSnapshots') or jsonb_typeof(document -> 'quoteSnapshots') = 'array')
  ) is true;
$$;
revoke all on function catalogue_private.has_workspace_shape(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function catalogue_private.has_workspace_shape(jsonb) to authenticated;

create table public.catalogue_workspaces (
  owner_id uuid primary key references auth.users (id) on delete restrict,
  revision uuid not null,
  document jsonb not null check (catalogue_private.has_workspace_shape(document))
);

create table public.catalogue_workspace_imports (
  owner_id uuid not null references auth.users (id) on delete restrict,
  source_revision text not null check (source_revision ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  document jsonb not null check (catalogue_private.has_workspace_shape(document)),
  created_at timestamptz not null default now(),
  primary key (owner_id, source_revision)
);

alter table public.catalogue_workspaces enable row level security;
alter table public.catalogue_workspace_imports enable row level security;

revoke all on public.catalogue_workspaces, public.catalogue_workspace_imports
  from public, anon, authenticated, service_role;
grant select, insert on public.catalogue_workspaces to authenticated;
grant update (revision, document) on public.catalogue_workspaces to authenticated;
grant select on public.catalogue_workspace_imports to authenticated;
grant insert (owner_id, source_revision, document)
  on public.catalogue_workspace_imports to authenticated;

create policy catalogue_workspaces_owner on public.catalogue_workspaces
  for all to authenticated
  using (owner_id = (select auth.uid()) and (select catalogue_private.has_provisioned_profile()))
  with check (owner_id = (select auth.uid()) and (select catalogue_private.has_provisioned_profile()));

create policy catalogue_imports_owner on public.catalogue_workspace_imports
  for all to authenticated
  using (owner_id = (select auth.uid()) and (select catalogue_private.has_provisioned_profile()))
  with check (owner_id = (select auth.uid()) and (select catalogue_private.has_provisioned_profile()));

create function catalogue_private.guard_workspace_history()
returns trigger language plpgsql security invoker set search_path = ''
as $$
declare
  prior jsonb;
  incoming jsonb := coalesce(new.document -> 'quoteSnapshots', '[]'::jsonb);
  appended jsonb;
  snapshot_id text;
  customer_id text;
  snapshot_fields text[] := array['id', 'customerId', 'customerName', 'customerPhone', 'confirmedAt', 'lines', 'total'];
  line_fields text[] := array['variantId', 'name', 'variant', 'unit', 'quantity', 'rate', 'subtotal'];
  previous_count integer;
  incoming_count integer;
begin
  if jsonb_typeof(incoming) <> 'array' then
    raise exception 'Quote snapshots must be an array' using errcode = '23514';
  end if;
  incoming_count := jsonb_array_length(incoming);
  if tg_op = 'INSERT' then
    if incoming_count <> 0 then
      raise exception 'Save the workspace before appending a quote snapshot' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.revision = old.revision then
    raise exception 'Each workspace save requires a new revision' using errcode = '23514';
  end if;
  prior := coalesce(old.document -> 'quoteSnapshots', '[]'::jsonb);
  previous_count := jsonb_array_length(prior);
  if incoming_count < previous_count or incoming_count > previous_count + 1 then
    raise exception 'Quote snapshots are append-only' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(prior) with ordinality as snapshot(value, position)
    where snapshot.value is distinct from incoming -> (snapshot.position - 1)::integer
  ) then
    raise exception 'Quote snapshots are immutable' using errcode = '23514';
  end if;
  if incoming_count > previous_count then
    appended := incoming -> previous_count;
    snapshot_id := appended ->> 'id';
    customer_id := appended ->> 'customerId';
    if coalesce(snapshot_id, '') !~ '^[A-Za-z0-9-]{1,64}$' or exists (
      select 1 from jsonb_array_elements(prior) as snapshot(value)
      where snapshot.value ->> 'id' = snapshot_id
    ) then
      raise exception 'Quote snapshot id must be stable and unique' using errcode = '23514';
    end if;
    if (jsonb_typeof(appended) = 'object' and appended ?& snapshot_fields
      and appended - snapshot_fields = '{}'::jsonb and jsonb_typeof(appended -> 'lines') = 'array') is not true then
      raise exception 'Quote snapshot has unexpected fields' using errcode = '23514';
    end if;
    if jsonb_array_length(appended -> 'lines') = 0 or exists (
      select 1 from jsonb_array_elements(appended -> 'lines') as line(value)
      where (jsonb_typeof(line.value) = 'object' and line.value ?& line_fields
        and line.value - line_fields = '{}'::jsonb) is not true
    ) then
      raise exception 'Quote snapshot lines have unexpected fields' using errcode = '23514';
    end if;
    if not exists (
      select 1 from jsonb_array_elements(coalesce(old.document -> 'quoteDrafts', '[]'::jsonb)) as draft(value)
      where draft.value ->> 'id' = snapshot_id and draft.value ->> 'customerId' = customer_id
    ) or exists (
      select 1 from jsonb_array_elements(coalesce(new.document -> 'quoteDrafts', '[]'::jsonb)) as draft(value)
      where draft.value ->> 'id' = snapshot_id
    ) then
      raise exception 'Quote snapshot must consume its saved draft' using errcode = '23514';
    end if;
    if not exists (
      select 1 from jsonb_array_elements(old.document -> 'customers') as customer(value)
      where customer.value ->> 'id' = customer_id and customer.value -> 'consent' = 'true'::jsonb
        and customer.value -> 'name' = appended -> 'customerName'
        and customer.value -> 'phone' = appended -> 'customerPhone'
    ) or not exists (
      select 1 from jsonb_array_elements(new.document -> 'customers') as customer(value)
      where customer.value ->> 'id' = customer_id and customer.value -> 'consent' = 'true'::jsonb
        and customer.value -> 'name' = appended -> 'customerName'
        and customer.value -> 'phone' = appended -> 'customerPhone'
    ) then
      raise exception 'Quote snapshot requires a saved consenting customer' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function catalogue_private.guard_workspace_history()
  from public, anon, authenticated, service_role;

create trigger catalogue_workspace_history
  before insert or update on public.catalogue_workspaces
  for each row execute function catalogue_private.guard_workspace_history();
