# Licensing

QueueThat is open core.

| Where                              | Licence                                                              | In production                                                                          |
| ---------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Everything outside `ee/`           | [GNU AGPL v3.0 only](LICENSE)                                        | Free. If you run a modified version as a network service, offer your users its source. |
| `ee/` (enterprise features)        | [QueueThat Commercial License](ee/LICENSE)                           | Needs a paid agreement or a QueueThat Cloud plan that includes the feature.            |
| Bundled Geist and Geist Mono fonts | [SIL Open Font License](apps/web/public/fonts/GEIST-OFL-LICENSE.txt) | Free.                                                                                  |

The `ee/` folder is readable and you may run and change it for development and testing without a
subscription. You may not redistribute it.

A self-hosted install built without `ee/` is fully AGPL and has no feature that depends on it.
The guest path (joining, status, alerts) and the visit engine are never in `ee/`.

Questions about a commercial agreement: support@queuethat.com.
