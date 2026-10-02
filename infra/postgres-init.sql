-- Local roles and database. Production uses the host's own secrets.
create role gs_owner login password 'gs_owner' createdb createrole;
create role gs_app login password 'gs_app';
create database green_star owner gs_owner;
