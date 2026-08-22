Add a reading-time estimate to articles.

An article's reading time is its word count divided by 200 words per minute,
rounded up, with a minimum of 1 minute. A 150 word article reads in 1 minute; a
450 word article reads in 3.

It needs to appear in four places:

- **Domain**: `Article` exposes `readingTime(): int`, the number of minutes.
- **HTML rendering**: the article page includes
  `<span class="reading-time">N min read</span>` inside the existing
  `article-meta` area.
- **TypeScript**: `web/util/format.ts` exports
  `readingTime(words: number): number` following the same rule, and the article
  list row shows `N min read` in its meta line.
- **CSS**: `assets/main.css` styles `.reading-time`.

The existing behaviour must not change: both suites still pass, and every other
renderer produces what it produced before.

## Done means

Both suites pass, and reading time is available in the domain, in the HTML
output, in the TypeScript, and styled.
