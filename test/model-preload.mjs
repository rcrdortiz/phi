// The load half of this extension is covered by using it; the release half is
// the dangerous one. Unloading while another session is mid-turn costs that
// session a full reload, so the guard is what needs asserting.
import { shouldRelease, residentBytes, release } from "../extensions/model-preload.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

check("releases when we are the last session", shouldRelease(0) === true);
check("holds when another session is live", shouldRelease(1) === false,
  "evicting a model another session is using costs it a reload mid-turn");
check("holds when several others are live", shouldRelease(4) === false);
// The whole point of otherSessions returning undefined rather than 0.
check("holds when it could not tell", shouldRelease(undefined) === false,
  "an unreadable process list is not evidence of an empty one");
check("PHI_RELEASE_ON_EXIT=0 holds even when alone", shouldRelease(0, false) === false);

// --- the network calls degrade rather than throw --------------------------
const dead = "http://127.0.0.1:9";
check("residentBytes reports undefined when Ollama is unreachable",
  (await residentBytes("m", dead)) === undefined);
check("release reports false rather than throwing", (await release("m", dead)) === false,
  "a failed release must not take the exit down with it");

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
