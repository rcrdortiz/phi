// The visible TypeScript suite. Passes today, and does not cover the defects.
import { slugify, isValidSlug } from "../web/util/slug.ts";
import { truncate, pluralise } from "../web/util/format.ts";
import { formatDate, relative } from "../web/util/dates.ts";
import { Store } from "../web/state/store.ts";
import { visible, byStatus, totalPages, tagCounts } from "../web/state/selectors.ts";
import { initialState, type ArticleState } from "../web/state/articles.ts";
import { toggleTag, MAX_TAGS } from "../web/components/TagPicker.ts";
import { pageNumbers } from "../web/components/Pagination.ts";
import { renderArticleList } from "../web/components/ArticleList.ts";
import { deriveFields, editorProblems } from "../web/components/ArticleEditor.ts";
import type { Article } from "../web/api/types.ts";

let pass = 0, fail = 0;
const check = (name: string, fn: () => boolean | string) => {
  try {
    const r = fn();
    if (r === true) { pass++; console.log("ok   " + name); }
    else { fail++; console.log("FAIL " + name + "\n     " + String(r)); }
  } catch (e) { fail++; console.log("FAIL " + name + "\n     " + (e as Error).message); }
};

const article = (over: Partial<Article> = {}): Article => ({
  id: 1, slug: "a", title: "A", excerpt: "", status: "published",
  publishedAt: 1000, updatedAt: 1000, tags: [], commentCount: 0, ...over,
});

check("slugify matches the PHP rule", () => slugify("On Loops & Things") === "on-loops-things");
check("a valid slug is accepted", () => isValidSlug("on-loops") && !isValidSlug("On Loops"));
check("truncate adds an ellipsis", () => truncate("abcdefgh", 5).length <= 5);
check("pluralise agrees with its count", () => pluralise(1, "comment", "comments") === "1 comment");
check("formatDate is ISO", () => formatDate(0) === "1970-01-01");
check("relative reports minutes", () => relative(0, 120) === "2m ago");

check("the store notifies subscribers", () => {
  const s = new Store({ n: 0 });
  let seen = -1;
  s.subscribe((st) => (seen = st.n));
  s.set({ n: 5 });
  return seen === 5;
});
check("unsubscribing stops updates", () => {
  const s = new Store({ n: 0 });
  let calls = 0;
  const off = s.subscribe(() => calls++);
  s.set({ n: 1 }); off(); s.set({ n: 2 });
  return calls === 1;
});

const state: ArticleState = { ...initialState, items: [article({ id: 1 }), article({ id: 2, status: "draft" })] };
check("visible respects a status filter", () => visible({ ...state, filterStatus: "draft" }).length === 1);
check("visible with no filter returns everything", () => visible(state).length === 2);
check("byStatus buckets every article", () => {
  const b = byStatus(state.items);
  return b.published.length === 1 && b.draft.length === 1;
});
check("totalPages rounds up", () => totalPages({ ...state, total: 25, perPage: 10 }) === 3);
check("tagCounts counts tags", () => {
  const t = tagCounts([article({ tags: [{ id: 1, slug: "x", name: "X" }] })]);
  return t.x === 1;
});

check("toggleTag adds then removes", () => toggleTag(toggleTag([], "a"), "a").length === 0);
check("toggleTag stops at the maximum", () => {
  let sel: string[] = [];
  for (let i = 0; i < MAX_TAGS + 3; i++) sel = toggleTag(sel, "t" + i);
  return sel.length === MAX_TAGS;
});
check("pageNumbers windows around the current page", () => pageNumbers(5, 10).join(",") === "3,4,5,6,7");
check("an empty list renders an empty state", () => renderArticleList([]).includes("Nothing here yet"));
check("a list renders one row per article", () =>
  (renderArticleList([article({ id: 1 }), article({ id: 2 })]).match(/article-row/g) ?? []).length === 2);

check("the slug follows the title until touched", () => deriveFields({ title: "On Cards" }, false).slug === "on-cards");
check("a touched slug is left alone", () => deriveFields({ title: "On Cards", slug: "custom" }, true).slug === "custom");
check("the editor reports a short body", () => editorProblems({ title: "T", slug: "t", body: "too short", tags: [] }).some((p) => p.includes("20 words")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
