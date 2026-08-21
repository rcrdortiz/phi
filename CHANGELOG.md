# Changelog

phi replaces itself on the machine it runs on, so "3 commits behind" is not
enough to decide whether to accept an update. This file says what changed and
whether it will alter how your sessions behave.

Versioning is semver, read against the *behaviour of a session*, not against a
public API. phi has no API.

- **major**: an update that needs something from you. A new setting, a
  reinstall, a model rebuild, anything that fails if you just take the update.
- **minor**: new behaviour, or a changed default that alters how sessions run.
  Safe to take, but worth reading first.
- **patch**: fixes and wording. Nothing about how a session runs changes,
  except that something broken stops being broken.

## Unreleased

## 0.2.0 (2026-08-21)

Everything before this was unversioned. The entry is written from `git log`.

**Fixed: compaction reclaimed almost nothing, then the next turn timed out.**
Two separate defects with one symptom. pi keeps `compaction.keepRecentTokens`
of recent messages past a compaction and defaults to 20000, sized for a 128K+
window; on a 64K window that is most of the 28,000 trigger, so a compaction at
31,126 tokens left about 29,500. Separately, the post-compaction baseline was
claimed on the first call *past* the trigger, so it recorded the trigger depth
rather than the depth compaction left behind, deferring the next compaction to
roughly 42,700. Both ended the same way: a prefix-cache miss with more tokens
to re-prefill than the idle timeout allows, reported as `Request timed out`.
The installer now seeds pi's compaction numbers, and the baseline is taken from
a reading below the trigger.

**Changed: the HTTP idle timeout is seeded at 500s, up from pi's 300s.** At the
measured ~120 tok/s prefill that moves the depth a cache miss can survive from
36,000 tokens to 60,000. The cost is that a genuinely hung request takes three
minutes longer to admit it. The compaction trigger deliberately did not move:
it is bounded by decode speed as well, and past 18,000 tokens the model is
already at about a third of its rate.

**Added: an elapsed counter on the working indicator.** A four-minute prefill
and a wedged process look identical behind a spinner.

**Added: `exit` quits.** A bare `exit`, `quit` or `:q` closes pi instead of
being sent to the model to be answered.

**Changed: quitting leaves the terminal as it was found.** pi's
`fullscreenExitOutput` default prints the whole session into the scrollback on
the way out; new installs get `resume-hint`.

**Changed: updates are reported once.** phi checks for a newer pi and a newer
phi in its own boot box and offers to install both. pi's own startup banners
said the same thing again, in a different place, with a command to copy, so the
`phi` command now sets `PI_OFFLINE`.

**Added: the boot box, and a large mark drawn in full blocks.** Half-blocks
stripe on a real terminal, where a cell taller than the glyph leaves a gap
between rows.

## 0.1.0

Initial: the extension set, the local model roster, `get-phi.sh`, and the test
suite.
