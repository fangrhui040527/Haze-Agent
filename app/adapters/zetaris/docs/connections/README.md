# Connect to Zetaris

[Get access first](../../START-HERE.md). You need the website URL, your account and query permission. Keep credentials private.

## SQL Editor

Sign in and open the SQL Editor. This is the recommended beginner route and needs no additional client tools.

Run [your first SQL commands](lightning-recipe-reference.md) to confirm execution and query the supplied samples. Run one complete statement at a time and wait for the result.

## Coding assistants

This is an optional alternative to SQL Editor.

Configure [client setup](client-setup.md), then follow [Cursor](cursor-connection.md), [Codex](codex-connection.md), or [Claude Code](claude-code-connection.md) for the starter prompt. JDBC needs Java, the matching driver JAR, endpoint and account.

Use the Zetaris driver; don't substitute a Hive/Spark driver or start a local Spark session. Direct REST uses an API key and the platform's OpenAPI specification; follow your assistant's guide.

## HTTP helpers

This is another optional route. You need Python or Deno, the UI URL, numeric organisation ID, and an account or token.

Follow [client scripts](../../scripts/HOWTO.md) for `.env.local`, authentication and the connection check. The helpers use UI proxy routes; the raw API URL is not a substitute.

## Next step

Once connected, [run your first SQL commands](lightning-recipe-reference.md). Use the [full reference](../guides/zetaris-lightning-sql-commands.md) later for additional commands and their prerequisites.
