import type { Status } from "../api/types.ts";
import type { ArticleState } from "./articles.ts";
import { Store } from "./store.ts";

/** Changing a filter always returns to the first page: showing page 4 of a
 *  narrower result set is how a listing appears empty for no reason. */
export function setStatusFilter(store: Store<ArticleState>, status: Status | "all"): void {
  store.set({ filterStatus: status, page: 1 });
}

export function setTagFilter(store: Store<ArticleState>, tag: string | null): void {
  store.set({ filterTag: tag, page: 1 });
}

export function clearFilters(store: Store<ArticleState>): void {
  store.set({ filterStatus: "all", filterTag: null, page: 1 });
}

export function goToPage(store: Store<ArticleState>, page: number): void {
  store.set({ page: Math.max(1, page) });
}
