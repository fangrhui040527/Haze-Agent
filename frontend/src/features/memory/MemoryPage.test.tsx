import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryPage } from './MemoryPage.tsx';

describe('MemoryPage', () => {
  it('renders the six areas and the overview counts', () => {
    const html = renderToStaticMarkup(createElement(MemoryPage));
    for (const label of [
      'Overview',
      'Memory browser',
      'Recall explanations',
      'Review queue',
      'Conflicts',
      'Maintenance &amp; history',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Pending reviews');
    expect(html).toContain('Sample data · not connected');
  });
});
