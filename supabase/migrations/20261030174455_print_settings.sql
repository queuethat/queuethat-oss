-- 2B-D3 (#260): thermal ticket paper settings per location.
--
-- print_paper_mm: 58 or 80 mm roll. print_footer: optional line at the bottom of the slip.
-- Admins write them through the existing locations_update policy; staff and paired devices read
-- their location row (locations_select), so no RPC is needed.

alter table app.locations
  add column print_paper_mm int not null default 80
    constraint locations_print_paper_mm_check check (print_paper_mm in (58, 80)),
  add column print_footer text
    constraint locations_print_footer_check check (print_footer is null or length(print_footer) <= 120);

comment on column app.locations.print_paper_mm is 'Width of the thermal ticket roll, 58 or 80 mm.';
comment on column app.locations.print_footer is 'Optional line printed at the bottom of a ticket slip, up to 120 characters.';
