import type { Article } from "../api/types.ts";
import { slugify, isValidSlug } from "../util/slug.ts";

export interface EditorFields {
  title: string;
  slug: string;
  body: string;
  tags: string[];
}

/** The slug follows the title until someone edits it by hand, after which it is
 *  left alone: a published URL should not move because a typo was fixed. */
export function deriveFields(input: Partial<EditorFields>, slugTouched: boolean): EditorFields {
  const title = input.title ?? "";
  const slug = slugTouched && input.slug ? input.slug : slugify(title);
  return { title, slug, body: input.body ?? "", tags: input.tags ?? [] };
}

export function editorProblems(fields: EditorFields): string[] {
  const problems: string[] = [];
  if (fields.title.trim() === "") problems.push("title is required");
  if (fields.title.length > 120) problems.push("title must be 120 characters or fewer");
  if (!isValidSlug(fields.slug)) problems.push("slug must be lowercase and hyphenated");
  if (fields.body.trim().split(/\s+/).filter(Boolean).length < 20) problems.push("body must be at least 20 words");
  if (fields.tags.length > 5) problems.push("at most five tags");
  return problems;
}

export function toPayload(fields: EditorFields): Record<string, unknown> {
  return { title: fields.title.trim(), slug: fields.slug, body: fields.body, tags: fields.tags };
}

export function fromArticle(a: Article): EditorFields {
  return { title: a.title, slug: a.slug, body: a.excerpt, tags: a.tags.map((t) => t.slug) };
}
