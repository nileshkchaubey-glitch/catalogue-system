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
insert into auth.sessions (id, user_id, not_after) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', null),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', null),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', null),
  ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', now() - interval '1 minute');

-- A rolled-back, synthetic capability. The disposable stack may already
-- have a local key configured; the rollback restores it.
insert into catalogue_private.workspace_write_key (key_sha256)
values (sha256(convert_to(repeat('a', 64), 'UTF8')))
on conflict (singleton) do update set key_sha256 = excluded.key_sha256;

set local role anon;
do $$
begin
  if exists (select 1 from storage.objects where bucket_id = 'catalogue-media') then
    raise exception 'Anonymous storage access was allowed';
  end if;
  if has_table_privilege(current_user, 'public.business_profiles', 'SELECT')
    or has_table_privilege(current_user, 'public.catalogue_workspaces', 'SELECT, INSERT, UPDATE')
    or has_any_column_privilege(current_user, 'public.catalogue_workspaces', 'INSERT, UPDATE')
    or has_table_privilege(current_user, 'public.catalogue_workspace_imports', 'SELECT, INSERT, UPDATE')
    or has_function_privilege(current_user, 'public.save_catalogue_workspace(uuid,jsonb)', 'EXECUTE')
    or has_function_privilege('service_role', 'public.save_catalogue_workspace(uuid,jsonb)', 'EXECUTE') then
    raise exception 'Unexpected anonymous table grants';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false,"session_id":"30000000-0000-4000-8000-000000000001"}', true);

do $$
declare
  owner_a constant uuid := '10000000-0000-4000-8000-000000000001';
  owner_b constant uuid := '10000000-0000-4000-8000-000000000002';
  rev1 uuid;
  rev2 uuid;
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

  if has_table_privilege(current_user, 'public.catalogue_workspaces', 'INSERT, UPDATE, DELETE, TRUNCATE')
    or has_any_column_privilege(current_user, 'public.catalogue_workspaces', 'INSERT, UPDATE')
    or has_any_column_privilege(current_user, 'catalogue_private.workspace_write_key', 'SELECT, INSERT, UPDATE')
    or pg_has_role(current_user, 'catalogue_workspace_writer', 'MEMBER') then
    raise exception 'Client workspace write privileges were left enabled';
  end if;
  begin
    insert into public.catalogue_workspaces (owner_id, revision, document) values (owner_a, gen_random_uuid(), workspace);
    raise exception 'Direct owner workspace creation was allowed';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.headers', '{}', true);
  begin
    perform public.save_catalogue_workspace(null, workspace);
    raise exception 'RPC accepted a missing write capability';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.headers', jsonb_build_object('x-catalogue-workspace-write-key', repeat('b', 64))::text, true);
  begin
    perform public.save_catalogue_workspace(null, workspace);
    raise exception 'RPC accepted an unknown write capability';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.headers', jsonb_build_object('x-catalogue-workspace-write-key', repeat('a', 64))::text, true);
  rev1 := public.save_catalogue_workspace(null, workspace);
  if rev1 is null or public.save_catalogue_workspace(null, workspace) is not null then
    raise exception 'Expected exactly one first workspace save';
  end if;
  begin
    update public.catalogue_workspaces set revision = gen_random_uuid() where owner_id = owner_a;
    raise exception 'Direct owner workspace update was allowed';
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
    perform public.save_catalogue_workspace(rev1,
      jsonb_set(confirmed, '{quoteSnapshots,0,lines,0,purchase}', '"4.20"'::jsonb));
    raise exception 'The snapshot accepted an internal purchase price field';
  exception when check_violation then null;
  end;
  begin
    perform public.save_catalogue_workspace(rev1,
      jsonb_set(confirmed, '{customers,0,consent}', 'false'::jsonb));
    raise exception 'The snapshot accepted revoked consent';
  exception when check_violation then null;
  end;
  begin
    perform public.save_catalogue_workspace(rev1,
      jsonb_set(confirmed, '{families,0,variants,0,rate}', '"9.70"'::jsonb));
    raise exception 'Quote confirmation changed a master rate';
  exception when check_violation then null;
  end;
  rev2 := public.save_catalogue_workspace(rev1, confirmed);
  if rev2 is null or rev2 = rev1 then raise exception 'The owner could not append a confirmed quote'; end if;
  if public.save_catalogue_workspace(rev1, workspace) is not null then
    raise exception 'An obsolete revision replaced a current workspace';
  end if;
  if (select document from public.catalogue_workspaces where revision = rev2) is distinct from confirmed then
    raise exception 'Saved quote or master data did not round-trip';
  end if;
  perform set_config('catalogue_test.owner_a_revision', rev2::text, true);
  begin
    perform public.save_catalogue_workspace(rev2, workspace);
    raise exception 'A confirmed quote could be removed';
  exception when check_violation then null;
  end;
  begin
    perform public.save_catalogue_workspace(rev2,
      jsonb_set(confirmed, '{quoteSnapshots,0,total}', '"0.01"'::jsonb));
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
  '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","is_anonymous":false,"session_id":"30000000-0000-4000-8000-000000000002"}', true);
do $$
declare
  empty_workspace constant jsonb := '{"schema":3,"departments":{},"collections":[],"families":[],"customers":[]}';
begin
  if (select count(*) from public.business_profiles) <> 1
    or exists (select 1 from public.catalogue_workspaces)
    or exists (select 1 from public.catalogue_workspace_imports)
    or exists (select 1 from storage.objects where bucket_id = 'catalogue-media') then
    raise exception 'Tenant B could read Tenant A private records';
  end if;
  if public.save_catalogue_workspace(current_setting('catalogue_test.owner_a_revision')::uuid, empty_workspace) is not null then
    raise exception 'Tenant B could use Tenant A revision';
  end if;
  if public.save_catalogue_workspace(null, empty_workspace) is null then
    raise exception 'Tenant B could not create its own workspace';
  end if;
  if (select owner_id from public.catalogue_workspaces) is distinct from auth.uid() then
    raise exception 'Tenant B workspace was assigned to another owner';
  end if;
end;
$$;

select set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":true,"session_id":"30000000-0000-4000-8000-000000000001"}', true);
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
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","is_anonymous":false,"session_id":"30000000-0000-4000-8000-000000000003"}', true);
do $$
begin
  perform public.save_catalogue_workspace(null, '{"schema":3,"departments":{},"collections":[],"families":[],"customers":[]}');
  raise exception 'Unprovisioned owner could create a workspace';
exception when insufficient_privilege then null;
end;
$$;

reset role;
delete from auth.sessions where id = '30000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$
declare
  claims constant jsonb := '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":false}';
  session_id text;
begin
  -- Missing, revoked, another owner's, expired and malformed session IDs.
  foreach session_id in array array[null, '30000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000004', 'invalid'] loop
    perform set_config('request.jwt.claims', (claims || jsonb_build_object('session_id', session_id))::text, true);
    if exists (select 1 from public.business_profiles)
      or exists (select 1 from public.catalogue_workspaces)
      or exists (select 1 from public.catalogue_workspace_imports)
      or exists (select 1 from storage.objects where bucket_id = 'catalogue-media') then
      raise exception 'An inactive session could read private data';
    end if;
    begin
      perform public.save_catalogue_workspace(current_setting('catalogue_test.owner_a_revision')::uuid,
        '{"schema":3,"departments":{},"collections":[],"families":[],"customers":[]}');
      raise exception 'An inactive session could save';
    exception when insufficient_privilege then null;
    end;
  end loop;
end;
$$;

rollback;
