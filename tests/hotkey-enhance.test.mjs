/**
 * Offline harness for dsh-hotkey-enhance: fake window, fake localStorage, fake
 * React and fake cordis ctx. Drives keydown/keyup sequences, the settings card
 * and the hold-to-preview session switcher.
 */
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../lib/client.js", import.meta.url),
  "utf8",
);

// ---- fake environment -----------------------------------------------------
const handlers = { keydown: new Set(), keyup: new Set(), blur: new Set() };
const calls = [];
const storage = new Map();
const slots = new Map();
const timers = new Map();
let timerSeq = 0;

const fakeWindow = {
  addEventListener: (type, fn) => handlers[type]?.add(fn),
  removeEventListener: (type, fn) => handlers[type]?.delete(fn),
  close: () => calls.push("window.close"),
};

class FakeComponent {
  constructor(props) {
    this.props = props ?? {};
  }
}
const FakeReact = {
  Component: FakeComponent,
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

fakeWindow.__ModuleLoader__ = {
  load({ id, factory }) {
    globalThis.__bundleId = id;
    globalThis.__exports = factory((name) => {
      if (name === "react") return FakeReact;
      throw new Error(`unexpected require: ${name}`);
    });
  },
};
globalThis.window = fakeWindow;
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.KeyboardEvent = class KeyboardEvent {
  constructor(type, init = {}) {
    Object.assign(this, { type }, init);
  }
};
globalThis.document = {
  visibilityState: "visible",
  addEventListener: () => {},
  removeEventListener: () => {},
  body: {
    dispatchEvent: (event) =>
      calls.push(
        `dispatch:${event.code}:${[event.metaKey && "meta", event.altKey && "alt", event.shiftKey && "shift", event.ctrlKey && "ctrl"].filter(Boolean).join("+")}`,
      ),
  },
};
globalThis.setTimeout = (fn, ms) => {
  const id = ++timerSeq;
  timers.set(id, { fn, ms });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
const fireWatchdog = () => {
  const pending = [...timers.values()];
  timers.clear();
  for (const timer of pending) timer.fn();
};
Object.defineProperty(globalThis, "navigator", {
  value: {
    language: "zh-CN",
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh) Electron/44.0.0",
  },
  configurable: true,
});

new Function(source)();

// ---- fake services --------------------------------------------------------
const now = Date.now();
const sessions = [
  { id: "s1", title: "一小时前的会话", updatedAt: now - 3_600_000, retainedBy: { mainView: 0 } },
  { id: "s2", title: "当前会话", updatedAt: now - 60_000, retainedBy: { mainView: 1 } },
  { id: "s3", title: "两分钟前", updatedAt: now - 120_000, retainedBy: { mainView: 0 } },
  { id: "s4", title: "", updatedAt: now - 5_000, retainedBy: { mainView: 0 }, blank: true },
  { id: "s5", title: "已归档", updatedAt: now - 9_000_000, retainedBy: { mainView: 0 } },
  { id: "s6", title: "子会话", updatedAt: now - 1_000, retainedBy: { mainView: 0 }, origin: "subagent" },
];
let pinned = [];

const ctx = {
  sessions: {
    list: {
      getSnapshot: () => ({
        ids: sessions.map((s) => s.id),
        byId: Object.fromEntries(sessions.map((s) => [s.id, s])),
      }),
    },
  },
  workspaces: {
    list: {
      getSnapshot: () => ({ items: [], pinnedSessionIds: pinned, archivedSessionIds: ["s5"] }),
    },
  },
  uiWorkspace: {
    mainReference: undefined,
    openSession: (id) => calls.push(`open:${id}`),
    clearMain: () => calls.push("clearMain"),
    startSession: () => calls.push("startSession"),
    pinSession: async (id) => calls.push(`pin:${id}`),
    unpinSession: async (id) => calls.push(`unpin:${id}`),
  },
  layout: {
    toggleSidebar: () => calls.push("toggleSidebar"),
  },
  // better-sidebar is optional: the plugin reads it through ctx.get.
  get: (name) => (name === "betterSidebar" ? globalThis.__betterSidebar : undefined),
  effect: (fn) => fn(),
  slots: {
    inject: (_name, register) => {
      const registration = register();
      slots.set(registration.component.name ?? slots.size, registration.component);
      return registration;
    },
    register: (meta, component) => {
      slots.set(meta.id, component);
      return { meta, component };
    },
  },
};

let catalogRows = [
  { id: "settings.open", binding: { code: "Comma", modifiers: ["alt", "meta"] } },
  { id: "terminal.new", binding: { code: "Backquote", modifiers: ["control"] } },
  { id: "browser.new", binding: { code: "KeyT", modifiers: ["alt", "meta"] } },
];
ctx.shortcuts = {
  runtime: "web",
  catalog: { getSnapshot: () => catalogRows },
};

// ---- helpers --------------------------------------------------------------
const fire = (type, init) => {
  const event = {
    code: "",
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...init,
  };
  calls.length = 0;
  for (const fn of handlers[type] ?? []) fn(event);
  return { consumed: event.defaultPrevented && event.propagationStopped, calls: [...calls] };
};
const down = (init) => fire("keydown", init);
const press2 = (type, init) => fire(type, init);
const up = (init) => fire("keyup", init);

const tabDown = (extra = {}) => down({ code: "Tab", key: "Tab", ctrlKey: true, ...extra });
const tabUp = (extra = {}) => up({ code: "Tab", key: "Tab", ctrlKey: true, ...extra });

const walk = (node, out = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (typeof node === "object") {
    out.push(node);
    for (const child of node.children ?? []) walk(child, out);
  }
  return out;
};
const textOf = (node) =>
  typeof node === "string" ? node : (node?.children ?? []).map(textOf).join("");
const buttons = (tree, label) =>
  walk(tree).filter((node) => node.type === "button" && textOf(node) === label);
const stored = () => JSON.parse(storage.get("dsh.sessionkeys.bindings.v1") ?? "{}").bindings ?? {};

let switcher;
const switcherTree = () => switcher();
const switcherRows = () => {
  const tree = switcherTree();
  return tree === null ? [] : walk(tree).filter((n) => n.props?.style?.padding === "7px 9px");
};
const highlighted = () => {
  const rows = switcherRows();
  const index = rows.findIndex((row) => row.props.style.background !== "transparent");
  return index < 0 ? null : textOf(rows[index]);
};
const switcherOpen = () => switcherTree() !== null;

// ---- assertions -----------------------------------------------------------
const failures = [];
const check = (name, condition, detail = "") => {
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

console.log("bundle id:", globalThis.__bundleId, "| exports:", Object.keys(globalThis.__exports));
globalThis.__exports.apply(ctx);
/** Slots are registered through a render boundary; unwrap to the inner component. */
const renderSurface = (registered) => {
  if (typeof registered !== "function") return null;
  const boundary = registered();
  const inner = boundary?.children?.[0];
  return inner === undefined ? null : inner.type(inner.props);
};
const card = slots.get("hotkey-enhance");
const cardTree = () => renderSurface(card);
const ACTION_ORDER = [
  "new",
  "close",
  "closeFallback",
  "pin",
  "cycle",
  "cyclePrev",
  "sidebarLeft",
  "settings",
  "sidebarSidechat",
  "sidebarTerminal",
  "sidebarBrowser",
];
const cardRecording = () => {
  const keys = walk(cardTree()).filter((n) => n.type === "kbd").map(textOf);
  const index = keys.indexOf("按下…");
  return index < 0 ? null : ACTION_ORDER[index];
};
switcher = () => renderSurface(slots.get("hotkey-enhance.switcher"));

check("registers settings card", typeof card === "function");
check("registers switcher overlay", typeof slots.get("hotkey-enhance.switcher") === "function");
check("idle overlay renders nothing", switcherTree() === null);
check("hooks keydown + keyup + blur", handlers.keydown.size === 1 && handlers.keyup.size === 1 && handlers.blur.size === 1);

// ---- tap: Tab is a repeatable "next", Control commits -------------------
let r = tabDown();
check("Ctrl+Tab opens the overlay", switcherOpen());
check("tap does not switch on keydown", r.calls.length === 0, r.calls.join());
// ring: s2 (current), s3, s1 → first non-current is s3 (index 1)
check("highlight starts on the next session", String(highlighted()).includes("两分钟前"), String(highlighted()));

r = tabUp();
check("releasing Tab keeps the overlay open", switcherOpen());
check("releasing Tab does not switch", r.calls.length === 0, r.calls.join());

r = tabDown();
check("a second Tab tap advances", String(highlighted()).includes("一小时前的会话"), String(highlighted()));
check("watchdog re-armed on advance", timers.size === 1, String(timers.size));
tabUp();
check("still open after the second release", switcherOpen());

r = up({ code: "ControlLeft", key: "Control", ctrlKey: false });
check("releasing Control commits once", r.calls.join() === "open:s1", r.calls.join());
check("overlay closes on Control release", !switcherOpen());

// ---- hold + repeats ------------------------------------------------------
r = tabDown();
tabDown({ repeat: true });
check("first repeat moves down", String(highlighted()).includes("一小时前的会话"), String(highlighted()));
tabDown({ repeat: true });
check("second repeat wraps to the current session", String(highlighted()).includes("当前会话"), String(highlighted()));
tabUp();
check("release keeps it open while Control is held", switcherOpen());
r = up({ code: "ControlLeft", key: "Control", ctrlKey: false });
check("commit lands on the wrapped row", r.calls.join() === "open:s2", r.calls.join());

// ---- reverse direction ---------------------------------------------------
r = tabDown({ shiftKey: true });
check("Ctrl+Shift+Tab starts on the oldest", String(highlighted()).includes("一小时前的会话"), String(highlighted()));
tabUp({ shiftKey: true });
check("reverse overlay stays open after Tab release", switcherOpen());
r = up({ code: "ControlLeft", key: "Control", ctrlKey: false });
check("reverse commit on Control release", r.calls.join() === "open:s1", r.calls.join());

// ---- Esc cancels ---------------------------------------------------------
tabDown();
r = down({ code: "Escape", key: "Escape" });
check("Esc closes the overlay", !switcherOpen());
check("Esc does not switch", r.calls.length === 0, r.calls.join());

// ---- blur cancels --------------------------------------------------------
tabDown();
tabUp();
r = fire("blur");
check("blur closes the overlay", !switcherOpen());
check("blur does not switch", r.calls.length === 0, r.calls.join());

// ---- watchdog: long safety net, never an idle timeout --------------------
tabDown();
check("watchdog armed on open", timers.size === 1, String(timers.size));
check(
  "watchdog waits 30s so a held modifier is never interrupted",
  [...timers.values()][0]?.ms === 30000,
  String([...timers.values()][0]?.ms),
);
fireWatchdog();
check("watchdog closes the overlay", !switcherOpen());
check("watchdog does not switch", calls.length === 0, calls.join());

// ---- other shortcuts suppressed while the overlay is open ---------------
tabDown();
r = down({ code: "KeyN", metaKey: true });
check("Cmd+N suppressed during preview", r.calls.length === 0 && r.consumed, r.calls.join());
up({ code: "ControlLeft", key: "Control", ctrlKey: false });

// ---- frozen snapshot -----------------------------------------------------
tabDown();
sessions[0].updatedAt = now; // make s1 the newest mid-preview
check("highlight unchanged after list mutates", String(highlighted()).includes("两分钟前"), String(highlighted()));
r = up({ code: "ControlLeft", key: "Control", ctrlKey: false });
check("commit uses the frozen target", r.calls.join() === "open:s3", r.calls.join());
sessions[0].updatedAt = now - 3_600_000;

// ---- single candidate ----------------------------------------------------
const saved = sessions.splice(2, 3); // keep s1 (other) + s2 (current)
tabDown();
check("single other session still opens", switcherOpen());
up({ code: "ControlLeft", key: "Control", ctrlKey: false });
sessions.splice(2, 0, ...saved);

// ---- overlay content -----------------------------------------------------
tabDown();
const overlayTree = switcherTree();
const overlayRows = switcherRows();
check("lists three candidates", overlayRows.length === 3, String(overlayRows.length));
check("first row is the current session", textOf(overlayRows[0]).includes("当前会话"), textOf(overlayRows[0]));
check("current row carries the 当前 badge", textOf(overlayRows[0]).includes("当前会话当前"), textOf(overlayRows[0]));
check("second row is the highlighted target", textOf(overlayRows[1]).includes("两分钟前"), textOf(overlayRows[1]));
check("row shows a relative time", /分钟前|小时前|刚刚/.test(textOf(overlayRows[0])), textOf(overlayRows[0]));
check(
  "footer explains the new gesture",
  walk(overlayTree).some((n) => textOf(n).includes("松开") && textOf(n).includes("Tab 继续选")),
);
up({ code: "ControlLeft", key: "Control", ctrlKey: false });

// ---- settings card still works ------------------------------------------
check("settings card lists eleven bindings", buttons(cardTree(), "修改").length === 11);
buttons(cardTree(), "修改")[4].props.onClick(); // cycle
check("recording starts", walk(cardTree()).some((n) => n.type === "kbd" && textOf(n) === "按下…"));
down({ code: "Escape", key: "Escape" });
check("recording cancelled", !walk(cardTree()).some((n) => n.type === "kbd" && textOf(n) === "按下…"));

// ---- web-runtime bindings the registry cannot carry ----------------------
check("Cmd+B toggles the left sidebar", down({ code: "KeyB", metaKey: true }).calls.join() === "toggleSidebar");
check(
  "Cmd+Shift+B stays with the right sidebar",
  down({ code: "KeyB", metaKey: true, shiftKey: true }).calls.length === 0,
);
check(
  "Cmd+Alt+B stays with the registry command",
  down({ code: "KeyB", metaKey: true, altKey: true }).calls.length === 0,
);
check("Ctrl+B is not ours on macOS", down({ code: "KeyB", ctrlKey: true }).calls.length === 0);

let r2 = down({ code: "Comma", metaKey: true });
check("Cmd+, replays settings.open", r2.calls.join() === "dispatch:Comma:meta+alt", r2.calls.join());

catalogRows = [{ id: "settings.open", binding: { code: "Comma", modifiers: ["meta"] } }];
r2 = down({ code: "Comma", metaKey: true });
check(
  "Cmd+, is left alone when the registry already owns it",
  r2.calls.length === 0,
  r2.calls.join(),
);
catalogRows = [
  { id: "settings.open", binding: { code: "Comma", modifiers: ["alt", "meta"] } },
  { id: "terminal.new", binding: { code: "Backquote", modifiers: ["control"] } },
  { id: "browser.new", binding: { code: "KeyT", modifiers: ["alt", "meta"] } },
];

// ---- desktop runtime defers to the registry ------------------------------
{
  handlers.keydown.clear();
  handlers.keyup.clear();
  handlers.blur.clear();
  ctx.shortcuts.runtime = "desktop";
  globalThis.__exports.apply(ctx);
  const desktopB = down({ code: "KeyB", metaKey: true });
  check("desktop runtime does not hijack Cmd+B", desktopB.calls.length === 0, desktopB.calls.join());
  ctx.shortcuts.runtime = "web";
  handlers.keydown.clear();
  handlers.keyup.clear();
  handlers.blur.clear();
  globalThis.__exports.apply(ctx);
}

// ---- the two desktop keys are customisable too ---------------------------
{
  const card0 = cardTree();
  const change = buttons(card0, "修改");
  change[6].props.onClick(); // sidebarLeft
  let rec = press2("keydown", { code: "KeyJ", metaKey: true, shiftKey: true });
  check("desktop key records a new chord", rec.consumed && stored().sidebarLeft === "Meta+Shift+KeyJ", String(stored().sidebarLeft));

  let r3 = press2("keydown", { code: "KeyJ", metaKey: true, shiftKey: true });
  check("new sidebar chord toggles the sidebar", r3.calls.join() === "toggleSidebar", r3.calls.join());
  r3 = press2("keydown", { code: "KeyB", metaKey: true });
  check("the replaced default Cmd+B is dead", r3.calls.length === 0, r3.calls.join());

  // undo through the card so later tests see defaults
  buttons(cardTree(), "恢复")[6].props.onClick();
  check("sidebar reset restores Cmd+B", stored().sidebarLeft === "Meta+KeyB", String(stored().sidebarLeft));
}

// ---- a chord owned by a built-in command is refused ----------------------
{
  catalogRows = [
    { id: "settings.open", binding: { code: "Comma", modifiers: ["alt", "meta"] } },
    { id: "sidebar.right.toggle", binding: { code: "KeyB", modifiers: ["alt", "meta"] } },
  ];
  buttons(cardTree(), "修改")[3].props.onClick(); // pin
  const rec = press2("keydown", { code: "KeyB", metaKey: true, altKey: true });
  check("registry-owned chord is refused", rec.consumed && cardRecording() === "pin", String(cardRecording()));
  check(
    "refusal names the owner",
    walk(cardTree()).some((n) => textOf(n).includes("sidebar.right.toggle")),
  );
  press2("keydown", { code: "Escape", key: "Escape" });
  catalogRows = [
  { id: "settings.open", binding: { code: "Comma", modifiers: ["alt", "meta"] } },
  { id: "terminal.new", binding: { code: "Backquote", modifiers: ["control"] } },
  { id: "browser.new", binding: { code: "KeyT", modifiers: ["alt", "meta"] } },
];
}

// ---- outside the Desktop shell the plugin stays inert --------------------
{
  const bareHandlers = { keydown: new Set(), keyup: new Set(), blur: new Set() };
  const bareWindow = {
    addEventListener: (type, fn) => bareHandlers[type]?.add(fn),
    removeEventListener: (type, fn) => bareHandlers[type]?.delete(fn),
  };
  bareWindow.__ModuleLoader__ = {
    load: ({ factory }) => {
      globalThis.__browserBuild = factory((name) => {
        if (name === "react") return FakeReact;
        throw new Error(name);
      });
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "zh-CN", platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh) Safari/605" },
    configurable: true,
  });
  globalThis.window = bareWindow;
  slots.clear();
  new Function(source)();
  let threw = false;
  try {
    globalThis.__browserBuild.apply(ctx);
  } catch {
    threw = true;
  }
  check("browser build does not throw", !threw);
  check("browser build installs no key listener", bareHandlers.keydown.size === 0);
  check("browser build registers no surfaces", slots.size === 0, String(slots.size));

  // restore the Desktop-shell environment
  Object.defineProperty(globalThis, "navigator", {
    value: {
      language: "zh-CN",
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh) Electron/44.0.0",
    },
    configurable: true,
  });
  globalThis.window = fakeWindow;
  handlers.keydown.clear();
  handlers.keyup.clear();
  handlers.blur.clear();
  globalThis.__exports.apply(ctx);
}

// ---- side chat / terminal / browser -------------------------------------
globalThis.__betterSidebar = {
  openTab: (seed, scope) => calls.push(`openTab:${seed.type}:${scope?.sessionId}`),
};

let r4 = down({ code: "KeyS", metaKey: true, altKey: true });
check("Cmd+Alt+S opens side chat", r4.calls.join() === "openTab:sidechat:s2", r4.calls.join());

r4 = down({ code: "KeyJ", metaKey: true });
check("Cmd+J replays terminal.new", r4.calls.join() === "dispatch:Backquote:ctrl", r4.calls.join());

r4 = down({ code: "KeyT", metaKey: true });
check("Cmd+T replays browser.new", r4.calls.join() === "dispatch:KeyT:meta+alt", r4.calls.join());

// availability B: the row shows why it cannot fire
check(
  "an available side-chat row carries no reason",
  !walk(cardTree()).some((n) => textOf(n) === "需要安装 dsh-better-sidebar"),
);

globalThis.__betterSidebar = undefined;
check(
  "missing better-sidebar is visible in the card",
  walk(cardTree()).some((n) => textOf(n) === "需要安装 dsh-better-sidebar"),
);
check(
  "the unavailable row disables its buttons",
  buttons(cardTree(), "修改")[8].props.disabled === true,
  String(buttons(cardTree(), "修改")[8].props.disabled),
);

r4 = down({ code: "KeyS", metaKey: true, altKey: true });
check(
  "side chat is a no-op without better-sidebar",
  r4.calls.length === 0 && !r4.consumed,
  r4.calls.join(),
);
globalThis.__betterSidebar = {
  openTab: (seed, scope) => calls.push(`openTab:${seed.type}:${scope?.sessionId}`),
};

// replay yields when the registry already owns our chord
catalogRows = [
  ...catalogRows.filter((row) => row.id !== "browser.new"),
  { id: "browser.new", binding: { code: "KeyT", modifiers: ["meta"] } },
];
r4 = down({ code: "KeyT", metaKey: true });
check("browser replay yields when the registry owns the chord", r4.calls.length === 0, r4.calls.join());
catalogRows = [
  ...catalogRows.filter((row) => row.id !== "browser.new"),
  { id: "browser.new", binding: { code: "KeyT", modifiers: ["alt", "meta"] } },
];

// a missing registry command makes the row unavailable instead of silently dead
catalogRows = catalogRows.filter((row) => row.id !== "terminal.new");
check(
  "a missing command is explained in the card",
  walk(cardTree()).some((n) => textOf(n).includes("terminal.new")),
);
catalogRows = [
  ...catalogRows,
  { id: "terminal.new", binding: { code: "Backquote", modifiers: ["control"] } },
];

// ---- persisted override still respected ---------------------------------
storage.set(
  "dsh.sessionkeys.bindings.v1",
  JSON.stringify({ version: 1, bindings: { pin: "Meta+Alt+KeyP" } }),
);
{
  const reloadedHandlers = { keydown: new Set(), keyup: new Set(), blur: new Set() };
  const reloadedWindow = {
    addEventListener: (type, fn) => reloadedHandlers[type]?.add(fn),
    removeEventListener: (type, fn) => reloadedHandlers[type]?.delete(fn),
  };
  reloadedWindow.__ModuleLoader__ = {
    load: ({ factory }) => {
      globalThis.__reloaded = factory((name) => {
        if (name === "react") return FakeReact;
        throw new Error(name);
      });
    },
  };
  globalThis.window = reloadedWindow;
  new Function(source)();
  globalThis.__reloaded.apply(ctx);
  calls.length = 0;
  for (const fn of reloadedHandlers.keydown) {
    fn({ code: "KeyP", metaKey: true, altKey: true, preventDefault() {}, stopPropagation() {} });
  }
  globalThis.window = fakeWindow;
  check("persisted binding survives a reload", calls.join() === "pin:s2", calls.join());
}

// ---- degradation: react seed unavailable must not throw ------------------
{
  const bareHandlers = { keydown: new Set(), keyup: new Set(), blur: new Set() };
  const bareWindow = {
    addEventListener: (type, fn) => bareHandlers[type]?.add(fn),
    removeEventListener: (type, fn) => bareHandlers[type]?.delete(fn),
  };
  bareWindow.__ModuleLoader__ = {
    load: ({ factory }) => {
      globalThis.__bare = factory((name) => {
        throw new Error(`seed unavailable: ${name}`);
      });
    },
  };
  globalThis.window = bareWindow;
  let threw = false;
  const errors = [];
  const savedError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    new Function(source)();
    globalThis.__bare.apply(ctx);
  } catch {
    threw = true;
  }
  console.error = savedError;
  globalThis.window = fakeWindow;
  check("missing react seed does not throw", !threw);
  check("missing react seed degrades to keyboard only", bareHandlers.keydown.size === 1);
  check(
    "missing react seed is logged",
    errors.some((line) => line.includes("FAILED") && line.includes("react")),
    errors.slice(0, 2).join(" | ").slice(0, 160),
  );
}

console.log(
  failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILURES:\n${failures.join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
