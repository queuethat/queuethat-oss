-- 2B-C3 (#302): duplicate guest detection and merge.
begin;
\ir ../helpers/_setup.psql
select plan(16);
select tests.create_world();

-- Two near-duplicate guests of org A: a phone typed without its country code, a +tag email.
insert into app.guests (id, org_id, first_name, created_at) values
  (tests.new_id('g_keep'), tests.id('org_a'), 'Dana', now() - interval '2 days'),
  (tests.new_id('g_dupe'), tests.id('org_a'), 'dana', now() - interval '1 day'),
  (tests.new_id('g_b'), tests.id('org_b'), 'Dana', now());
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source) values
  (tests.new_id('c_keep'), tests.id('org_a'), tests.id('g_keep'), 'phone', '+14155550188', 'staff'),
  (tests.new_id('c_dupe'), tests.id('org_a'), tests.id('g_dupe'), 'phone', '+4155550188', 'staff'),
  (tests.new_id('c_dupe_mail'), tests.id('org_a'), tests.id('g_dupe'), 'email', 'dana@example.com', 'staff');
insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash,
                          attested_at, attestation_text_version)
values (tests.id('org_a'), tests.id('c_dupe'), 'sms', 'transactional', 'granted', 'staff', 'v1', 'h', now(), 1);
select tests.new_visit('v_k1', 'queue_a'); select tests.new_visit('v_k2', 'queue_a');
select tests.new_visit('v_d1', 'queue_a'); select tests.new_visit('v_d2', 'queue_a'); select tests.new_visit('v_d3', 'queue_a');
select private.set_actor('system', null);
update app.visits set guest_id = tests.id('g_keep') where id in (tests.id('v_k1'), tests.id('v_k2'));
update app.visits set guest_id = tests.id('g_dupe') where id in (tests.id('v_d1'), tests.id('v_d2'), tests.id('v_d3'));
insert into app.guest_tags (id, org_id, name) values (tests.new_id('t_vip'), tests.id('org_a'), 'VIP');
insert into app.guest_tag_links (org_id, guest_id, tag_id) values
  (tests.id('org_a'), tests.id('g_keep'), tests.id('gtag_a')), (tests.id('org_a'), tests.id('g_dupe'), tests.id('gtag_a')),
  (tests.id('org_a'), tests.id('g_dupe'), tests.id('t_vip'));
insert into app.guest_notes (org_id, guest_id, body) values (tests.id('org_a'), tests.id('g_dupe'), 'note on dupe');

-- Detection
select tests.act_as('manager');
select is((select count(*) from api.duplicate_guest_candidates(tests.id('org_a'))), 1::bigint, 'the near-duplicate pair is suggested');
select is((select keep_id from api.duplicate_guest_candidates(tests.id('org_a'))), tests.id('g_keep'), 'the older profile is the suggested survivor');
select is((select score from api.duplicate_guest_candidates(tests.id('org_a'))), 1.0, 'a matching name raises the score');
select tests.act_as('staff');
select throws_ok($$ select * from api.duplicate_guest_candidates(tests.id('org_a')) $$, 'P0001', 'not_found', 'staff cannot list candidates');

-- AC2: manager and staff are denied
select throws_ok($$ select api.merge_guests(tests.id('g_keep'), tests.id('g_dupe'), gen_random_uuid()) $$, 'P0001', 'not_found', 'AC2: staff denied');
select tests.act_as('manager');
select throws_ok($$ select api.merge_guests(tests.id('g_keep'), tests.id('g_dupe'), gen_random_uuid()) $$, 'P0001', 'not_found', 'AC2: manager denied');

-- AC3: cross-org
select tests.act_as('owner');
select throws_ok($$ select api.merge_guests(tests.id('g_keep'), tests.id('g_b'), gen_random_uuid()) $$, 'P0001', 'not_found', 'AC3: guests of two orgs give not_found');
select tests.act_as('other_owner');
select throws_ok($$ select api.merge_guests(tests.id('g_keep'), tests.id('g_dupe'), gen_random_uuid()) $$, 'P0001', 'not_found', 'AC3: org B cannot merge org A guests');

-- AC1
select tests.act_as('admin');
select is((api.merge_guests(tests.id('g_keep'), tests.id('g_dupe'), '00000000-0000-0000-0000-0000000000c1')).visit_count, 5,
  'AC1: the survivor has 2 + 3 visits');
select tests.as_postgres();
select is((select merged_into_id from app.guests where id = tests.id('g_dupe')), tests.id('g_keep'), 'AC1: the other guest is a tombstone');
select is((select count(*) from app.guest_contacts where guest_id = tests.id('g_keep')), 3::bigint, 'AC1: all contacts moved');
select is((select count(*) from app.consents where contact_id = tests.id('c_dupe')), 1::bigint, 'AC1: consent evidence kept');
select is((select count(*) from app.guest_tag_links where guest_id = tests.id('g_keep')), 2::bigint, 'tags merged without duplicates');
select is((select count(*) from app.guest_notes where guest_id = tests.id('g_keep')), 1::bigint, 'notes moved');

-- Repeat is a no-op; the pair no longer shows up
select tests.act_as('admin');
select is((api.merge_guests(tests.id('g_keep'), tests.id('g_dupe'), gen_random_uuid())).visit_count, 5, 'repeating a merge is a no-op');
select is((select count(*) from api.duplicate_guest_candidates(tests.id('org_a'))), 0::bigint, 'the merged pair disappears from suggestions');

select * from finish();
rollback;
