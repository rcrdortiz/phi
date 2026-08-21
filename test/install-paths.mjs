import * as fs from "node:fs";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

const script = fs.readFileSync(new URL("../get-phi.sh", import.meta.url), "utf8");
const wrapper = fs.readFileSync(new URL("../bin/phi", import.meta.url), "utf8");

// PI_CODING_AGENT_DIR is the agent directory ITSELF. Unset, pi uses ~/.pi/agent,
// so settings are <agentdir>/settings.json and clones <agentdir>/git. Treating
// PHI_HOME as the parent writes a settings file pi never reads and looks for the
// launcher one level too deep, which is exactly what shipped: `phi` was not
// installed and the theme, fullscreen and model defaults were all ignored.
check("get-phi.sh does not nest an agent/ under PHI_HOME",
  !/\$PHI_HOME\/agent/.test(script),
  (script.match(/\$PHI_HOME\/[a-z/]*/g) ?? []).join(", "));
check("settings go to <PHI_HOME>/settings.json",
  /SETTINGS="\$PHI_HOME\/settings\.json"/.test(script));
check("the launcher is looked for under <PHI_HOME>/git",
  /WRAPPER="\$PHI_HOME\/git\//.test(script));
check("bin/phi checks the same settings path",
  /\$PHI_HOME\/settings\.json/.test(wrapper) && !/agent\/settings\.json/.test(wrapper));

// The launcher must not silently fall through to a vanilla pi.
check("bin/phi points pi at PHI_HOME", /export PI_CODING_AGENT_DIR="\$PHI_HOME"/.test(wrapper));
check("bin/phi refuses when pi is absent", /command -v pi/.test(wrapper) && /exit 127/.test(wrapper));

// The path the script links from is the one pi actually clones into.
const repoPath = /WRAPPER="([^"]+)"/.exec(script)?.[1] ?? "";
check("the wrapper path matches the repo layout", repoPath.endsWith("/bin/phi"), repoPath);
check("bin/phi ships and is executable",
  (fs.statSync(new URL("../bin/phi", import.meta.url)).mode & 0o111) !== 0);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
