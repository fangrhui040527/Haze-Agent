import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Root configuration first, with the main checkout and legacy files as fallbacks. */
export function envFileCandidates(projectRoot = PROJECT_ROOT): string[] {
  const roots = [resolve(projectRoot)];
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(
      readFileSync(join(projectRoot, '.git'), 'utf8'),
    );
    if (match?.[1]) {
      const gitdir = match[1].trim();
      const main = dirname(
        dirname(
          dirname(isAbsolute(gitdir) ? gitdir : resolve(projectRoot, gitdir)),
        ),
      );
      if (!roots.includes(main)) roots.push(main);
    }
  } catch {
    // A normal checkout has a .git directory rather than a worktree pointer.
  }

  return [
    ...roots.map((root) => join(root, '.env')),
    ...roots.map((root) => join(root, '.env.local')),
    ...roots.map((root) => join(root, 'app/adapters/zetaris/.env.local')),
    ...roots.map((root) => join(root, 'app/adapters/zetaris/.env')),
  ];
}
