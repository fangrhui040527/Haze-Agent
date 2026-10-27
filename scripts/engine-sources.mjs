import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

export function resolveInside(root, relative) {
  const resolved = path.resolve(root, relative);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    !resolved.startsWith(`${path.resolve(root)}${path.sep}`)
  ) {
    throw new Error(`Path escapes its source root: ${relative}`);
  }
  return resolved;
}

export async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Symlinks are not source inputs: ${relative}`);
    if (entry.isDirectory())
      files.push(
        ...(await listFiles(path.join(directory, entry.name), relative)),
      );
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported source input: ${relative}`);
  }
  return files.sort();
}

export async function verifySources(root = repositoryRoot) {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'engine_sources.json'), 'utf8'),
  );
  if (
    manifest.manifest_version !== 1 ||
    manifest.checksum_algorithm !== 'sha256'
  ) {
    throw new Error('Unsupported engine source manifest');
  }
  if (
    Object.keys(manifest.sources).sort().join(',') !==
    'hmem,starter,world_model'
  ) {
    throw new Error('Expected starter, hmem and world_model sources');
  }
  for (const [name, source] of Object.entries(manifest.sources)) {
    if (
      !/^[a-f0-9]{40}$/.test(source.revision) ||
      source.license !== 'Apache-2.0'
    ) {
      throw new Error(`Invalid source revision or license: ${name}`);
    }
    const directory = resolveInside(root, source.source_path);
    const actualFiles = await listFiles(directory);
    const expectedFiles = Object.keys(source.files).sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      const actual = new Set(actualFiles);
      const expected = new Set(expectedFiles);
      const unexpected = actualFiles.filter((file) => !expected.has(file));
      const missing = expectedFiles.filter((file) => !actual.has(file));
      const details = [
        unexpected.length ? `unexpected files: ${unexpected.join(', ')}` : '',
        missing.length ? `missing files: ${missing.join(', ')}` : '',
      ].filter(Boolean);
      throw new Error(
        `Source file inventory differs: ${name} (${details.join('; ')})`,
      );
    }
    for (const relative of expectedFiles) {
      const file = resolveInside(directory, relative);
      if (
        !(await lstat(file)).isFile() ||
        sha256(await readFile(file)) !== source.files[relative]
      ) {
        throw new Error(`Source checksum differs: ${name}/${relative}`);
      }
    }
    const inventory = expectedFiles
      .map((relative) => `${source.files[relative]}  ${relative}\n`)
      .join('');
    if (sha256(inventory) !== source.sha256)
      throw new Error(`Source tree checksum differs: ${name}`);
    if (
      !source.files.LICENSE ||
      !expectedFiles.some((file) => file.endsWith('package-lock.json'))
    ) {
      throw new Error(`Missing license or upstream lockfile: ${name}`);
    }
  }
  return manifest;
}

export async function verifyWorkflowPins(root = repositoryRoot) {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'engine_sources.json'), 'utf8'),
  );
  const versions = JSON.parse(
    await readFile(resolveInside(root, manifest.workflow_versions), 'utf8'),
  );
  const pkg = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  );
  const lock = JSON.parse(
    await readFile(path.join(root, 'package-lock.json'), 'utf8'),
  );
  for (const [name, version] of Object.entries(versions.dependencies)) {
    const entry = lock.packages[`node_modules/${name}`];
    if (
      !/^\d+\.\d+\.\d+$/.test(version) ||
      pkg.dependencies[name] !== version ||
      lock.packages[''].dependencies[name] !== version ||
      entry?.version !== version ||
      !entry.integrity?.startsWith('sha512-')
    ) {
      throw new Error(`Workflow dependency pin differs: ${name}`);
    }
  }
  return versions;
}
