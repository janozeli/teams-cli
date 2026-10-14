// Page-side sources, evaluated inside the Teams web page over CDP.
//
// They are plain JS strings rather than TS functions on purpose: bundlers and
// loaders (esbuild keepNames, tsx) inject helpers into function bodies, which
// would break once `Function.prototype.toString()` ships them to the page.
// Each source is an async function taking one JSON argument.
//
// Reads come from Teams' own IndexedDB cache, so they never mark anything as
// read. Writes drive the UI the same way a user would.
//
// Errors thrown with fail() reach the CLI as `TEAMS_CLI:<CODE>:<message>`.
// Interruption can follow partial effects; never infer rollback from an error.

/** Shared helpers, spliced into every source. Exported for tests of its pure parts. */
export const PRELUDE = String.raw`
  const fail = (code, message) => { throw new Error("TEAMS_CLI:" + code + ":" + message); };
  const activityGuard = globalThis.__teamsCliGate && !globalThis.__teamsCliGate.closed ? globalThis.__teamsCliGate.capture() : null;
  const checkpoint = () => activityGuard?.assert();
  const act = (action, fn, target) => activityGuard ? activityGuard.act(action, fn, target) : fn();
  const sleep = async (ms) => { await new Promise((r) => setTimeout(r, ms)); checkpoint(); };
  const waitFor = async (fn, timeoutMs, what) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      checkpoint();
      const v = fn();
      if (v) return v;
      if (Date.now() > end) fail("UI_TIMEOUT", "Timed out waiting for " + what);
      await sleep(100);
    }
  };
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

  // Cache databases are named Teams:<kind>:react-web-client:<tenant>:<user>:<locale>.
  // Bind to the signed-in account (its ids prefix the left-rail folder ids) and
  // refuse to guess when that cannot be established.
  const activeAccount = () => {
    const el = document.querySelector("[data-testid=conversation-folder-header][id*='~']");
    if (!el) return null;
    const [tenant, user] = el.id.split("~");
    return tenant && user ? tenant + ":" + user : null;
  };
  // Pure: choose one database name for a kind. override ("tenant:user", from
  // TEAMS_CLI_ACCOUNT) wins; else the account seen in the UI; else it must be unambiguous.
  const pickDatabase = (kind, names, active, lang, override) => {
    const parse = (n) => { const p = n.split(":"); return { name: n, account: p[3] + ":" + p[p.length - 2], locale: p[p.length - 1].toLowerCase() }; };
    let candidates = names.filter((n) => n && n.startsWith("Teams:" + kind + ":")).map(parse);
    if (!candidates.length) fail("CACHE_UNAVAILABLE", "Teams cache '" + kind + "' not found; is Teams fully loaded?");
    const accounts = [...new Set(candidates.map((c) => c.account))];
    const want = override || active;
    if (want) candidates = candidates.filter((c) => c.account === want);
    else if (accounts.length > 1) fail("ACCOUNT_AMBIGUOUS", "Cache holds " + accounts.length + " accounts (" + accounts.join(", ") + ") and the signed-in one could not be identified; set TEAMS_CLI_ACCOUNT=<tenant>:<user>");
    if (!candidates.length) fail("CACHE_UNAVAILABLE", "No '" + kind + "' cache for account " + want + " (cached: " + accounts.join(", ") + ")");
    return candidates.find((c) => c.locale === (lang || "").toLowerCase()) || candidates[0];
  };
  const openDb = async (kind) => {
    const names = (await indexedDB.databases()).map((d) => d.name);
    const pick = pickDatabase(kind, names, activeAccount(), document.documentElement.lang, args && args.account);
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(pick.name);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onupgradeneeded = () => { r.transaction.abort(); reject(new Error("TEAMS_CLI:CACHE_UNAVAILABLE:cache '" + kind + "' is being created")); };
    });
    const [tenantId, userId] = pick.account.split(":");
    return { db, tenantId, meId: "8:orgid:" + userId };
  };
  // Run fn(db) and always close; a missing store/index means the cache layout changed.
  const withDb = async (kind, fn) => {
    const { db, meId } = await openDb(kind);
    try {
      return await fn(db, meId);
    } catch (e) {
      if (e && (e.name === "NotFoundError" || e.name === "InvalidStateError")) fail("CACHE_UNAVAILABLE", "Teams cache '" + kind + "' layout changed: " + e.message);
      throw e;
    } finally {
      db.close();
    }
  };

  // The chat pane header carries the conversation id; the left rail flips to "selected"
  // before the pane swaps, so the pane (not the rail) says which chat is open.
  const paneIs = (id) => !!document.querySelector("[id=" + JSON.stringify("chat-header-" + id) + "]");
  const SEND_BUTTONS = "[data-tid=sendMessageCommands-send], [data-tid=newMessageCommands-send]";
  // The composer for a conversation: exactly one send button tagged with that thread id
  // (data-track-thread-id), and the single editor that shares its container.
  // An untagged or duplicated button is never trusted.
  const composerFor = (id) => {
    if (!paneIs(id)) return null;
    const buttons = [...document.querySelectorAll(SEND_BUTTONS)].filter((b) => b.getAttribute("data-track-thread-id") === id && b.isConnected);
    if (buttons.length !== 1) return null;
    const button = buttons[0];
    let box = button.parentElement;
    for (let i = 0; box && i < 8; i++, box = box.parentElement) {
      const editors = box.querySelectorAll("[data-tid=ckeditor]");
      if (editors.length === 1) return { button, editor: editors[0], box };
      if (editors.length > 1) return null;
    }
    return null;
  };
  // Anything already in the composer: text, inline media/tables, or attachment chips.
  const draftOf = (c) => ({
    text: c.editor.innerText.trim().length,
    media: c.editor.querySelectorAll("img, table, figure, video").length,
    attachments: [...c.box.querySelectorAll("[data-tid]")].filter((e) => /attach|file-?chip|filecard/i.test(e.getAttribute("data-tid")) && !/FilePicker/i.test(e.getAttribute("data-tid"))).length,
  });
  const isEmpty = (d) => d.text === 0 && d.media === 0 && d.attachments === 0;

  // Channels. The open channel is identified by header controls tagged with its thread
  // id (or its posts' response surfaces) inside the single message pane.
  const q = (sel) => document.querySelector(sel);
  const byId = (prefix, id) => "[id=" + JSON.stringify(prefix + id) + "]";
  const channelPane = (id) => {
    const panes = document.querySelectorAll("[data-tid=message-pane-layout]");
    if (panes.length !== 1) return null;
    const tagged = [...document.querySelectorAll("[data-track-thread-id]")].some(
      (e) => e.getAttribute("data-track-thread-id") === id && !/send/i.test(e.getAttribute("data-tid") || ""),
    );
    return tagged || panes[0].querySelector(byId("response-surface-", id)) ? panes[0] : null;
  };
  // The new-post button has no data-tid; match its visible label, and only inside the post composer.
  const POST_LABELS = /^(Postar|Post|Publicar|Publier|Posten|Pubblica)$/i;
  // Composer for a target: {kind:"chat"} | {kind:"post"} | {kind:"reply", rootId}.
  const composerAt = (t) => {
    if (t.kind === "chat") return composerFor(t.conversationId);
    const pane = channelPane(t.conversationId);
    if (!pane) return null;
    if (t.kind === "reply") {
      const box = pane.querySelector(byId("reply-chain-summary-", t.rootId));
      if (!box) return null;
      const editors = box.querySelectorAll("[data-tid=ckeditor]");
      const buttons = [...box.querySelectorAll(SEND_BUTTONS)].filter((b) => b.getAttribute("data-track-thread-id") === t.conversationId);
      return editors.length === 1 && buttons.length === 1 ? { button: buttons[0], editor: editors[0], box } : null;
    }
    const layouts = pane.querySelectorAll("[data-tid=post-compose-layout]");
    if (layouts.length !== 1) return null;
    const box = layouts[0];
    const editors = box.querySelectorAll("[data-tid=ckeditor]");
    const buttons = [...box.querySelectorAll("button")].filter((b) => POST_LABELS.test((b.getAttribute("aria-label") || b.innerText || "").trim()));
    return editors.length === 1 && buttons.length === 1 ? { button: buttons[0], editor: editors[0], box } : null;
  };
`;

const wrap = (body: string) => `async (args) => {${PRELUDE}\n${body}\n}`;

/** All cached conversations, trimmed to the fields the CLI normalizes. */
export const LIST_CONVERSATIONS = wrap(String.raw`
  return withDb("conversation-manager", async (db, meId) => {
    const all = await req(db.transaction("conversations").objectStore("conversations").getAll());
    const spaces = {};
    for (const c of all) if (c.type === "Space") spaces[c.id] = c;
    const spaceName = (id) => (spaces[id] && spaces[id].threadProperties && spaces[id].threadProperties.spaceThreadTopic) || null;
    return {
      meId,
      conversations: all.map((c) => {
        const tp = c.threadProperties || {};
        const lm = c.lastMessage || {};
        const props = c.properties || {};
        return {
          id: c.id,
          type: c.type,
          topic: tp.topic || null,
          spaceName: c.type === "Space" ? tp.spaceThreadTopic || null : null,
          shortTitle: (c.chatTitle && c.chatTitle.shortTitle) || null,
          teamId: c.teamId || null,
          teamName: c.teamId ? spaceName(c.teamId) : null,
          lastTime: c.lastMessageTimeUtc || 0,
          lastId: lm.id || null,
          lastFrom: lm.fromUserId || lm.from || null,
          lastFromName: lm.imdisplayname || lm.fromDisplayNameInToken || null,
          lastType: lm.messagetype || null,
          lastContent: typeof lm.content === "string" ? lm.content.slice(0, 2000) : "",
          horizon: props.consumptionhorizon || null,
          members: Array.isArray(c.members) ? c.members.length : null,
          hidden: [props.isDeleted, props.isemptyconversation].some((v) => v === true || String(v).toLowerCase() === "true"),
        };
      }),
    };
  });
`);

/**
 * Latest reply chains of one conversation (a chain is a message plus its replies),
 * newest first, until `want` displayable messages are collected or `maxChains` is hit.
 */
export const LIST_MESSAGES = wrap(String.raw`
  return withDb("replychain-manager", async (db, meId) => {
    const index = db.transaction("replychains").objectStore("replychains").index("latestDeliveryTimeByConversationId");
    const range = IDBKeyRange.bound([args.conversationId, -Infinity], [args.conversationId, Infinity]);
    const totalChains = await req(index.count(range));
    const displayable = (m) => /^(RichText|Text$)/.test(m.messageType || "");
    const chains = [];
    let shown = 0;
    let hasMore = false;
    await new Promise((resolve, reject) => {
      const cur = index.openCursor(range, "prev");
      cur.onerror = () => reject(cur.error);
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        if (shown >= args.want || chains.length >= args.maxChains) { hasMore = true; return resolve(); }
        chains.push(c.value);
        shown += Object.values(c.value.messageMap || {}).filter(displayable).length;
        c.continue();
      };
    });
    const parse = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return null; } };
    const messages = [];
    for (const chain of chains) {
      for (const m of Object.values(chain.messageMap || {})) {
        const p = m.properties || {};
        const files = parse(p.files);
        messages.push({
          id: m.id,
          chainId: chain.replyChainId,
          isRoot: m.id === chain.replyChainId,
          time: m.originalArrivalTime || 0,
          fromId: m.creator || null,
          fromName: m.imDisplayName || m.fromDisplayNameInToken || null,
          fromMe: m.isSentByCurrentUser === true || m.creator === meId,
          type: m.messageType || null,
          content: typeof m.content === "string" ? m.content : "",
          subject: p.subject || null,
          files: Array.isArray(files) ? files.map((f) => f && f.fileName).filter(Boolean) : [],
          deleted: !!p.deletetime,
          edited: !!(m.skypeEditedId || p.edittime),
          clientMessageId: m.clientMessageId || null,
          state: m.state === undefined ? null : m.state,
          sendStatus: m.sendPipelineStatus || null,
          chainHorizon: chain.consumptionHorizon || null,
          reactions: (m.annotationsSummary && m.annotationsSummary.emotions) || null,
          reactionUsers: (() => {
            const e = parse(p.emotions);
            return Array.isArray(e) ? Object.fromEntries(e.filter((x) => typeof x.key === "string").map((x) => [x.key, (x.users || []).map((u) => u.mri).filter((id) => typeof id === "string")])) : {};
          })(),
          myReactions: (() => {
            const e = parse(p.emotions);
            return Array.isArray(e) ? e.filter((x) => (x.users || []).some((u) => u.mri === meId)).map((x) => x.key) : [];
          })(),
        });
      }
    }
    return { meId, totalChains, hasMore, messages };
  });
`);

/** Open a chat from the left rail by conversation id; resolves once its pane and composer are live. */
export const OPEN_CHAT = wrap(String.raw`
  const id = args.conversationId;
  if (!composerFor(id)) {
    const title = document.querySelector("[id=" + JSON.stringify("title-chat-list-item_" + id) + "]");
    if (!title) fail("NOT_IN_SIDEBAR", "Chat is not in the left rail (only listed chats can be opened for sending)");
    const item = title.closest("[role=treeitem]");
    if (!item) fail("NOT_IN_SIDEBAR", "Chat entry has no clickable tree item");
    act("click", () => item.click(), item);
  }
  await waitFor(() => composerFor(id), 8000, "the chat pane and its composer to switch to the target chat");
  return { ok: true };
`);

/** Paste HTML into the target chat's composer. Does not send. */
export const COMPOSE = wrap(String.raw`
  const t = args.target || { kind: "chat", conversationId: args.conversationId };
  const c = composerAt(t);
  if (!c) fail("WRONG_CHAT", "The target chat's composer is not the active one; nothing was changed");
  const before = draftOf(c);
  if (!isEmpty(before)) fail("COMPOSER_NOT_EMPTY", "The composer already has an unsent draft (" + JSON.stringify(before) + "); clear it in Teams first");
  act("focus", () => c.editor.focus(), c.editor);
  const data = new DataTransfer();
  data.setData("text/html", args.html);
  data.setData("text/plain", args.text);
  act("dispatch", () => c.editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })), c.editor);
  // Re-resolve: pasting a table can swap the compact composer for the expanded one.
  const landed = await waitFor(() => { const n = composerAt(t); return n && !isEmpty(draftOf(n)) ? n : null; }, 5000, "the pasted content to land in the composer");
  return { draft: draftOf(landed) };
`);

/**
 * Click send for the target chat. Every check happens before the click, which is the
 * last statement: a coded error here always means the message was not sent.
 */
export const CLICK_SEND = wrap(String.raw`
  const t = args.target || { kind: "chat", conversationId: args.conversationId };
  // Pasting a table swaps the compact composer for the expanded one; let it settle.
  const c = await waitFor(() => composerAt(t), 3000, "the target's send button");
  if (isEmpty(draftOf(c))) fail("DRAFT_LOST", "The composed message is no longer in the composer; nothing was sent");
  if (c.button.disabled || c.button.getAttribute("aria-disabled") === "true") fail("SEND_DISABLED", "The send button is disabled; nothing was sent");
  act("click", () => c.button.click(), c.button);
  return { clicked: c.button.getAttribute("data-tid") };
`);

/** Focus and select the global search box, so typed text replaces any previous query. */
export const SEARCH_FOCUS = wrap(String.raw`
  const input = document.querySelector("#ms-searchux-input");
  if (!input) fail("UI_CHANGED", "Search box not found");
  act("focus", () => input.focus(), input);
  act("select", () => input.select(), input);
  return { ok: document.activeElement === input };
`);

/**
 * Pick the people suggestion whose data-tid carries the exact MRI (never a text match),
 * then wait for that conversation's pane and composer. The click is the only mutation.
 */
export const SEARCH_PICK = wrap(String.raw`
  const tid = "AUTOSUGGEST_SUGGESTION_TOPHITS" + args.peer;
  const option = await waitFor(() => document.querySelector("[data-tid=" + JSON.stringify(tid) + "]"), 6000, "a search suggestion for that exact person");
  act("click", () => option.click(), option);
  await waitFor(() => composerFor(args.conversationId), 8000, "the searched chat's pane and composer");
  return { ok: true };
`);

/** Open a channel from the left rail by id; resolves once its message pane is the open one. */
export const OPEN_CHANNEL = wrap(String.raw`
  const id = args.conversationId;
  if (!channelPane(id)) {
    const title = q(byId("title-channel-list-item-", id));
    if (!title) fail("NOT_IN_SIDEBAR", "Channel is not in the left rail (hidden channel or collapsed team)");
    const item = title.closest("[role=treeitem]");
    if (!item) fail("NOT_IN_SIDEBAR", "Channel entry has no clickable tree item");
    act("click", () => item.click(), item);
  }
  await waitFor(() => channelPane(id), 8000, "the channel pane to switch to the target channel");
  return { ok: true };
`);

/** Open the composer for a new post or for a reply to one root post. The click is the only mutation. */
export const OPEN_CHANNEL_COMPOSER = wrap(String.raw`
  const t = args.target;
  const pane = channelPane(t.conversationId);
  if (!pane) fail("WRONG_CHAT", "The open channel is not the target channel; nothing was changed");
  if (composerAt(t)) return { ok: true, reused: true };
  if (t.kind === "reply") {
    const box = pane.querySelector(byId("reply-chain-summary-", t.rootId));
    if (!box) fail("NOT_REACHABLE", "That post is not rendered in the channel view (too old or scrolled away)");
    const placeholder = box.querySelector("[data-tid=quick-reply-placeholder-reply]");
    if (!placeholder) fail("UI_CHANGED", "Reply control not found on that post");
    act("click", () => placeholder.click(), placeholder);
  } else {
    const start = pane.querySelector("[data-tid=compose-start-post]") || q("[data-tid=compose-start-post]");
    if (!start) fail(q("[data-tid=post-compose-disabled]") ? "NOT_ALLOWED" : "UI_CHANGED", q("[data-tid=post-compose-disabled]") ? "Posting is disabled in this channel" : "New post control not found");
    act("click", () => start.click(), start);
  }
  await waitFor(() => composerAt(t), 6000, "the " + t.kind + " composer to open");
  return { ok: true, reused: false };
`);

/** Resolve a message id to its thread root within one conversation (cache only). */
export const FIND_ROOT = wrap(String.raw`
  return withDb("replychain-manager", async (db) => {
    const store = db.transaction("replychains").objectStore("replychains");
    const direct = await req(store.get([args.conversationId, args.messageId]));
    if (direct) return { rootId: direct.replyChainId };
    const hit = await req(store.index("byMessageSearchKeys").get(args.conversationId + "_" + args.messageId));
    return hit ? { rootId: hit.replyChainId } : null;
  });
`);

// ---------------------------------------------------------------- editing a sent message
//
// The hover toolbar (with the Edit button) is a floating portal outside the message item,
// and a stale toolbar of another message can linger. So the Edit button is only a hint:
// what binds an edit to a message is the edit editor living in the chat-pane-item that
// holds [data-mid=<id>].

const EDIT_HELPERS = String.raw`
  const msgEl = (mid) => document.querySelector("[data-tid=chat-pane-message][data-mid=" + JSON.stringify(mid) + "]");
  const openEditors = () => [...document.querySelectorAll("[data-tid=ckeditor]")].filter((e) => !e.closest("[data-tid=chat-pane-compose-message-footer]"));
  const itemMids = (el) => { const item = el && el.closest("[data-tid=chat-pane-item]"); return item ? [...item.querySelectorAll("[data-mid]")].map((x) => x.getAttribute("data-mid")) : []; };
  // The single open edit editor, and whether it belongs to mid.
  const editState = (mid) => {
    const eds = openEditors();
    if (eds.length === 0) return { open: false };
    if (eds.length > 1) return { open: true, ambiguous: true };
    const ed = eds[0];
    const item = ed.closest("[data-tid=chat-pane-item]");
    const done = item ? [...item.querySelectorAll("[data-tid=newMessageCommands-send]")] : [];
    return { open: true, bound: itemMids(ed).includes(mid), ed, item, done: done.length === 1 ? done[0] : null };
  };
`;

const wrapEdit = (body: string) => wrap(`${EDIT_HELPERS}\n${body}`);

/** The portal id and Tabster identity bind the action to a message before the click. */
export const REACT_CLICK = wrapEdit(String.raw`
  if (!document.getElementById("chat-header-" + args.conversationId)) fail("WRONG_CHAT", "The requested chat is no longer open");
  if (!msgEl(args.mid)) fail("NOT_REACHABLE", "The message is no longer rendered");
  await waitFor(() => document.getElementById(args.mid + "-popover-surface"), 3000, "the target message toolbar");
  const boxes = [...document.querySelectorAll("[data-tid=message-actions-container]")].filter((e) => e.id === args.mid + "-popover-surface");
  if (boxes.length !== 1) fail("WRONG_MESSAGE", "No unique action toolbar belongs to this message");
  const box = boxes[0];
  let identity;
  try { identity = JSON.parse(box.getAttribute("data-tabster") || "{}").modalizer.id; } catch {}
  if (identity !== args.mid + "-Main") fail("WRONG_MESSAGE", "The toolbar identity does not match the message");
  const buttons = [...box.querySelectorAll("[data-tid=message-reactions-toolbar] button[data-tid]")].filter((b) => b.getAttribute("data-tid") === "message-actions-" + args.key);
  if (buttons.length !== 1) fail("REACTION_UNAVAILABLE", "This reaction is not available in the message toolbar");
  const button = buttons[0], r = button.getBoundingClientRect();
  if (!r.width || !r.height || button.disabled || !button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) fail("UI_CHANGED", "The reaction button is hidden or covered");
  const pressed = button.getAttribute("aria-pressed");
  if (pressed !== "true" && pressed !== "false") fail("UI_CHANGED", "The reaction state is unknown");
  if ((pressed === "true") === args.present) return { clicked: false };
  act("click", () => button.click(), button);
  return { clicked: true };
`);

/** Scroll the message into view and report where to hover. Refuses if an edit is already open. */
export const EDIT_LOCATE = wrapEdit(String.raw`
  if (openEditors().length) fail("EDIT_IN_PROGRESS", "Another message is being edited in Teams; finish or cancel it first");
  const m = msgEl(args.mid);
  if (!m) fail("NOT_REACHABLE", "The message is not rendered in the open chat (too old to be loaded)");
  act("scroll", () => m.scrollIntoView({ block: "center", behavior: "instant" }), m);
  await sleep(300);
  const r = m.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(12, r.height / 2)), top: r.top, bottom: r.bottom };
`);

/** After hovering: the visible Edit button nearest to the message, hit-tested at its centre. */
export const EDIT_BUTTON = wrapEdit(String.raw`
  const m = msgEl(args.mid);
  if (!m) fail("NOT_REACHABLE", "The message disappeared from the view");
  const mr = m.getBoundingClientRect();
  const candidates = [...document.querySelectorAll("[data-tid=message-actions-edit]")]
    .map((b) => ({ b, r: b.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0 && r.bottom >= mr.top - 60 && r.top <= mr.bottom)
    .sort((a, b) => Math.abs(a.r.bottom - mr.top) - Math.abs(b.r.bottom - mr.top));
  if (!candidates.length) fail("NOT_EDITABLE", "No Edit action appeared for this message (not yours, or Teams does not allow editing it)");
  const { r } = candidates[0];
  const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(x, y);
  const btn = hit && hit.closest("button");
  if (!btn || btn.getAttribute("data-tid") !== "message-actions-edit") fail("UI_CHANGED", "The Edit button is covered by another element");
  return { x, y };
`);

/** Wait for the edit editor; report whether it belongs to the target message. */
export const EDIT_BOUND = wrapEdit(String.raw`
  const st = await waitFor(() => { const s = editState(args.mid); return s.open ? s : null; }, 4000, "the edit box to open");
  if (st.ambiguous) return { bound: false, reason: "several edit boxes are open" };
  if (!st.bound) return { bound: false, reason: "the edit box that opened belongs to another message" };
  if (!st.done) return { bound: false, reason: "the edit box has no unique save button" };
  act("focus", () => st.ed.focus(), st.ed);
  return { bound: true, text: st.ed.innerText };
`);

/** Is the bound edit editor empty (after Ctrl+A, Backspace)? */
export const EDIT_CLEARED = wrapEdit(String.raw`
  const st = editState(args.mid);
  if (!st.open || !st.bound) fail("WRONG_MESSAGE", "The edit box is no longer the target message's");
  return { empty: st.ed.innerText.trim() === "" && !st.ed.querySelector("img, table, figure, video") };
`);

/** Paste the new content into the bound, empty edit editor and return what it now holds. */
export const EDIT_PASTE = wrapEdit(String.raw`
  const st = editState(args.mid);
  if (!st.open || !st.bound) fail("WRONG_MESSAGE", "The edit box is no longer the target message's");
  if (st.ed.innerText.trim() !== "") fail("EDIT_NOT_CLEARED", "The edit box still has the old text");
  act("focus", () => st.ed.focus(), st.ed);
  const data = new DataTransfer();
  data.setData("text/html", args.html);
  data.setData("text/plain", args.text);
  act("dispatch", () => st.ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })), st.ed);
  await waitFor(() => st.ed.innerText.trim() !== "", 4000, "the new content to land in the edit box");
  return { text: st.ed.innerText };
`);

/** Save the edit. All checks come first; the click is the last statement. */
export const EDIT_SAVE = wrapEdit(String.raw`
  const st = editState(args.mid);
  if (!st.open || !st.bound || !st.done) fail("WRONG_MESSAGE", "The edit box is no longer the target message's; nothing was saved");
  act("click", () => st.done.click(), st.done);
  return { ok: true };
`);

/** Close any open edit box without saving (Cancel, then confirm the discard dialog). */
export const EDIT_CANCEL = wrapEdit(String.raw`
  for (const ed of openEditors()) {
    const item = ed.closest("[data-tid=chat-pane-item]");
    const cancel = item && item.querySelector("[data-tid=newMessageCommands-discard-draft]");
    if (cancel) act("click", () => cancel.click(), cancel);
    const confirm = await waitFor(() => document.querySelector("[data-tid=messagedraft-discard-confirm]") || (openEditors().length === 0 ? "closed" : null), 3000, "the discard confirmation");
    if (confirm !== "closed") act("click", () => confirm.click(), confirm);
  }
  await waitFor(() => openEditors().length === 0, 3000, "the edit box to close");
  return { closed: true };
`);

/** One cached message by id (for the edit command's before/after checks). */
export const GET_MESSAGE = wrap(String.raw`
  return withDb("replychain-manager", async (db, meId) => {
    const store = db.transaction("replychains").objectStore("replychains");
    const chain = (await req(store.get([args.conversationId, args.mid]))) || (await req(store.index("byMessageSearchKeys").get(args.conversationId + "_" + args.mid)));
    const m = chain && chain.messageMap && Object.values(chain.messageMap).find((x) => x.id === args.mid);
    if (!m) return null;
    const p = m.properties || {};
    return {
      id: m.id, chainId: chain.replyChainId, isRoot: m.id === chain.replyChainId, time: m.originalArrivalTime || 0,
      fromId: m.creator || null, fromName: m.imDisplayName || null, fromMe: m.isSentByCurrentUser === true || m.creator === meId,
      type: m.messageType || null, content: typeof m.content === "string" ? m.content : "", subject: p.subject || null,
      files: [], deleted: !!p.deletetime, edited: !!(m.skypeEditedId || p.edittime), editedAt: m.skypeEditedId || p.edittime || null,
      reactions: (m.annotationsSummary && m.annotationsSummary.emotions) || null,
      myReactions: (() => { let e = p.emotions; if (typeof e === "string") { try { e = JSON.parse(e); } catch { e = null; } } return Array.isArray(e) ? e.filter((x) => (x.users || []).some((u) => u.mri === meId)).map((x) => x.key) : []; })(),
    };
  });
`);

/**
 * Read-only self-check of everything teams-cli relies on: the local cache and the UI
 * contract. It makes no network request and touches no credential.
 */
export const DOCTOR = wrap(String.raw`
  const checks = [];
  const add = (area, name, ok, detail) => checks.push({ area, name, ok: !!ok, detail: detail || "" });
  // Cache databases, stores and indexes.
  const names = (await indexedDB.databases()).map((d) => d.name);
  const need = { "conversation-manager": { conversations: [] }, "replychain-manager": { replychains: ["latestDeliveryTimeByConversationId", "byMessageSearchKeys"] } };
  for (const [kind, stores] of Object.entries(need)) {
    let db = null;
    try { ({ db } = await openDb(kind)); } catch (e) { add("cache", kind, false, String(e.message).replace(/^.*TEAMS_CLI:[A-Z_]+:/, "")); continue; }
    for (const [store, idx] of Object.entries(stores)) {
      const has = db.objectStoreNames.contains(store);
      add("cache", kind + "/" + store, has, has ? "" : "store missing");
      if (has) { const s = db.transaction(store).objectStore(store); for (const i of idx) add("cache", kind + "/" + store + "#" + i, s.indexNames.contains(i), ""); }
    }
    db.close();
  }
  add("cache", "account", activeAccount(), activeAccount() ? "" : "signed-in account not visible in the left rail");
  // UI contract (the parts that must exist without opening anything).
  add("ui", "left rail chat items", document.querySelector("[id^=title-chat-list-item_]"), "title-chat-list-item_<id>");
  add("ui", "left rail channel items", document.querySelector("[id^=title-channel-list-item-]"), "title-channel-list-item-<id>");
  add("ui", "chat pane header", document.querySelector("[id^=chat-header-]") || document.querySelector("[data-tid=message-pane-layout]"), "chat-header-<id> (chat open) or message-pane-layout");
  add("ui", "composer", document.querySelector("[data-tid=ckeditor]"), "data-tid=ckeditor");
  add("ui", "send button tagged with thread", document.querySelector("[data-tid=sendMessageCommands-send][data-track-thread-id], [data-tid=newMessageCommands-send][data-track-thread-id]"), "data-track-thread-id");
  add("ui", "search box", document.querySelector("#ms-searchux-input"), "#ms-searchux-input");
  return { checks, lang: document.documentElement.lang, focused: document.hasFocus() };
`);

/**
 * The activity feed (mentions, replies, reactions to you) from the local cache, newest
 * first, joined with the source message when it is cached.
 */
export const LIST_ACTIVITY = wrap(String.raw`
  const feed = await withDb("activity-manager", async (db) => req(db.transaction("feed-items").objectStore("feed-items").getAll()));
  feed.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const items = feed.filter((f) => !args.unread || !f.isRead).slice(0, args.limit);
  const total = feed.length, unread = feed.filter((f) => !f.isRead).length;
  const rows = await withDb("replychain-manager", async (db, meId) => {
    const store = db.transaction("replychains").objectStore("replychains");
    const out = [];
    for (const f of items) {
      let m = null;
      const chain = f.sourceThreadId && f.sourceReplyChainId ? await req(store.get([f.sourceThreadId, f.sourceReplyChainId])) : null;
      if (chain && chain.messageMap) m = Object.values(chain.messageMap).find((x) => x.id === f.sourceMessageId) || null;
      out.push({
        id: f.activityId, type: f.activityType || "", subtype: f.activitySubtype || "", time: f.timestamp || 0, read: !!f.isRead,
        threadId: f.sourceThreadId || null, messageId: f.sourceMessageId || null, rootId: f.sourceReplyChainId || null,
        fromName: m ? (m.imDisplayName || m.fromDisplayNameInToken || null) : null,
        fromMe: m ? (m.isSentByCurrentUser === true || m.creator === meId) : false,
        messageType: m ? m.messageType : null, content: m && typeof m.content === "string" ? m.content.slice(0, 4000) : null,
      });
    }
    return out;
  });
  return { total, unread, rows };
`);

/**
 * Full-text search over cached messages, done page-side so only matches travel.
 * Every term must appear (case- and accent-insensitive). Newest first.
 */
export const SEARCH_MESSAGES = wrap(String.raw`
  const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const strip = (html) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
  const terms = fold(args.query).split(/\s+/).filter(Boolean);
  return withDb("replychain-manager", async (db, meId) => {
    const store = db.transaction("replychains").objectStore("replychains");
    const chains = args.conversationId
      ? await req(store.index("latestDeliveryTimeByConversationId").getAll(IDBKeyRange.bound([args.conversationId, -Infinity], [args.conversationId, Infinity])))
      : await req(store.getAll());
    const hits = [];
    let scanned = 0;
    for (const chain of chains) {
      for (const m of Object.values(chain.messageMap || {})) {
        if (!/^(RichText|Text$)/.test(m.messageType || "") || typeof m.content !== "string") continue;
        scanned++;
        const text = strip(m.content);
        const folded = fold(text);
        if (!terms.every((t) => folded.includes(t))) continue;
        const at = Math.max(0, folded.indexOf(terms[0]) - 60);
        hits.push({
          conversationId: chain.conversationId, id: m.id, chainId: chain.replyChainId, time: m.originalArrivalTime || 0,
          fromName: m.imDisplayName || m.fromDisplayNameInToken || null, fromMe: m.isSentByCurrentUser === true || m.creator === meId,
          snippet: (at > 0 ? "…" : "") + text.slice(at, at + 220) + (text.length > at + 220 ? "…" : ""),
        });
      }
    }
    hits.sort((a, b) => b.time - a.time);
    return { scanned, total: hits.length, hits: hits.slice(0, args.limit) };
  });
`);

/** Is the user working in Teams right now? Focus, visibility and the open composer's draft. */
export const USER_STATE = wrap(String.raw`
  const editor = document.querySelector("[data-tid=chat-pane-compose-message-footer] [data-tid=ckeditor]") || document.querySelector("[data-tid=ckeditor]");
  const draft = editor ? editor.innerText.trim().length > 0 || !!editor.querySelector("img, table, figure") : false;
  const header = document.querySelector("[id^=chat-header-]");
  return {
    focused: document.hasFocus(),
    visible: document.visibilityState === "visible",
    draft,
    openConversation: header ? header.id.slice("chat-header-".length) : null,
  };
`);

/**
 * Presence as the left rail shows it: each chat entry's accessible name is
 * "Chat <title> <status>", and 1:1 entries carry a presence badge with the person's id.
 */
export const LIST_PRESENCE = wrap(String.raw`
  const rows = [];
  for (const title of document.querySelectorAll("[id^=title-chat-list-item_]")) {
    const conversationId = title.id.slice("title-chat-list-item_".length);
    const item = title.closest("[role=treeitem]");
    if (!item) continue;
    const badge = item.querySelector("[id^=presence-pill-]");
    const label = (item.getAttribute("aria-label") || item.innerText || "").replace(/\s+/g, " ").trim();
    rows.push({ conversationId, title: title.textContent.trim(), label, mri: badge ? badge.id.slice("presence-pill-".length) : null, badgeLabel: badge ? badge.getAttribute("aria-label") || badge.getAttribute("title") : null });
  }
  return rows;
`);

/** People seen in cached conversations (from each chat's avatar/participant info). */
export const LIST_PEOPLE = wrap(String.raw`
  return withDb("conversation-manager", async (db, meId) => {
    const all = await req(db.transaction("conversations").objectStore("conversations").getAll());
    const people = {};
    for (const c of all) {
      const infos = (c.chatTitle && c.chatTitle.avatarUsersInfo) || [];
      for (const u of infos) {
        if (!u || !u.mri || u.mri === meId) continue;
        const p = people[u.mri] || (people[u.mri] = { mri: u.mri, name: u.displayName || null, email: u.email || null, chats: 0, lastTime: 0 });
        p.chats++;
        p.lastTime = Math.max(p.lastTime, c.lastMessageTimeUtc || 0);
        if (!p.name && u.displayName) p.name = u.displayName;
        if (!p.email && u.email) p.email = u.email;
      }
    }
    return Object.values(people);
  });
`);

/** Call history from the local cache (who, when, direction, outcome, length). */
export const LIST_CALLS = wrap(String.raw`
  const all = await withDb("call-history-manager", async (db) => req(db.transaction("call-history").objectStore("call-history").getAll()));
  return all.filter((c) => !c.isDeleted).map((c) => ({
    start: c.startTime || null, connect: c.connectTime || null, end: c.endTime || null,
    direction: c.callDirection || null, type: c.callType || null, state: c.callState || null,
    originator: (c.originatorParticipant && c.originatorParticipant.displayName) || null,
    target: (c.targetParticipant && c.targetParticipant.displayName) || null,
    group: c.groupChatThreadId || null,
  }));
`);

/** Attachment identities from one cached message; signed URLs never leave the page. */
export const LIST_ATTACHMENTS = wrap(String.raw`
  return withDb("replychain-manager", async (db) => {
    const store = db.transaction("replychains").objectStore("replychains");
    const chain = (await req(store.get([args.conversationId, args.mid]))) || (await req(store.index("byMessageSearchKeys").get(args.conversationId + "_" + args.mid)));
    const m = chain && Object.values(chain.messageMap || {}).find((m) => m.id === args.mid);
    if (!m) fail("MESSAGE_NOT_FOUND", "The message is not in this conversation's cache");
    let files = m.properties && m.properties.files;
    try { if (typeof files === "string") files = JSON.parse(files); } catch { fail("CACHE_UNAVAILABLE", "Attachment metadata is unreadable"); }
    if (!Array.isArray(files)) return [];
    return files.map((f, i) => {
      let origin = null, path = null;
      try { const u = new URL(f.objectUrl || (f.fileInfo && f.fileInfo.fileUrl)); origin = u.origin; path = decodeURIComponent(u.pathname); } catch {}
      const id = (f.sharepointIds && f.sharepointIds.listItemUniqueId) || f.itemid || f.id;
      return { index: i + 1, id: typeof id === "string" ? id : null, name: f.fileName || f.title || "unnamed", type: f.fileType || "", origin, path };
    });
  });
`);

/** Open only the file tile bound by conversation, message, index, name and object path. */
export const OPEN_ATTACHMENT = wrap(String.raw`
  const bound = () => args.channel ? channelPane(args.conversationId) : paneIs(args.conversationId);
  if (!bound()) fail("WRONG_CHAT", "The requested conversation is not open");
  let msg = null;
  for (let step = 0; step < 20; step++) {
    if (!bound()) fail("WRONG_CHAT", "The conversation changed while locating its file");
    msg = document.querySelector("[data-mid=" + JSON.stringify(args.mid) + "]");
    if (msg) break;
    const viewport = document.querySelector("[data-tid=message-pane-list-viewport]");
    if (!viewport) break;
    act("scroll", () => { viewport.scrollTop = Math.max(0, viewport.scrollTop - viewport.clientHeight * 0.8); }, viewport);
    await sleep(200);
  }
  if (!msg) fail("NOT_REACHABLE", "The attachment's message is not rendered; open it in Teams and retry");
  let box = msg;
  for (let i = 0; box && i < 8 && !box.querySelector("[data-tid=file-attachment-grid]"); i++) box = box.parentElement;
  if (!box || [...box.querySelectorAll("[data-mid]")].some((e) => e.getAttribute("data-mid") !== args.mid)) fail("WRONG_MESSAGE", "Attachment grid is not bound to the selected message");
  const tiles = [...box.querySelectorAll("[data-tid=file-attachment-grid] [role=group][index]")].filter((e) => {
    if (Number(e.getAttribute("index")) !== args.file.index - 1 || e.getAttribute("aria-label") !== args.file.name) return false;
    const title = e.querySelector("[data-testid=content-card-custom-title]");
    const label = title && title.getAttribute("aria-label");
    try { const u = new URL(label.slice(label.indexOf("\n") + 1)); return u.origin === args.file.origin && decodeURIComponent(u.pathname) === args.file.path; } catch { return false; }
  });
  if (tiles.length !== 1) fail("ATTACHMENT_UNAVAILABLE", "No unique file tile matches the cached attachment identity");
  const tile = tiles[0];
  act("scroll", () => tile.scrollIntoView({ block: "center", behavior: "instant" }), tile);
  act("focus", () => tile.focus(), tile);
  act("dispatch", () => tile.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })), tile);
  return { opened: true };
`);
