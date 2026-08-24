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
// The fallback, used only when `pi list` cannot be read, still has to name the
// file that actually ships.
const fallback = /\|\| WRAPPER="([^"]+)"/.exec(script)?.[1] ?? "";
check("the fallback path matches the repo layout", fallback.endsWith("/bin/phi"), fallback);
check("bin/phi ships and is executable",
  (fs.statSync(new URL("../bin/phi", import.meta.url)).mode & 0o111) !== 0);

// The launcher location comes from pi, not from a reconstructed path. Guessing
// it is what shipped broken: the step looked one directory too deep, warned,
// and the warning was lost in the install output.
check("the launcher path is read from `pi list`", /pi list .*awk/s.test(script),
  "the layout belongs to pi, so pi is asked where the package went");
check("a reconstructed path remains only as a fallback",
  /\[ -n "\$WRAPPER" \] \|\| WRAPPER=/.test(script));

// A link that was not created must not be reported as though it were.
check("the link is verified before it is announced",
  /if ln -sf .* && \[ -x "\$BINDIR\/phi" \]; then/.test(script), "ok only after the link exists and is executable");
check("a failed link warns with what to run instead",
  /could not link .*PI_CODING_AGENT_DIR=/.test(script));
check("the shell command cache is cleared before verifying",
  /hash -r/.test(script), "a brand new link is invisible to the running shell otherwise");

// One place reports updates. Two banners saying the same thing in different
// words, one of them telling you to run a command by hand, is what this
// silences, and the update commands have to opt back in or they no-op.
const boot = fs.readFileSync(new URL("../extensions/boot-screen.ts", import.meta.url), "utf8");
check("the wrapper puts pi's own update banners away",
  /export PI_OFFLINE=/.test(wrapper), "the boot box is the only place updates are reported");
check("the wrapper still lets PI_OFFLINE be overridden",
  /PI_OFFLINE="\$\{PI_OFFLINE:-1\}"/.test(wrapper));
check("update commands drop the flag again",
  /delete env\.PI_OFFLINE/.test(boot) && /env: online\(\)/.test(boot),
  "`pi update` under PI_OFFLINE succeeds and does nothing, which looks like success");

// Quitting should hand the terminal back the way it was found. pi's default
// prints the whole session into the scrollback on the way out.
check("exiting fullscreen leaves the scrollback alone",
  /"fullscreenExitOutput", "resume-hint"/.test(script),
  "the default, \"transcript\", dumps the boot box and every tool call");

// The installer has to write compaction.keepRecentTokens, because pi reads it
// from settings.json and nothing else can change it: CompactOptions has no
// per-call override. Left unset, pi keeps 20000 on a 64K window and compaction
// reclaims almost nothing.
check("the installer seeds pi's compaction numbers",
  /"compaction", \{"keepRecentTokens": 6000/.test(script),
  "pi's 20000 default is sized for a 128K window");

// `pi -v` prints pi's version, which under this name is the wrong answer.
// --version never starts a session, so pi prints and exits before any extension
// loads: the wrapper is the only place this can be answered.
check("the wrapper answers -v itself", /-v\|--version\)/.test(wrapper));
check("it reports phi's version", /echo "phi /.test(wrapper));
check("and pi's alongside it", /echo "pi /.test(wrapper),
  "almost everything phi does is constrained by the pi underneath it");
check("the version is read from package.json, not carried in the wrapper",
  /package\.json/.test(wrapper) && !/phi 0\.\d+\.\d+/.test(wrapper),
  "a second copy is a second thing to forget on release");
check("an unreadable version says so rather than printing nothing",
  /:-unknown/.test(wrapper));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
