// Phase two: reading time, in four places, without breaking phase one.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.resolve(process.argv[2] ?? ".");
const here = path.dirname(new URL(import.meta.url).pathname);
const results = [];
const check = (name, fn) => {
  try {
    const ok = fn();
    results.push({ name, pass: ok === true, detail: ok === true ? "" : String(ok) });
  } catch (e) {
    results.push({ name, pass: false, detail: (e && e.message || String(e)).split("\n")[0].slice(0, 160) });
  }
};

const php = (code) => execFileSync("php", ["-r", `require '${dir}/bin/seed.php'; ${code}`], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }).trim();
const ts = (code) => {
  const f = path.join(dir, `.probe-${Math.floor(Math.random() * 1e9)}.mjs`);
  fs.writeFileSync(f, code);
  try { return execFileSync(process.execPath, ["--experimental-strip-types", f], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  finally { fs.rmSync(f, { force: true }); }
};
const article = (words) => `$a = new Quill\\Domain\\Article(1, 1, Quill\\Domain\\Slug::fromString('s'), 'T',
  implode(' ', array_fill(0, ${words}, 'word')), Quill\\Domain\\Status::Published, 1700000000, null, 1, 1, []);`;

// Regression: what phase one had working must still work.
//
// Measured against a baseline written before this phase ran, not against a
// perfect score. Counting every failing earlier check as a regression makes a
// defect that was never fixed look like damage the new work caused: a tree
// sitting at 12/14 reported 2 regressions before anything had been edited, and
// an untouched checkout reported 7. A regression is something that passed and
// then stopped.
//
// With no baseline on disk, nothing can be said about what changed, so this
// reports null rather than inventing a number. The harness writes the baseline
// by running the earlier suite before it starts the phase.
let regressed = null;
try {
  const prior = JSON.parse(execFileSync(process.execPath, [path.join(here, "verify1.mjs"), dir], { encoding: "utf8", timeout: 180000 }));
  for (const r of prior.results) results.push({ ...r, name: `phase 1 still: ${r.name}` });
  const basePath = path.join(dir, ".bench-baseline-1.json");
  if (fs.existsSync(basePath)) {
    const was = new Map(JSON.parse(fs.readFileSync(basePath, "utf8")).map((r) => [r.name, r.pass]));
    regressed = prior.results.filter((r) => was.get(r.name) === true && !r.pass).length;
  }
} catch (e) {
  results.push({ name: "phase 1 still passes", pass: false, detail: (e && e.message) || String(e) });
  regressed = 1;
}

// Domain
check("Article::readingTime rounds up", () => php(`${article(150)} echo $a->readingTime();`) === "1");
check("a 450 word article reads in 3 minutes", () => php(`${article(450)} echo $a->readingTime();`) === "3");
check("a 401 word article rounds up to 3", () => php(`${article(401)} echo $a->readingTime();`) === "3");
check("an exactly 400 word article is 2 minutes", () => php(`${article(400)} echo $a->readingTime();`) === "2");
check("a very short article is still 1 minute", () => php(`${article(3)} echo $a->readingTime();`) === "1");

// HTML rendering
check("the html renderer emits a reading time", () =>
  php(`${article(450)} $h = (new Quill\\Rendering\\HtmlRenderer())->render($a);
       echo preg_match('/<span class="reading-time">\\s*3 min read\\s*<\\/span>/', $h) ? 'yes' : 'no:'.$h;`) === "yes");
check("it sits inside the article meta area", () =>
  php(`${article(450)} $h = (new Quill\\Rendering\\HtmlRenderer())->render($a);
       echo preg_match('/article-meta[\\s\\S]*reading-time/', $h) ? 'yes' : 'no';`) === "yes");

// TypeScript
check("format.readingTime follows the same rule", () =>
  ts(`import { readingTime } from "${dir}/web/util/format.ts";
      console.log([150, 400, 401, 450, 3].map(readingTime).join(","));`) === "1,2,3,3,1");
check("the list row shows a reading time", () =>
  ts(`import { renderArticleList } from "${dir}/web/components/ArticleList.ts";
      const a = { id: 1, slug: "a", title: "A", excerpt: "", status: "published", publishedAt: 1000,
        updatedAt: 1000, tags: [], commentCount: 0, readingTime: 4, wordCount: 800 };
      const out = renderArticleList([a]);
      console.log(/min read/.test(out) ? "yes" : "no:" + out);`) === "yes");

// CSS
check("the stylesheet defines .reading-time", () =>
  /\.reading-time\s*\{[^}]*\S[^}]*\}/.test(fs.readFileSync(path.join(dir, "assets/main.css"), "utf8")) || "no rule with declarations");

const passed = results.filter((r) => r.pass).length;
process.stdout.write(JSON.stringify({ passed, total: results.length, regressed, results }, null, 2));
