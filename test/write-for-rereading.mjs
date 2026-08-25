// This is charged on every turn, so its size matters as much as its content.
// It is also an experiment: the claim is that stating what a reader would
// re-derive reduces deliberation, and deliberation is ~74% of output tokens.
import { GUIDANCE } from "../extensions/write-for-rereading.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

const words = GUIDANCE.split(/\s+/).length;
check("stays short enough to charge every turn", words < 160, `${words} words, roughly ${Math.round(words * 1.4)} tokens per turn`);
check("targets re-derivation, not token count", /re-derive/.test(GUIDANCE),
  "the cost is deliberation, not the bytes read");
check("says why over what", /Say why, not what/.test(GUIDANCE));
check("covers code that looks wrong but is not", /looks wrong but is right/.test(GUIDANCE),
  "otherwise it is re-investigated on every single read");
check("covers dead ends", /tried and failed/.test(GUIDANCE));
check("covers units in names", /timeoutMs/.test(GUIDANCE));
check("covers invariants at the point of assumption", /where it is assumed/.test(GUIDANCE));
// The failure mode of the whole idea: comments that rot mislead, which costs
// the deliberation AND sends it the wrong way.
check("warns that a stale comment is worse than none", /stale comment costs more/.test(GUIDANCE));
check("forbids restating the code", /never restate code/.test(GUIDANCE));

// Off switch, so the A/B is possible at all.
{
  process.env.PHI_WRITE_GUIDANCE = "0";
  const off = {};
  const fresh = await import("../extensions/write-for-rereading.ts?off");
  fresh.default({ on: (e, h) => (off[e] = h), registerTool: () => {}, registerCommand: () => {} });
  check("PHI_WRITE_GUIDANCE=0 injects nothing", off["before_agent_start"] === undefined,
    "an unmeasurable experiment is not worth charging for");
  delete process.env.PHI_WRITE_GUIDANCE;
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
