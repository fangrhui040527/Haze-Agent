import {
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  FileText,
  Info,
  Minus,
  Search,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useLiveData } from '../../app/liveDataContext.ts';
import {
  useMediaQuery,
  useNow,
  useSessionState,
} from '../../shared/hooks/hooks.ts';
import { itemBand, itemPm25 } from '../../shared/lib/bands.ts';
import { CATEGORY_LABELS, STATUS_LABELS } from '../../shared/lib/labels.ts';
import { formatDateTime, utcOffsetLabel } from '../../shared/lib/time.ts';
import type {
  CategoryId,
  HazeItem,
  ItemStatus,
  Location,
  Trend,
} from '../../shared/types/domain.ts';
import { BandBadge, StatusBadge } from '../../shared/ui/Badge.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Skeleton, StateMessage } from '../../shared/ui/States.tsx';
import { TimeAgo } from '../../shared/ui/TimeAgo.tsx';
import styles from './LiveTable.module.css';
import {
  rankItems,
  type RankedItem,
  type RankPart,
} from './ranking.ts';

interface Filters {
  search: string;
  locationId: string;
  category: CategoryId | '';
  status: ItemStatus | '';
  sort: 'rank' | 'newest';
}

const NO_FILTERS: Filters = {
  search: '',
  locationId: '',
  category: '',
  status: '',
  sort: 'newest',
};

function matches(ranked: RankedItem, f: Filters): boolean {
  const { item, location } = ranked;
  if (f.locationId && item.locationId !== f.locationId) return false;
  if (f.category && item.category !== f.category) return false;
  if (f.status && item.status !== f.status) return false;
  if (f.search) {
    const haystack =
      `${item.headline} ${item.summary} ${location?.name ?? ''} ${location?.country ?? ''} ${location?.region ?? ''}`.toLowerCase();
    if (
      !f.search
        .toLowerCase()
        .split(/\s+/)
        .every((word) => haystack.includes(word))
    )
      return false;
  }
  return true;
}

export function LiveTable() {
  const live = useLiveData();
  const now = useNow(30_000);
  const isNarrow = useMediaQuery('(max-width: 767px)');
  const [filters, setFilters] = useSessionState<Filters>(
    'hazewatch.table.filters.v2',
    NO_FILTERS,
  );
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  const ranked = useMemo(
    () => rankItems(live.items, live.locations, now),
    [live.items, live.locations, now],
  );
  const visible = useMemo(() => {
    const list = ranked.filter((r) => matches(r, filters));
    if (filters.sort === 'newest') {
      list.sort(
        (a, b) => Date.parse(b.item.updatedAt) - Date.parse(a.item.updatedAt),
      );
    }
    return list;
  }, [ranked, filters]);

  const sortedLocations = useMemo(
    () => [...live.locations].sort((a, b) => a.name.localeCompare(b.name)),
    [live.locations],
  );

  // Remember the scroll position inside the table box when going to a detail page and back.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || live.status !== 'ready') return;
    const saved = Number(sessionStorage.getItem('hazewatch.table.scroll') ?? 0);
    if (saved > 0) box.scrollTop = saved;
    const onScroll = () =>
      sessionStorage.setItem('hazewatch.table.scroll', String(box.scrollTop));
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => box.removeEventListener('scroll', onScroll);
  }, [live.status]);

  const update = (patch: Partial<Filters>) =>
    setFilters({ ...filters, ...patch });
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const filtersActive =
    JSON.stringify({ ...filters, sort: NO_FILTERS.sort }) !==
    JSON.stringify(NO_FILTERS);

  return (
    <section className={styles.wrapper} aria-labelledby="live-table-title">
      <div className={styles.toolbar}>
        <div className={styles.tableIntro}>
          <h2 id="live-table-title" className={styles.title}>
            Live haze information
          </h2>
          <span className={styles.metaRow} aria-live="polite">
            {live.status === 'ready' &&
              `Showing ${visible.length} of ${ranked.length}`}
          </span>
        </div>
        <div className={styles.filterControls}>
          <div className={styles.filters}>
            <form
              className={`${styles.field} ${styles.searchField}`}
              onSubmit={(e) => {
                e.preventDefault();
                update({ search: searchDraft });
              }}
            >
              <Search className={styles.fieldIcon} aria-hidden="true" />
              <label className={styles.searchLabel}>
                <span className="visually-hidden">Search</span>
                <input
                  type="search"
                  placeholder="Search…"
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                />
              </label>
            </form>
            <label className={styles.field}>
              <span className="visually-hidden">Sort</span>
              <ArrowDownWideNarrow
                className={styles.fieldIcon}
                aria-hidden="true"
              />
              <select
                value={filters.sort}
                onChange={(e) =>
                  update({ sort: e.target.value as Filters['sort'] })
                }
              >
                <option value="rank">Rank</option>
                <option value="newest">Newest</option>
              </select>
            </label>
          </div>
          <div className={styles.updateControl} aria-live="polite">
            {live.pending.length > 0 ? (
              <button
                type="button"
                className={styles.pendingBar}
                onClick={live.applyPending}
              >
                <span className={styles.pendingCount}>
                  {live.pending.length}
                </span>
                <span className={styles.pendingText}>
                  {live.pending.length === 1 ? 'new update' : 'new updates'}
                </span>
                <ArrowDown size={16} aria-hidden="true" />
              </button>
            ) : (
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  className={styles.checkboxInput}
                  checked={live.autoApply}
                  onChange={(e) => live.setAutoApply(e.target.checked)}
                />
                <span className={styles.checkboxBox} aria-hidden="true" />
                <span className={styles.checkboxText}>
                  Show new updates automatically
                </span>
              </label>
            )}
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={styles.scrollBox}
        tabIndex={0}
        role="region"
        aria-label="Live haze information, scrollable"
      >
        {live.status === 'loading' && <LoadingRows />}
        {live.status === 'error' && (
          <StateMessage
            kind="error"
            title="Couldn't load haze data."
            action={<Button onClick={live.retry}>Retry</Button>}
          >
            {live.error}
          </StateMessage>
        )}
        {live.status === 'ready' && visible.length === 0 && (
          <StateMessage
            kind="empty"
            title={
              ranked.length === 0
                ? 'No haze information yet.'
                : 'No items match your filters.'
            }
            action={
              filtersActive ? (
                <Button
                  size="small"
                  variant="ghost"
                  className={styles.clearFiltersButton}
                  onClick={() =>
                    setFilters({ ...NO_FILTERS, sort: filters.sort })
                  }
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        )}
        {live.status === 'ready' &&
          visible.length > 0 &&
          (isNarrow ? (
            <ul className={styles.cards}>
              {visible.map((r) => (
                <ItemCard
                  key={r.item.id}
                  ranked={r}
                  fresh={live.freshIds.has(r.item.id)}
                />
              ))}
            </ul>
          ) : (
            <table className={styles.table}>
              <caption className="visually-hidden">
                Haze information, newest first by default. Use the score button
                to see why an item has its rank.
              </caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Score</th>
                  <th scope="col">Updated</th>
                  <th scope="col" className={styles.locationCol}>
                    <label
                      className={`${styles.thFilterLabel} ${filters.locationId ? styles.thFilterActive : ''}`}
                    >
                      <span>Location</span>
                      <ChevronDown
                        size={10}
                        strokeWidth={2.5}
                        aria-hidden="true"
                      />
                      {filters.locationId && (
                        <span
                          className={styles.thFilterDot}
                          aria-hidden="true"
                        />
                      )}
                      <select
                        aria-label="Filter by location"
                        className={styles.thFilterOverlay}
                        value={filters.locationId}
                        onChange={(e) => update({ locationId: e.target.value })}
                      >
                        <option value="">All locations</option>
                        {sortedLocations.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}, {l.countryCode}
                          </option>
                        ))}
                      </select>
                    </label>
                  </th>
                  <th scope="col" className={styles.categoryCol}>
                    <label
                      className={`${styles.thFilterLabel} ${filters.category ? styles.thFilterActive : ''}`}
                    >
                      <span>Category</span>
                      <ChevronDown
                        size={10}
                        strokeWidth={2.5}
                        aria-hidden="true"
                      />
                      {filters.category && (
                        <span
                          className={styles.thFilterDot}
                          aria-hidden="true"
                        />
                      )}
                      <select
                        aria-label="Filter by category"
                        className={styles.thFilterOverlay}
                        value={filters.category}
                        onChange={(e) =>
                          update({
                            category: e.target.value as Filters['category'],
                          })
                        }
                      >
                        <option value="">All categories</option>
                        {Object.entries(CATEGORY_LABELS).map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </th>
                  <th scope="col" className={styles.summary}>
                    Summary
                  </th>
                  <th scope="col" className={styles.airQualityCol}>
                    Air quality
                  </th>
                  <th scope="col" className={styles.trendCol}>
                    Trend
                  </th>
                  <th scope="col">Evidence</th>
                  <th scope="col" className={styles.statusCol}>
                    <label
                      className={`${styles.thFilterLabel} ${filters.status ? styles.thFilterActive : ''}`}
                    >
                      <span>Status</span>
                      <ChevronDown
                        size={10}
                        strokeWidth={2.5}
                        aria-hidden="true"
                      />
                      {filters.status && (
                        <span
                          className={styles.thFilterDot}
                          aria-hidden="true"
                        />
                      )}
                      <select
                        aria-label="Filter by status"
                        className={styles.thFilterOverlay}
                        value={filters.status}
                        onChange={(e) =>
                          update({
                            status: e.target.value as Filters['status'],
                          })
                        }
                      >
                        <option value="">All statuses</option>
                        {Object.entries(STATUS_LABELS).map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, index) => {
                  const open = expanded.has(r.item.id);
                  const breakdownId = `rank-${r.item.id}`;
                  return (
                    <Fragment key={r.item.id}>
                      <tr
                        className={[
                          live.freshIds.has(r.item.id) ? styles.fresh : '',
                          r.item.status === 'retracted' ? styles.retracted : '',
                        ].join(' ')}
                      >
                        <td className={styles.num}>
                          {filters.sort === 'rank' ? r.rank : index + 1}
                        </td>
                        <td>
                          <button
                            type="button"
                            className={styles.scoreButton}
                            aria-expanded={open}
                            aria-controls={breakdownId}
                            onClick={() => toggle(r.item.id)}
                            title="Why this rank?"
                          >
                            <span>{r.score}</span>
                            <Info
                              size={13}
                              strokeWidth={2.2}
                              aria-hidden="true"
                            />
                            <span className="visually-hidden">
                              {' '}
                              — show why this item has rank {r.rank}
                            </span>
                          </button>
                        </td>
                        <td className={styles.nowrap}>
                          <TimeAgo iso={r.item.updatedAt} prefix="Updated" />
                        </td>
                        <td className={styles.locationCol}>
                          <LocationName
                            location={r.location}
                            iso={r.item.observedAt}
                          />
                        </td>
                        <td className={styles.categoryCol}>
                          {CATEGORY_LABELS[r.item.category]}
                        </td>
                        <td className={styles.summary} title={r.item.summary}>
                          {r.item.headline}
                        </td>
                        <td className={styles.airQualityCol}>
                          <BandBadge
                            band={itemBand(r.item)}
                            pm25={itemPm25(r.item)}
                            compact
                            className={
                              itemBand(r.item) === 'sensitive'
                                ? styles.airQualityWrap
                                : styles.airQualityNowrap
                            }
                          />
                        </td>
                        <td className={styles.trendCol}>
                          <TrendCell trend={r.item.trend} />
                        </td>
                        <td>
                          <EvidenceCell item={r.item} />
                        </td>
                        <td className={styles.statusCol}>
                          <StatusBadge status={r.item.status} />
                        </td>
                        <td>
                          <Link
                            to={`/item/${encodeURIComponent(r.item.id)}`}
                            className={styles.readMoreBtn}
                            title="Read more"
                            aria-label={`Read more about ${r.item.headline}`}
                          >
                            <FileText size={16} aria-hidden="true" />
                            <span className="visually-hidden">
                              {' '}
                              about {r.item.headline}
                            </span>
                          </Link>
                        </td>
                      </tr>
                      {open && (
                        <tr id={breakdownId} className={styles.breakdownRow}>
                          <td />
                          <td colSpan={10}>
                            <RankBreakdown parts={r.parts} score={r.score} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          ))}
      </div>
    </section>
  );
}

function LoadingRows() {
  return (
    <div
      className={styles.loading}
      aria-busy="true"
      aria-label="Loading haze data"
    >
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} height="28px" />
      ))}
    </div>
  );
}

function LocationName({
  location,
  iso,
}: {
  location: Location | null;
  iso: string;
}) {
  if (!location) return <span>Unknown location</span>;
  const local = `${formatDateTime(iso, location.timeZone)} local (${utcOffsetLabel(iso, location.timeZone)})`;
  return (
    <span
      className={styles.nowrap}
      title={`${location.region} · observed ${local}`}
    >
      {location.name},{' '}
      <abbr title={location.country}>{location.countryCode}</abbr>
    </span>
  );
}

function TrendCell({ trend }: { trend: Trend | null }) {
  if (trend === null) {
    return (
      <span
        className={`${styles.trendIcon} ${styles.muted}`}
        title="No trend data"
      >
        <Minus size={15} strokeWidth={2.5} aria-hidden="true" />
        <span className="visually-hidden">No trend data</span>
      </span>
    );
  }

  const text =
    trend === 'up' ? 'rising' : trend === 'down' ? 'falling' : 'steady';

  return (
    <span
      title={text}
      className={`${styles.trendIcon} ${
        trend === 'up'
          ? styles.trendUp
          : trend === 'down'
            ? styles.trendDown
            : styles.trendFlat
      }`}
    >
      {trend === 'up' && (
        <ArrowUp size={15} strokeWidth={2.5} aria-hidden="true" />
      )}
      {trend === 'down' && (
        <ArrowDown size={15} strokeWidth={2.5} aria-hidden="true" />
      )}
      {trend !== 'up' && trend !== 'down' && (
        <ArrowRight size={15} strokeWidth={2.5} aria-hidden="true" />
      )}
      <span className="visually-hidden">{text}</span>
    </span>
  );
}

function EvidenceCell({ item }: { item: HazeItem }) {
  const total = item.checks.length;
  const passed = item.checks.filter((c) => c.result === 'pass').length;
  if (total === 0) return <span className={styles.muted}>no checks</span>;
  return (
    <span
      className={styles.nowrap}
      title={`${passed} of ${total} evidence checks passed · ${item.sources.length} source(s)`}
    >
      {passed}/{total}
      {passed === total && <span aria-hidden="true"> ✓</span>}
      <span className={styles.muted}> · {item.sources.length} src</span>
    </span>
  );
}

export function RankBreakdown({
  parts,
  score,
}: {
  parts: RankPart[];
  score: number;
}) {
  return (
    <div className={styles.breakdown}>
      <p className={styles.breakdownTitle}>Why this score ({score} / 100)</p>
      <ul>
        {parts.map((p) => (
          <li key={p.key}>
            <span className={styles.partLabel}>{p.label}</span>
            <span className={styles.partPoints}>
              {p.points > 0 ? '+' : ''}
              {p.points}
              {p.max > 0 && <span className={styles.muted}> / {p.max}</span>}
            </span>
            <span className={styles.muted}>{p.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemCard({ ranked, fresh }: { ranked: RankedItem; fresh: boolean }) {
  const { item, location } = ranked;
  return (
    <li className={`${styles.card} ${fresh ? styles.fresh : ''}`}>
      <div className={styles.cardTop}>
        <span>
          #{ranked.rank} · score {ranked.score}
        </span>
        <TimeAgo iso={item.updatedAt} prefix="Updated" />
      </div>
      <p className={styles.cardTitle}>{item.headline}</p>
      <p className={styles.muted}>
        <LocationName location={location} iso={item.observedAt} /> ·{' '}
        {CATEGORY_LABELS[item.category]}
      </p>
      <div className={styles.cardRow}>
        <BandBadge band={itemBand(item)} pm25={itemPm25(item)} />
        <StatusBadge status={item.status} />
        <EvidenceCell item={item} />
      </div>
      <Link
        to={`/item/${encodeURIComponent(item.id)}`}
        className={styles.readMoreBtn}
        title="Read more"
        aria-label={`Read more about ${item.headline}`}
      >
        <FileText size={16} aria-hidden="true" />
        <span className="visually-hidden"> about {item.headline}</span>
      </Link>
    </li>
  );
}
