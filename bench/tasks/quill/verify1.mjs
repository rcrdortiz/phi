// Phase one: are the three defects fixed, and do the visible suites still pass?
//
// Re-run unchanged after phases two and three, where it becomes the regression
// check: a feature added by breaking a fix is not a feature.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.resolve(process.argv[2] ?? ".");
const results = [];
const check = (name, fn) => {
  try {
    const ok = fn();
    results.push({ name, pass: ok === true, detail: ok === true ? "" : String(ok) });
  } catch (e) {
    results.push({ name, pass: false, detail: (e && e.message || String(e)).split("\n")[0].slice(0, 160) });
  }
};

/** Run a PHP snippet against the repo and return its stdout. */
const php = (code) =>
  execFileSync("php", ["-r", `require '${dir}/bin/seed.php'; ${code}`], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }).trim();

/** Run a TS snippet importing from the repo. */
const ts = (code) => {
  const f = path.join(dir, `.probe-${Math.floor(Math.random() * 1e9)}.mjs`);
  fs.writeFileSync(f, code);
  try {
    return execFileSync(process.execPath, ["--experimental-strip-types", f], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } finally {
    fs.rmSync(f, { force: true });
  }
};

const seeded = `$c = new Quill\\Container(); $c->db()->runScript(file_get_contents('${dir}/db/schema.sql')); $c->db()->runScript(file_get_contents('${dir}/db/seed.sql'));`;

// DEFECT 1: the listing INNER JOINs article_tags, so an article with no tags
// vanishes. The method's own comment says a tag join filters, it does not decide
// which articles exist.
check("an untagged article appears in the listing", () =>
  php(`${seeded} $a = $c->articles()->matching(Quill\\Query\\Criteria::published(), new Quill\\Query\\Paginator(1, 50));
       $slugs = array_map(fn($x) => $x->slug->value, $a);
       echo in_array('on-cards', $slugs) ? 'yes' : 'no:'.implode(',', $slugs);`) === "yes");

check("the listing returns every published, undeleted article", () =>
  php(`${seeded} $a = $c->articles()->matching(Quill\\Query\\Criteria::published(), new Quill\\Query\\Paginator(1, 50));
       echo count($a);`) === "4");

check("an article is not duplicated by its tags", () =>
  php(`${seeded} $a = $c->articles()->matching(Quill\\Query\\Criteria::published(), new Quill\\Query\\Paginator(1, 50));
       $slugs = array_map(fn($x) => $x->slug->value, $a);
       echo count($slugs) === count(array_unique($slugs)) ? 'unique' : 'dupes:'.implode(',', $slugs);`) === "unique");

check("filtering by tag still filters", () =>
  php(`${seeded} $a = $c->articles()->matching(Quill\\Query\\Criteria::published()->withTag('design'), new Quill\\Query\\Paginator(1, 50));
       echo implode(',', array_map(fn($x) => $x->slug->value, $a));`) === "on-compilers");

// DEFECT 2: pages are documented as 1-based, and Paginator::offset() multiplies
// the page straight through, so page 1 skips the first page of results. Neither
// the controller nor the paginator is wrong alone.
check("the first page starts at the beginning", () =>
  php(`echo (new Quill\\Query\\Paginator(1, 10))->offset();`) === "0");

check("the second page skips exactly one page", () =>
  php(`echo (new Quill\\Query\\Paginator(2, 10))->offset();`) === "10");

// The fix has to reach the places that never mention pagination.
//
// FeedController and FeedService both build `new Paginator(1, N)` and never
// think about pages: the docblock says "always the newest articles, never
// paginated past the first page". With the offset defect that skips N rows, so
// the feed comes back completely empty, and nothing in the visible suites or
// the task points at the feed at all.
//
// Added after a run scored 14/14 and its own audit noted the consequence
// unaided: "FeedController.feed ... Now correct (pre-fix skipped first 20)."
// A fix judged only at the site it was made is judged too narrowly, and every
// other run had been getting credit without this ever being checked.
check("the feed is not emptied by the paging fix", () =>
  php(`${seeded} echo count($c->articles()->matching(Quill\\Query\\Criteria::published(), new Quill\\Query\\Paginator(1, 20), Quill\\Query\\SortOrder::newest()));`) !== "0"
    || "the feed fetches nothing: Paginator(1, N) is still skipping a page");

check("page 1 of the listing is not empty", () =>
  php(`${seeded} $res = $c->router()->dispatch(Quill\\Http\\Request::get('/articles', ['page' => 1, 'per_page' => 2]));
       echo substr_count($res->body, 'class="card"');`) === "2");

// DEFECT 3: newestFirst's comparator returns a boolean, which Array.sort
// coerces to 0 or 1 and never negative, so nothing is reordered.
check("newestFirst actually sorts", () =>
  ts(`import { newestFirst } from "${dir}/web/state/selectors.ts";
      const a = (id, when) => ({ id, slug: "s"+id, title: "t", excerpt: "", status: "published",
        publishedAt: when, updatedAt: when, tags: [], commentCount: 0 });
      console.log(newestFirst([a(1,1000), a(2,3000), a(3,2000)]).map(x => x.publishedAt).join(","));`) === "3000,2000,1000");

check("newestFirst falls back to updatedAt for drafts", () =>
  ts(`import { newestFirst } from "${dir}/web/state/selectors.ts";
      const a = (id, pub, upd) => ({ id, slug: "s"+id, title: "t", excerpt: "", status: "draft",
        publishedAt: pub, updatedAt: upd, tags: [], commentCount: 0 });
      console.log(newestFirst([a(1,null,500), a(2,null,900)]).map(x => x.id).join(","));`) === "2,1");

check("newestFirst does not mutate its input", () =>
  ts(`import { newestFirst } from "${dir}/web/state/selectors.ts";
      const a = (id, when) => ({ id, slug: "s"+id, title: "t", excerpt: "", status: "published",
        publishedAt: when, updatedAt: when, tags: [], commentCount: 0 });
      const input = [a(1,1000), a(2,3000)];
      newestFirst(input);
      console.log(input.map(x => x.id).join(","));`) === "1,2");

// The visible suites, unchanged.
check("the PHP suite passes", () => {
  try { execFileSync("php", ["test/run.php"], { cwd: dir, encoding: "utf8", timeout: 60000 }); return true; }
  catch (e) { return (e.stdout ?? "").split("\n").filter((l) => l.startsWith("FAIL")).join("; ") || "failed"; }
});
check("the TypeScript suite passes", () => {
  try { execFileSync(process.execPath, ["--experimental-strip-types", "test/run.ts"], { cwd: dir, encoding: "utf8", timeout: 60000 }); return true; }
  catch (e) { return (e.stdout ?? "").split("\n").filter((l) => l.startsWith("FAIL")).join("; ") || "failed"; }
});

// And the suites must not have been edited into agreement.
const here = path.dirname(new URL(import.meta.url).pathname);
for (const f of ["test/run.php", "test/run.ts"]) {
  check(`${f} was not modified`, () => {
    const want = fs.readFileSync(path.join(here, "hashes", path.basename(f) + ".sha"), "utf8").trim();
    const got = execFileSync("shasum", ["-a", "256", path.join(dir, f)], { encoding: "utf8" }).split(" ")[0];
    return got === want || `${f} was edited`;
  });
}

const passed = results.filter((r) => r.pass).length;
process.stdout.write(JSON.stringify({ passed, total: results.length, results }, null, 2));
