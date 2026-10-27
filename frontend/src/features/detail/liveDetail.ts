import type { HazeItem, ItemDetail } from '../../shared/types/domain.ts';

/** Pending stream updates take precedence over the visible table at the same revision. */
export function latestLiveItem(
  id: string,
  items: readonly HazeItem[],
  pending: readonly HazeItem[],
): HazeItem | null {
  let latest: HazeItem | null = null;
  for (const item of [...items, ...pending]) {
    if (item.id === id && (!latest || item.revision >= latest.revision))
      latest = item;
  }
  return latest;
}

/** Refresh computed checks immediately; a new observation still needs explicit loading. */
export function refreshLiveDetail(
  detail: ItemDetail,
  item: HazeItem | null,
): ItemDetail {
  if (
    !item ||
    item.id !== detail.item.id ||
    item.revision !== detail.item.revision ||
    item === detail.item
  )
    return detail;
  return { ...detail, item };
}
