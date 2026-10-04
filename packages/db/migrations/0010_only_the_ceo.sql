-- Only the CEO signs in.
--
-- The system is for one person. There is no owner account that reads without
-- changing anything, and no monitor account for an office screen.
--
-- What the database guarantees here:
--   1. No account can be made that is not a CEO's. An owner or monitor
--      account left from before is switched off and signed out.
--   2. Everything else is as it was: every change needs an active account
--      acting under its own name, and there is always at least one.
--
-- The two old roles stay in the list of roles only because Postgres cannot
-- take a value out of an enum. Nothing can use them.

update sessions set revoked_at = now(), revoked_by = user_id
 where revoked_at is null and user_id in (select id from users where role <> 'ceo');
update users set active = false where role <> 'ceo' and active;

-- "not valid" leaves the switched-off rows alone and binds every new row and every change.
alter table users add constraint users_only_the_ceo check (role = 'ceo') not valid;
alter table users alter column role set default 'ceo';

-- The office screen went with the monitor account, and so does its setting.
alter table settings drop constraint settings_widgets;
alter table settings drop column monitor_widgets;
drop function gs_widgets_valid(text[]);
