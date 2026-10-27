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

  it('renders the checked account in plain language', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DamageAccountDemoPage />
      </MemoryRouter>,
    );
    expect(html).toContain('about 21.5 million in harm');
    expect(html).toContain('4.57');
    expect(html).toContain('People needing medical treatment');
    expect(html).toContain('5 of 5 agreed');
    expect(html).toContain('September 2015 to October 2015');
    expect(html).not.toContain('sha256');
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

  it('renders the completed preview in plain language with local-only source lookup', async () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DamageReductionDemoPage />
      </MemoryRouter>,
    );
    expect(html).toContain('by about 12%');
    expect(html).toContain('at least 10%');
    expect(html).toContain('1,000 days');
    expect(html).toContain('880 days');
    expect(html).toContain('re-checked the numbers and agreed');
    expect(html).toContain('January 2027');
    expect(html).not.toContain('SHA-256');
    expect(html).not.toContain('Create conditional preview');
    const read = recordedArtifactReader(reduction.artifacts);
    for (const reference of reduction.preview.source_refs)
      expect(await read(reference.id)).toMatchObject(reference);
    await expect(read('not-in-this-demo')).rejects.toThrow('not included');
  });
});
