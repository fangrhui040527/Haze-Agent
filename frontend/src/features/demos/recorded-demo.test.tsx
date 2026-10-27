import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import accountSnapshot from './data/damage-account.json';
import reductionSnapshot from './data/damage-reduction.json';
import { DamageAccountDemoPage } from './DamageAccountDemoPage.tsx';
import { DamageReductionDemoPage } from './DamageReductionDemoPage.tsx';
import {
  accountDemoArtifactHref,
  parseAccountDemo,
  parseReductionDemo,
  recordedArtifactReader,
} from './recorded-demo.ts';

describe('bundled browser demos', () => {
  const account = parseAccountDemo(accountSnapshot);
  const reduction = parseReductionDemo(reductionSnapshot);

  it('renders the checked account and resolves source links inside the frontend', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DamageAccountDemoPage />
      </MemoryRouter>,
    );
    expect(html).toContain('21534033.4');
    expect(html).toContain('4.57');
    expect(html).toContain('Review at capture');
    expect(html).toContain('/demos/damage-account/artifacts/');
    expect(html).not.toContain('/api/artifacts/');
    expect(html).not.toContain('Continue in a new run');
  });

  it('rejects an altered source hash rather than displaying another version', () => {
    const reference = account.account;
    const wrongUrl = accountDemoArtifactHref({
      ...reference,
      sha256: '0'.repeat(64),
    });
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[wrongUrl]}>
        <Routes>
          <Route
            path="/demos/damage-account/artifacts/:artifactId"
            element={<DamageAccountDemoPage />}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(html).toContain('This exact version and hash are not included');
    expect(html).not.toContain('21534033.4');
  });

  it('renders the completed conditional preview with local-only source lookup', async () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DamageReductionDemoPage />
      </MemoryRouter>,
    );
    expect(html).toContain('Point estimate meets target');
    expect(html).toContain('Arithmetic review at capture: supported');
    expect(html).toContain('Inspect recorded source');
    expect(html).not.toContain('Create conditional preview');
    const read = recordedArtifactReader(reduction.artifacts);
    for (const reference of reduction.preview.source_refs)
      expect(await read(reference.id)).toMatchObject(reference);
    await expect(read('not-in-this-demo')).rejects.toThrow('not included');
  });
});
