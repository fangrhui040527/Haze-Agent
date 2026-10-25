import { describe, expect, it } from 'vitest';
import { sourceImportFromFile } from './SourceImport.tsx';
describe('source import interaction boundary', () => {
  it('encodes exact UTF-8 source bytes for each supported format', async () => {
    for (const [name, media] of [
      ['notes.txt', 'text/plain'],
      ['notes.md', 'text/markdown'],
      ['table.csv', 'text/csv'],
      ['data.json', 'application/json'],
    ]) {
      const value = await sourceImportFromFile(
        new File(['Hello \u4e16\u754c'], name),
      );
      expect(value.media_type).toBe(media);
      expect(
        new TextDecoder().decode(
          Uint8Array.from(atob(value.content_base64), (c) => c.charCodeAt(0)),
        ),
      ).toBe('Hello \u4e16\u754c');
    }
  });
  it('rejects oversized, unsupported, or invalid UTF-8 sources before network disclosure', async () => {
    await expect(
      sourceImportFromFile(new File(['x'], 'image.png')),
    ).rejects.toThrow('UTF-8 text');
    await expect(
      sourceImportFromFile(
        new File([new Uint8Array(1024 * 1024 + 1)], 'notes.txt'),
      ),
    ).rejects.toThrow('exceeds 1 MiB');
    await expect(
      sourceImportFromFile(new File([new Uint8Array([255])], 'notes.txt')),
    ).rejects.toThrow();
  });
});
