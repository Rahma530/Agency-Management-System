-- Separate the structured client sector from the existing free-text industry.
-- Nullable preserves every existing client and keeps older bulk-import files compatible.
alter table public.clients add column sector text;

alter table public.clients add constraint clients_sector_check
  check (sector is null or sector in ('E-Commerce', 'Service'));
