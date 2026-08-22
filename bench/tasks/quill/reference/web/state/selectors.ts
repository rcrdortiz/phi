import type { Article, Status } from "../api/types.ts";
import type { ArticleState } from "./articles.ts";

/** Articles passing the current filters. "all" means no status filter. */
export function visible(state: ArticleState): Article[] {
  return state.items.filter((a) => {
    if (state.filterStatus !== "all" && a.status !== state.filterStatus) return false;
    if (state.filterTag !== null && !a.tags.some((t) => t.slug === state.filterTag)) return false;
    return true;
  });
}

/**
 * Newest first, by published date, falling back to updated for drafts which
 * have never been published.
 *
 * Ties keep their existing order, so a stable input gives a stable listing.
 */
export function newestFirst(articles: Article[]): Article[] {
  const when = (a: Article): number => a.publishedAt ?? a.updatedAt;
  return [...articles].sort((a, b) => when(b) - when(a));
}

export function byStatus(articles: Article[]): Record<Status, Article[]> {
  const out = { draft: [], published: [], archived: [] } as Record<Status, Article[]>;
  for (const a of articles) out[a.status].push(a);
  return out;
}

export function totalPages(state: ArticleState): number {
  return Math.max(1, Math.ceil(state.total / state.perPage));
}

export function tagCounts(articles: Article[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of articles) for (const t of a.tags) out[t.slug] = (out[t.slug] ?? 0) + 1;
  return out;
}
