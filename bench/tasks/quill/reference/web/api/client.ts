import type { Article, Page } from "./types.ts";

/** Everything that talks to the server goes through here. */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(baseUrl: string, fetchFn: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn;
  }

  private async getJson<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(this.baseUrl + path, "http://localhost");
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const res = await this.fetchFn(url.toString());
    if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  listArticles(page: number, perPage: number, tag?: string): Promise<Page<Article>> {
    return this.getJson<Page<Article>>("/articles", tag ? { page, per_page: perPage, tag } : { page, per_page: perPage });
  }

  getArticle(slug: string): Promise<Article> {
    return this.getJson<Article>(`/articles/${slug}`);
  }

  search(term: string, page = 1): Promise<Page<Article>> {
    return this.getJson<Page<Article>>("/search", { q: term, page });
  }
}
