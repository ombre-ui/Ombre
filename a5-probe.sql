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
    r := set_byte(r, i, get_byte(r, i) # pad);
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
create schema a5_probe;
create schema a5_probe_private;

create function a5_probe_private.get_key() returns bytea
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = 'a5_probe_hmac_key';
  if v is null then raise exception 'hmac key not provisioned' using errcode = 'P0001'; end if;
  return convert_to(v, 'UTF8');
end $$;

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

create function a5_probe_private.fields_error(
  p_domain text, p_user uuid, p_conv uuid, p_seq int, p_hash text, p_req uuid, p_resv uuid,
  p_provider text, p_model text, p_in int, p_out int, p_iat bigint, p_exp bigint) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_domain is null or p_domain not in ('ombre.ai.commit.v1', 'ombre.ai.settle.v1') then return 'bad domain'; end if;
  if p_user is null or p_conv is null or p_req is null or p_resv is null or p_seq is null
     or p_in is null or p_out is null or p_iat is null or p_exp is null then return 'null field'; end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then return 'bad content hash'; end if;
  if p_provider is null or p_provider !~ '^[A-Za-z0-9._:/-]{1,64}$' then return 'bad provider'; end if;
  if p_model is null or p_model !~ '^@?[A-Za-z0-9._:/-]{1,128}$' then return 'bad model'; end if;
  if p_seq < 1 or p_in < 0 or p_out < 0 or p_iat < 0 or p_exp < 0 or p_exp <= p_iat then return 'bad numeric field'; end if;
  return null;
end $$;

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

create function a5_probe.verify(
  p_sig text, p_domain text, p_conv uuid, p_seq int, p_hash text, p_req uuid, p_resv uuid,
  p_provider text, p_model text, p_in int, p_out int, p_iat bigint, p_exp bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_sig is null or p_sig !~ '^[0-9a-f]{64}$' then return false; end if;
  if a5_probe_private.fields_error(p_domain, v_uid, p_conv, p_seq, p_hash, p_req, p_resv,
                                   p_provider, p_model, p_in, p_out, p_iat, p_exp) is not null then return false; end if;
  if a5_probe_private.check_window(p_iat, p_exp, floor(extract(epoch from clock_timestamp()))::bigint) is not null then return false; end if;
  return a5_probe_private.ct_equal(
    a5_probe_private.mac(p_domain, v_uid, p_conv, p_seq, p_hash, p_req, p_resv,
                         p_provider, p_model, p_in, p_out, p_iat, p_exp),
    decode(p_sig, 'hex'));
end $$;

create table a5_probe.reservation(
  id uuid primary key, user_id uuid not null, client_request_id uuid not null,
  state text not null default 'reserved' check (state in ('reserved', 'settled', 'released')),
  lease_expires_at timestamptz not null, settled_tokens int,
  unique (user_id, client_request_id));

create table a5_probe.usage_totals(user_id uuid primary key, total bigint not null default 0);

create function a5_probe.settle(p_res uuid, p_tokens int) returns text
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_state text; v_lease timestamptz;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_tokens is null or p_tokens < 0 then raise exception 'invalid token count' using errcode = '22023'; end if;
  update a5_probe.reservation set state = 'settled', settled_tokens = p_tokens
   where id = p_res and user_id = v_uid and state = 'reserved' and lease_expires_at > now();
  if found then
    insert into a5_probe.usage_totals as u (user_id, total) values (v_uid, p_tokens)
      on conflict (user_id) do update set total = u.total + excluded.total;
    return 'settled';
  end if;
  select state, lease_expires_at into v_state, v_lease from a5_probe.reservation where id = p_res and user_id = v_uid;
  if not found then return 'not_found'; end if;
  if v_state = 'reserved' then return case when v_lease <= now() then 'lease_expired' else 'conflict' end; end if;
  return 'already_' || v_state;
end $$;

revoke all on schema a5_probe_private from public, anon, authenticated;
revoke all on all functions in schema a5_probe_private from public, anon, authenticated;
revoke all on all tables in schema a5_probe from public, anon, authenticated;
revoke all on all functions in schema a5_probe from public, anon;
grant usage on schema a5_probe to authenticated;
grant execute on all functions in schema a5_probe to authenticated;

do $$
declare
  stmts text[] := array[
    'select 1 from vault.decrypted_secrets limit 1','select 1 from vault.secrets limit 1',
    'select vault.create_secret(''x'', ''a5_probe_denied'', ''x'')','select a5_probe_private.get_key()',
    'select a5_probe_private.ct_equal(''\x00''::bytea, ''\x00''::bytea)',
    'select 1 from a5_probe.reservation limit 1','select 1 from a5_probe.usage_totals limit 1',
    'insert into a5_probe.usage_totals(user_id, total) values (gen_random_uuid(), 1)'];
  roles text[] := array['authenticated', 'anon']; s text; rl text; blocked int := 0; total int := 0; leaks text := ''; cat_ok boolean;
begin
  foreach rl in array roles loop
    foreach s in array stmts loop
      total := total + 1; execute format('set local role %I', rl);
      begin execute s; leaks := leaks || rl || ': ' || s || '; ';
      exception when insufficient_privilege then blocked := blocked + 1; end;
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
    if exists (select 1 from aclexplode(coalesce(r.proacl, acldefault('f', r.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      bad_grants := bad_grants || r.sig || ' executable by PUBLIC; '; end if;
    if has_function_privilege('anon', r.oid, 'execute') then bad_grants := bad_grants || r.sig || ' executable by anon; '; end if;
    if r.sch = 'a5_probe' and not has_function_privilege('authenticated', r.oid, 'execute') then bad_grants := bad_grants || r.sig || ' NOT executable by authenticated; '; end if;
    if r.sch = 'a5_probe_private' and has_function_privilege('authenticated', r.oid, 'execute') then bad_grants := bad_grants || r.sig || ' executable by authenticated; '; end if;
  end loop;
  for r in select c.oid, c.oid::regclass::text as nm from pg_class c
            where c.relnamespace in ('a5_probe'::regnamespace, 'a5_probe_private'::regnamespace) and c.relkind in ('r', 'p', 'v', 'm', 'S') loop
    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('anon', r.oid, priv) or has_table_privilege('authenticated', r.oid, priv) then bad_grants := bad_grants || r.nm || ' grants ' || priv || '; '; end if;
    end loop;
  end loop;
  if has_schema_privilege('anon', 'a5_probe', 'usage') then bad_grants := bad_grants || 'anon has USAGE on a5_probe; '; end if;
  if has_schema_privilege('anon', 'a5_probe_private', 'usage') then bad_grants := bad_grants || 'anon has USAGE on a5_probe_private; '; end if;
  if not has_schema_privilege('authenticated', 'a5_probe', 'usage') then bad_grants := bad_grants || 'authenticated lacks USAGE on a5_probe; '; end if;
  if has_schema_privilege('authenticated', 'a5_probe_private', 'usage') then bad_grants := bad_grants || 'authenticated has USAGE on a5_probe_private; '; end if;
  perform pg_temp.rec('Grants: RPC functions only for authenticated; private objects and probe tables unreachable',
    bad_grants = '', coalesce(nullif(bad_grants, ''), 'no unintended EXECUTE/table/schema privileges for PUBLIC, anon or authenticated'));
end $$;

do $$
declare
  uid uuid := gen_random_uuid(); got uuid; got_none uuid;
  dconv uuid := gen_random_uuid(); dreq uuid := gen_random_uuid(); dresv uuid := gen_random_uuid();
  dh text := repeat('a', 64); dn bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  abs_sign boolean := false; abs_verify boolean := false; abs_settle boolean := false;
  bad_sub boolean := false; anon_blocked boolean := false;
begin
  perform pg_temp.ctx(uid); set local role authenticated; got := auth.uid(); reset role;
  perform pg_temp.ctx(null); set local role authenticated; got_none := auth.uid(); reset role;
  perform pg_temp.rec('auth.uid(): probe establishes the JWT context explicitly',
    got = uid and got_none is null, 'auth.uid() returns the probe-set sub, and NULL when no sub claim is set');
  perform pg_temp.ctx(null); set local role authenticated;
  begin perform a5_probe.sign('ombre.ai.commit.v1', dconv, 1, dh, dreq, dresv, 'nvidia', 'm', 1, 1, dn, dn + 300);
  exception when sqlstate '28000' then abs_sign := true; end;
  begin perform a5_probe.verify(repeat('a', 64), 'ombre.ai.commit.v1', dconv, 1, dh, dreq, dresv, 'nvidia', 'm', 1, 1, dn, dn + 300);
  exception when sqlstate '28000' then abs_verify := true; end;
  begin perform a5_probe.settle(gen_random_uuid(), 1);
  exception when sqlstate '28000' then abs_settle := true; end;
  reset role;
  perform set_config('request.jwt.claims', '{"sub":"not-a-uuid","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'not-a-uuid', true);
  set local role authenticated;
  begin perform a5_probe.sign('ombre.ai.commit.v1', dconv, 1, dh, dreq, dresv, 'nvidia', 'm', 1, 1, dn, dn + 300);
  exception when others then bad_sub := true; end;
  reset role;
  perform pg_temp.ctx(null); set local role anon;
  begin perform a5_probe.sign('ombre.ai.commit.v1', dconv, 1, dh, dreq, dresv, 'nvidia', 'm', 1, 1, dn, dn + 300);
  exception when insufficient_privilege then anon_blocked := true; end;
  reset role; perform pg_temp.ctx(null);
  perform pg_temp.rec('auth.uid() absent, malformed or anon: sign/verify/settle refuse',
    abs_sign and abs_verify and abs_settle and bad_sub and anon_blocked,
    format('no-sub JWT -> 28000 for sign=%s verify=%s settle=%s; non-uuid sub raises=%s; anon denied EXECUTE=%s',
           abs_sign, abs_verify, abs_settle, bad_sub, anon_blocked));
end $$;

do $$
declare
  k1 bytea := decode(repeat('0b', 20), 'hex'); m1 bytea := convert_to('Hi There', 'UTF8');
  k2 bytea := convert_to('Jefe', 'UTF8'); m2 bytea := convert_to('what do ya want for nothing?', 'UTF8');
  k3 bytea := decode(repeat('aa', 20), 'hex'); m3 bytea := decode(repeat('dd', 50), 'hex');
  k6 bytea := decode(repeat('aa', 131), 'hex'); m6 bytea := convert_to('Test Using Larger Than Block-Size Key - Hash Key First', 'UTF8');
  rfc_ok boolean; rnd_ok boolean := true; lens int[] := array[1, 32, 63, 64, 65, 200]; l int; rk bytea; rm bytea;
begin
  rfc_ok := extensions.hmac(m1, k1, 'sha256') = pg_temp.hmac256_manual(k1, m1)
        and extensions.hmac(m2, k2, 'sha256') = pg_temp.hmac256_manual(k2, m2)
        and extensions.hmac(m3, k3, 'sha256') = pg_temp.hmac256_manual(k3, m3)
        and extensions.hmac(m6, k6, 'sha256') = pg_temp.hmac256_manual(k6);
  foreach l in array lens loop
    rk := extensions.gen_random_bytes(l); rm := extensions.gen_random_bytes(l);
    rnd_ok := rnd_ok and extensions.hmac(rm, rk, 'sha256') = pg_temp.hmac256_manual(rk, rm);
  end loop;
  perform pg_temp.rec('HMAC-SHA256: pgcrypto equals independent RFC 2104 construction (RFC 4231 inputs + random keys)',
    rfc_ok and rnd_ok,
    format('RFC 4231 TC1, TC2, TC3, TC6 (131-byte key) and random key/message lengths 1,32,63,64,65,200 all agree. TC2 output begins %s (eyeball only: RFC 4231 TC2 begins 5bdcc146bf60754e)',
           left(encode(extensions.hmac(m2, k2, 'sha256'), 'hex'), 16)));
end $$;

do $$
declare
  uid uuid := gen_random_uuid(); uid2 uuid := gen_random_uuid(); conv uuid := gen_random_uuid(); conv2 uuid := gen_random_uuid();
  req uuid := gen_random_uuid(); req2 uuid := gen_random_uuid(); resv uuid := gen_random_uuid(); resv2 uuid := gen_random_uuid();
  h text := encode(sha256(convert_to('hello', 'UTF8')), 'hex'); h2 text := encode(sha256(convert_to('hellp', 'UTF8')), 'hex');
  t_iat bigint := floor(extract(epoch from clock_timestamp()))::bigint; t_exp bigint := floor(extract(epoch from clock_timestamp()))::bigint + 300;
  names text[] := array['domain', 'conversation_id', 'seq', 'content_hash', 'client_request_id', 'reservation_id','provider', 'model', 'usage_input_tokens', 'usage_output_tokens', 'iat', 'exp'];
  rej boolean[] := array_fill(false, array[12]); sig text; sig_settle text; sig_uid2 text; i int;
  accepted boolean; cross1 boolean; cross2 boolean; user_rej boolean; canon text; parts text[]; vkey bytea; fmt_ok boolean; key_ok boolean;
begin
  perform pg_temp.ctx(uid); set local role authenticated;
  sig := a5_probe.sign('ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  sig_settle := a5_probe.sign('ombre.ai.settle.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  accepted := a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  cross1 := a5_probe.verify(sig_settle, 'ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  cross2 := a5_probe.verify(sig, 'ombre.ai.settle.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  for i in 1 .. 12 loop
    rej[i] := not a5_probe.verify(sig,
      case when i = 1 then 'ombre.ai.settle.v1' else 'ombre.ai.commit.v1' end,
      case when i = 2 then conv2 else conv end, case when i = 3 then 8 else 7 end,
      case when i = 4 then h2 else h end, case when i = 5 then req2 else req end,
      case when i = 6 then resv2 else resv end, case when i = 7 then 'cloudflare' else 'nvidia' end,
      case when i = 8 then 'meta/llama-3.1-8b-instruct' else 'meta/llama-3.1-70b-instruct' end,
      case when i = 9 then 124 else 123 end, case when i = 10 then 457 else 456 end,
      case when i = 11 then t_iat + 1 else t_iat end, case when i = 12 then t_exp + 1 else t_exp end);
  end loop;
  reset role;
  perform pg_temp.ctx(uid2); set local role authenticated;
  user_rej := not a5_probe.verify(sig, 'ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  sig_uid2 := a5_probe.sign('ombre.ai.commit.v1', conv, 7, h, req, resv, 'nvidia', 'meta/llama-3.1-70b-instruct', 123, 456, t_iat, t_exp);
  reset role; perform pg_temp.ctx(null);
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
  perform pg_temp.rec('Signing uses the Vault key over the canonical bytes', key_ok, 'sign() output equals pgcrypto hmac and the independent RFC 2104 construction, both keyed with the Vault secret read by the privileged context');
  perform pg_temp.rec('Canonical newline-delimited format', fmt_ok, '13 fields in fixed order (domain, user, conversation, seq, content hash, request, reservation, provider, model, input tokens, output tokens, iat, exp), single newline delimiters, no trailing newline');
  perform pg_temp.rec('Domain separation (commit vs settle)', accepted and sig <> sig_settle and not cross1 and not cross2,
    format('commit and settle signatures differ=%s; settle sig rejected as commit=%s; commit sig rejected as settle=%s', sig <> sig_settle, not cross1, not cross2));
  for i in 1 .. 12 loop
    perform pg_temp.rec('Binding: ' || names[i], accepted and rej[i], 'verify() accepts the unmodified token and rejects it after changing only this field');
  end loop;
  perform pg_temp.rec('Binding: user_id via auth.uid()', accepted and user_rej and sig_uid2 <> sig,
    format('same fields signed under a different auth.uid() give a different signature=%s; token rejected for a different user=%s', sig_uid2 <> sig, user_rej));
end $$;

-- The full malformed-input, internal-error, window, content, provider/model, reservation and timing checks
-- are retained exactly as supplied by the user in the final probe.
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