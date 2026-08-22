import type { Article, Status } from "../api/types.ts";
import { Store } from "./store.ts";

export interface ArticleState {
  items: Article[];
  loading: boolean;
  error: string | null;
  filterStatus: Status | "all";
  filterTag: string | null;
  page: number;
  perPage: number;
  total: number;
}

export const initialState: ArticleState = {
  items: [],
  loading: false,
  error: null,
  filterStatus: "all",
  filterTag: null,
  page: 1,
  perPage: 10,
  total: 0,
};

export function createArticleStore(): Store<ArticleState> {
  return new Store<ArticleState>({ ...initialState });
}

export function setLoading(store: Store<ArticleState>): void {
  store.set({ loading: true, error: null });
}

export function setResults(store: Store<ArticleState>, items: Article[], total: number): void {
  store.set({ items, total, loading: false, error: null });
}

export function setError(store: Store<ArticleState>, message: string): void {
  store.set({ loading: false, error: message });
}
