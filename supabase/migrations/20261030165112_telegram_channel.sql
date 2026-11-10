-- N-3 (#251): Telegram is a notification channel and a contact channel. Expand only: adds enum
-- values. A telegram contact's value is `tg:<chat_id>`; the linking flow (#252) creates them.
alter type app.notification_channel add value if not exists 'telegram';
alter type app.contact_channel add value if not exists 'telegram';
