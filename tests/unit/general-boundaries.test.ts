import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}
function imports(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  return source.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  );
}

describe('general engine dependency boundaries', () => {
  it('keeps core runtime, persistence and transport independent of agent and capability packages', () => {
    for (const directory of [
      'tasks',
      'orchestration',
      'adapters',
      'checkpoints',
    ]) {
      for (const file of files(join('app', directory))) {
        const domainImports = imports(file).filter((value) =>
          /(?:^|\/)(?:capabilities|agents)\//u.test(value),
        );
        expect(domainImports, relative('app', file)).toEqual([]);
      }
    }
  });

  it('keeps public contracts browser safe and server serialization explicit', () => {
    for (const file of files('app/contracts').filter(
      (path) => !path.endsWith('json.ts'),
    )) {
      expect(
        imports(file).filter(
          (value) =>
            value.startsWith('node:') ||
            /(?:adapters|tasks|orchestration|capabilities|checkpoints)\//u.test(
              value,
            ) ||
            value.endsWith('/json.js'),
        ),
        file,
      ).toEqual([]);
    }
  });
});
