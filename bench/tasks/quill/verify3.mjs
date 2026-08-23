// Phase three: a new output format, and whether it went in through the seam.
//
// The architecture measurement is here, and it is deliberately not diff size,
// which was measured on a smaller task and did not discriminate at all. It is:
// did a new class implement the existing interface and register itself, or did
// conditionals appear in the classes that were already there?
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
const php = (code) => execFileSync("php", ["-r", `require '${dir}/bin/seed.php'; ${code}`],
  { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }).trim();
const seeded = `$c = new Quill\\Container(); $c->db()->runScript(file_get_contents('${dir}/db/schema.sql')); $c->db()->runScript(file_get_contents('${dir}/db/seed.sql'));`;

// Regression: what the earlier phases had working must still work.
//
// Measured against a baseline written before this phase ran, not against a
// perfect score. Counting every failing earlier check as a regression makes a
// defect that was never fixed look like damage the new work caused: a tree at
// 12/14 on phase one reported 2 regressions before anything had been edited.
// A regression is something that passed and then stopped.
//
// With no baseline on disk, nothing can be said about what changed, so this
// reports null rather than inventing a number.
let regressed = null;
try {
  const prior = JSON.parse(execFileSync(process.execPath, [path.join(here, "verify2.mjs"), dir],
    { encoding: "utf8", timeout: 300000, stdio: ["ignore", "pipe", "ignore"] }));
  for (const r of prior.results) results.push({ ...r, name: `earlier still: ${r.name}` });
  const basePath = path.join(dir, ".bench-baseline-2.json");
  if (fs.existsSync(basePath)) {
    const was = new Map(JSON.parse(fs.readFileSync(basePath, "utf8")).map((r) => [r.name, r.pass]));
    regressed = prior.results.filter((r) => was.get(r.name) === true && !r.pass).length;
  }
} catch (e) {
  results.push({ name: "earlier phases still pass", pass: false, detail: (e && e.message) || String(e) });
  regressed = 1;
}

// The format exists and is reachable the same way every other format is.
check("the registry knows jsonfeed", () =>
  php(`${seeded} echo in_array('jsonfeed', $c->renderers()->names(), true) ? 'yes' : 'no:'.implode(',', $c->renderers()->names());`) === "yes");
check("it declares the right content type", () =>
  php(`${seeded} echo $c->renderers()->get('jsonfeed')->contentType();`).includes("application/feed+json") || "wrong content type");
check("FeedService can render it", () =>
  php(`${seeded} $out = $c->feed()->render('jsonfeed'); echo json_decode($out) === null ? 'not json' : 'json';`) === "json");
check("the route serves it", () =>
  php(`${seeded} $res = $c->router()->dispatch(Quill\\Http\\Request::get('/articles', ['format' => 'jsonfeed']));
       echo $res->isOk() && json_decode($res->body) !== null ? 'yes' : 'no:'.$res->status;`) === "yes");

// The shape.
const feed = () => JSON.parse(php(`${seeded} echo $c->feed()->render('jsonfeed');`));
check("the feed declares its version", () => feed().version === "https://jsonfeed.org/version/1.1" || "wrong version");
check("items carry id, url, title and content", () => {
  const i = feed().items[0];
  return (typeof i.id === "string" && i.url === `/a/${i.id}` && typeof i.title === "string" && typeof i.content_text === "string")
    || JSON.stringify(i).slice(0, 120);
});
check("dates are ISO 8601", () => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(feed().items[0].date_published) || "not ISO");
check("items are newest first", () => {
  const d = feed().items.map((i) => i.date_published);
  return [...d].sort().reverse().join() === d.join() || d.join();
});
check("an untagged article omits tags entirely", () =>
  php(`${seeded} $a = $c->articles()->findBySlug('on-cards');
       $j = json_decode($c->renderers()->get('jsonfeed')->render($a), true);
       $item = $j['items'][0];
       echo array_key_exists('tags', $item) ? 'present' : 'absent';`) === "absent");
check("a tagged article lists its tag names", () =>
  php(`${seeded} $a = $c->articles()->findBySlug('on-compilers');
       $j = json_decode($c->renderers()->get('jsonfeed')->render($a), true);
       echo implode(',', $j['items'][0]['tags']);`).split(",").sort().join(",") === "Design,Engineering");
check("an unpublished article omits date_published", () =>
  php(`${seeded} $a = $c->articles()->findById(4);
       $j = json_decode($c->renderers()->get('jsonfeed')->render($a), true);
       echo array_key_exists('date_published', $j['items'][0]) ? 'present' : 'absent';`) === "absent");
check("a single article renders one item", () =>
  php(`${seeded} $a = $c->articles()->findBySlug('on-loops');
       $j = json_decode($c->renderers()->get('jsonfeed')->render($a), true);
       echo count($j['items']);`) === "1");

// --- architecture ----------------------------------------------------------
check("it went in as a new class implementing the interface", () => {
  const files = fs.readdirSync(path.join(dir, "src/Rendering"));
  const added = files.filter((f) => !["RendererInterface.php","RendererRegistry.php","HtmlRenderer.php","MarkdownRenderer.php","PlainTextRenderer.php"].includes(f));
  if (added.length === 0) return "no new renderer file; the format was bolted onto an existing class";
  const src = added.map((f) => fs.readFileSync(path.join(dir, "src/Rendering", f), "utf8")).join("\n");
  return /implements\s+RendererInterface/.test(src) || `new file(s) ${added.join(",")} do not implement RendererInterface`;
});
check("the existing renderers do not know the new format exists", () => {
  // Not a hash of the files: phase two legitimately edits HtmlRenderer, and
  // comparing against a pre-phase-two snapshot would fail an honest run. What
  // matters is whether they changed BECAUSE of this format.
  const named = ["HtmlRenderer.php", "MarkdownRenderer.php", "PlainTextRenderer.php"].filter((f) =>
    /jsonfeed|json_feed|feed\+json/i.test(fs.readFileSync(path.join(dir, "src/Rendering", f), "utf8")));
  return named.length === 0 || `${named.join(", ")} mentions the new format`;
});
check("the registry was not special-cased for it", () => {
  const src = fs.readFileSync(path.join(dir, "src/Rendering/RendererRegistry.php"), "utf8");
  return !/jsonfeed/i.test(src) || "the registry names the format directly";
});
check("no format switch appeared in the controllers", () => {
  const src = ["ArticleController.php", "FeedController.php", "Controller.php"]
    .map((f) => fs.readFileSync(path.join(dir, "src/Http", f), "utf8")).join("\n");
  return !/jsonfeed/i.test(src) || "a controller names the format directly";
});

const passed = results.filter((r) => r.pass).length;
process.stdout.write(JSON.stringify({ passed, total: results.length, regressed, results }, null, 2));
