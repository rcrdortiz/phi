import type { Article } from "../api/types.ts";
import { formatDate } from "../util/dates.ts";
import { pluralise } from "../util/format.ts";

/** Renders the listing to HTML. Returns a string rather than touching the DOM,
 *  so it can be tested without a browser. */
export function renderArticleList(articles: Article[]): string {
  if (articles.length === 0) return '<p class="empty">Nothing here yet.</p>';
  return `<ul class="article-list">\n${articles.map(renderRow).join("\n")}\n</ul>`;
}

function renderRow(a: Article): string {
  const when = a.publishedAt === null ? "unpublished" : formatDate(a.publishedAt);
  const tags = a.tags.map((t) => `<span class="tag">${t.name}</span>`).join("");
  return [
    `  <li class="article-row" data-slug="${a.slug}">`,
    `    <a class="article-link" href="/a/${a.slug}">${a.title}</a>`,
    `    <span class="article-meta">${when} \u00b7 ${pluralise(a.commentCount, "comment", "comments")}</span>`,
    tags === "" ? "" : `    <div class="article-tags">${tags}</div>`,
    `  </li>`,
  ].filter((l) => l !== "").join("\n");
}
