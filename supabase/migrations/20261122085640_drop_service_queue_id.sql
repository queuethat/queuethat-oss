-- Location-level services, step 3 of 3 (contract; queuethat-oss #75).
--
-- 20261122085036_location_services_switch.sql moved every reader to app.queue_services and made
-- services.queue_id optional. One release has shipped since, so no running web bundle writes it.
-- Drop the column (with its foreign key, index and the (org_id, queue_id, id) key) and the
-- dual-write trigger from the expand step. A queue now offers a service only through queue_services.

drop trigger link_new_service on app.services;
drop function private.link_new_service();

alter table app.services drop column queue_id;
