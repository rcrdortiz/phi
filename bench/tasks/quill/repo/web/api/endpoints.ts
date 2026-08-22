/** Paths in one place, so a route rename is a single edit. */
export const endpoints = {
  articles: "/articles",
  article: (slug: string) => `/articles/${slug}`,
  search: "/search",
  feed: (format: string) => `/feed.${format}`,
  tags: "/tags",
} as const;
