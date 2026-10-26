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

/** Load configured env files without overriding variables already in process. */
export function loadEnvironment(
  files: string[] = envFileCandidates(),
): void {
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of content.split(/\r?\n/u)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const separator = line.indexOf('=');
      const name = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if (
        value.length >= 2 &&
        value[0] === value[value.length - 1] &&
        (value[0] === '"' || value[0] === "'")
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[name] === undefined) process.env[name] = value;
    }
  }
}
