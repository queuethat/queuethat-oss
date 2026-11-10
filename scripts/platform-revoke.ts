// Removes a platform role and ends the person's sessions (#1134):
// `pnpm platform:revoke <email> [--allow-last-operator]`. Same connection rules as platform:grant.
//
// Repeating it is safe: with no role left it only ends any sessions. It refuses to remove the last
// operator unless --allow-last-operator is given (the database checks that, atomically).
import { client, connection, runCli } from './lib/platform-cli.ts';
import { revoke } from './lib/platform-revoke.ts';

await runCli(async () => {
  console.log(await revoke(process.argv.slice(2), client(connection())));
});
