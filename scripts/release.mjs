// Cut a release: bump package.json, date the changelog, commit, tag.
//
// Version discipline exists here for one reason: phi replaces itself on the
// machine it runs on. "3 commits behind" tells a user nothing about whether the
// update is a typo fix or a changed default that will alter how their sessions
// compact. A version and a changelog entry do.
//
//   npm run release -- patch|minor|major [--dry]
//
// No dependencies, and no network: it stops at the tag. Pushing is deliberate
// and separate, because a tag pushed by accident is awkward to withdraw.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" }).trim();
const die = (msg) => { console.error(`release: ${msg}`); process.exit(1); };

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const kind = args.find((a) => ["patch", "minor", "major"].includes(a));
if (!kind) die("say which: patch, minor or major");

// A release has to describe a known tree. Bumping on top of uncommitted work
// produces a tag whose contents nobody can reconstruct.
if (!dry && run("git", ["status", "--porcelain"])) die("working tree is dirty; commit or stash first");

const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);
if ([maj, min, pat].some((n) => !Number.isFinite(n))) die(`cannot parse version ${pkg.version}`);
const next = kind === "major" ? `${maj + 1}.0.0` : kind === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;

const clPath = path.join(ROOT, "CHANGELOG.md");
const changelog = readFileSync(clPath, "utf8");
const UNRELEASED = "## Unreleased\n";
if (!changelog.includes(UNRELEASED)) die("CHANGELOG.md has no ## Unreleased section");
const body = changelog.split(UNRELEASED)[1].split("\n## ")[0].trim();
if (!body) die("nothing under ## Unreleased; a release with no entry is a release nobody can read");

const today = new Date().toISOString().slice(0, 10);
const dated = changelog.replace(UNRELEASED, `${UNRELEASED}\n## ${next} (${today})\n`);

console.log(`${pkg.version} -> ${next}\n\n${body}\n`);
if (dry) { console.log("(dry run, nothing written)"); process.exit(0); }

pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(clPath, dated);
run("git", ["add", "package.json", "CHANGELOG.md"]);
run("git", ["commit", "-m", `release: ${next}`]);
run("git", ["tag", "-a", `v${next}`, "-m", `${next}\n\n${body}`]);
console.log(`tagged v${next}. push with: git push origin master --follow-tags`);
