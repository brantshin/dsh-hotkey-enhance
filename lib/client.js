/**
 * dsh-hotkey-enhance — desktop keyboard enhancement for DSH.
 *
 * Why a raw keydown listener instead of `ctx.shortcuts.register`:
 *
 * DSH Desktop 2.0.18 never sets `document.documentElement.dataset.platform` and
 * its preload exposes no `dshDesktop.keyboard` bridge, so the client runs in
 * `web` runtime. There `isWebBindingAllowed()` rejects every browser-reserved
 * combination — `Cmd+N`, `Cmd+W`, `Cmd+D`, `Ctrl+Tab` — so the shortcut registry
 * cannot carry these bindings at all. The registry is bypassed and the
 * combinations are matched directly, which is what community shortcut plugins do.
 *
 * Two surfaces:
 *   1. Bindings, editable in 设置 → 通用 → 会话快捷键 (localStorage).
 *   2. A hold-to-preview switcher: pressing Ctrl+Tab opens a floating list of
 *      recent sessions; Tab moves the highlight, releasing Tab commits.
 *
 * Defaults (macOS; Windows/Linux swap Meta for Ctrl):
 *   Meta+N         new session
 *   Meta+W         close current session, back to the list
 *   Meta+Shift+W   same (the native File menu may own Meta+W)
 *   Meta+D         pin / unpin the current session
 *   Ctrl+Tab       preview / advance the recent-session switcher
 *   Ctrl+Shift+Tab preview / advance it backwards
 */
window.__ModuleLoader__.load({
  id: "@brantshi1/dsh-hotkey-enhance",
  factory(require) {
    // A missing seed must degrade to "keyboard only", never to a dead renderer.
    let React;
    let h;
    try {
      React = require("react");
      h = React.createElement;
    } catch (error) {
      console.error("[dsh-hotkey-enhance] FAILED react seed:", error?.stack ?? String(error));
    }

    // Diagnostics are off by default: every handled key would otherwise land in
    // the Desktop renderer error log. Flip to true when debugging bindings.
    const DEBUG = false;
    const log = (...parts) => {
      if (DEBUG) console.error("[dsh-hotkey-enhance]", ...parts);
    };
    /** Always-on diagnostic: a boot-blocking failure must leave a readable trace. */
    const fail = (...parts) => {
      console.error("[dsh-hotkey-enhance] FAILED", ...parts);
    };

    // Kept from the first release on purpose: renaming it would silently drop
    // the bindings people already recorded.
    const STORAGE_KEY = "dsh.sessionkeys.bindings.v1";
    const SWITCHER_LIMIT = 9;
    // Safety net only: the overlay normally lives until Control is released, so
    // this must be long enough to never interrupt a held-Control decision.
    const SWITCHER_WATCHDOG_MS = 30_000;

    const isMac = /darwin|mac/i.test(
      String(globalThis.navigator?.platform ?? globalThis.navigator?.userAgent ?? ""),
    );
    const PRIMARY = isMac ? "Meta" : "Ctrl";

    /**
     * Canonical modifier order for both persistence and rendering. It must match
     * the order the default chords are written in (`Meta+Shift+KeyW`), otherwise
     * a recorded chord would never equal a default and duplicate detection would
     * compare unequal strings for the same physical combination.
     */
    const MODIFIERS = ["Ctrl", "Meta", "Alt", "Shift"];

    const ACTIONS = [
      {
        id: "new",
        label: { zh: "新建会话", en: "New session" },
        defaultChord: `${PRIMARY}+KeyN`,
      },
      {
        id: "close",
        label: { zh: "关闭当前会话", en: "Close current session" },
        defaultChord: `${PRIMARY}+KeyW`,
      },
      {
        id: "closeFallback",
        label: { zh: "关闭当前会话（备用键）", en: "Close current session (fallback)" },
        defaultChord: `${PRIMARY}+Shift+KeyW`,
      },
      {
        id: "pin",
        label: { zh: "置顶／取消置顶当前会话", en: "Pin or unpin the session" },
        defaultChord: `${PRIMARY}+KeyD`,
      },
      {
        id: "cycle",
        label: { zh: "最近会话浮窗（下一个）", en: "Recent-session switcher (next)" },
        defaultChord: "Ctrl+Tab",
      },
      {
        id: "cyclePrev",
        label: { zh: "最近会话浮窗（上一个）", en: "Recent-session switcher (previous)" },
        defaultChord: "Ctrl+Shift+Tab",
      },
      {
        id: "sidebarLeft",
        label: { zh: "收起／展开左侧栏", en: "Toggle the left sidebar" },
        defaultChord: `${PRIMARY}+KeyB`,
      },
      {
        id: "settings",
        label: { zh: "打开设置", en: "Open settings" },
        defaultChord: `${PRIMARY}+Comma`,
      },
    ];

    /** Chord modifier names → the registry's normalized names. */
    const MODIFIER_NAMES = { Ctrl: "control", Alt: "alt", Shift: "shift", Meta: "meta" };

    const defaultBindings = () =>
      Object.fromEntries(ACTIONS.map((action) => [action.id, action.defaultChord]));

    const preferChinese = () =>
      !String(globalThis.navigator?.language ?? "en").toLowerCase().startsWith("en");
    const text = (pair) => (preferChinese() ? pair.zh : pair.en);

    // ---- chord vocabulary -------------------------------------------------
    const CODE_LABELS = {
      Tab: "Tab",
      Enter: "Enter",
      Escape: "Esc",
      Space: "Space",
      Backspace: "Backspace",
      Delete: "Delete",
      ArrowUp: "↑",
      ArrowDown: "↓",
      ArrowLeft: "←",
      ArrowRight: "→",
      Slash: "/",
      Comma: ",",
      Period: ".",
      Backslash: "\\",
      Backquote: "`",
      Minus: "-",
      Equal: "=",
      BracketLeft: "[",
      BracketRight: "]",
      Semicolon: ";",
      Quote: "'",
    };

    const codeLabel = (code) => CODE_LABELS[code] ?? code.replace(/^(Key|Digit|Numpad)/, "");

    /** Build a canonical chord from a DOM event, or null when unusable. */
    const chordOf = (event) => {
      const code = typeof event.code === "string" ? event.code : "";
      const usableCode = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(code)
        || Object.hasOwn(CODE_LABELS, code);
      if (!usableCode) return null;
      const parts = [];
      for (const name of MODIFIERS) {
        const held = name === "Ctrl" ? event.ctrlKey
          : name === "Meta" ? event.metaKey
            : name === "Alt" ? event.altKey
              : event.shiftKey;
        if (held) parts.push(name);
      }
      return [...parts, code].join("+");
    };

    const parseChord = (chord) => {
      const parts = String(chord).split("+");
      const code = parts.pop();
      return { code, modifiers: new Set(parts) };
    };

    const formatChord = (chord) => {
      const { code, modifiers } = parseChord(chord);
      const symbols = isMac
        ? { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" }
        : { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Meta" };
      return [
        ...MODIFIERS.filter((name) => modifiers.has(name)).map((name) => symbols[name]),
        codeLabel(code),
      ].join(isMac ? "" : "+");
    };

    /** A binding must carry at least one non-Shift modifier and exactly one key. */
    const chordProblem = (chord) => {
      if (typeof chord !== "string" || chord.length === 0) return "empty";
      const { modifiers } = parseChord(chord);
      const strong = ["Ctrl", "Alt", "Meta"].some((name) => modifiers.has(name));
      return strong ? null : "weak";
    };

    const matchesChord = (chord, event) => {
      const { code, modifiers } = parseChord(chord);
      return (
        event.code === code
        && Boolean(event.ctrlKey) === modifiers.has("Ctrl")
        && Boolean(event.altKey) === modifiers.has("Alt")
        && Boolean(event.shiftKey) === modifiers.has("Shift")
        && Boolean(event.metaKey) === modifiers.has("Meta")
      );
    };

    /** Compare one of our chords with a normalized registry binding. */
    const chordMatchesBinding = (chord, binding) => {
      if (binding === null || binding === undefined) return false;
      if (binding.secondCode !== undefined) return false;
      const { code, modifiers } = parseChord(chord);
      const expected = MODIFIERS
        .filter((name) => modifiers.has(name))
        .map((name) => MODIFIER_NAMES[name]);
      const actual = [...binding.modifiers];
      return binding.code === code
        && expected.length === actual.length
        && expected.every((name) => actual.includes(name));
    };

    /** Actions the registry also carries; only the web runtime replays them. */
    const DESKTOP_ACTIONS = new Set(["sidebarLeft", "settings"]);

    const relativeTime = (updatedAt) => {
      const elapsed = Date.now() - Number(updatedAt ?? 0);
      if (!Number.isFinite(elapsed) || elapsed < 0) return "";
      const minute = 60_000;
      const hour = 60 * minute;
      const day = 24 * hour;
      if (elapsed < minute) return text({ zh: "刚刚", en: "now" });
      if (elapsed < hour) {
        const n = Math.floor(elapsed / minute);
        return text({ zh: `${n} 分钟前`, en: `${n}m` });
      }
      if (elapsed < day) {
        const n = Math.floor(elapsed / hour);
        return text({ zh: `${n} 小时前`, en: `${n}h` });
      }
      const n = Math.floor(elapsed / day);
      return text({ zh: `${n} 天前`, en: `${n}d` });
    };

    // ---- binding store ----------------------------------------------------
    const readStored = () => {
      try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
        if (raw === null || raw === undefined) return defaultBindings();
        const parsed = JSON.parse(raw);
        const stored = parsed?.bindings;
        if (typeof stored !== "object" || stored === null) return defaultBindings();
        const result = defaultBindings();
        for (const action of ACTIONS) {
          const value = stored[action.id];
          if (typeof value === "string" && chordProblem(value) === null) result[action.id] = value;
        }
        return result;
      } catch {
        return defaultBindings();
      }
    };

    const writeStored = (bindings) => {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, bindings }));
        return true;
      } catch (error) {
        log("persist failed", String(error));
        return false;
      }
    };

    const createBindingsStore = () => {
      let snapshot = { bindings: readStored(), recording: null, message: "", error: "" };
      /** Injected by apply(): returns a registry command id that owns the chord. */
      let conflictProbe = () => null;
      const listeners = new Set();
      const publish = (changes) => {
        snapshot = { ...snapshot, ...changes };
        for (const listener of listeners) listener();
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        setConflictProbe(probe) {
          conflictProbe = probe;
        },
        startRecording(actionId) {
          publish({ recording: actionId, message: "", error: "" });
        },
        stopRecording() {
          if (snapshot.recording === null) return;
          publish({ recording: null });
        },
        /** @returns whether the chord was accepted. */
        assign(actionId, chord) {
          const problem = chordProblem(chord);
          if (problem !== null) {
            publish({
              error: text({
                zh: "需要至少一个 Ctrl／Alt／⌘ 修饰键。",
                en: "A Ctrl/Alt/⌘ modifier is required.",
              }),
            });
            return false;
          }
          const clash = ACTIONS.find(
            (action) => action.id !== actionId && snapshot.bindings[action.id] === chord,
          );
          if (clash !== undefined) {
            publish({
              error: text({
                zh: `该组合已被「${clash.label.zh}」占用。`,
                en: `Already used by “${clash.label.en}”.`,
              }),
            });
            return false;
          }
          const reserved = conflictProbe(chord);
          if (reserved !== null) {
            publish({
              error: text({
                zh: `该组合已被 DSH 内置命令占用（${reserved}）。`,
                en: `Reserved by a built-in DSH command (${reserved}).`,
              }),
            });
            return false;
          }
          const bindings = { ...snapshot.bindings, [actionId]: chord };
          if (!writeStored(bindings)) {
            publish({
              error: text({ zh: "保存失败：本地存储不可用。", en: "Save failed: local storage unavailable." }),
            });
            return false;
          }
          publish({ bindings, recording: null, error: "", message: text({ zh: "已保存。", en: "Saved." }) });
          return true;
        },
        reset(actionId) {
          this.assign(actionId, ACTIONS.find((action) => action.id === actionId).defaultChord);
        },
        resetAll() {
          const bindings = defaultBindings();
          if (!writeStored(bindings)) {
            publish({
              error: text({ zh: "保存失败：本地存储不可用。", en: "Save failed: local storage unavailable." }),
            });
            return;
          }
          publish({ bindings, recording: null, error: "", message: text({ zh: "已恢复默认。", en: "Defaults restored." }) });
        },
      };
    };

    // ---- switcher store ---------------------------------------------------
    const createSwitcherStore = () => {
      let snapshot = { phase: "idle", index: 0, entries: [] };
      const listeners = new Set();
      const publish = (next) => {
        snapshot = next;
        for (const listener of listeners) listener();
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        open(entries, start) {
          publish({ phase: "preview", index: start, entries });
        },
        advance(delta) {
          if (snapshot.phase !== "preview" || snapshot.entries.length === 0) return;
          const size = snapshot.entries.length;
          publish({
            ...snapshot,
            index: ((snapshot.index + delta) % size + size) % size,
          });
        },
        close() {
          if (snapshot.phase === "idle") return;
          publish({ phase: "idle", index: 0, entries: [] });
        },
        target() {
          return snapshot.phase === "preview" ? snapshot.entries[snapshot.index] : undefined;
        },
      };
    };

    const bindingsStore = createBindingsStore();
    const switcherStore = createSwitcherStore();

    // ---- settings card ----------------------------------------------------
    // Type scale borrowed from the settings shell's own row module
    // (DeveloperToolsRow.module.css): 14/20 title, 12/18 description, one
    // hairline separator per row instead of a boxed card per entry.
    const CARD_STYLE = { display: "block", padding: "0 0 4px" };
    const ROW_STYLE = {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 16,
      padding: "12px 0",
      borderBottom: ".5px solid var(--dsw-alias-border-l2)",
      fontSize: 14,
      lineHeight: "20px",
      color: "var(--dsw-alias-label-primary)",
    };
    const ROW_LAST_STYLE = { ...ROW_STYLE, borderBottom: "none" };
    const ROW_GROUP_STYLE = {
      display: "flex",
      alignItems: "center",
      gap: 8,
      flexShrink: 0,
    };
    const KEY_STYLE = {
      display: "inline-block",
      textAlign: "center",
      padding: "2px 6px",
      borderRadius: 4,
      border: ".5px solid var(--dsw-alias-border-l2)",
      color: "var(--dsw-alias-label-secondary)",
      fontSize: 12,
      lineHeight: "18px",
      whiteSpace: "nowrap",
    };
    const BUTTON_STYLE = {
      height: 28,
      padding: "0 10px",
      borderRadius: 6,
      border: ".5px solid var(--dsw-alias-border-l2)",
      background: "transparent",
      color: "var(--dsw-alias-label-primary)",
      font: "inherit",
      fontSize: 12,
      lineHeight: "18px",
      cursor: "pointer",
    };
    const HEADER_STYLE = { padding: "16px 0 16px" };
    const TITLE_STYLE = {
      fontSize: 14,
      lineHeight: "20px",
      color: "var(--dsw-alias-label-primary)",
    };
    const HINT_STYLE = {
      margin: "4px 0 0",
      color: "var(--dsw-alias-label-secondary)",
      fontSize: 12,
      lineHeight: "18px",
    };
    const STATUS_STYLE = {
      fontSize: 12,
      lineHeight: "18px",
      color: "var(--dsw-alias-label-tertiary)",
    };
    const ERROR_STYLE = {
      fontSize: 12,
      lineHeight: "18px",
      color: "var(--dsw-alias-state-error-primary)",
    };

    function SettingsCard() {
      const snapshot = React.useSyncExternalStore(
        bindingsStore.subscribe,
        bindingsStore.getSnapshot,
      );
      const recording = snapshot.recording;
      return h(
        "div",
        { style: CARD_STYLE },
        h(
          "div",
          { style: HEADER_STYLE },
          h("div", { style: TITLE_STYLE }, text({ zh: "桌面快捷键", en: "Desktop shortcuts" })),
          h(
            "p",
            { style: HINT_STYLE },
            text({
              zh: "绕过 DSH 快捷键注册表（web 运行时拒绝浏览器保留组合），因此不在上方列表中。点「修改」录制新组合，Esc 取消；与内置命令冲突的组合会被拒绝。仅适配 DSH Desktop。",
              en: "Bypasses the DSH shortcut registry (the web runtime rejects browser-reserved chords), so these are absent from the list above. Choose 修改 to record a combination, Esc to cancel; chords owned by a built-in command are rejected. DSH Desktop only.",
            }),
          ),
        ),
        ...ACTIONS.map((action, index) => {
          const isRecording = recording === action.id;
          return h(
            "div",
            {
              key: action.id,
              style: index === ACTIONS.length - 1 ? ROW_LAST_STYLE : ROW_STYLE,
            },
            h("span", null, text(action.label)),
            h(
              "span",
              { style: ROW_GROUP_STYLE },
              h(
                "kbd",
                { style: KEY_STYLE },
                isRecording
                  ? text({ zh: "按下…", en: "press…" })
                  : formatChord(snapshot.bindings[action.id]),
              ),
              h(
                "button",
                {
                  type: "button",
                  style: BUTTON_STYLE,
                  onClick: () => {
                    if (isRecording) {
                      bindingsStore.stopRecording();
                      return;
                    }
                    bindingsStore.startRecording(action.id);
                  },
                },
                isRecording ? text({ zh: "取消", en: "Cancel" }) : text({ zh: "修改", en: "Change" }),
              ),
              h(
                "button",
                {
                  type: "button",
                  style: BUTTON_STYLE,
                  onClick: () => bindingsStore.reset(action.id),
                },
                text({ zh: "恢复", en: "Reset" }),
              ),
            ),
          );
        }),
        h(
          "div",
          { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", paddingTop: 12 } },
          h(
            "button",
            { type: "button", style: BUTTON_STYLE, onClick: () => bindingsStore.resetAll() },
            text({ zh: "全部恢复默认", en: "Reset all" }),
          ),
          snapshot.error !== ""
            ? h("span", { style: ERROR_STYLE }, snapshot.error)
            : snapshot.message !== ""
              ? h("span", { style: STATUS_STYLE }, snapshot.message)
              : null,
        ),
      );
    }

    /**
     * Render guard: a surface that throws must not fail renderer boot. The
     * overlay renders inside the always-mounted shell layer, so an exception
     * here would otherwise be indistinguishable from a failed plugin.
     */
    const SurfaceBoundary = React === undefined || React === null
      ? null
      : class SurfaceBoundary extends React.Component {
        state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        componentDidCatch(error) {
          fail("surface render threw:", error?.stack ?? error?.message ?? String(error));
        }
        render() {
          return this.state.failed ? null : this.props.children;
        }
      };

    // ---- switcher overlay -------------------------------------------------
    const BACKDROP_STYLE = {
      position: "fixed",
      inset: 0,
      zIndex: 2147483000,
      pointerEvents: "none",
      display: "flex",
      justifyContent: "center",
      alignItems: "flex-start",
      paddingTop: "16vh",
    };
    const PANEL_STYLE = {
      minWidth: 320,
      maxWidth: "min(560px, 72vw)",
      padding: 8,
      borderRadius: 12,
      border: ".5px solid var(--dsw-alias-border-l3)",
      background: "var(--dsw-alias-bg-layer-1)",
      boxShadow: "0 18px 48px rgba(0,0,0,.28)",
      display: "grid",
      gap: 2,
    };
    const PANEL_TITLE_STYLE = {
      padding: "4px 8px 6px",
      fontSize: 11,
      letterSpacing: ".04em",
      textTransform: "uppercase",
      color: "var(--dsw-alias-label-tertiary)",
    };
    const rowStyle = (active) => ({
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "7px 9px",
      borderRadius: 8,
      fontSize: 13,
      background: active ? "var(--dsw-alias-bg-layer-3)" : "transparent",
      color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
      outline: active ? ".5px solid var(--dsw-alias-border-l3)" : "none",
    });
    const ROW_TITLE_STYLE = {
      flex: 1,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    };
    const META_STYLE = { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" };
    const BADGE_STYLE = {
      fontSize: 10,
      padding: "1px 5px",
      borderRadius: 4,
      border: ".5px solid var(--dsw-alias-border-l3)",
      color: "var(--dsw-alias-label-tertiary)",
      whiteSpace: "nowrap",
    };
    const PANEL_HINT_STYLE = {
      padding: "6px 8px 2px",
      fontSize: 11,
      color: "var(--dsw-alias-label-tertiary)",
    };

    function SessionSwitcher() {
      const snapshot = React.useSyncExternalStore(
        switcherStore.subscribe,
        switcherStore.getSnapshot,
      );
      if (snapshot.phase !== "preview") return null;
      return h(
        "div",
        { style: BACKDROP_STYLE },
        h(
          "div",
          { style: PANEL_STYLE, role: "status", "aria-live": "polite" },
          h("div", { style: PANEL_TITLE_STYLE }, text({ zh: "最近会话", en: "Recent sessions" })),
          ...snapshot.entries.map((entry, index) =>
            h(
              "div",
              { key: entry.id, style: rowStyle(index === snapshot.index) },
              h("span", { style: ROW_TITLE_STYLE }, entry.title),
              entry.isCurrent ? h("span", { style: BADGE_STYLE }, text({ zh: "当前", en: "Current" })) : null,
              h("span", { style: META_STYLE }, entry.relative),
            ),
          ),
          h(
            "div",
            { style: PANEL_HINT_STYLE },
            text({
              zh: `松开 ${isMac ? "⌃" : "Ctrl"} 切换 · Tab 继续选 · Esc 取消`,
              en: `Release ${isMac ? "⌃" : "Ctrl"} to switch · Tab to keep moving · Esc to cancel`,
            }),
          ),
        ),
      );
    }

    // ---- plugin body ------------------------------------------------------
    const inject = ["sessions", "workspaces", "uiWorkspace", "slots", "shortcuts", "layout"];

    function applyUnsafe(ctx) {
      const runtime = ctx.shortcuts.runtime;
      const isDesktopShell = /Electron/i.test(String(globalThis.navigator?.userAgent ?? ""));
      log("apply", `runtime=${runtime}`, `mac=${isMac}`, `electron=${isDesktopShell}`);
      // Every binding here is browser-reserved: in a plain browser the page
      // never receives these chords, so the plugin stays completely inert.
      if (!isDesktopShell) {
        log("skip: not the DSH Desktop shell");
        return;
      }
      bindingsStore.setConflictProbe(registryConflict);

      const sessionState = () => ctx.sessions.list.getSnapshot();
      const workspaceState = () => ctx.workspaces.list.getSnapshot();

      /**
       * The registry command that already owns a chord, or null. Used to reject
       * card edits that would double-fire with a built-in command.
       */
      function registryConflict(chord) {
        try {
          const catalog = ctx.shortcuts.catalog.getSnapshot();
          const hit = catalog.find((row) => chordMatchesBinding(chord, row.binding));
          if (hit !== undefined) return hit.id;
          const fixed = ctx.shortcuts.fixedCatalog?.getSnapshot?.() ?? [];
          const fixedHit = fixed.find((row) => chordMatchesBinding(chord, row.binding));
          return fixedHit === undefined ? null : fixedHit.id;
        } catch {
          return null;
        }
      }

      /**
       * The session the main view is showing. `uiWorkspace.mainReference` is
       * authoritative; `retainedBy.mainView` is the projection fallback.
       */
      const currentId = () => {
        const byId = sessionState().byId ?? {};
        try {
          const referenced = ctx.uiWorkspace?.mainReference?.sessionId;
          if (typeof referenced === "string" && byId[referenced] !== undefined) return referenced;
        } catch {
          /* the service may not expose the reference yet; fall through */
        }
        const row = Object.values(byId).find(
          (candidate) => ((candidate.retainedBy && candidate.retainedBy.mainView) || 0) > 0,
        );
        return row === undefined ? undefined : row.id;
      };

      /**
       * Cycle candidates. Archived, blank and subagent sessions are skipped, so
       * the ring never lands in an Agent Teams member session. Ties on
       * `updatedAt` fall back to the snapshot id order to keep the ring stable.
       */
      const recentRows = () => {
        const list = sessionState();
        const byId = list.byId ?? {};
        const ids = list.ids ?? Object.keys(byId);
        const archived = new Set(workspaceState().archivedSessionIds ?? []);
        const position = new Map(ids.map((id, index) => [id, index]));
        return ids
          .map((id) => byId[id])
          .filter(
            (row) => row !== undefined
              && row.blank !== true
              && row.origin !== "subagent"
              && !archived.has(row.id),
          )
          .sort(
            (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
              || (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0),
          );
      };

      const titleOf = (row) => {
        const title = typeof row.title === "string" ? row.title.trim() : "";
        return title === "" ? text({ zh: "未命名会话", en: "Untitled session" }) : title;
      };

      /**
       * Snapshot the candidate list when the switcher opens.
       *
       * Forward starts on the first session that is not the current one, so a
       * quick tap really switches; backward starts on the oldest entry, which is
       * the recency ring's previous element.
       */
      const openSwitcher = (direction = 1) => {
        const rows = recentRows();
        if (rows.length < 2) return false;
        const current = currentId();
        const entries = rows.slice(0, SWITCHER_LIMIT).map((row) => ({
          id: row.id,
          title: titleOf(row),
          isCurrent: row.id === current,
          relative: relativeTime(row.updatedAt),
        }));
        const firstOther = entries.findIndex((entry) => !entry.isCurrent);
        const start = direction > 0
          ? (firstOther < 0 ? 0 : firstOther)
          : entries.length - 1;
        switcherStore.open(entries, start);
        armWatchdog();
        return true;
      };

      let watchdog;
      const clearWatchdog = () => {
        if (watchdog !== undefined) {
          clearTimeout(watchdog);
          watchdog = undefined;
        }
      };
      const armWatchdog = () => {
        clearWatchdog();
        watchdog = setTimeout(() => {
          watchdog = undefined;
          log("switcher watchdog fired");
          closeSwitcher();
        }, SWITCHER_WATCHDOG_MS);
      };
      const closeSwitcher = () => {
        clearWatchdog();
        switcherStore.close();
      };
      const commitSwitcher = () => {
        const target = switcherStore.target();
        closeSwitcher();
        if (target === undefined) return;
        ctx.uiWorkspace.openSession(target.id);
      };

      const closeSession = () => {
        if (currentId() === undefined) return false;
        ctx.uiWorkspace.clearMain();
        return true;
      };

      const pinSession = () => {
        const id = currentId();
        if (id === undefined) return false;
        const pinned = (workspaceState().pinnedSessionIds ?? []).includes(id);
        const pending = pinned
          ? ctx.uiWorkspace.unpinSession(id)
          : ctx.uiWorkspace.pinSession(id);
        void Promise.resolve(pending).catch((error) => log("pin failed", String(error)));
        return true;
      };

      const runAction = (actionId) => {
        switch (actionId) {
          case "new":
            ctx.uiWorkspace.startSession();
            return true;
          case "close":
          case "closeFallback":
            return closeSession();
          case "pin":
            return pinSession();
          case "cycle":
            return openSwitcher(1);
          case "cyclePrev":
            return openSwitcher(-1);
          case "sidebarLeft":
            ctx.layout.toggleSidebar();
            return true;
          case "settings":
            return replaySettingsOpen();
          default:
            return false;
        }
      };

      /**
       * Bindings the DSH registry cannot carry in the web runtime, replayed
       * through the app's own code paths:
       *
       * - `Cmd/Ctrl+B` toggles the left sidebar through the layout service, the
       *   same call the built-in `sidebar.left.toggle` command makes. The web
       *   allowlist rejects one-modifier combinations, so the registry cannot
       *   hold this binding itself.
       * - `Cmd/Ctrl+,` replays the live `settings.open` binding as a synthetic
       *   keydown instead of calling a private action, so a later remap of that
       *   command keeps working and the modal rules still apply.
       */
      const primaryHeld = (event) => (isMac
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey);

      /** Replay a registered command by synthesizing its current binding. */
      const replayCommand = (id) => {
        try {
          const row = ctx.shortcuts.catalog
            .getSnapshot()
            .find((candidate) => candidate.id === id);
          const binding = row?.binding;
          if (binding === null || binding === undefined) return false;
          const target = globalThis.document?.body ?? globalThis.document ?? globalThis.window;
          if (typeof target?.dispatchEvent !== "function") return false;
          target.dispatchEvent(new globalThis.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            composed: true,
            code: binding.code,
            ctrlKey: binding.modifiers.includes("control"),
            altKey: binding.modifiers.includes("alt"),
            shiftKey: binding.modifiers.includes("shift"),
            metaKey: binding.modifiers.includes("meta"),
          }));
          return true;
        } catch (error) {
          fail("command replay failed:", String(error));
          return false;
        }
      };

      /**
       * Replay `settings.open`, unless our own chord already equals that
       * command's binding — then the registry delivers it and replaying would
       * open settings twice.
       */
      const replaySettingsOpen = () => {
        try {
          const row = ctx.shortcuts.catalog
            .getSnapshot()
            .find((candidate) => candidate.id === "settings.open");
          const mine = bindingsStore.getSnapshot().bindings.settings;
          if (chordMatchesBinding(mine, row?.binding)) return false;
        } catch {
          /* fall through to the replay */
        }
        return replayCommand("settings.open");
      };

      const consume = (event, consumed) => {
        if (!consumed) return;
        event.preventDefault();
        event.stopPropagation();
      };

      const onKeyDown = (event) => {
        if (event.isComposing) return;
        let consumed = false;
        try {
          const settings = bindingsStore.getSnapshot();
          if (settings.recording !== null) {
            // While recording, always swallow the key: an invalid or rejected
            // chord must not leak through to the app or the native menu.
            consumed = true;
            if (event.code === "Escape") {
              bindingsStore.stopRecording();
            } else {
              const chord = chordOf(event);
              if (chord !== null) bindingsStore.assign(settings.recording, chord);
            }
            consume(event, consumed);
            return;
          }

          if (switcherStore.getSnapshot().phase === "preview") {
            consumed = true;
            if (matchesChord(settings.bindings.cycle, event)) {
              switcherStore.advance(1);
              armWatchdog();
            } else if (matchesChord(settings.bindings.cyclePrev, event)) {
              switcherStore.advance(-1);
              armWatchdog();
            } else if (event.code === "Escape") {
              closeSwitcher();
            }
            consume(event, consumed);
            return;
          }

          const actionId = ACTIONS.find((action) =>
            matchesChord(settings.bindings[action.id], event),
          )?.id;
          if (actionId !== undefined && DESKTOP_ACTIONS.has(actionId)) {
            // On the desktop keymap the registry owns these two; replaying
            // them there would fire the command twice.
            consumed = runtime !== "desktop" && runAction(actionId);
          } else if (actionId !== undefined) {
            consumed = runAction(actionId);
          }
        } catch (error) {
          log("keydown failed", String(error));
        }
        consume(event, consumed);
      };

      const onKeyUp = (event) => {
        if (switcherStore.getSnapshot().phase !== "preview") return;
        // Releasing Tab deliberately keeps the overlay alive: the switcher ends
        // when the primary modifier is released, so Tab works as a repeatable
        // "next" button rather than a commit.
        if (event.code === "Tab") return;
        const releasingControl = event.code === "ControlLeft"
          || event.code === "ControlRight"
          || event.key === "Control";
        if (!releasingControl) return;
        commitSwitcher();
        consume(event, true);
      };

      const onBlur = () => {
        if (switcherStore.getSnapshot().phase === "preview") {
          log("switcher cancelled by blur");
          closeSwitcher();
        }
      };

      const onVisibility = () => {
        if (globalThis.document?.visibilityState === "hidden") onBlur();
      };

      ctx.effect(
        () => {
          const window = globalThis.window;
          const document = globalThis.document;
          window?.addEventListener("keydown", onKeyDown, true);
          window?.addEventListener("keyup", onKeyUp, true);
          window?.addEventListener("blur", onBlur);
          document?.addEventListener?.("visibilitychange", onVisibility);
          return () => {
            window?.removeEventListener("keydown", onKeyDown, true);
            window?.removeEventListener("keyup", onKeyUp, true);
            window?.removeEventListener("blur", onBlur);
            document?.removeEventListener?.("visibilitychange", onVisibility);
            clearWatchdog();
          };
        },
        "dsh-hotkey-enhance: keyboard",
      );

      /** Register one slot surface without ever blocking renderer boot. */
      const registerSurface = (name, id, order) => {
        if (React === undefined || React === null || SurfaceBoundary === null) {
          fail(`skipping ${name}: react is unavailable`);
          return;
        }
        try {
          ctx.slots.inject(name, () => {
            log("declaring into", name);
            const meta = order === undefined ? { name, id } : { name, id, order };
            // Every root-scoped overlay entry carries an inject face; the
            // renderer composes root props from it during the root rebuild.
            meta.inject = () => ({});
            return ctx.slots.register(
              meta,
              name === "shell.overlay"
                ? () => h(SurfaceBoundary, null, h(SessionSwitcher))
                : () => h(SurfaceBoundary, null, h(SettingsCard)),
            );
          });
          log("slot injection requested:", name);
        } catch (error) {
          fail(`${name} registration threw:`, error?.stack ?? error?.message ?? String(error));
        }
      };

      registerSurface("settings.general.item", "hotkey-enhance", 1000);
      registerSurface("shell.overlay", "hotkey-enhance.switcher");
      log("apply finished");
    }

    /** Never let a registration mistake take the whole renderer down. */
    function apply(ctx) {
      try {
        applyUnsafe(ctx);
      } catch (error) {
        fail("apply threw:", error?.stack ?? error?.message ?? String(error));
      }
    }

    return { inject, apply };
  },
});
