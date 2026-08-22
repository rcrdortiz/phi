// Shapes returned by the PHP side. Kept in one file so a schema change has one
// place to land.

export type Status = "draft" | "published" | "archived";

export interface Tag {
  id: number;
  slug: string;
  name: string;
}

export interface Article {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  status: Status;
  publishedAt: number | null;
  updatedAt: number;
  tags: Tag[];
  commentCount: number;
  readingTime?: number;
  wordCount?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}
