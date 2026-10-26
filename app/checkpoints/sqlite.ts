import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

/** Callers choose STATE_DIR explicitly and close this handle after graph work finishes. */
export async function openSqliteCheckpointer(
  stateDir: string,
  filename = 'checkpoint.sqlite',
) {
  if (stateDir.trim().length === 0) {
    throw new Error('STATE_DIR must be a nonempty directory path.');
  }

  const directory = resolve(stateDir);
  await mkdir(directory, { recursive: true });
  const databasePath = join(directory, filename);
  const checkpointer = SqliteSaver.fromConnString(databasePath);
  // Explicit local durability; the saver creates/migrates its tables on first use.
  checkpointer.db.pragma('journal_mode = WAL');
  checkpointer.db.pragma('synchronous = FULL');
  checkpointer.db.pragma('busy_timeout = 5000');

  return {
    checkpointer,
    databasePath,
    durability: {
      saver: 'SqliteSaver' as const,
      journalMode: checkpointer.db.pragma('journal_mode', { simple: true }),
      synchronous: checkpointer.db.pragma('synchronous', { simple: true }),
      busyTimeoutMs: checkpointer.db.pragma('busy_timeout', { simple: true }),
    },
    close(): void {
      if (checkpointer.db.open) {
        checkpointer.db.close();
      }
    },
  };
}
