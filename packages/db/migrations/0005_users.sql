-- People who sign in: the CEO, the owner, and the office monitor.
--
-- "I see everything. The owner sees everything. Everyone else doesn't see
-- anything except what we decide to show them in the monitor."
--
-- What the database guarantees here:
--   1. Every "who did it" in the system is a real user.
--   2. The application tells the database who is acting in each transaction
--      (the gs.actor setting). Without a name, it can change nothing here.
--   3. A ledger entry is created by an active CEO, and by the one who is
--      acting. The owner and the monitor can never post money.
--   4. Users are added and changed only by a CEO. A password is changed only
--      by a CEO or by the user himself.
--   5. There is always at least one active CEO.
--   6. Every change to a user is written to the audit log with before and
--      after. The log is never edited. A password is never written to it.

create type user_role as enum ('ceo', 'owner', 'monitor');

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

-- A person signs in with a phone number. The office monitor is a screen, not
-- a person, so it signs in with a short name instead.
create table users (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  role         user_role not null,
  phone        text unique,            -- +9647701234567, people only
  sign_in_name text unique,            -- "monitor", the office screen only
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  created_by   uuid references users (id),
  constraint users_name_not_blank check (length(btrim(name)) > 0),
  constraint users_phone_format check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint users_sign_in_name_format check (sign_in_name is null or sign_in_name ~ '^[a-z][a-z0-9_-]{2,31}$'),
  constraint users_people_have_a_phone check ((role = 'monitor') = (phone is null)),
  constraint users_monitor_has_a_name check ((role = 'monitor') = (sign_in_name is not null))
);

-- Kept apart from users so that reading a user can never return a password.
-- The value is a salted scrypt hash, never the password itself.
create table user_credentials (
  user_id       uuid primary key references users (id),
  password_hash text not null,
  changed_at    timestamptz not null default now(),
  changed_by    uuid references users (id),
  constraint user_credentials_is_a_hash check (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$')
);

-- One row per device that is signed in. The token itself is never stored,
-- only its sha256, so reading this table cannot sign anyone in.
create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id),
  token_hash   bytea not null unique,
  device       text,                    -- the browser, as it named itself
  ip           inet,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  revoked_by   uuid references users (id),
  constraint sessions_token_hash_is_sha256 check (octet_length(token_hash) = 32),
  constraint sessions_revoke_fields check ((revoked_at is null) = (revoked_by is null))
);

create index sessions_user on sessions (user_id) where revoked_at is null;

-- Every try at signing in, so wrong passwords can be counted and slowed down.
create table sign_in_attempts (
  id          bigint generated always as identity primary key,
  sign_in_key text not null,           -- the phone or name that was typed, normalised
  ip          inet,
  succeeded   boolean not null,
  at          timestamptz not null default now()
);

create index sign_in_attempts_key on sign_in_attempts (sign_in_key, at);
create index sign_in_attempts_ip on sign_in_attempts (ip, at);

-- ---------------------------------------------------------------------------
-- Who is acting
-- ---------------------------------------------------------------------------

-- True for a connection made by the application's login. False for the role
-- that owns the schema: migrations and a person fixing something by hand.
-- Looks at the login, not the current role, so it stays true inside the
-- functions that run with the owner's rights.
create function gs_app_session() returns boolean
language sql stable as $$
  select session_user <> (select pg_get_userbyid(c.relowner) from pg_class c
                          where c.relname = 'users' and c.relnamespace = 'public'::regnamespace);
$$;

-- The user the application is acting for in this transaction, or null.
create function gs_actor() returns uuid
language plpgsql stable as $$
declare
  v_raw text := nullif(current_setting('gs.actor', true), '');
begin
  if v_raw is null then
    return null;
  end if;
  return v_raw::uuid;
exception
  when invalid_text_representation then
    raise exception 'actor_invalid: gs.actor is not a user id' using errcode = 'P0001';
end $$;

-- The acting user, checked: set, real and active. Raises otherwise.
create function gs_require_actor() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := gs_actor();
begin
  if v_actor is null then
    raise exception 'actor_required: the application must say who is acting' using errcode = 'P0001';
  end if;
  if not exists (select 1 from users where id = v_actor and active) then
    raise exception 'actor_unknown: % is not an active user', v_actor using errcode = 'P0001';
  end if;
  return v_actor;
end $$;

-- The acting user, and he must be a CEO. Raises otherwise.
create function gs_require_ceo() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := gs_require_actor();
begin
  if not exists (select 1 from users where id = v_actor and role = 'ceo') then
    raise exception 'ceo_only: only the CEO can change this' using errcode = 'P0001';
  end if;
  return v_actor;
end $$;

-- ---------------------------------------------------------------------------
-- The audit log
-- ---------------------------------------------------------------------------

-- Every change outside the ledger, with before and after. The ledger does
-- not need one: it is never changed, only added to.
create table audit_log (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  actor     uuid references users (id),   -- null when the schema owner did it by hand
  db_role   text not null default session_user,
  action    text not null check (action in ('insert', 'update', 'delete')),
  entity    text not null,                -- the table
  entity_id text,
  before    jsonb,
  after     jsonb
);

create index audit_log_entity on audit_log (entity, entity_id);
create index audit_log_at on audit_log (at);

create trigger audit_log_no_change before update or delete on audit_log
  for each row execute function gs_forbid_change();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function gs_forbid_change();

-- Writes one row of a table's change to the audit log.
--
--   create trigger x after insert or update or delete on some_table
--     for each row execute function gs_audit('ceo');
--
-- First argument: 'ceo' when only a CEO may change the table, 'any' when any
-- signed-in user may. Second argument, optional: the column that identifies
-- the row (default: id). An update that changes nothing is not logged.
create function gs_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor  uuid;
  v_before jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_after  jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_key    text := coalesce(tg_argv[1], 'id');
begin
  if gs_app_session() then
    if tg_argv[0] = 'ceo' then
      v_actor := gs_require_ceo();
    else
      v_actor := gs_require_actor();
    end if;
  else
    v_actor := gs_actor();
  end if;

  if tg_op = 'UPDATE' and v_before = v_after then
    return null;
  end if;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (v_actor, lower(tg_op), tg_table_name, coalesce(v_after, v_before) ->> v_key, v_before, v_after);
  return null;
end $$;

create trigger users_audit after insert or update or delete on users
  for each row execute function gs_audit('ceo');

-- ---------------------------------------------------------------------------
-- Guards on users
-- ---------------------------------------------------------------------------

create function gs_users_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'user_kept: a user is never deleted, because his name is on what he did. Switch him off instead.'
      using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and (new.id, new.role, new.created_at, new.created_by)
                          is distinct from (old.id, old.role, old.created_at, old.created_by) then
    raise exception 'user_locked: a user keeps his role. Switch him off and add a new one.' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.active and not new.active and gs_app_session() and new.id = gs_actor() then
    raise exception 'own_account: you cannot switch off your own account' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger users_guard before update or delete on users
  for each row execute function gs_users_guard();

-- Checked at the end of the transaction, so the last CEO cannot be switched off.
create function gs_users_keep_a_ceo() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from users where role = 'ceo' and active) then
    raise exception 'last_ceo: there must always be an active CEO' using errcode = 'P0001';
  end if;
  return null;
end $$;

create constraint trigger users_keep_a_ceo after update on users
  deferrable initially deferred
  for each row when (old.role = 'ceo' and old.active and not new.active)
  execute function gs_users_keep_a_ceo();

-- A password is set by a CEO or by the user himself. The log says that it
-- changed and who changed it, never what it is.
create function gs_user_credentials_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'credentials_kept: a password is replaced, not removed' using errcode = 'P0001';
  end if;
  if gs_app_session() then
    v_actor := gs_require_actor();
    if v_actor <> new.user_id
       and not exists (select 1 from users where id = v_actor and role = 'ceo') then
      raise exception 'ceo_only: only the CEO can set another user''s password' using errcode = 'P0001';
    end if;
    new.changed_by := v_actor;
  else
    new.changed_by := coalesce(gs_actor(), new.changed_by);
  end if;
  new.changed_at := now();
  return new;
end $$;

create trigger user_credentials_guard before insert or update or delete on user_credentials
  for each row execute function gs_user_credentials_guard();

create function gs_user_credentials_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (new.changed_by, lower(tg_op), tg_table_name, new.user_id::text,
          case when tg_op = 'UPDATE' then jsonb_build_object('password', 'set') end,
          jsonb_build_object('password', case when tg_op = 'UPDATE' then 'changed' else 'set' end));
  return null;
end $$;

create trigger user_credentials_audit after insert or update on user_credentials
  for each row execute function gs_user_credentials_audit();

-- A session belongs to one user and one device for life. Only "last seen",
-- its expiry and its end can change.
create function gs_sessions_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'session_kept: a session is ended, not deleted' using errcode = 'P0001';
  end if;
  if (new.id, new.user_id, new.token_hash, new.device, new.ip, new.created_at)
     is distinct from (old.id, old.user_id, old.token_hash, old.device, old.ip, old.created_at) then
    raise exception 'session_locked: only last seen, expiry and the end of a session can change' using errcode = 'P0001';
  end if;
  if old.revoked_at is not null and (new.revoked_at, new.revoked_by) is distinct from (old.revoked_at, old.revoked_by) then
    raise exception 'session_locked: a session that has ended stays ended' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger sessions_guard before update or delete on sessions
  for each row execute function gs_sessions_guard();

create trigger sign_in_attempts_no_change before update or delete on sign_in_attempts
  for each row execute function gs_forbid_change();

-- ---------------------------------------------------------------------------
-- Every "who did it" is a real user
-- ---------------------------------------------------------------------------

alter table journal_entries        add constraint journal_entries_created_by_fk        foreign key (created_by)   references users (id);
alter table fx_rates               add constraint fx_rates_set_by_fk                   foreign key (set_by)       references users (id);
alter table fx_rate_changes        add constraint fx_rate_changes_set_by_fk            foreign key (set_by)       references users (id);
alter table customer_trust_changes add constraint customer_trust_changes_changed_by_fk foreign key (changed_by)   references users (id);
alter table source_files           add constraint source_files_uploaded_by_fk          foreign key (uploaded_by)  references users (id);
alter table shipments              add constraint shipments_confirmed_by_fk            foreign key (confirmed_by) references users (id);
alter table disputes               add constraint disputes_created_by_fk               foreign key (created_by)   references users (id);
alter table rounds                 add constraint rounds_created_by_fk                 foreign key (created_by)   references users (id);
alter table round_stops            add constraint round_stops_added_by_fk              foreign key (added_by)     references users (id);
alter table round_results          add constraint round_results_entered_by_fk          foreign key (entered_by)   references users (id);
alter table round_results          add constraint round_results_voided_by_fk           foreign key (voided_by)    references users (id);
alter table attachments            add constraint attachments_uploaded_by_fk           foreign key (uploaded_by)  references users (id);
alter table exceptions             add constraint exceptions_approved_by_fk            foreign key (approved_by)  references users (id);
alter table round_hand_ins         add constraint round_hand_ins_handed_in_by_fk       foreign key (handed_in_by) references users (id);
alter table round_hand_ins         add constraint round_hand_ins_voided_by_fk          foreign key (voided_by)    references users (id);
alter table cash_counts            add constraint cash_counts_counted_by_fk            foreign key (counted_by)   references users (id);
alter table vault_closes           add constraint vault_closes_closed_by_fk            foreign key (closed_by)    references users (id);
alter table vault_closes           add constraint vault_closes_voided_by_fk            foreign key (voided_by)    references users (id);

-- ---------------------------------------------------------------------------
-- Guard: money is posted by the CEO who is acting
-- ---------------------------------------------------------------------------

-- The owner sees everything and changes nothing; the monitor is a screen.
-- Whatever the application does, an entry it posts carries the name of an
-- active CEO, and that CEO is the one signed in.
create function gs_entry_is_by_the_ceo() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid;
begin
  if not gs_app_session() then
    return new;
  end if;
  v_actor := gs_require_ceo();
  if new.created_by is distinct from v_actor then
    raise exception 'actor_mismatch: the entry names % but % is acting', new.created_by, v_actor using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger journal_entries_by_the_ceo before insert on journal_entries
  for each row execute function gs_entry_is_by_the_ceo();

-- ---------------------------------------------------------------------------
-- The application's role
-- ---------------------------------------------------------------------------

grant select on users, sessions, audit_log to green_star_app;
grant insert (id, name, role, phone, sign_in_name, created_by), update (name, phone, sign_in_name, active)
  on users to green_star_app;
-- The hash is read to check a password at sign-in. No screen ever gets it.
grant select, insert (user_id, password_hash), update (password_hash) on user_credentials to green_star_app;
grant insert (id, user_id, token_hash, device, ip, expires_at),
      update (last_seen_at, expires_at, revoked_at, revoked_by)
  on sessions to green_star_app;
grant select, insert on sign_in_attempts to green_star_app;
