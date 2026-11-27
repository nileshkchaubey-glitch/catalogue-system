\set ON_ERROR_STOP on
begin;

-- Run only on the disposable local stack. Every fixture is rolled back.
insert into auth.users (id, email) values
  ('10000000-0000-4000-8000-000000000001', 'owner-a@example.test'),
  ('10000000-0000-4000-8000-000000000002', 'owner-b@example.test'),
  ('10000000-0000-4000-8000-000000000003', 'unprovisioned@example.test');
insert into public.business_profiles (owner_id, business_name, currency) values
  ('10000000-0000-4000-8000-000000000001', 'Synthetic Owner A', 'INR'),
  ('10000000-0000-4000-8000-000000000002', 'Synthetic Owner B', 'INR');

set local role anon;
do $$
begin
  if exists (select 1 from storage.objects where bucket_id = 'catalogue-media') then
    raise exception 'Anonymous storage access was allowed';
  end if;
  if has_table_privilege(current_user, 'public.business_profiles', 'SELECT')
    or has_table_privilege(current_user, 'public.catalogue_workspaces', 'SELECT, INSERT, UPDATE')
    or has_table_privilege(current_user, 'public.catalogue_workspace_imports', 'SELECT, INSERT, UPDATE') then
    raise exception 'Unexpected anonymous table grants';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false}', true);

do $$
declare
  owner_a constant uuid := '10000000-0000-4000-8000-000000000001';
  owner_b constant uuid := '10000000-0000-4000-8000-000000000002';
  rev1 constant uuid := '20000000-0000-4000-8000-000000000001';
  rev2 constant uuid := '20000000-0000-4000-8000-000000000002';
  rev3 constant uuid := '20000000-0000-4000-8000-000000000003';
  workspace constant jsonb := '{"schema":3,"departments":{"Samples":["Containers"]},"collections":[],
    "families":[{"id":"family-a","name":"Synthetic Product","category":"Containers",
      "photo":"/api/photos/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "gallery":[],"collections":[],"variants":[{"id":"variant-a","variant":"Pack","unit":"Pack",
        "purchase":"4.20","rate":"8.70","ready":true,"history":[],"overridePhoto":""}]}],
    "customers":[{"id":"buyer-a","name":"Synthetic Buyer","phone":"00000000000",
      "collection":"Full catalog","consent":true}],
    "quoteDrafts":[{"id":"quote-a","customerId":"buyer-a",
      "lines":[{"variantId":"variant-a","quantity":"1","rateOverride":""}]}]}'::jsonb;
  snapshot constant jsonb := '{"id":"quote-a","customerId":"buyer-a","customerName":"Synthetic Buyer",
    "customerPhone":"00000000000","confirmedAt":"2026-11-27T00:00:00.000Z",
    "lines":[{"variantId":"variant-a","name":"Synthetic Product","variant":"Pack","unit":"Pack",
      "quantity":"1","rate":"8.70","subtotal":"8.70"}],"total":"8.70"}'::jsonb;
  confirmed jsonb := jsonb_set(workspace, '{quoteDrafts}', '[]'::jsonb) ||
    jsonb_build_object('quoteSnapshots', jsonb_build_array(snapshot));
begin
  if (select count(*) from public.business_profiles) <> 1 then
    raise exception 'Expected only the owner profile';
  end if;
  if has_table_privilege(current_user, 'public.business_profiles', 'INSERT, UPDATE, DELETE') then
    raise exception 'Clients must never provision a profile';
  end if;

  insert into public.catalogue_workspaces (owner_id, revision, document) values (owner_a, rev1, workspace);
  begin
    insert into public.catalogue_workspaces (owner_id, revision, document) values (owner_b, rev1, workspace);
    raise exception 'Cross-tenant workspace creation was allowed';
  exception when insufficient_privilege then null;
  end;

  insert into public.catalogue_workspace_imports (owner_id, source_revision, document)
    values (owner_a, 'synthetic-revision', workspace);
  if (select document from public.catalogue_workspace_imports where source_revision = 'synthetic-revision')
    is distinct from workspace then
    raise exception 'Staged data did not round-trip';
  end if;
  if has_table_privilege(current_user, 'public.catalogue_workspace_imports', 'UPDATE, DELETE')
    or has_table_privilege(current_user, 'public.catalogue_workspaces', 'DELETE') then
    raise exception 'History tables unexpectedly permit destructive client writes';
  end if;
  begin
    insert into public.catalogue_workspace_imports (owner_id, source_revision, document)
      values (owner_b, 'synthetic-revision', workspace);
    raise exception 'Cross-tenant staging was allowed';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.catalogue_workspaces set revision = rev2,
      document = jsonb_set(confirmed, '{quoteSnapshots,0,lines,0,purchase}', '"4.20"'::jsonb)
      where owner_id = owner_a;
    raise exception 'The snapshot accepted an internal purchase price field';
  exception when check_violation then null;
  end;
  begin
    update public.catalogue_workspaces set revision = rev2,
      document = jsonb_set(confirmed, '{customers,0,consent}', 'false'::jsonb)
      where owner_id = owner_a;
    raise exception 'The snapshot accepted revoked consent';
  exception when check_violation then null;
  end;
  update public.catalogue_workspaces set revision = rev2, document = confirmed
    where owner_id = owner_a and revision = rev1;
  if not found then raise exception 'The owner could not append a confirmed quote'; end if;
  update public.catalogue_workspaces set revision = rev3, document = confirmed
    where owner_id = owner_a and revision = rev1;
  if found then raise exception 'An obsolete revision replaced a current workspace'; end if;
  begin
    update public.catalogue_workspaces set revision = rev3, document = workspace where owner_id = owner_a;
    raise exception 'A confirmed quote could be removed';
  exception when check_violation then null;
  end;
  begin
    update public.catalogue_workspaces set revision = rev3,
      document = jsonb_set(confirmed, '{quoteSnapshots,0,total}', '"0.01"'::jsonb) where owner_id = owner_a;
    raise exception 'A confirmed quote could be edited';
  exception when check_violation then null;
  end;

  insert into storage.objects (bucket_id, name)
    values ('catalogue-media', owner_a::text || '/synthetic.jpg');
  if not exists (select 1 from storage.objects
    where bucket_id = 'catalogue-media' and name = owner_a::text || '/synthetic.jpg') then
    raise exception 'The owner could not read its private media';
  end if;
  begin
    insert into storage.objects (bucket_id, name)
      values ('catalogue-media', owner_b::text || '/synthetic.jpg');
    raise exception 'Cross-tenant image creation was allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  if exists (select 1 from storage.objects where bucket_id = 'catalogue-media') then
    raise exception 'Anonymous storage access was allowed';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","is_anonymous":false}', true);
do $$
begin
  if (select count(*) from public.business_profiles) <> 1
    or exists (select 1 from public.catalogue_workspaces)
    or exists (select 1 from public.catalogue_workspace_imports)
    or exists (select 1 from storage.objects where bucket_id = 'catalogue-media') then
    raise exception 'Tenant B could read Tenant A private records';
  end if;
  update public.catalogue_workspaces set revision = gen_random_uuid();
  if found then raise exception 'Tenant B could update Tenant A workspace'; end if;
end;
$$;

select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":true}', true);
do $$
begin
  if exists (select 1 from public.business_profiles)
    or exists (select 1 from public.catalogue_workspaces)
    or exists (select 1 from public.catalogue_workspace_imports)
    or exists (select 1 from storage.objects where bucket_id = 'catalogue-media') then
    raise exception 'An anonymous Auth session inherited owner access';
  end if;
end;
$$;

select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","is_anonymous":false}', true);
do $$
begin
  insert into public.catalogue_workspaces (owner_id, revision, document)
    values (auth.uid(), gen_random_uuid(), '{"schema":3,"departments":{},"collections":[],"families":[],"customers":[]}');
  raise exception 'Unprovisioned owner could create a workspace';
exception when insufficient_privilege then null;
end;
$$;

rollback;
