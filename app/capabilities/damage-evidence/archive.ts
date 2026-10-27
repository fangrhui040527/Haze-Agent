import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  AcquisitionAttempt,
  AcquisitionRequest,
  EvidenceCapture,
} from './contracts.js';

export const evidenceSha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
export const evidenceRequestKey = (request: AcquisitionRequest): string =>
  evidenceSha256(
    JSON.stringify({
      source_id: request.source_id,
      selection: Object.fromEntries(
        Object.entries(request.selection).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    }),
  );

/** Immutable byte archive and separate append-only capture/attempt manifests. */
export class DamageEvidenceArchive {
  constructor(
    readonly root: string,
    readonly throttleRoot: string = root,
  ) {
    for (const folder of ['raw', 'captures', 'attempts', 'cases', 'throttles'])
      mkdirSync(join(root, folder), { recursive: true });
    mkdirSync(join(throttleRoot, 'throttles'), { recursive: true });
  }

  private atomicJson(path: string, value: unknown): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
    });
    renameSync(temporary, path);
  }

  writeRaw(bytes: Uint8Array): {
    raw_ref: string;
    raw_sha256: string;
    raw_bytes: number;
  } {
    const sha = evidenceSha256(bytes);
    const path = join(this.root, 'raw', sha);
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' });
    else if (evidenceSha256(readFileSync(path)) !== sha)
      throw new Error('Retained evidence integrity failure.');
    return {
      raw_ref: `sha256:${sha}`,
      raw_sha256: sha,
      raw_bytes: bytes.byteLength,
    };
  }

  readRaw(ref: string, maximumBytes = 64 * 1024 * 1024): Buffer {
    if (!/^sha256:[a-f0-9]{64}$/.test(ref))
      throw new Error('Invalid bounded raw reference.');
    const bytes = readFileSync(join(this.root, 'raw', ref.slice(7)));
    if (bytes.byteLength > maximumBytes)
      throw new Error('Raw evidence exceeds requested read bound.');
    if (evidenceSha256(bytes) !== ref.slice(7))
      throw new Error('Retained evidence integrity failure.');
    return bytes;
  }

  saveCapture(capture: EvidenceCapture): EvidenceCapture {
    if (!/^[a-f0-9]{64}$/.test(capture.capture_id))
      throw new Error('Invalid capture identifier.');
    const path = join(this.root, 'captures', `${capture.capture_id}.json`);
    if (!existsSync(path)) this.atomicJson(path, capture);
    return JSON.parse(readFileSync(path, 'utf8')) as EvidenceCapture;
  }

  capture(id: string): EvidenceCapture {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error('Invalid capture identifier.');
    return JSON.parse(
      readFileSync(join(this.root, 'captures', `${id}.json`), 'utf8'),
    ) as EvidenceCapture;
  }

  listCaptures(): EvidenceCapture[] {
    return readdirSync(join(this.root, 'captures'))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map(
        (name) =>
          JSON.parse(
            readFileSync(join(this.root, 'captures', name), 'utf8'),
          ) as EvidenceCapture,
      )
      .sort((a, b) => a.retrieved_at.localeCompare(b.retrieved_at));
  }

  latest(request: AcquisitionRequest): EvidenceCapture | undefined {
    const key = evidenceRequestKey(request);
    const latestSuccess = this.attempts(request).findLast(
      (attempt) => attempt.capture_id !== null,
    );
    return latestSuccess?.capture_id
      ? this.capture(latestSuccess.capture_id)
      : this.listCaptures().findLast((capture) => capture.request_key === key);
  }

  saveAttempt(attempt: AcquisitionAttempt): void {
    if (!/^[a-f0-9-]{36}$/.test(attempt.id))
      throw new Error('Invalid attempt identifier.');
    this.atomicJson(join(this.root, 'attempts', `${attempt.id}.json`), attempt);
  }

  attempts(request?: AcquisitionRequest): AcquisitionAttempt[] {
    const key = request ? evidenceRequestKey(request) : undefined;
    return readdirSync(join(this.root, 'attempts'))
      .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map(
        (name) =>
          JSON.parse(
            readFileSync(join(this.root, 'attempts', name), 'utf8'),
          ) as AcquisitionAttempt,
      )
      .filter((attempt) => key === undefined || attempt.request_key === key)
      .sort((a, b) => a.finished_at.localeCompare(b.finished_at));
  }

  availability(
    request: AcquisitionRequest,
    now = new Date(),
  ): {
    current_availability: 'available' | 'unavailable' | 'never_attempted';
    last_usable_capture: EvidenceCapture | null;
    age_seconds: number | null;
    latest_attempt: AcquisitionAttempt | null;
  } {
    const attempts = this.attempts(request);
    const attempt = attempts.at(-1) ?? null;
    const usable = (capture: EvidenceCapture) =>
      capture.gaps.length === 0 &&
      (capture.stage === 'validated' || capture.excerpt !== null);
    const key = evidenceRequestKey(request);
    let capture: EvidenceCapture | null = null;
    for (const retainedAttempt of attempts.toReversed()) {
      if (!retainedAttempt.capture_id) continue;
      const candidate = this.capture(retainedAttempt.capture_id);
      if (usable(candidate)) {
        capture = candidate;
        break;
      }
    }
    capture ??=
      this.listCaptures().findLast(
        (candidate) => candidate.request_key === key && usable(candidate),
      ) ?? null;
    const latestCapture = attempt?.capture_id
      ? this.capture(attempt.capture_id)
      : null;
    return {
      current_availability:
        attempt === null
          ? 'never_attempted'
          : attempt.status === 'succeeded' &&
              latestCapture !== null &&
              usable(latestCapture)
            ? 'available'
            : 'unavailable',
      last_usable_capture: capture,
      age_seconds: capture
        ? Math.max(0, (now.getTime() - Date.parse(capture.retrieved_at)) / 1000)
        : null,
      latest_attempt: attempt,
    };
  }

  saveCaseManifest(manifest: unknown): string {
    const id = evidenceSha256(JSON.stringify(manifest));
    const path = join(this.root, 'cases', `${id}.json`);
    if (!existsSync(path)) this.atomicJson(path, manifest);
    return `case:${id}`;
  }

  throttleTime(provider: string): number {
    const path = join(
      this.throttleRoot,
      'throttles',
      `${evidenceSha256(provider)}.json`,
    );
    if (!existsSync(path)) return 0;
    const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof state !== 'object' ||
      state === null ||
      !('next_request_ms' in state) ||
      typeof state.next_request_ms !== 'number' ||
      !Number.isFinite(state.next_request_ms)
    )
      throw new Error('Invalid retained provider throttle state.');
    return state.next_request_ms;
  }

  reserveThrottle(provider: string, nextRequestMs: number): void {
    this.atomicJson(
      join(this.throttleRoot, 'throttles', `${evidenceSha256(provider)}.json`),
      { next_request_ms: nextRequestMs },
    );
  }
}
