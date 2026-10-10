-- The Excel import: a spreadsheet becomes a draft file.
--
-- The CEO, October 2026: "I just want the feature where you can import Excel
-- files and it automatically adds it to the system, the customer accounts.
-- He also wants to add them manually." The real China files have not
-- arrived, so the import reads any layout: the CEO says which column is which.
--
-- What the database guarantees here:
--   1. The file itself is kept, byte for byte, with the draft it made. There
--      is no file storage yet, so it is kept here. It is never changed.
--   2. The same file, by its sha256, is never imported twice (source_files,
--      since the start).
--   3. Every row is kept as the sheet had it (shipment_lines.raw), next to
--      what was read from it and the consignment it went to.
--   4. A draft made by the import is a draft like any other: it charges
--      nobody until it is confirmed, and its rows can be changed until then.

create table source_file_contents (
  source_file_id uuid primary key references source_files (id),
  bytes          bytea not null,
  constraint source_file_contents_size check (octet_length(bytes) between 1 and 15 * 1024 * 1024)
);

create trigger source_file_contents_no_change before update or delete on source_file_contents
  for each row execute function gs_forbid_change();
create trigger source_file_contents_no_truncate before truncate on source_file_contents
  for each statement execute function gs_forbid_change();

-- Only the CEO, under his own name, adds a file. Not in the audit log: it
-- would copy the whole spreadsheet there.
create function gs_ceo_writes() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if gs_app_session() then
    perform gs_require_ceo();
  end if;
  return new;
end $$;

create trigger source_file_contents_ceo before insert on source_file_contents
  for each row execute function gs_ceo_writes();

-- The bytes are what the sha256 says they are.
create function gs_source_file_matches() returns trigger
language plpgsql as $$
begin
  if encode(sha256(new.bytes), 'hex') <> (select sha256 from source_files where id = new.source_file_id) then
    raise exception 'file_mismatch: the file is not the one its fingerprint names' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger source_file_contents_match before insert on source_file_contents
  for each row execute function gs_source_file_matches();

-- Which draft or file a spreadsheet already became.
create view source_file_shipments as
select f.id as source_file_id,
       f.filename,
       f.sha256,
       f.uploaded_at,
       f.uploaded_by,
       s.id as shipment_id,
       s.code as shipment_code,
       s.status as shipment_status,
       (select count(*) from shipment_lines l where l.shipment_id = s.id) as rows
from source_files f
left join shipments s on s.source_file_id = f.id;

grant select on source_files, source_file_shipments to green_star_app;
grant insert on source_file_contents to green_star_app;
grant select (source_file_id) on source_file_contents to green_star_app;
grant select on shipment_lines to green_star_app;
