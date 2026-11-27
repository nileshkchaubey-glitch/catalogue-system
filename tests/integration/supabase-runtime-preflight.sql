-- Run only after verifying the disposable container against the image pin.
begin;
set local lock_timeout = '4s';
set local statement_timeout = '8s';

create role catalogue_runtime_probe_writer nologin noinherit nobypassrls;
grant catalogue_runtime_probe_writer to current_user with inherit false, set true;
do $$
begin
  if not exists (
    select 1 from pg_auth_members
    where roleid = 'catalogue_runtime_probe_writer'::regrole
      and member = current_user::regrole
      and not inherit_option and set_option
  ) then
    raise exception 'Unexpected special-grantee membership';
  end if;
end;
$$;

revoke catalogue_runtime_probe_writer from current_user;
do $$
begin
  if exists (
    select 1 from pg_auth_members
    where roleid = 'catalogue_runtime_probe_writer'::regrole
      and member = current_user::regrole and set_option
  ) then
    raise exception 'Special-grantee revocation did not remove SET permission';
  end if;
end;
$$;

create schema catalogue_runtime_probe;
grant usage on schema catalogue_runtime_probe to anon, authenticated;
create function catalogue_runtime_probe.denied_function() returns integer
  language sql as $$ select 17 $$;
revoke execute on function catalogue_runtime_probe.denied_function() from public, anon, authenticated;

do $$
declare
  client_role text;
begin
  if catalogue_runtime_probe.denied_function() <> 17 then
    raise exception 'Denied-function control did not execute as owner';
  end if;

  foreach client_role in array array['anon', 'authenticated'] loop
    execute format('set local role %I', client_role);
    if not has_schema_privilege('catalogue_runtime_probe', 'USAGE')
      or has_function_privilege('catalogue_runtime_probe.denied_function()', 'EXECUTE') then
      raise exception 'Unexpected probe privileges';
    end if;

    begin
      perform catalogue_runtime_probe.denied_function();
      raise exception 'Expected function EXECUTE denial';
    exception when insufficient_privilege then
      null;
    end;

    -- Reaching this control requires the same connection to survive 42501.
    if current_user <> client_role then
      raise exception 'The caller changed during the denial probe';
    end if;
    reset role;
  end loop;
end;
$$;

rollback;
