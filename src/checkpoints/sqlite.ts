import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

/** Callers choose STATE_DIR explicitly and close this handle after graph work finishes. */
export async function openSqliteCheckpointer(stateDir: string) {
  if (stateDir.trim().length === 0) {
    throw new Error('STATE_DIR must be a nonempty directory path.');
  }

  const directory = resolve(stateDir);
  await mkdir(directory, { recursive: true });
  const databasePath = join(directory, 'checkpoint.sqlite');
  const checkpointer = SqliteSaver.fromConnString(databasePath);

  return {
    checkpointer,
    databasePath,
    close(): void {
      if (checkpointer.db.open) {
        checkpointer.db.close();
      }
    },
  };
}
