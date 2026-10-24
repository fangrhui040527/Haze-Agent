import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router';
import {
  demoStore,
  importDataset,
  loadDemoDataset,
  regenerateDataset,
  resetToSeed,
  SEED_URL,
} from '../../mock/demoStore.ts';
import type { Coverage } from '../../mock/generator/locations.ts';
import { SCENARIOS, type Scenario } from '../../mock/generator/simulate.ts';
import { validateDataset } from '../../mock/generator/validate.ts';
import {
  DEFAULT_MOCK_SETTINGS,
  mockSettings,
  updateMockSettings,
  type MockSettings,
} from '../../mock/settings.ts';
import { dataService, mockDataService } from '../../services/data/index.ts';
import { useStore } from '../../shared/lib/store.ts';
import { CATEGORY_LABELS, STATUS_LABELS } from '../../shared/lib/labels.ts';
import type { DemoDataset } from '../../shared/types/dataset.ts';
import { Badge } from '../../shared/ui/Badge.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Panel, StateMessage } from '../../shared/ui/States.tsx';
import { TimeAgo } from '../../shared/ui/TimeAgo.tsx';
import styles from './DemoDataPage.module.css';

type Tab = 'items' | 'locations' | 'sources' | 'chatScripts' | 'events';

const TABS: { id: Tab; label: string }[] = [
  { id: 'items', label: 'Items' },
  { id: 'locations', label: 'Locations' },
  { id: 'sources', label: 'Sources' },
  { id: 'chatScripts', label: 'Chat scripts' },
  { id: 'events', label: 'Live event log' },
];

const ORIGIN_LABEL = {
  none: 'not loaded',
  seed: 'committed seed file',
  saved: 'saved in this browser',
  generated: 'regenerated in this browser',
  imported: 'imported file',
} as const;

const MAX_ROWS = 200;

export function DemoDataPage() {
  const demo = useStore(demoStore);
  const settings = useStore(mockSettings);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seed, setSeed] = useState(2026);
  const [itemCount, setItemCount] = useState(240);
  const [coverage, setCoverage] = useState<Coverage>('asean');
  const [message, setMessage] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadDemoDataset().catch((e: unknown) =>
      setLoadError(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  const dataset = demo.dataset;
  const usingMock = dataService === mockDataService;

  const flash = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage((m) => (m === text ? null : m)), 5000);
  };

  const simulate = (count: number, scenario: Scenario) => {
    const n = mockDataService.simulate(count, scenario);
    flash(
      `Added ${n} simulated event(s) (${scenario}). The dashboard shows them as "new updates".`,
    );
  };

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportErrors([]);
    try {
      const result = validateDataset(JSON.parse(await file.text()));
      if (!result.ok) {
        setImportErrors(result.errors);
        return;
      }
      importDataset(result.dataset);
      flash(
        `Imported ${result.dataset.items.length} items from ${file.name}.${result.warnings.length ? ` ${result.warnings.length} warning(s).` : ''}`,
      );
    } catch (error) {
      setImportErrors([
        `Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  };

  const onExport = () => {
    if (!dataset) return;
    const blob = new Blob([JSON.stringify(dataset, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hazewatch-demo-data-seed${dataset.seed}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={styles.page}>
      <div className={styles.warning} role="note">
        <strong>Everything on this page is FICTIONAL test data</strong>, not
        real measurements. It exists so the team can build and demo the
        interface before the backend is ready.
      </div>

      {!usingMock && (
        <StateMessage kind="info" title="The dashboard is not using mock data.">
          It uses “{dataService.label}”. Changes here only affect the mock.
          Switch in <code>src/services/data/index.ts</code>.
        </StateMessage>
      )}

      <Panel className={styles.block}>
        <h1>Demo data</h1>
        {loadError && (
          <StateMessage kind="error" title="Couldn't load the demo data.">
            {loadError}
          </StateMessage>
        )}
        {dataset ? (
          <DatasetStats
            dataset={dataset}
            origin={ORIGIN_LABEL[demo.origin]}
            liveEvents={demo.liveEvents}
          />
        ) : (
          !loadError && <p>Loading…</p>
        )}
        {demo.saveWarning && <p className={styles.error}>{demo.saveWarning}</p>}
        <p className={styles.muted}>
          Base file: <code>public/demo-data/demo-data.seed.json</code> (served
          at <code>{SEED_URL}</code>). Rebuild it with{' '}
          <code>npm run data:generate</code>.
        </p>
        <div aria-live="polite" className={styles.message}>
          {message}
        </div>
      </Panel>

      <Panel className={styles.block}>
        <h2>Generate</h2>
        <div className={styles.row}>
          <label className={styles.field}>
            Seed
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value) || 0)}
            />
          </label>
          <label className={styles.field}>
            Items
            <input
              type="number"
              min={20}
              max={2000}
              value={itemCount}
              onChange={(e) =>
                setItemCount(
                  Math.max(20, Math.min(2000, Number(e.target.value) || 20)),
                )
              }
            />
          </label>
          <label className={styles.field}>
            Coverage
            <select
              value={coverage}
              onChange={(e) => setCoverage(e.target.value as Coverage)}
            >
              <option value="asean">Southeast Asia (Malaysia first)</option>
              <option value="worldwide">Worldwide</option>
            </select>
          </label>
          <Button
            variant="primary"
            onClick={() => {
              regenerateDataset(seed, itemCount, coverage);
              flash(`Regenerated with seed ${seed}.`);
            }}
          >
            Regenerate
          </Button>
          <Button
            onClick={() =>
              resetToSeed()
                .then(() => flash('Reset to the committed seed file.'))
                .catch((e: unknown) => setLoadError(String(e)))
            }
          >
            Reset to seed file
          </Button>
        </div>
        <p className={styles.muted}>
          The same seed always produces the same data (times are relative to
          now).
        </p>
      </Panel>

      <Panel className={styles.block}>
        <h2>Live simulation</h2>
        <div className={styles.row}>
          <Button
            onClick={() => simulate(1, settings.scenario)}
            disabled={!dataset}
          >
            +1 event
          </Button>
          <Button
            onClick={() => simulate(5, settings.scenario)}
            disabled={!dataset}
          >
            +5 events
          </Button>
          <Button
            onClick={() => simulate(20, settings.scenario)}
            disabled={!dataset}
          >
            Burst 20
          </Button>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={settings.autoSimulate}
              onChange={(e) =>
                updateMockSettings({ autoSimulate: e.target.checked })
              }
            />
            Auto every
          </label>
          <label className={styles.field}>
            <span className="visually-hidden">
              Seconds between automatic events
            </span>
            <input
              type="number"
              min={2}
              max={600}
              value={settings.intervalSec}
              onChange={(e) =>
                updateMockSettings({
                  intervalSec: Math.max(2, Number(e.target.value) || 2),
                })
              }
            />
            s
          </label>
        </div>
        <fieldset className={styles.scenarios}>
          <legend>Scenario</legend>
          {SCENARIOS.map((s) => (
            <label key={s.id} className={styles.check} title={s.description}>
              <input
                type="radio"
                name="scenario"
                checked={settings.scenario === s.id}
                onChange={() => updateMockSettings({ scenario: s.id })}
              />
              {s.label}
            </label>
          ))}
        </fieldset>
        <p className={styles.muted}>
          {SCENARIOS.find((s) => s.id === settings.scenario)?.description}{' '}
          Simulated events stay in memory until you Export.
        </p>
      </Panel>

      <Panel className={styles.block}>
        <h2>Mock behaviour</h2>
        <div className={styles.row}>
          <SelectSetting
            label="Agent speed"
            value={settings.agentSpeed}
            options={[
              [0.5, '0.5×'],
              [1, '1×'],
              [2, '2×'],
              [4, '4×'],
            ]}
            onChange={(v) => updateMockSettings({ agentSpeed: v })}
          />
          <SelectSetting
            label="Agent failure rate"
            value={settings.agentFailureRate}
            options={[
              [0, '0%'],
              [0.2, '20%'],
              [0.5, '50%'],
              [1, '100%'],
            ]}
            onChange={(v) => updateMockSettings({ agentFailureRate: v })}
          />
          <SelectSetting<MockSettings['agentMode']>
            label="Agent event detail"
            value={settings.agentMode}
            options={[
              ['full', 'Full events (level A)'],
              ['run_state', 'Run state only (level B)'],
              ['fail', 'Always fail'],
            ]}
            onChange={(v) => updateMockSettings({ agentMode: v })}
          />
          <SelectSetting
            label="Load latency"
            value={settings.latencyMs}
            options={[
              [0, 'none'],
              [600, '0.6 s'],
              [2000, '2 s'],
              [5000, '5 s'],
            ]}
            onChange={(v) => updateMockSettings({ latencyMs: v })}
          />
        </div>
        <div className={styles.row}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={settings.failNextLoad}
              onChange={(e) =>
                updateMockSettings({ failNextLoad: e.target.checked })
              }
            />
            Make the next dashboard load fail (to see the error state), then
            reload the page
          </label>
          <Button
            size="small"
            variant="ghost"
            onClick={() => mockSettings.set(DEFAULT_MOCK_SETTINGS)}
          >
            Reset settings
          </Button>
        </div>
      </Panel>

      <Panel className={styles.block}>
        <h2>Import / export</h2>
        <div className={styles.row}>
          <Button onClick={() => fileRef.current?.click()}>Import JSON…</Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => void onImport(e)}
          />
          <Button onClick={onExport} disabled={!dataset}>
            Export JSON
          </Button>
          <Button
            onClick={() =>
              dataset &&
              navigator.clipboard
                ?.writeText(JSON.stringify(dataset, null, 2))
                .then(() => flash('Copied to clipboard.'))
            }
            disabled={!dataset}
          >
            Copy to clipboard
          </Button>
        </div>
        <p className={styles.muted}>
          To make an exported file the new default for the whole team, save it
          as <code>public/demo-data/demo-data.seed.json</code> and commit it.
        </p>
        {importErrors.length > 0 && (
          <div role="alert" className={styles.importErrors}>
            <p>
              <strong>Import rejected. Nothing was replaced.</strong>
            </p>
            <ul>
              {importErrors.map((err, i) => (
                <li key={i}>
                  <code>{err}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      {dataset && <Browser dataset={dataset} />}
    </div>
  );
}

function DatasetStats({
  dataset,
  origin,
  liveEvents,
}: {
  dataset: DemoDataset;
  origin: string;
  liveEvents: number;
}) {
  const count = <K extends string>(
    key: (i: DemoDataset['items'][number]) => K,
  ) =>
    dataset.items.reduce<Record<string, number>>(
      (acc, i) => ((acc[key(i)] = (acc[key(i)] ?? 0) + 1), acc),
      {},
    );
  const byCategory = count((i) => i.category);
  const byStatus = count((i) => i.status);
  const edge = dataset.items.filter((i) => i.tags.includes('edge-case')).length;
  return (
    <div className={styles.stats}>
      <p>
        Seed <strong>{dataset.seed}</strong> ·{' '}
        <strong>{dataset.items.length}</strong> items ·{' '}
        <strong>{dataset.locations.length}</strong> locations ·{' '}
        <strong>{dataset.sources.length}</strong> sources · {edge} edge cases ·
        source: {origin} · {liveEvents} simulated event(s) this session ·
        generated <TimeAgo iso={dataset.generatedAt} />
      </p>
      <div className={styles.chips}>
        {Object.entries(byCategory).map(([k, v]) => (
          <Badge key={k}>
            {CATEGORY_LABELS[k as keyof typeof CATEGORY_LABELS] ?? k}: {v}
          </Badge>
        ))}
      </div>
      <div className={styles.chips}>
        {Object.entries(byStatus).map(([k, v]) => (
          <Badge key={k} tone="info">
            {STATUS_LABELS[k as keyof typeof STATUS_LABELS] ?? k}: {v}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function SelectSetting<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <label className={styles.field}>
      {label}
      <select
        value={String(value)}
        onChange={(e) =>
          onChange(
            options.find(([v]) => String(v) === e.target.value)?.[0] ?? value,
          )
        }
      >
        {options.map(([v, text]) => (
          <option key={String(v)} value={String(v)}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

interface BrowserRow {
  key: string;
  cells: string[];
  data: unknown;
}

function Browser({ dataset }: { dataset: DemoDataset }) {
  const [tab, setTab] = useState<Tab>('items');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const { headers, rows } = useMemo((): {
    headers: string[];
    rows: BrowserRow[];
  } => {
    const loc = new Map(dataset.locations.map((l) => [l.id, l.name]));
    switch (tab) {
      case 'items':
        return {
          headers: ['Id', 'Location', 'Category', 'Status', 'Headline', 'Tags'],
          rows: dataset.items.map((i) => ({
            key: i.id,
            cells: [
              i.id,
              loc.get(i.locationId) ?? i.locationId,
              i.category,
              i.status,
              i.headline,
              i.tags.join(', '),
            ],
            data: i,
          })),
        };
      case 'locations':
        return {
          headers: ['Id', 'Name', 'Country', 'Region', 'Time zone', 'Standard'],
          rows: dataset.locations.map((l) => ({
            key: l.id,
            cells: [
              l.id,
              l.name,
              l.country,
              l.region,
              l.timeZone,
              l.aqiStandard,
            ],
            data: l,
          })),
        };
      case 'sources':
        return {
          headers: ['Id', 'Name', 'Kind', 'Evidence', 'Cadence'],
          rows: dataset.sources.map((s) => ({
            key: s.id,
            cells: [s.id, s.name, s.kind, s.evidenceKind, s.cadence],
            data: s,
          })),
        };
      case 'chatScripts':
        return {
          headers: ['Intent', 'Keywords', 'Templates'],
          rows: dataset.chatScripts.map((c) => ({
            key: c.intent,
            cells: [
              c.intent,
              c.keywords.join(', '),
              String(c.templates.length),
            ],
            data: c,
          })),
        };
      case 'events':
        return {
          headers: ['Id', 'Updated', 'Location', 'Category', 'Headline'],
          rows: dataset.items
            .filter((i) => i.tags.includes('simulated'))
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .map((i) => ({
              key: `${i.id}-${i.revision}`,
              cells: [
                i.id,
                new Date(i.updatedAt).toLocaleTimeString(),
                loc.get(i.locationId) ?? i.locationId,
                i.category,
                i.headline,
              ],
              data: i,
            })),
        };
    }
  }, [dataset, tab]);

  const filtered = rows.filter(
    (r) =>
      !filter || r.cells.join(' ').toLowerCase().includes(filter.toLowerCase()),
  );
  const selectedRow = filtered.find((r) => r.key === selected) ?? null;

  return (
    <Panel className={styles.block}>
      <h2>Browse</h2>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Dataset collections"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            className={styles.tab}
            onClick={() => {
              setTab(t.id);
              setSelected(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <label className={styles.field}>
        Filter
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Type to filter rows…"
        />
      </label>
      <p className={styles.muted}>
        {filtered.length} row(s)
        {filtered.length > MAX_ROWS ? `, showing the first ${MAX_ROWS}` : ''}.
        Select a row to see its JSON.
        {tab === 'items' &&
          ' Tip: filter by "edge-case" to see the deliberately awkward items.'}
      </p>
      <div className={styles.browser}>
        <div
          className={styles.browserTable}
          tabIndex={0}
          role="region"
          aria-label={`${tab} table`}
        >
          {filtered.length === 0 ? (
            <StateMessage
              kind="empty"
              title={
                tab === 'events' ? 'No simulated events yet.' : 'No rows match.'
              }
            />
          ) : (
            <table>
              <thead>
                <tr>
                  {headers.map((h) => (
                    <th key={h} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, MAX_ROWS).map((r) => (
                  <tr
                    key={r.key}
                    aria-selected={r.key === selected}
                    className={r.key === selected ? styles.selected : ''}
                  >
                    {r.cells.map((c, i) => (
                      <td key={i}>
                        {i === 0 ? (
                          <button
                            type="button"
                            className={styles.rowButton}
                            onClick={() => setSelected(r.key)}
                          >
                            {c}
                          </button>
                        ) : (
                          c
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className={styles.json}>
          {selectedRow ? (
            <>
              {tab === 'items' && (
                <Link to={`/item/${encodeURIComponent(selectedRow.key)}`}>
                  Open on the detail page →
                </Link>
              )}
              <pre>{JSON.stringify(selectedRow.data, null, 2)}</pre>
            </>
          ) : (
            <p className={styles.muted}>
              Select a row (click its first cell) to see the raw JSON.
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}
