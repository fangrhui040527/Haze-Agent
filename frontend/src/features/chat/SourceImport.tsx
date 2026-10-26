import { useRef, useState } from 'react';
import type {
  Artifact,
  ArtifactImport,
  ArtifactRef,
} from '../../../../app/contracts/artifacts.ts';
import { Button } from '../../shared/ui/Button.tsx';
import styles from './ChatPanel.module.css';

const MAX_SOURCE_BYTES = 1024 * 1024;
const TYPES: Record<string, ArtifactImport['media_type']> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};
const DEFAULT_FORMATS = ['txt', 'md', 'markdown', 'csv', 'json'] as const;
export async function sourceImportFromFile(
  file: File,
): Promise<ArtifactImport> {
  const media = TYPES[file.name.split('.').at(-1)?.toLowerCase() ?? ''];
  if (!media)
    throw new Error('Choose a UTF-8 text, Markdown, CSV, or JSON file.');
  if (file.size > MAX_SOURCE_BYTES)
    throw new Error('The source exceeds 1 MiB. Choose a smaller file.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      'The source is not valid UTF-8. Save it as UTF-8 and import it again.',
    );
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    schema_version: 'haze.artifact.import.v3',
    filename: file.name,
    media_type: media,
    content_base64: btoa(binary),
  };
}
export function SourceImport({
  sources,
  onChange,
  importSource,
  disabled,
  idPrefix = 'task',
  formats = DEFAULT_FORMATS,
  defaultFilename = 'pasted-source.txt',
  required = false,
  attachmentPurpose,
}: {
  idPrefix?: string;
  sources: Artifact[];
  onChange(sources: Artifact[]): void;
  importSource(source: ArtifactImport, key: string): Promise<Artifact>;
  disabled: boolean;
  formats?: readonly string[];
  defaultFilename?: string;
  required?: boolean;
  attachmentPurpose?: string;
}) {
  const [pasted, setPasted] = useState('');
  const [filename, setFilename] = useState(defaultFilename);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const retryRef = useRef<{ file: File; key: string } | null>(null);
  const upload = async (file: File) => {
    setPending(true);
    setError(null);
    const retry = retryRef.current;
    const key = retry?.file === file ? retry.key : crypto.randomUUID();
    retryRef.current = { file, key };
    try {
      if (!formats.includes(file.name.split('.').at(-1)?.toLowerCase() ?? ''))
        throw new Error(
          `Choose a UTF-8 ${formats.map((format) => `.${format}`).join(' or ')} file.`,
        );
      const imported = await importSource(
        await sourceImportFromFile(file),
        key,
      );
      onChange([
        ...sources.filter((item) => item.id !== imported.id),
        imported,
      ]);
      retryRef.current = null;
      if (inputRef.current) inputRef.current.value = '';
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The source could not be imported. Retry the upload.',
      );
      return false;
    } finally {
      setPending(false);
    }
  };
  return (
    <div className={styles.sourceImport}>
      <label htmlFor={`${idPrefix}-source`}>
        Attach source material{' '}
        <span className={styles.muted}>
          ({required ? 'required' : 'optional'}, UTF-8, up to 1 MiB)
        </span>
      </label>
      <input
        ref={inputRef}
        id={`${idPrefix}-source`}
        type="file"
        accept={
          formats === DEFAULT_FORMATS
            ? '.txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json'
            : formats.map((format) => `.${format}`).join(',')
        }
        disabled={disabled || pending || sources.length >= 64}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <details>
        <summary>Paste a source instead</summary>
        <div className={styles.updateForm}>
          <label htmlFor={`${idPrefix}-filename`}>
            {formats === DEFAULT_FORMATS
              ? 'Source filename (.txt, .md, .csv, or .json)'
              : `Source filename (${formats.map((format) => `.${format}`).join(', ')})`}
          </label>
          <input
            id={`${idPrefix}-filename`}
            value={filename}
            maxLength={255}
            disabled={disabled || pending}
            onChange={(event) => setFilename(event.target.value)}
          />
          <label htmlFor={`${idPrefix}-paste`}>Source content</label>
          <textarea
            id={`${idPrefix}-paste`}
            value={pasted}
            rows={3}
            maxLength={1024 * 1024}
            disabled={disabled || pending}
            onChange={(event) => setPasted(event.target.value)}
          />
          <Button
            type="button"
            size="small"
            disabled={
              disabled ||
              pending ||
              !pasted ||
              !filename ||
              sources.length >= 64
            }
            onClick={() =>
              void upload(new File([pasted], filename)).then((imported) => {
                if (imported) setPasted('');
              })
            }
          >
            Import pasted source
          </Button>
        </div>
      </details>
      {pending && <p role="status">Importing source...</p>}
      {error && (
        <p role="alert" className={styles.cancellationError}>
          {error}
          {retryRef.current && (
            <Button
              size="small"
              onClick={() => void upload(retryRef.current!.file)}
              disabled={pending}
            >
              Retry import
            </Button>
          )}
        </p>
      )}
      {sources.length > 0 && (
        <ul>
          {sources.map((source) => (
            <li key={source.id}>
              {source.filename ?? source.kind} - version {source.version}{' '}
              <button
                type="button"
                className={styles.linkButton}
                disabled={disabled}
                onClick={() =>
                  onChange(sources.filter((item) => item.id !== source.id))
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {sources.length > 0 && (
        <p className={styles.muted}>
          {attachmentPurpose ??
            (idPrefix === 'task'
              ? 'Attached sources accompany your next task.'
              : 'Attached sources accompany this correction or clarification.')}{' '}
          Origin labels are supplied attribution.
        </p>
      )}
    </div>
  );
}
export function sourceReferences(sources: Artifact[]): ArtifactRef[] {
  return sources.map(({ id, version, sha256 }) => ({ id, version, sha256 }));
}
