-- #479 follow-up, part 2: every system email template ends with an optional stop link. The
-- dispatcher fills {unsubscribe_url} with the signed /u link (and sends the one-click
-- List-Unsubscribe header); render() drops the sentence when it has no link to give
-- (UNSUBSCRIBE_SECRET unset). Org and queue overrides are theirs; their mail still carries the
-- header.

update app.notification_templates
set body = body || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]',
    version = version + 1
where org_id is null and channel = 'email' and body not like '%{unsubscribe_url}%';
