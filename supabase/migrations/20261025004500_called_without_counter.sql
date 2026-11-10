-- N3 follow-up: a call made without a counter rendered "Please go to ." The default `called`
-- templates mark the counter sentence optional, so the dispatcher's render() drops it when the
-- visit has no counter. Org and queue overrides are theirs to edit and stay as they are.

update app.notification_templates
set body = replace(body, 'Please go to {counter}.', '[Please go to {counter}.]'),
    version = version + 1
where org_id is null and trigger = 'called' and body like '%Please go to {counter}.%';
