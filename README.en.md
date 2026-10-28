# dsh-hotkey-enhance

Desktop keyboard enhancement for DSH — a **Codex-style session switcher** (hold `Ctrl`, tap `Tab`, release to
commit) plus the desktop keymap that DSH 2.0.18 never applies.

> **DSH Desktop only.** Every combination this plugin binds (`Ctrl+Tab`, `⌘N`, `⌘W`, `⌘D`, `⌘B`, `⌘,`) belongs
> to the browser outside Electron: `Ctrl+Tab` switches tabs, `⌘N` opens a window, `⌘W` closes a tab, `⌘D` adds a
> bookmark. The plugin therefore **installs no listener at all** outside the Desktop shell — loading it in a
> plain browser is a no-op, and it will not steal those keys. In a browser it would conflict with the browser.

## Why this exists

After moving from Codex to DSH, the thing I missed most was the **feel of switching sessions**: in Codex you hold
`Ctrl`, tap `Tab`, a list of recent sessions appears, and the switch happens when you let go. DSH has no such
thing — and DSH Desktop 2.0.18 never applies its own desktop keymap (see below), so even `⌘N` does nothing.

This plugin fills exactly those two gaps, and nothing else.

## Keys

| macOS | Action |
|---|---|
| `⌘N` | New session |
| `⌘W` | Close the current session, back to the session list |
| `⌘⇧W` | Same, fallback when the native File menu owns `⌘W` |
| `⌘D` | Pin / unpin the current session |
| `⌘B` | Toggle the left sidebar |
| `⌘,` | Open settings |
| `Ctrl+Tab` | Open the recent-session overlay; each tap moves the highlight |
| `Ctrl+Shift+Tab` | Same, reverse (starts on the oldest entry) |

All eight are remappable in **Settings → General → Session shortcuts** (record, per-item reset, reset all).
On Windows/Linux `⌘` becomes `Ctrl`.

### The session switcher

```
┌────────────────────────────────┐
│ Recent sessions                │
│   Current session   Current 1m │   ← the real current session
│ ▸ Two minutes ago            2m │   ← highlighted row starts on "next"
│   An hour ago                 1h │
│                                │
│ Release ⌃ to switch · Tab keeps │
│ moving · Esc cancels            │
└────────────────────────────────┘
```

| Action | Result |
|---|---|
| `Ctrl+Tab` | Opens the overlay, highlight on the next session |
| **Release `Tab` (Ctrl still held)** | **Overlay stays** — `Tab` is a repeatable "next" button |
| Tap `Tab` again | Highlight moves one row; wraps at the end |
| Hold `Tab` | Auto-repeat walks the list |
| **Release `Ctrl`** | **Commits**: switches to the highlighted session and closes the overlay |
| `Esc` | Cancels without switching |
| Window blur / hidden / 30s with no events | Cancels (safety net only) |

## Why it bypasses the DSH shortcut registry

DSH Desktop 2.0.18 runs its client in **`web` runtime**:

- `dsh-client-shortcuts` derives the runtime from `document.documentElement.dataset.platform`, but **nothing in
  the installation ever sets that attribute** and the preload exposes no `dshDesktop.keyboard` bridge. So every
  `desktop:*` default is dead, and the effective keymap is the `web:*` one (`⌘⌥N`, `⌘⌥K`, …).
- `isWebBindingAllowed()` then **rejects** every browser-reserved combination in `web` runtime: `⌘N`, `⌘W`,
  `⌘D`, `Ctrl+Tab` all throw `Unsupported Web shortcut` at registration time.

The plugin therefore matches chords directly on `keydown`/`keyup` (the same approach other DSH shortcut plugins
take). Consequences, stated up front:

- These eight keys **do not appear in the native shortcut list** — they live in this plugin's own card.
- There is no registry conflict detection, so the card checks the registry catalog itself and **rejects a chord
  a built-in command already owns**, naming the owner.
- `⌘B` and `⌘,` deliberately yield to the registry when DSH runs in `desktop` runtime, so the day upstream fixes
  the runtime these two hand themselves back instead of double-firing.

## Install

```bash
dsh plugin --profile desktop add dsh-hotkey-enhance
```

Or from source:

```bash
dsh plugin --profile desktop add /path/to/dsh-hotkey-enhance
```

Then restart DSH Desktop. Settings → General → Session shortcuts should show eight rows.

## Tests

62 offline assertions against a fake DOM, fake React and fake cordis context — key mapping, candidate
filtering (blank / archived / subagent), the overlay state machine, recording, conflict refusal, persistence
across reloads, and both degradation paths (missing React seed, non-Electron host):

```bash
pnpm test        # or: node tests/hotkey-enhance.test.mjs
```

## Limitations

- **DSH Desktop only**, verified on 2.0.18 / macOS. Windows is untested.
- The switcher lists at most 9 sessions ordered by `updatedAt`; there is no search. The sidebar's real order is
  computed in `ui-workspace`'s React layer and is not exposed as a service, so `⌘1..9` is not implemented.
- Bindings persist in `localStorage` (`dsh.sessionkeys.bindings.v1`), not in the profile config — they do not
  sync across machines and cannot be read from a CLI.
- Depends on a few internal service methods (`clearMain`, `pinSession`, `toggleSidebar`) and on replaying
  `settings.open` through a synthetic `keydown`; a DSH upgrade can break those. The plugin is built to fail
  soft: three layers of guards mean a broken surface logs and degrades instead of blocking renderer boot.

## License

MIT
