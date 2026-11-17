-- A5.0 Step 3 (rev 2): self-contained Vault / HMAC / signed-commit primitives probe.
-- Runs in ONE transaction and ends with ROLLBACK. Creates only: temp objects, schemas a5_probe and
-- a5_probe_private, and one throwaway Vault secret (a5_probe_hmac_key). All are rolled back.
-- Every cryptographic expectation is derived inside PostgreSQL (sha256(), digest(), hmac(), decode(),
-- gen_random_bytes()). The only literals are tiny byte constants (<= 3 bytes) for encoding checks.
--
-- rev 2 changes: settle() requires an unexpired lease and validates p_tokens; verify() returns false for
-- malformed attacker-controlled input (no blanket exception handler); Cloudflare-style model ids
-- (single leading @) are an approved part of the design.

\set ON_ERROR_STOP on
\pset pager off
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
\o /dev/null

-- ===== 0. harness ======================================================================================
create temp table probe_results(n serial primary key, check_name text not null, status text not null, evidence text);

create function pg_temp.rec(p_name text, p_ok boolean, p_ev text) returns void language sql as $$
  insert into pg_temp.probe_results(check_name, status, evidence)
  values (p_name, case when p_ok is true then 'PASS' else 'FAIL' end, p_ev)
$$;

create function pg_temp.info(p_name text, p_ev text) returns void language sql as $$
  insert into pg_temp.probe_results(check_name, status, evidence) values (p_name, 'INFO', p_ev)
$$;

-- Establishes an explicit JWT context for auth.uid() (both the claims JSON and the legacy sub setting).
-- p_sub = null means "authenticated role but no sub claim". Transaction-local (rolled back).
create function pg_temp.ctx(p_sub uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then '{"role":"authenticated"}'
         else json_build_object('sub', p_sub, 'role', 'authenticated')::text end, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
end $$;

-- Independent HMAC-SHA256 built from RFC 2104 using core sha256() (not pgcrypto).
create function pg_temp.xor_pad(k bytea, pad int) returns bytea language plpgsql immutable as $$
declare r bytea := k; i int;
begin
  for i in 0 .. length(k) - 1 loop
    r := set_byte(r, i, get_byte(k, i) # pad);
  end loop;
  return r;
end $$;

create function pg_temp.hmac256_manual(p_key bytea, p_msg bytea) returns bytea language plpgsql immutable as $$
declare k bytea := p_key; k0 bytea;
begin
  if length(k) > 64 then k := sha256(k); end if;
  k0 := k || decode(repeat('00', 64 - length(k)), 'hex');
  return sha256(pg_temp.xor_pad(k0, 92) || sha256(pg_temp.xor_pad(k0, 54) || p_msg));
end $$;

-- ===== 1. preconditions ================================================================================
do $$
declare v_mig bigint; v_sec bigint;
begin
  select count(*) into v_mig from supabase_migrations.schema_migrations;
  select count(*) into v_sec from vault.secrets;
  perform pg_temp.rec('Preconditions: postgres session, no leftover probe objects',
    current_user = 'postgres' and session_user = 'postgres'
      and to_regnamespace('a5_probe') is null and to_regnamespace('a5_probe_private') is null
      and not exists (select 1 from vault.secrets where name = 'a5_probe_hmac_key'),
    format('current_user=%s; migrations=%s; vault secrets=%s (compare after rollback)', current_user, v_mig, v_sec));
end $$;

-- ===== 2. extensions ===================================================================================
select pg_temp.rec('pgcrypto installed',
  exists (select 1 from pg_extension where extname = 'pgcrypto')
    and to_regprocedure('extensions.hmac(bytea,bytea,text)') is not null
    and to_regprocedure('extensions.digest(bytea,text)') is not null
    and to_regprocedure('extensions.gen_random_bytes(integer)') is not null,
  coalesce((select 'v' || extversion || ' in schema ' || extnamespace::regnamespace::text
            from pg_extension where extname = 'pgcrypto'), 'not installed'));

select pg_temp.rec('supabase_vault installed',
  exists (select 1 from pg_extension where extname = 'supabase_vault')
    and to_regclass('vault.decrypted_secrets') is not null
    and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'vault' and p.proname = 'create_secret'),
  coalesce((select 'v' || extversion from pg_extension where extname = 'supabase_vault'), 'not installed'));

-- ===== 3. Vault secret (random key generated inside SQL) ===============================================
create temp table probe_key(k text not null);
insert into pg_temp.probe_key select encode(extensions.gen_random_bytes(32), 'hex');
select vault.create_secret((select k from pg_temp.probe_key), 'a5_probe_hmac_key', 'a5.0 probe, rolled back');

select pg_temp.rec('Vault: secret created and readable from the privileged context',
  (select decrypted_secret from vault.decrypted_secrets where name = 'a5_probe_hmac_key')
      = (select k from pg_temp.probe_key)
    and (select secret from vault.secrets where name = 'a5_probe_hmac_key')
      <> (select k from pg_temp.probe_key),
  'decrypted value equals the random key generated in SQL; the stored column differs from the plaintext');

-- ===== 4. probe objects ================================================================================
create schema a5_probe;          -- would-be public RPC surface
create schema a5_probe_private;  -- would-be private helpers

create function a5_probe_private.get_key() returns bytea
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = 'a5_probe_hmac_key';
  if v is null then raise exception 'hmac key not provisioned' using errcode = 'P0001'; end if;
  return convert_to(v, 'UTF8');
end $$;

-- Comparison with no early exit: XOR-accumulate over every byte. Length is public (always 32 for HMAC-SHA256).
create function a5_probe_private.ct_equal(a bytea, b bytea) returns boolean
language plpgsql immutable set search_path = '' as $$
declare diff int := 0; i int; n int;
begin
  if a is null or b is null then return false; end if;
  n := length(a);
  if n <> length(b) then return false; end if;
  for i in 0 .. n - 1 loop
    diff := diff | (get_byte(a, i) # get_byte(b, i));
  end loop;
  return diff = 0;
end $$;

create function a5_probe_private.check_window(p_iat bigint, p_exp bigint, p_now bigint) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_iat is null or p_exp is null or p_now is null then 'null_input'
    when p_iat > p_now + 60 then 'iat_in_future'
    when p_exp <= p_iat then 'exp_not_after_iat'
    when p_exp - p_iat > 600 then 'lifetime_too_long'
    when p_exp <= p_now then 'expired'
    else null end
$$;

-- Non-raising field validation shared by canonical() (which raises) and verify() (which returns false).
-- Provider charset: approved [A-Za-z0-9._:/-]. Model charset: the same plus ONE optional leading '@'
-- (approved, for Cloudflare Workers AI ids such as @cf/...). iat and exp are epoch seconds, so they must be
-- non-negative (this also rules out bigint overflow in the window arithmetic).
-- Returns NULL when every field is valid, otherwise a short reason.
create function a5_probe_private.fields_error(
  p_domain text, p_user uuid, p_conv uuid, p_seq int, p_hash text, p_req uuid, p_resv uuid,
  p_provider text, p_model text, p_in int, p_out int, p_iat bigint, p_exp bigint) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_domain is null or p_domain not in ('ombre.ai.commit.v1', 'ombre.ai.settle.v1') then
    return 'bad domain'; end if;
  if p_user is null or p_conv is null or p_req is null or p_resv is null or p_seq is null
     or p_in is null or p_out is null or p_iat is null or p_exp is null then
    return 'null field'; end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then return 'bad content hash'; end if;
  if p_provider is null or p_provider !~ '^[A-Za-z0-9._:/-]{1,64}$' then return 'bad provider'; end if;
  if p_model is null or p_model !~ '^@?[A-Za-z0-9._:/-]{1,128}$' then return 'bad model'; end if;
  if p_seq < 1 or p_in < 0 or p_out < 0 or p_iat < 0 or p_exp < 0 or p_exp <= p_iat then
    return 'bad numeric field'; end if;
  return null;
end $$;

-- Canonical signed string: 13 fixed fields, newline-delimited, no trailing newline. Raises 22023 on bad input.
create function a5_probe_private.canonical(
  p_domain text, p_user uuid, p_conv uuid, p_seq int, p_hash text, p_req uuid, p_resv uuid,
  p_provider text, p_model text, p_in int, p_out int, p_iat bigint, p_exp bigint) returns text
language plpgsql immutable set search_path = '' as $$
declare v_err text;
begin
  v_err := a5_probe_private.fields_error(p_domain, p_user, p_conv, p_seq, p_hash, p_req, p_resv,
                                         p_provider, p_model, p_in, p_out, p_iat, p_exp);
  if v_err is not null then raise exception '%', v_err using errcode = '22023'; end if;
  return concat_ws(E'\n', p_domain, p_user::text, p_conv::text, p_seq::text, p_hash, p_req::text, p_resv::text,
                   p_provider, p_model, p_in::text, p_out::text, p_iat::text, p_exp::text);
end $$;

create function a5_probe_private.mac(
  p_domain text, p_user uuid, p_conv uuid, p_seq int, p_hash text, p_req uuid, p_resv uuid,
  p_provider text, p_model text, p_in int, p_out int, p_iat bigint, p_exp bigint) returns bytea
language plpgsql set search_path = '' as $$
begin
  return extensions.hmac(
    convert_to(a5_probe_private.canonical(p_domain, p_user, p_conv, p_seq, p_hash, p_req, p_resv,
                                          p_provider, p_model, p_in, p_out, p_iat, p_exp), 'UTF8'),
    a5_probe_private.get_key(), 'sha256');
end $$;

create function a5_probe.sign(
  p_domain text, p_conv uuid, p_seq int, p_hash text, p_req uuid, p_resv uuid,
  p_provider text, p_model text, p_in int, p_out int, p_iat bigint, p_exp bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_why text;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  v_why := a5_probe_private.check_window(p_iat, p_exp, floor(extract(epoch from clock_timestamp()))::bigint);
  if v_why is not null then raise exception 'bad time window: %', v_why using errcode = '22023'; end if;
  return encode(a5_probe_private.mac(p_domain, v_uid, p_conv, p_seq, p_hash, p_req, p_resv,
                                     p_provider, p_model, p_in, p_out, p_iat, p_exp), 'hex');
end $$;

-- verify(): the only error it raises on purpose is "not authenticated" (28000). Every malformed or
-- attacker-controlled input value returns false. There is deliberately NO exception handler, so unexpected
-- internal or database errors (for example a missing Vault key) propagate to the caller.
create function a5_probe.verify(
  p_sig text, p_domain text, p_conv uuid, p_seq int, p_hash text, p_req uuid, p_resv uuid,
  p_provider text, p_model text, p_in int, p_out int, p_iat bigint, p_exp bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_sig is null or p_sig !~ '^[0-9a-f]{64}$' then return false; end if;
  if a5_probe_private.fields_error(p_domain, v_uid, p_conv, p_seq, p_hash, p_req, p_resv,
                                   p_provider, p_model, p_in, p_out, p_iat, p_exp) is not null then
    return false; end if;
  if a5_probe_private.check_window(p_iat, p_exp, floor(extract(epoch from clock_timestamp()))::bigint) is not null then
    return false; end if;
  return a5_probe_private.ct_equal(
    a5_probe_private.mac(p_domain, v_uid, p_conv, p_seq, p_hash, p_req, p_resv,
                         p_provider, p_model, p_in, p_out, p_iat, p_exp),
    decode(p_sig, 'hex'));
end $$;

create table a5_probe.reservation(
  id uuid primary key,
  user_id uuid not null,
  client_request_id uuid not null,
  state text not null default 'reserved' check (state in ('reserved', 'settled', 'released')),
  lease_expires_at timestamptz not null,
  settled_tokens int,
  unique (user_id, client_request_id));

create table a5_probe.usage_totals(user_id uuid primary key, total bigint not null default 0);

-- settle(): deterministic contract.
--   not authenticated                      -> raises 28000
--   p_tokens null or negative              -> raises 22023 before any write
--   unexpired reserved row of this user    -> 'settled' (state, settled_tokens and usage_totals updated once)
--   reserved row whose lease has expired   -> 'lease_expired' (nothing is modified)
--   row already settled/released           -> 'already_<state>' (nothing is modified)
--   no such row for this user              -> 'not_found'
-- No upper bound on p_tokens is enforced: the probe's contract defines none, so only the int range applies.
create function a5_probe.settle(p_res uuid, p_tokens int) returns text
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_state text; v_lease timestamptz;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_tokens is null or p_tokens < 0 then
    raise exception 'invalid token count' using errcode = '22023'; end if;
  update a5_probe.reservation set state = 'settled', settled_tokens = p_tokens
   where id = p_res and user_id = v_uid and state = 'reserved' and lease_expires_at > now();
  if found then
    insert into a5_probe.usage_totals as u (user_id, total) values (v_uid, p_tokens)
      on conflict (user_id) do update set total = u.total + excluded.total;
    return 'settled';
  end if;
  select state, lease_expires_at into v_state, v_lease
    from a5_probe.reservation where id = p_res and user_id = v_uid;
  if not found then return 'not_found'; end if;
  if v_state = 'reserved' then
    return case when v_lease <= now() then 'lease_expired' else 'conflict' end;
  end if;
  return 'already_' || v_state;
end $$;

-- explicit grants: only the three RPC-style functions are reachable, and only by authenticated
revoke all on schema a5_probe_private from public, anon, authenticated;
revoke all on all functions in schema a5_probe_private from public, anon, authenticated;
revoke all on all tables in schema a5_probe from public, anon, authenticated;
revoke all on all functions in schema a5_probe from public, anon;
grant usage on schema a5_probe to authenticated;
grant execute on all functions in schema a5_probe to authenticated;

-- ===== 5. direct access denied (behavioural + catalog) ================================================
do $$
declare
  stmts text[] := array[
    'select 1 from vault.decrypted_secrets limit 1',
    'select 1 from vault.secrets limit 1',
    'select vault.create_secret(''x'', ''a5_probe_denied'', ''x'')',
    'select a5_probe_private.get_key()',
    'select a5_probe_private.ct_equal(''\x00''::bytea, ''\x00''::bytea)',
    'select 1 from a5_probe.reservation limit 1',
    'select 1 from a5_probe.usage_totals limit 1',
    'insert into a5_probe.usage_totals(user_id, total) values (gen_random_uuid(), 1)'];
  roles text[] := array['authenticated', 'anon'];
  s text; rl text; blocked int := 0; total int := 0; leaks text := ''; cat_ok boolean;
begin
  foreach rl in array roles loop
    foreach s in array stmts loop
      total := total + 1;
      execute format('set local role %I', rl);
      begin
        execute s;
        leaks := leaks || rl || ': ' || s || '; ';
      exception when insufficient_privilege then
        blocked := blocked + 1;
      end;
      reset role;
    end loop;
  end loop;
  cat_ok := not has_schema_privilege('anon', 'vault', 'usage')
        and not has_schema_privilege('authenticated', 'vault', 'usage')
        and not has_table_privilege('anon', 'vault.decrypted_secrets', 'select')
        and not has_table_privilege('authenticated', 'vault.decrypted_secrets', 'select')
        and not has_table_privilege('anon', 'vault.secrets', 'select')
        and not has_table_privilege('authenticated', 'vault.secrets', 'select');
  perform pg_temp.rec('Direct access denied (anon, authenticated) to Vault and private/probe objects',
    blocked = total and cat_ok,
    format('%s/%s attempts raised 42501; catalog privileges for anon/authenticated on vault are absent: %s%s',
           blocked, total, cat_ok, case when leaks <> '' then '; LEAKS: ' || leaks else '' end));
  perform pg_temp.info('service_role access to Vault (design decision)',
    format('schema USAGE=%s, decrypted_secrets SELECT=%s, secrets SELECT=%s (if true, a leaked service-role key can read the HMAC key)',
           has_schema_privilege('service_role', 'vault', 'usage'),
           has_table_privilege('service_role', 'vault.decrypted_secrets', 'select'),
           has_table_privilege('service_role', 'vault.secrets', 'select')));
end $$;

-- ===== 6. search_path and grants audit ==================================================================
do $$
declare
  n_fn int; n_def int; no_sp text; bad_grants text := ''; r record; priv text;
begin
  select count(*), count(*) filter (where prosecdef) into n_fn, n_def
    from pg_proc where pronamespace in ('a5_probe'::regnamespace, 'a5_probe_private'::regnamespace);
  select string_agg(p.oid::regprocedure::text, '; ') into no_sp
    from pg_proc p
   where p.pronamespace in ('a5_probe'::regnamespace, 'a5_probe_private'::regnamespace)
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c ~ '^search_path=("")?$');
  perform pg_temp.rec('SECURITY DEFINER and helper functions pin search_path to empty',
    no_sp is null and n_def = 4,
    format('%s functions, %s SECURITY DEFINER (expected 4: get_key, sign, verify, settle); without empty search_path: %s',
           n_fn, n_def, coalesce(no_sp, 'none')));

  for r in select p.oid, p.oid::regprocedure::text as sig, p.pronamespace::regnamespace::text as sch, p.proacl, p.proowner
             from pg_proc p where p.pronamespace in ('a5_probe'::regnamespace, 'a5_probe_private'::regnamespace) loop
    if exists (select 1 from aclexplode(coalesce(r.proacl, acldefault('f', r.proowner))) a
               where a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      bad_grants := bad_grants || r.sig || ' executable by PUBLIC; ';
    end if;
    if has_function_privilege('anon', r.oid, 'execute') then
      bad_grants := bad_grants || r.sig || ' executable by anon; ';
    end if;
    if r.sch = 'a5_probe' and not has_function_privilege('authenticated', r.oid, 'execute') then
      bad_grants := bad_grants || r.sig || ' NOT executable by authenticated; ';
    end if;
    if r.sch = 'a5_probe_private' and has_function_privilege('authenticated', r.oid, 'execute') then
      bad_grants := bad_grants || r.sig || ' executable by authenticated; ';
    end if;
  end loop;

  for r in select c.oid, c.oid::regclass::text as nm from pg_class c
            where c.relnamespace in ('a5_probe'::regnamespace, 'a5_probe_private'::regnamespace) and c.relkind in ('r', 'p', 'v', 'm', 'S') loop
    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('anon', r.oid, priv) or has_table_privilege('authenticated', r.oid, priv) then
        bad_grants := bad_grants || r.nm || ' grants ' || priv || '; ';
      end if;
    end loop;
  end loop;

  if has_schema_privilege('anon', 'a5_probe', 'usage') then bad_grants := bad_grants || 'anon has USAGE on a5_probe; '; end if;
  if has_schema_privilege('anon', 'a5_probe_private', 'usage') then bad_grants := bad_grants || 'anon has USAGE on a5_probe_private; '; end if;
  if not has_schema_privilege('authenticated', 'a5_probe', 'usage') then bad_grants := bad_grants || 'authenticated lacks USAGE on a5_probe; '; end if;
  if has_schema_privilege('authenticated', 'a5_probe_private', 'usage') then bad_grants := bad_grants || 'authenticated has USAGE on a5_probe_private; '; end if;

  perform pg_temp.rec('Grants: RPC functions only for authenticated; private objects and probe tables unreachable',
    bad_grants = '', coalesce(nullif(bad_grants, ''), 'no unintended EXECUTE/table/schema privileges for PUBLIC, anon or authenticated'));
end $$;

-- ===== 7. auth.uid() context =============================================================================
do $$
declare
  uid uuid := gen_random_uuid(); got uuid; got_none uuid;
  dconv uuid := gen_random_uuid(); dreq uuid := gen_random_uuid(); dresv uuid := gen_random_uuid();
  dh text := repeat('a', 64); dn bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  abs_sign boolean := false; abs_verify boolean := false; abs_settle boolean := false;
  bad_sub boolean := false; anon_blocked boolean := false;
begin
  perform pg_temp.ctx(uid);
  set local role authenticated;
  got := auth.uid();
  reset role;
  perform pg_temp.ctx(null);
  set local role authenticated;
  got_none := auth.uid();
  reset role;
  perform pg_temp.rec('auth.uid(): probe establishes the JWT context explicitly',
    got = uid and got_none is null, 'auth.uid() returns the probe-set sub, and NULL when no sub claim is set');

  perform pg_temp.ctx(null);
  set local role authenticated;
  begin
    perform a5_probe.sign('ombre.ai.commit.v1', dconv, 1, dh, dreq, dresv, 'nvidia', 'm', 1, 1, dn, dn + 300);
  exception when sqlstate '28000' then abs_sign := true;
  end;
  begin
    perform a5_probe.verify(repeat('a', 64), 'ombre.ai.commit.v1', dconv, 1, dh, dreq, dresv, 'nvidia', 'm', 1, 1, dn, dn + 300);
  exception when sqlstate '28000' then abs_verify := true;
  end;
  begin
    perform a5_probe.settle(gen_random_uuid(), 1);
  exception when sqlstate '28000' then abs_settle := true;
  end;
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"not-a-uuid","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'not-a-uuid', true);
  set local role authenticated;
  begin
    perform a5_probe.sign('ombre.ai.commit.v1', dconv, 1, dh, dreq, dresv, 'nvidia', 'm', 1, 1, dn, dn + 300);
  exception when others then bad_sub := true;
  end;
  reset role;

  perform pg_temp.ctx(null);
  set local role anon;
  begin
    perform a5_probe.sign('ombre.ai.commit.v1', dconv, 1, dh, dreq, dresv, 'nvidia', 'm', 1, 1, dn, dn + 300);
  exception when insufficient_privilege then anon_blocked := true;
  end;
  reset role;
  perform pg_temp.ctx(null);

  perform pg_temp.rec('auth.uid() absent, malformed or anon: sign/verify/settle refuse',
    abs_sign and abs_verify and abs_settle and bad_sub and anon_blocked,
    format('no-sub JWT -> 28000 for sign=%s verify=%s settle=%s; non-uuid sub raises=%s; anon denied EXECUTE=%s',
           abs_sign, abs_verify, abs_settle, bad_sub, anon_blocked));
end $$;

-- ===== 8. HMAC-SHA256: pgcrypto vs an independent RFC 2104 construction over RFC 4231 inputs ===========
do $$
declare
  k1 bytea := decode(repeat('0b', 20), 'hex');   m1 bytea := convert_to('Hi There', 'UTF8');
  k2 bytea := convert_to('Jefe', 'UTF8');        m2 bytea := convert_to('what do ya want for nothing?', 'UTF8');
  k3 bytea := decode(repeat('aa', 20), 'hex');   m3 bytea := decode(repeat('dd', 50), 'hex');
  k6 bytea := decode(repeat('aa', 131), 'hex');  m6 bytea := convert_to('Test Using Larger Than Block-Size Key - Hash Key First', 'UTF8');
  rfc_ok boolean; rnd_ok boolean := true; lens int[] := array[1, 32, 63, 64, 65, 200]; l int; rk bytea; rm bytea;
begin
  rfc_ok := extensions.hmac(m1, k1, 'sha256') = pg_temp.hmac256_manual(k1, m1)
        and extensions.hmac(m2, k2, 'sha256') = pg_temp.hmac256_manual(k2, m2)
        and extensions.hmac(m3, k3, 'sha256') = pg_temp.hmac256_manual(k3, m3)
        and extensions.hmac(m6, k6, 'sha256') = pg_temp.hmac256_manual(k6, m6);
  foreach l in array lens loop
    rk := extensions.gen_random_bytes(l);
    rm := extensions.gen_random_bytes(l);
    rnd_ok := rnd_ok and extensions.hmac(rm, rk, 'sha256') = pg_temp.hmac256_manual(rk, rm);
  end loop;
  perform pg_temp.rec('HMAC-SHA256: pgcrypto equals independent RFC 2104 construction (RFC 4231 inputs + random keys)',
    rfc_ok and rnd_ok,
    format('RFC 4231 TC1, TC2, TC3, TC6 (131-byte key) and random key/message lengths 1,32,63,64,65,200 all agree. TC2 output begins %s (eyeball only: RFC 4231 TC2 begins 5bdcc146bf60754e)',
           left(encode(extensions.hmac(m2, k2, 'sha256'), 'hex'), 16)));
end $$;

-- ===== 9. signing: Vault key, canonical format, domain separation, field and user binding ==============
do $$
declare
  uid uuid := gen_random_uuid();  uid2 uuid := gen_random_uuid();
  conv uuid := gen_random_uuid(); conv2 uuid := gen_random_uuid();
  req uuid := gen_random_uuid();  req2 uuid := gen_random_uuid();
  resv uuid := gen_random_uuid(); resv2 uuid := gen_random_uuid();
  h text := encode(sha256(convert_to('hello', 'UTF8')), 'hex');
  h2 text := encode(sha256(convert_to('hellp', 'UTF8')), 'hex');
  t_iat bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  t_exp bigint := floor(extract(epoch from clock_timestamp()))::bigint + 300;
  names text[] := array['domain', 'conversation_id', 'seq', 'content_hash', 'client_request_id', 'reservation_id',
                        'provider', 'model', 'usage_input_tokens', 'usage_output_tokens', 'iat', 'exp'];
  rej boolean[] := array_fill(false, array[12]);
  sig text; sig_settle text; sig_uid2 text; i int;
  accepted boolean; cross1 boolean; cross2 boolean; user_rej boolean;
  canon text; parts text[]; vkey bytea; fmt_ok boolean; key_ok boolean;
begin
  perform pg_temp.ctx(uid);
  set local role authenticated;
  sig := a5_probe.sign('ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  sig_settle := a5_probe.sign('ombre.ai.settle.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  accepted := a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  cross1 := a5_probe.verify(sig_settle, 'ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  cross2 := a5_probe.verify(sig, 'ombre.ai.settle.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  for i in 1 .. 12 loop
    rej[i] := not a5_probe.verify(sig,
      case when i = 1 then 'ombre.ai.settle.v1' else 'ombre.ai.commit.v1' end,
      case when i = 2 then conv2 else conv end,
      case when i = 3 then 8 else 7 end,
      case when i = 4 then h2 else h end,
      case when i = 5 then req2 else req end,
      case when i = 6 then resv2 else resv end,
      case when i = 7 then 'cloudflare' else 'nvidia' end,
      case when i = 8 then 'meta/llama-3.1-8b-instruct' else 'meta/llama-3.1-70b-instruct' end,
      case when i = 9 then 124 else 123 end,
      case when i = 10 then 457 else 456 end,
      case when i = 11 then t_iat + 1 else t_iat end,
      case when i = 12 then t_exp + 1 else t_exp end);
  end loop;
  reset role;

  perform pg_temp.ctx(uid2);
  set local role authenticated;
  user_rej := not a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  sig_uid2 := a5_probe.sign('ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  reset role;
  perform pg_temp.ctx(null);

  canon := a5_probe_private.canonical('ombre.ai.commit.v1', uid, conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  parts := string_to_array(canon, E'\n');
  fmt_ok := array_length(parts, 1) = 13
        and parts[1] = 'ombre.ai.commit.v1' and parts[2] = uid::text and parts[3] = conv::text
        and parts[4] = '7' and parts[5] = h and parts[6] = req::text and parts[7] = resv::text
        and parts[8] = 'nvidia' and parts[9] = 'meta/llama-3.1-70b-instruct'
        and parts[10] = '123' and parts[11] = '456' and parts[12] = t_iat::text and parts[13] = t_exp::text
        and right(canon, 1) <> E'\n';
  vkey := a5_probe_private.get_key();
  key_ok := sig = encode(extensions.hmac(convert_to(canon, 'UTF8'), vkey, 'sha256'), 'hex')
        and sig = encode(pg_temp.hmac256_manual(vkey, convert_to(canon, 'UTF8')), 'hex');

  perform pg_temp.rec('Signing uses the Vault key over the canonical bytes',
    key_ok, 'sign() output equals pgcrypto hmac and the independent RFC 2104 construction, both keyed with the Vault secret read by the privileged context');
  perform pg_temp.rec('Canonical newline-delimited format',
    fmt_ok, '13 fields in fixed order (domain, user, conversation, seq, content hash, request, reservation, provider, model, input tokens, output tokens, iat, exp), single newline delimiters, no trailing newline');
  perform pg_temp.rec('Domain separation (commit vs settle)',
    accepted and sig <> sig_settle and not cross1 and not cross2,
    format('commit and settle signatures differ=%s; settle sig rejected as commit=%s; commit sig rejected as settle=%s', sig <> sig_settle, not cross1, not cross2));
  for i in 1 .. 12 loop
    perform pg_temp.rec('Binding: ' || names[i], accepted and rej[i],
      'verify() accepts the unmodified token and rejects it after changing only this field');
  end loop;
  perform pg_temp.rec('Binding: user_id via auth.uid()',
    accepted and user_rej and sig_uid2 <> sig,
    format('same fields signed under a different auth.uid() give a different signature=%s; token rejected for a different user=%s', sig_uid2 <> sig, user_rej));
end $$;

-- ===== 9b. verify(): attacker-controlled malformed input returns false and never raises ================
do $$
declare
  uid uuid := gen_random_uuid(); conv uuid := gen_random_uuid(); req uuid := gen_random_uuid(); resv uuid := gen_random_uuid();
  h text := encode(sha256(convert_to('hello', 'UTF8')), 'hex');
  t_iat bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  t_exp bigint := floor(extract(epoch from clock_timestamp()))::bigint + 300;
  sig text; base_ok boolean; r boolean; s text; k int; n int;
  tested int := 0; wrong int := 0; raised int := 0; detail text := ''; unauth_ok boolean := false;
  verify_src text;
  sigs text[]; doms text[]; hashes text[]; provs text[]; models text[];
  seqs int[] := array[null::int, 0, -1];
  ins int[] := array[null::int, -1];
  outs int[] := array[null::int, -1];
  iats bigint[]; exps bigint[];
begin
  perform pg_temp.ctx(uid);
  set local role authenticated;
  sig := a5_probe.sign('ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  base_ok := a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);

  sigs := array[null, '', 'abc', repeat('g', 64), translate(sig, 'abcdef', 'ABCDEF'), sig || 'a', left(sig, 63),
                E'\n' || left(sig, 63), sig || E'\n'];
  doms := array[null, '', 'ombre.ai.commit.v2', 'OMBRE.AI.COMMIT.V1', E'ombre.ai.commit.v1\n', 'ombre.ai.other.v1'];
  hashes := array[null, '', repeat('a', 63), repeat('a', 65), translate(h, 'abcdef', 'ABCDEF'), repeat('z', 64),
                  h || E'\n', E'\n' || left(h, 63)];
  provs := array[null, '', E'a\nb', 'has space', repeat('a', 65), '@cf', 'semi;colon', E'nvidia\n'];
  models := array[null, '', repeat('a', 129), '@@cf/x', 'a@b', '@', E'm\n', 'has space', 's' || chr(233) || 'mantic'];
  iats := array[null::bigint, t_iat, t_iat, t_iat + 10, t_iat, t_iat + 61, t_iat - 400, -1, 9223372036854775806, t_iat];
  exps := array[t_exp, null::bigint, t_iat, t_iat, t_iat + 601, t_iat + 120, t_iat - 100, t_exp, 9223372036854775807, 9223372036854775807];

  foreach s in array sigs loop
    tested := tested + 1;
    begin
      r := a5_probe.verify(s, 'ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
      if r is distinct from false then wrong := wrong + 1; detail := detail || 'sig=' || coalesce(left(s, 12), 'NULL') || '; '; end if;
    exception when others then raised := raised + 1; detail := detail || 'sig raised ' || sqlstate || '; ';
    end;
  end loop;
  foreach s in array doms loop
    tested := tested + 1;
    begin
      r := a5_probe.verify(sig, s, conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
      if r is distinct from false then wrong := wrong + 1; detail := detail || 'domain=' || coalesce(s, 'NULL') || '; '; end if;
    exception when others then raised := raised + 1; detail := detail || 'domain raised ' || sqlstate || '; ';
    end;
  end loop;
  foreach s in array hashes loop
    tested := tested + 1;
    begin
      r := a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 7, s, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
      if r is distinct from false then wrong := wrong + 1; detail := detail || 'hash=' || coalesce(left(s, 12), 'NULL') || '; '; end if;
    exception when others then raised := raised + 1; detail := detail || 'hash raised ' || sqlstate || '; ';
    end;
  end loop;
  foreach s in array provs loop
    tested := tested + 1;
    begin
      r := a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 7, h, req, resv, s, 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
      if r is distinct from false then wrong := wrong + 1; detail := detail || 'provider=' || coalesce(left(s, 12), 'NULL') || '; '; end if;
    exception when others then raised := raised + 1; detail := detail || 'provider raised ' || sqlstate || '; ';
    end;
  end loop;
  foreach s in array models loop
    tested := tested + 1;
    begin
      r := a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', s, 123, 456, t_iat, t_exp);
      if r is distinct from false then wrong := wrong + 1; detail := detail || 'model=' || coalesce(left(s, 12), 'NULL') || '; '; end if;
    exception when others then raised := raised + 1; detail := detail || 'model raised ' || sqlstate || '; ';
    end;
  end loop;
  foreach k in array seqs loop
    tested := tested + 1;
    begin
      r := a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, k, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
      if r is distinct from false then wrong := wrong + 1; detail := detail || 'seq=' || coalesce(k::text, 'NULL') || '; '; end if;
    exception when others then raised := raised + 1; detail := detail || 'seq raised ' || sqlstate || '; ';
    end;
  end loop;
  foreach k in array ins loop
    tested := tested + 1;
    begin
      r := a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', k, 456, t_iat, t_exp);
      if r is distinct from false then wrong := wrong + 1; detail := detail || 'input_tokens=' || coalesce(k::text, 'NULL') || '; '; end if;
    exception when others then raised := raised + 1; detail := detail || 'input_tokens raised ' || sqlstate || '; ';
    end;
  end loop;
  foreach k in array outs loop
    tested := tested + 1;
    begin
      r := a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, k, t_iat, t_exp);
      if r is distinct from false then wrong := wrong + 1; detail := detail || 'output_tokens=' || coalesce(k::text, 'NULL') || '; '; end if;
    exception when others then raised := raised + 1; detail := detail || 'output_tokens raised ' || sqlstate || '; ';
    end;
  end loop;
  for n in 1 .. array_length(iats, 1) loop
    tested := tested + 1;
    begin
      r := a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, iats[n], exps[n]);
      if r is distinct from false then wrong := wrong + 1; detail := detail || 'iat/exp pair ' || n || '; '; end if;
    exception when others then raised := raised + 1; detail := detail || 'iat/exp pair ' || n || ' raised ' || sqlstate || '; ';
    end;
  end loop;
  for n in 1 .. 3 loop
    tested := tested + 1;
    begin
      r := a5_probe.verify(sig, 'ombre.ai.commit.v1',
        case when n = 1 then null::uuid else conv end, 7, h,
        case when n = 2 then null::uuid else req end,
        case when n = 3 then null::uuid else resv end,
        'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
      if r is distinct from false then wrong := wrong + 1; detail := detail || 'null uuid ' || n || '; '; end if;
    exception when others then raised := raised + 1; detail := detail || 'null uuid ' || n || ' raised ' || sqlstate || '; ';
    end;
  end loop;
  reset role;

  -- authentication is checked first: absent auth.uid() still raises 28000, even with malformed input
  perform pg_temp.ctx(null);
  set local role authenticated;
  begin
    perform a5_probe.verify(null, null, null, null, null, null, null, null, null, null, null, null, null);
  exception when sqlstate '28000' then unauth_ok := true;
  end;
  reset role;
  perform pg_temp.ctx(null);

  select prosrc into verify_src from pg_proc
   where oid = 'a5_probe.verify(text,text,uuid,integer,text,uuid,uuid,text,text,integer,integer,bigint,bigint)'::regprocedure;

  perform pg_temp.rec('verify(): malformed input returns false and never raises',
    base_ok and wrong = 0 and raised = 0,
    format('%s malformed cases (signature, domain, content hash, provider, model, seq, usage figures, iat/exp incl. overflow-range values, NULL uuids): %s returned something other than false, %s raised%s',
           tested, wrong, raised, case when detail <> '' then ' -> ' || left(detail, 200) else '' end));
  perform pg_temp.rec('verify(): absent auth.uid() still raises (authentication is checked before input validation)',
    unauth_ok, 'fully NULL arguments without auth.uid() raise 28000 instead of returning false');
  perform pg_temp.rec('verify(): no blanket exception handler',
    verify_src !~* 'exception\s+when', 'function source has no exception handler, so unexpected internal errors propagate');
end $$;

-- ===== 9c. verify(): an internal failure propagates instead of returning false ========================
do $$
declare
  uid uuid := gen_random_uuid(); conv uuid := gen_random_uuid(); req uuid := gen_random_uuid(); resv uuid := gen_random_uuid();
  h text := repeat('c', 64);
  t_iat bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  t_exp bigint := floor(extract(epoch from clock_timestamp()))::bigint + 300;
  sig text; v_before boolean; v_after boolean := false; inj boolean := false; n int;
  propagated boolean := false; outcome text := 'not run'; malformed_false boolean := false; restored boolean := false;
begin
  perform pg_temp.ctx(uid);
  set local role authenticated;
  sig := a5_probe.sign('ombre.ai.commit.v1', conv, 1, h, req, resv, 'nvidia', 'm', 1, 1, t_iat, t_exp);
  v_before := a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 1, h, req, resv, 'nvidia', 'm', 1, 1, t_iat, t_exp);
  reset role;

  begin
    update vault.secrets set name = 'a5_probe_hmac_key_renamed' where name = 'a5_probe_hmac_key';
    get diagnostics n = row_count;
    inj := n = 1;
  exception when others then
    inj := false;
  end;

  if inj then
    set local role authenticated;
    begin
      perform a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 1, h, req, resv, 'nvidia', 'm', 1, 1, t_iat, t_exp);
      outcome := 'returned without error';
    exception when others then
      propagated := sqlstate = 'P0001';
      outcome := 'raised ' || sqlstate;
    end;
    begin
      malformed_false := a5_probe.verify('abc', 'ombre.ai.commit.v1', conv, 1, h, req, resv, 'nvidia', 'm', 1, 1, t_iat, t_exp) is not distinct from false;
    exception when others then
      malformed_false := false;
    end;
    reset role;
    begin
      update vault.secrets set name = 'a5_probe_hmac_key' where name = 'a5_probe_hmac_key_renamed';
      get diagnostics n = row_count;
      restored := n = 1;
    exception when others then
      restored := false;
    end;
    perform pg_temp.ctx(uid);
    set local role authenticated;
    begin
      v_after := a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 1, h, req, resv, 'nvidia', 'm', 1, 1, t_iat, t_exp);
    exception when others then
      v_after := false;
    end;
    reset role;
    perform pg_temp.ctx(null);
    perform pg_temp.rec('verify(): internal errors propagate (missing Vault key raises P0001, not false)',
      v_before and propagated and malformed_false and restored and v_after,
      format('valid token verified=%s; with the key unavailable a valid-shaped token -> %s; a malformed signature still returns false=%s; key restored=%s and verifies again=%s',
             v_before, outcome, malformed_false, restored, v_after));
  else
    perform pg_temp.ctx(null);
    perform pg_temp.info('verify(): internal-error propagation not exercised',
      'the probe could not temporarily rename the throwaway Vault secret; the "no blanket exception handler" source check above still applies');
  end if;
end $$;

-- ===== 10. iat/exp windows ===============================================================================
select pg_temp.rec('iat/exp: check_window boundaries (iat<=now+60, exp-iat<=600, exp>iat, not expired)',
  count(*) = 8 and bool_and(a5_probe_private.check_window(c_iat, c_exp, c_now) is not distinct from c_expect),
  (count(*) filter (where a5_probe_private.check_window(c_iat, c_exp, c_now) is not distinct from c_expect)) || '/' || count(*) || ' boundary cases correct')
from (values
  ('iat=now',               1000, 1300, 1000, null::text),
  ('iat=now+60 boundary',   1060, 1360, 1000, null),
  ('iat=now+61',            1061, 1361, 1000, 'iat_in_future'),
  ('lifetime=600 boundary', 1000, 1600, 1000, null),
  ('lifetime=601',          1000, 1601, 1000, 'lifetime_too_long'),
  ('exp=iat',               1000, 1000, 1000, 'exp_not_after_iat'),
  ('expired (exp=now)',     1000, 1300, 1300, 'expired'),
  ('null input',            null, 1300, 1000, 'null_input')
) as c(label, c_iat, c_exp, c_now, c_expect);

do $$
declare
  uid uuid := gen_random_uuid(); conv uuid := gen_random_uuid(); req uuid := gen_random_uuid(); resv uuid := gen_random_uuid();
  h text := repeat('b', 64); now_s bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  fut_rej boolean := false; long_rej boolean := false; exp_rej boolean := false; edge_ok boolean := false;
  old_sig text; old_mac_ok boolean; old_verify boolean; s text;
begin
  perform pg_temp.ctx(uid);
  set local role authenticated;
  begin perform a5_probe.sign('ombre.ai.commit.v1', conv, 1, h, req, resv, 'p', 'm', 0, 0, now_s + 61, now_s + 120);
  exception when sqlstate '22023' then fut_rej := true; end;
  begin perform a5_probe.sign('ombre.ai.commit.v1', conv, 1, h, req, resv, 'p', 'm', 0, 0, now_s, now_s + 601);
  exception when sqlstate '22023' then long_rej := true; end;
  begin perform a5_probe.sign('ombre.ai.commit.v1', conv, 1, h, req, resv, 'p', 'm', 0, 0, now_s - 400, now_s - 100);
  exception when sqlstate '22023' then exp_rej := true; end;
  s := a5_probe.sign('ombre.ai.commit.v1', conv, 1, h, req, resv, 'p', 'm', 0, 0, now_s + 60, now_s + 660);
  edge_ok := s is not null;
  reset role;

  -- a correctly signed but already expired token (made with the private mac(), bypassing sign()'s window check)
  old_sig := encode(a5_probe_private.mac('ombre.ai.commit.v1', uid, conv, 1, h, req, resv, 'p', 'm', 0, 0, now_s - 400, now_s - 100), 'hex');
  old_mac_ok := a5_probe_private.ct_equal(
    a5_probe_private.mac('ombre.ai.commit.v1', uid, conv, 1, h, req, resv, 'p', 'm', 0, 0, now_s - 400, now_s - 100), decode(old_sig, 'hex'));
  perform pg_temp.ctx(uid);
  set local role authenticated;
  old_verify := a5_probe.verify(old_sig, 'ombre.ai.commit.v1', conv, 1, h, req, resv, 'p', 'm', 0, 0, now_s - 400, now_s - 100);
  reset role;
  perform pg_temp.ctx(null);

  perform pg_temp.rec('iat/exp: sign() refuses bad windows; verify() refuses an expired token',
    fut_rej and long_rej and exp_rej and edge_ok and old_mac_ok and not old_verify,
    format('iat=now+61 refused=%s; lifetime 601 refused=%s; already expired refused=%s; iat=now+60 with lifetime 600 accepted=%s; expired token has a valid MAC=%s yet verify()=%s',
           fut_rej, long_rej, exp_rej, edge_ok, old_mac_ok, old_verify));
end $$;

-- ===== 11. content hash / NUL / surrogates ===============================================================
do $$
declare
  samples text[] := array['hello', 'a b', 'e' || chr(769), chr(128512), chr(28450) || chr(23383),
                          E'line1\r\nline2\n', '', chr(65533)];
  s text; b bytea; n_ok int := 0; two_impl boolean := true;
  nul_pg text := 'accepted'; nul_chr text := 'accepted'; sur text := 'accepted'; fffd_ok boolean; byte_char boolean;
begin
  foreach s in array samples loop
    b := convert_to(s, 'UTF8');
    if extensions.digest(b, 'sha256') = sha256(b) and length(sha256(b)) = 32
       and encode(sha256(b), 'hex') ~ '^[0-9a-f]{64}$' then
      n_ok := n_ok + 1;
    else
      two_impl := false;
    end if;
  end loop;
  byte_char := octet_length(convert_to(chr(233), 'UTF8')) = 2 and char_length(chr(233)) = 1
           and sha256(convert_to(chr(233), 'UTF8')) = sha256(decode('c3', 'hex') || decode('a9', 'hex'))
           and sha256(convert_to('hello', 'UTF8')) = sha256(decode('68656c6c6f', 'hex'));
  fffd_ok := convert_to(chr(65533), 'UTF8') = decode('efbfbd', 'hex')
         and convert_from(decode('efbfbd', 'hex'), 'UTF8') = chr(65533);
  begin
    perform convert_from(decode('61', 'hex') || decode('00', 'hex') || decode('62', 'hex'), 'UTF8');
  exception when others then nul_pg := 'rejected, SQLSTATE ' || sqlstate;
  end;
  begin
    perform chr(0);
  exception when others then nul_chr := 'rejected, SQLSTATE ' || sqlstate;
  end;
  begin
    perform convert_from(decode('ed', 'hex') || decode('a0', 'hex') || decode('80', 'hex'), 'UTF8');
  exception when others then sur := 'rejected, SQLSTATE ' || sqlstate;
  end;

  perform pg_temp.rec('Content hash: SHA-256 over UTF-8 bytes, pgcrypto equals core sha256()',
    two_impl and n_ok = array_length(samples, 1) and byte_char,
    format('%s samples (ASCII, combining mark, emoji, CJK, CRLF, empty, U+FFFD): digest()=sha256(); hash covers bytes not characters (U+00E9 is 2 bytes); hello via convert_to equals hello via decode',
           n_ok));
  perform pg_temp.rec('Content: raw NUL rejected by PostgreSQL (why NUL is stripped client-side)',
    nul_pg like 'rejected%' and nul_chr like 'rejected%', format('NUL byte in UTF8 text: %s; chr(0): %s', nul_pg, nul_chr));
  perform pg_temp.rec('Content: lone-surrogate bytes rejected, U+FFFD accepted (what toWellFormed() produces)',
    sur like 'rejected%' and fffd_ok, format('surrogate byte sequence ED A0 80: %s; U+FFFD round-trips as EF BF BD: %s', sur, fffd_ok));
  perform pg_temp.info('Content: toWellFormed() and NUL stripping are client-side JavaScript',
    'cannot be executed in SQL; this probe proves only the PostgreSQL side. Cover the JS side with Node unit tests when the A5 code is written (lone surrogate -> U+FFFD, NUL removed, then SHA-256 of UTF-8)');
end $$;

-- ===== 12. provider/model validation ====================================================================
do $$
declare
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid(); u4 uuid := gen_random_uuid();
  h text := repeat('a', 64);
  prov_good text[] := array['nvidia', 'cloudflare', 'a_b.c-d', 'X', 'meta/llama'];
  prov_bad text[] := array['has space', E'new\nline', E'trailing\n', '', repeat('a', 65), 'semi;colon', 'quo"te',
                           E'tab\there', 's' || chr(233) || 'mantic', 'emoji' || chr(128512), '@cf', '=x'];
  model_good text[] := array['meta/llama-3.1-70b-instruct', 'qwen2.5:7b', '@cf/meta/llama-3.1-8b-instruct',
                             '@hf/thebloke/mistral-7b-instruct-v0.1-awq', 'X'];
  model_bad text[] := array['has space', E'new\nline', E'trailing\n', '', repeat('a', 129), 'semi;colon', 'quo"te',
                            E'tab\there', 's' || chr(233) || 'mantic', 'emoji' || chr(128512), '@@cf/x', 'a@b', '@', E'@cf/x\n'];
  s text; good_fail int := 0; bad_accepted int := 0; cf boolean := false;
begin
  foreach s in array prov_good loop
    begin perform a5_probe_private.canonical('ombre.ai.commit.v1', u1, u2, 1, h, u3, u4, s, 'm', 0, 0, 1, 2);
    exception when others then good_fail := good_fail + 1; end;
  end loop;
  foreach s in array prov_bad loop
    begin perform a5_probe_private.canonical('ombre.ai.commit.v1', u1, u2, 1, h, u3, u4, s, 'm', 0, 0, 1, 2);
      bad_accepted := bad_accepted + 1;
    exception when sqlstate '22023' then null; end;
  end loop;
  foreach s in array model_good loop
    begin perform a5_probe_private.canonical('ombre.ai.commit.v1', u1, u2, 1, h, u3, u4, 'p', s, 0, 0, 1, 2);
    exception when others then good_fail := good_fail + 1; end;
  end loop;
  foreach s in array model_bad loop
    begin perform a5_probe_private.canonical('ombre.ai.commit.v1', u1, u2, 1, h, u3, u4, 'p', s, 0, 0, 1, 2);
      bad_accepted := bad_accepted + 1;
    exception when sqlstate '22023' then null; end;
  end loop;
  begin perform a5_probe_private.canonical('ombre.ai.commit.v1', u1, u2, 1, h, u3, u4, 'cloudflare', '@cf/meta/llama-3.1-8b-instruct', 0, 0, 1, 2);
    cf := true;
  exception when others then cf := false; end;

  perform pg_temp.rec('Provider/model validation (incl. newline and delimiter-injection attempts)',
    good_fail = 0 and bad_accepted = 0,
    format('%s valid values accepted, %s invalid values rejected with 22023 (space, newline, trailing newline, empty, over-length, ; " tab, non-ASCII, emoji, provider @, double or inner @)',
           array_length(prov_good, 1) + array_length(model_good, 1), array_length(prov_bad, 1) + array_length(model_bad, 1)));
  perform pg_temp.rec('Cloudflare-style model id (@cf/...) accepted', cf,
    'model regex ^@?[A-Za-z0-9._:/-]{1,128}$ accepts a single leading @; a second or inner @ and any @ in the provider are rejected');
  perform pg_temp.info('Approved design: one leading @ allowed in model ids',
    'approved for Cloudflare Workers AI ids (@cf/..., @hf/...). Provider charset stays [A-Za-z0-9._:/-]. @ is not a field delimiter, so newline-delimited canonicalization is unaffected');
end $$;

-- ===== 13. reservation uniqueness, lease, settlement ====================================================
do $$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  r1 uuid := gen_random_uuid();   -- user a, live lease: settles 500
  r2 uuid := gen_random_uuid();   -- user a, expired lease: reclaim test
  r3 uuid := gen_random_uuid();   -- user a, expired lease: settle must fail and change nothing
  rc uuid := gen_random_uuid();   -- user c, live lease: token validation cases
  q1 uuid := gen_random_uuid(); q2 uuid := gen_random_uuid(); q3 uuid := gen_random_uuid(); q4 uuid := gen_random_uuid();
  dup_rows int; reclaim_expired int; reclaim_live int; uniq_raised boolean := false;
  s1 text; s2 text; s3 text; s_exp1 text; s_exp2 text; s_exp_other text; tot_a bigint;
  st3 text; tk3 int;
  null_rej boolean := false; neg_rej boolean := false; n_usage_c int; st_c text; tk_c int;
  s_zero text; s_replay text; tot_c bigint; st_c2 text; tk_c2 int;
begin
  insert into a5_probe.reservation(id, user_id, client_request_id, lease_expires_at) values
    (r1, a, q1, now() + interval '60 seconds'),
    (r2, a, q2, now() - interval '1 second'),
    (r3, a, q3, now() - interval '1 second'),
    (rc, c, q4, now() + interval '60 seconds');

  -- uniqueness on (user_id, client_request_id)
  insert into a5_probe.reservation(id, user_id, client_request_id, lease_expires_at)
    values (gen_random_uuid(), a, q1, now() + interval '60 seconds')
    on conflict (user_id, client_request_id) do nothing;
  get diagnostics dup_rows = row_count;
  begin
    insert into a5_probe.reservation(id, user_id, client_request_id, lease_expires_at)
      values (gen_random_uuid(), a, q1, now() + interval '60 seconds');
  exception when unique_violation then uniq_raised := true;
  end;
  insert into a5_probe.reservation(id, user_id, client_request_id, lease_expires_at)
    values (gen_random_uuid(), b, q1, now() + interval '60 seconds');   -- same request id, different user: allowed
  perform pg_temp.rec('Reservation uniqueness on (user_id, client_request_id)',
    dup_rows = 0 and uniq_raised,
    format('duplicate insert: ON CONFLICT DO NOTHING inserted %s rows, plain insert raised unique_violation=%s; same request id for another user is allowed', dup_rows, uniq_raised));

  -- lease reclaim (r2 is expired, r1 is live)
  update a5_probe.reservation set lease_expires_at = now() + interval '60 seconds'
   where id = r2 and state = 'reserved' and lease_expires_at <= now();
  get diagnostics reclaim_expired = row_count;
  update a5_probe.reservation set lease_expires_at = now() + interval '60 seconds'
   where id = r1 and state = 'reserved' and lease_expires_at <= now();
  get diagnostics reclaim_live = row_count;
  perform pg_temp.rec('Reservation lease: expired lease reclaimable, live lease not',
    reclaim_expired = 1 and reclaim_live = 0,
    format('expired lease reclaimed %s row(s); unexpired lease reclaimed %s row(s)', reclaim_expired, reclaim_live));

  -- settlement as user a: unexpired settles once; expired is refused deterministically and changes nothing
  perform pg_temp.ctx(a);
  set local role authenticated;
  s1 := a5_probe.settle(r1, 500);
  s2 := a5_probe.settle(r1, 500);
  s_exp1 := a5_probe.settle(r3, 100);
  s_exp2 := a5_probe.settle(r3, 100);
  reset role;
  perform pg_temp.ctx(b);
  set local role authenticated;
  s3 := a5_probe.settle(r1, 500);
  s_exp_other := a5_probe.settle(r3, 100);
  reset role;
  perform pg_temp.ctx(null);
  select u.total into tot_a from a5_probe.usage_totals u where u.user_id = a;
  select state, settled_tokens into st3, tk3 from a5_probe.reservation where id = r3;

  perform pg_temp.rec('Settlement is idempotent and bound to auth.uid()',
    s1 = 'settled' and s2 = 'already_settled' and s3 = 'not_found' and tot_a = 500,
    format('unexpired reservation settled=%s; replay=%s; other user=%s; usage counted once=%s', s1, s2, s3, tot_a));
  perform pg_temp.rec('Settlement rejects expired reservations deterministically',
    s_exp1 = 'lease_expired' and s_exp2 = 'lease_expired' and s_exp_other = 'not_found'
      and st3 = 'reserved' and tk3 is null and tot_a = 500,
    format('expired reservation: settle -> %s, repeated -> %s (contract: returns lease_expired and modifies nothing); afterwards state=%s, settled_tokens=%s, usage total still %s; another user -> %s',
           s_exp1, s_exp2, st3, coalesce(tk3::text, 'NULL'), tot_a, s_exp_other));

  -- token validation as user c (no usage_totals row exists yet)
  perform pg_temp.ctx(c);
  set local role authenticated;
  begin perform a5_probe.settle(rc, null);
  exception when sqlstate '22023' then null_rej := true; end;
  begin perform a5_probe.settle(rc, -1);
  exception when sqlstate '22023' then neg_rej := true; end;
  reset role;
  select count(*) into n_usage_c from a5_probe.usage_totals where user_id = c;
  select state, settled_tokens into st_c, tk_c from a5_probe.reservation where id = rc;

  perform pg_temp.ctx(c);
  set local role authenticated;
  s_zero := a5_probe.settle(rc, 0);
  s_replay := a5_probe.settle(rc, 5);
  reset role;
  perform pg_temp.ctx(null);
  select u.total into tot_c from a5_probe.usage_totals u where u.user_id = c;
  select state, settled_tokens into st_c2, tk_c2 from a5_probe.reservation where id = rc;

  perform pg_temp.rec('Settlement token validation: NULL and negative rejected; 0 and a positive value settle',
    null_rej and neg_rej and n_usage_c = 0 and st_c = 'reserved' and tk_c is null
      and s_zero = 'settled' and s_replay = 'already_settled' and tot_c = 0 and st_c2 = 'settled' and tk_c2 = 0
      and s1 = 'settled' and tot_a = 500,
    format('NULL rejected=%s, -1 rejected=%s (22023, before any write); after them usage_totals rows for the user=%s, reservation state=%s, settled_tokens=%s; 0 -> %s (total %s), replay -> %s; normal positive (500) -> %s. No upper bound enforced: the probe contract defines none, only the int range applies',
           null_rej, neg_rej, n_usage_c, st_c, coalesce(tk_c::text, 'NULL'), s_zero, tot_c, s_replay, s1));
end $$;

-- ===== 14. timing-safe comparison ========================================================================
do $$
declare
  a bytea := extensions.gen_random_bytes(32); f bytea; l bytea; sh bytea; ex boolean; i int; t0 timestamptz;
  d_first interval; d_last interval; x boolean; fn_src text;
begin
  f := set_byte(a, 0, get_byte(a, 0) # 1);
  l := set_byte(a, 31, get_byte(a, 31) # 1);
  sh := substring(a from 1 for 31);
  ex := a5_probe_private.ct_equal(a, a)
    and not a5_probe_private.ct_equal(a, f)
    and not a5_probe_private.ct_equal(a, l)
    and not a5_probe_private.ct_equal(a, sh)
    and not a5_probe_private.ct_equal(a, null)
    and not a5_probe_private.ct_equal(null, null)
    and a5_probe_private.ct_equal(''::bytea, ''::bytea);
  select prosrc into fn_src from pg_proc where oid = 'a5_probe_private.ct_equal(bytea,bytea)'::regprocedure;
  perform pg_temp.rec('Timing-safe comparison: functional behaviour',
    ex and fn_src like '%diff := diff |%' and fn_src not like '%exit%',
    'equal -> true; first-byte, last-byte, length and NULL mismatches -> false; loop accumulates XOR over all bytes with no early exit (source inspected). Functional proof only: PL/pgSQL gives no constant-time guarantee');
  t0 := clock_timestamp();
  for i in 1 .. 20000 loop x := a5_probe_private.ct_equal(a, f); end loop;
  d_first := clock_timestamp() - t0;
  t0 := clock_timestamp();
  for i in 1 .. 20000 loop x := a5_probe_private.ct_equal(a, l); end loop;
  d_last := clock_timestamp() - t0;
  perform pg_temp.info('Timing-safe comparison: informal timing sample (NOT a proof)',
    format('20000 comparisons: first-byte mismatch %s ms, last-byte mismatch %s ms. PL/pgSQL gives no constant-time guarantee; this single noisy sample cannot prove one',
           round((extract(epoch from d_first) * 1000)::numeric, 1), round((extract(epoch from d_last) * 1000)::numeric, 1)));
end $$;

-- ===== 15. report =========================================================================================
\o
\echo '=== ALL CHECKS ==='
select n, status, check_name, left(evidence, 200) as evidence from pg_temp.probe_results order by n;
\echo '=== COUNTS ==='
select s.status, count(r.n) as rows
  from (values ('PASS'), ('FAIL'), ('INFO')) as s(status)
  left join pg_temp.probe_results r on r.status = s.status
 group by s.status
 order by case s.status when 'PASS' then 1 when 'FAIL' then 2 else 3 end;
\echo '=== FAIL ROWS (none listed means no FAIL) ==='
select n, check_name, evidence from pg_temp.probe_results where status = 'FAIL' order by n;
\echo '=== OVERALL ==='
select case when count(*) filter (where status = 'FAIL') = 0 then 'NO FAILS' else 'HAS FAILS' end as overall,
       count(*) as total_rows
  from pg_temp.probe_results;
rollback;
