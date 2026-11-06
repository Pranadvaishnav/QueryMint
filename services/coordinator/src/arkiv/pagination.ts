import type { Hex } from "viem";

export interface KeyedEntity { $key: Hex }
export interface PaginationResult<T> { entities: T[]; complete: boolean; pagesScanned: number }

/** Bounded Arkiv keyset pagination. A short or empty page proves exhaustion; a full cap does not. */
export async function collectArkivPages<T extends KeyedEntity>(
  fetchPage: (cursor?: Hex) => Promise<readonly T[]>,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<PaginationResult<T>> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100);
  const maxPages = Math.min(Math.max(options.maxPages ?? 20, 1), 20);
  const entities: T[] = [];
  const seenKeys = new Set<string>();
  let cursor: Hex | undefined;
  let pagesScanned = 0;
  while (pagesScanned < maxPages) {
    const page = await fetchPage(cursor);
    pagesScanned++;
    if (page.length > pageSize) throw new Error("Arkiv returned more entities than the requested page size");
    if (page.length === 0) return { entities, complete: true, pagesScanned };
    let previousKey = cursor;
    for (const entity of page) {
      const key = entity.$key.toLowerCase();
      if (seenKeys.has(key) || (previousKey && BigInt(entity.$key) <= BigInt(previousKey))) throw new Error("Arkiv pagination returned a repeated or out-of-order entity key");
      seenKeys.add(key);
      entities.push(entity);
      previousKey = entity.$key;
    }
    cursor = page.at(-1)!.$key;
    if (page.length < pageSize) return { entities, complete: true, pagesScanned };
  }
  return { entities, complete: false, pagesScanned };
}
