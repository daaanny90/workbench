// Workbench: the team's Jira kanban boards with their own columns, opened as a dialog
// (keys.json: "cmd-shift-b": "mod.open:workbench").
// - Clients: one profile per client (PROFILES), chosen by the folder of the terminal you were in. It
//   says which tracker, which boards, and which Keychain item holds the token.
// - Data: Jira's REST API through curl in zsh; zsh reads the token from the Keychain, so it never
//   reaches this script. Everything is read with GET; the only writes are a status move or a comment,
//   from the panel under the board, each after a confirmation.
// - Columns, statuses and the sub-filter come from each board's configuration, so board changes show up.
// - Swimlanes follow each board's grouping (stories, queries, projects); without it, plain columns.
// - Start: the agent button runs `roger open <key>` in the folder of the terminal you were in, like the
//   roger dialog (mods/roger); when roger asks which project or branch, its options become buttons.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { props, openOverlay, closeOverlay, theme, focused, spaces, exec, home, notify, readTextFile, run } from "herdr";

// One workbench.json per client, next to its code. See README.md for what goes in it
const PROFILES = "~/clients/*/workbench.json";
const FIELDS = "summary,status,assignee,priority,issuetype,parent,project";
const PAGE = 100;
const MAX_ISSUES = 500;
const REFRESH_MS = 60_000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// The last useful line of a failed program: Jira's error messages when it sent JSON, else stderr
function failure(r, name) {
  try {
    const body = JSON.parse(r.stdout);
    const messages = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})];
    if (messages.length) return messages.join(" ");
  } catch {}
  const last = (text) => (text ?? "").trim().split("\n").filter(Boolean).at(-1);
  return (last(r.stderr) ?? last(r.stdout) ?? `${name} exited with ${r.code}`).replace(/^roger: /, "");
}

// zsh takes the token from the Keychain item the profile names ($3) and gives it to curl through a
// config pipe: it never reaches this script nor curl's command line ($1 site, $2 user, $4 path)
const AUTH = 'tok=$(security find-generic-password -s workbench -a "$3" -w 2>/dev/null)'
  + ' || { print -u2 "the Keychain has no workbench item \\"$3\\""; exit 1; }; '
  + 'auth() { print -r -- "user = \\"$2:$tok\\"" }; ';

async function curl(script, args) {
  let r;
  try { r = await exec("/bin/zsh", ["-c", AUTH + script, "zsh", ...args], { cwd: home(), timeout: 30_000 }); }
  catch (error) { throw new Error(`Jira is unreachable: ${error}`); }
  if (r.code !== 0) {
    const why = failure(r, "curl");
    throw new Error(/error: 401\b/.test(why) ? `${why}: is the token in the Keychain item "${args[2]}" right?` : why);
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;   // a transition answers 204, no body
}

// GET <site><path>?<params>
async function jira(tracker, path, params = {}) {
  const query = Object.entries(params).flatMap(([k, v]) => ["--data-urlencode", `${k}=${v}`]);
  return curl('exec curl -sS --fail-with-body --max-time 25 -K <(auth "$@") -G "$1$4" "${@:5}"',
    [tracker.site, tracker.user, tracker.keychain, path, ...query]);
}

// POST <site><path> with a JSON body (never starts with "@", so curl never reads a file)
async function jiraPost(tracker, path, body) {
  return curl('exec curl -sS --fail-with-body --max-time 25 -K <(auth "$@") -X POST -H "Content-Type: application/json"'
    + ' -H "Accept: application/json" --data-binary "$5" "$1$4"', [tracker.site, tracker.user, tracker.keychain, path, JSON.stringify(body)]);
}

// Every client's profile, { file, name, tracker }, or { file, error } when it can't be read
async function loadProfiles() {
  const r = await exec("/bin/zsh", ["-c", `print -rl -- ${PROFILES}(N)`], { cwd: home() });
  const profiles = [];
  for (const file of (r.stdout ?? "").split("\n").filter(Boolean)) {
    try { profiles.push({ file, ...JSON.parse(await readTextFile(file)) }); }
    catch (error) { profiles.push({ file, error: `${file.replace(home(), "~")}: ${error?.message ?? error}` }); }
  }
  return profiles;
}

// The client whose folders hold the terminal you were in (by default, the profile's own folder);
// anywhere else, the first one
function clientFor(profiles, cwd) {
  const usable = profiles.filter((p) => !p.error && p.tracker);
  const inside = (folder) => { const f = folder.replace(/^~/, home()); return cwd === f || cwd.startsWith(`${f}/`); };
  return usable.find((p) => (p.folders ?? [p.file.replace(/\/[^/]+$/, "")]).some(inside)) ?? usable[0] ?? null;
}

// The board's visible columns and the JQL that fetches only their issues
async function boardConfig(tracker, board) {
  const c = await jira(tracker, `/rest/agile/1.0/board/${board.id}/configuration`);
  const hiddenColumns = new Set(tracker.hiddenColumns ?? []);
  const hiddenProjects = tracker.hiddenProjects ?? [];   // e.g. another team's tickets on the same boards
  const columns = c.columnConfig.columns
    .filter((col) => !hiddenColumns.has(col.name) && col.statuses.length)
    .map((col) => ({ name: col.name, statuses: col.statuses.map((s) => s.id) }));
  const sub = c.subQuery?.query;
  const jql = `status in (${columns.flatMap((col) => col.statuses).join(",")})` + (sub ? ` AND (${sub})` : "")
    + (hiddenProjects.length ? ` AND project not in (${hiddenProjects.join(",")})` : "");
  return { columns, jql };
}

// The board endpoint adds the board's own filter and keeps its rank order
async function boardIssues(tracker, board, config) {
  const issues = [];
  let total = 0;
  for (let startAt = 0; startAt < MAX_ISSUES; startAt += PAGE) {
    const page = await jira(tracker, `/rest/agile/1.0/board/${board.id}/issue`, { jql: config.jql, fields: FIELDS, startAt, maxResults: PAGE });
    total = page.total ?? 0;
    issues.push(...(page.issues ?? []));
    if (!page.issues?.length || issues.length >= total) break;
  }
  return { issues, total };
}

// How the board groups and draws its issues, from the data Jira's own board page loads. It's an internal
// endpoint: when it fails the board keeps its last version, or shows plain columns and plain cards.
// Query lanes come with Jira's own assignment of issues, first matching query wins; each card brings
// the board's extra fields (deployment flags, status, reviewer) and its epic
async function boardPage(tracker, board) {
  const data = await jira(tracker, "/rest/greenhopper/1.0/xboard/work/allData.json", { rapidViewId: board.id });
  const s = data.swimlanesData ?? {};
  const plain = (html) => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  return {
    strategy: s.swimlaneStrategy,
    custom: (s.customSwimlanesData?.swimlanes ?? []).map((l) => ({ id: String(l.id), name: l.name, ids: new Set((l.issueIds ?? []).map(String)) })),
    cards: new Map((data.issuesData?.issues ?? []).map((i) => [String(i.id), {
      lines: (i.extraFields ?? []).map((f) => f.text || plain(f.html ?? "")).filter(Boolean),
      epic: i.epicField ? { name: i.epicField.text ?? i.epicField.summary ?? "", color: EPIC_COLORS[i.epicField.color] ?? EPIC_COLORS.grey } : null,
    }])),
  };
}

// Jira's epic label colors by name
const EPIC_COLORS = {
  blue: "#579dff", dark_blue: "#0c66e4", green: "#4bce97", dark_green: "#1f845a", teal: "#6cc3e0", dark_teal: "#227d9b",
  yellow: "#e2b203", dark_yellow: "#b38600", orange: "#fea362", dark_orange: "#c25100", red: "#f87168", dark_red: "#c9372c",
  purple: "#9f8fef", dark_purple: "#6e5dc6", grey: "#8590a2", dark_grey: "#626f86",
};
const AVATAR_COLORS = ["#579dff", "#4bce97", "#e2b203", "#fea362", "#f87168", "#9f8fef", "#6cc3e0", "#e774bb"];

// The issue type's color, as on Jira's icons
function typeColor(type) {
  const name = type?.name ?? "";
  if (/bug/i.test(name)) return "#e5493a";
  if (/story/i.test(name)) return "#63ba3c";
  if (/epic|ops/i.test(name)) return "#904ee2";
  return "#4bade8";
}

// Jira's priority arrows, by the standard names; a profile maps its own ones ("priorityAliases"),
// anything else has none
function priorityMark(name = "", aliases = {}) {
  const level = aliases[name] ?? name;
  if (/highest|blocker|critical/i.test(level)) return { glyph: "↑↑", color: "#e5493a" };
  if (/high|major/i.test(level)) return { glyph: "↑", color: "#f15c45" };
  if (/medium/i.test(level)) return { glyph: "=", color: "#f5a623" };
  if (/lowest|trivial/i.test(level)) return { glyph: "↓↓", color: "#4bade8" };
  if (/low|minor/i.test(level)) return { glyph: "↓", color: "#4bade8" };
  return null;
}

// The comment for Jira: each mention chip becomes [~accountid:…], which notifies that person. Token
// ranges count like JavaScript strings, so umlauts and emoji before a chip don't shift it
function commentBody(content) {
  let text = content.text;
  for (const { range, token } of [...content.tokens].sort((a, b) => b.range.start - a.range.start)) {
    text = text.slice(0, range.start) + `[~accountid:${token.id}]` + text.slice(range.end);
  }
  return text.trim();
}

// For matching names as typed: "jurg" finds "Jürgen"
function fold(text) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// "Ada Lovelace / ACME" -> "AL"
function initials(name) {
  return name.split(" / ")[0].split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

// The issues as the board's lanes, in Jira's order: [{ id, name?, parent?, issues }]. One lane without
// a name is the plain board
function lanes(swim, issues) {
  const rest = (list) => ({ id: "other", name: "Everything else", issues: list });
  if (swim?.strategy === "parentChild") {
    // Only subtasks: stories under an epic have a parent too. A story with subtasks is its lane, not a card
    const byParent = new Map();
    for (const i of issues) {
      const p = i.fields?.parent;
      if (!i.fields?.issuetype?.subtask || !p) continue;
      if (!byParent.has(p.id)) byParent.set(p.id, { id: p.key, parent: p, issues: [] });
      byParent.get(p.id).issues.push(i);
    }
    // In the stories' own rank order, as Jira does; a story that isn't on the board after them
    const rank = new Map(issues.map((i, n) => [i.id, n]));
    const place = (id) => rank.get(id) ?? issues.length;
    const parents = [...byParent.keys()].sort((a, b) => place(a) - place(b));
    const others = issues.filter((i) => !byParent.has(i.id) && !(i.fields?.issuetype?.subtask && byParent.has(i.fields?.parent?.id)));
    return [...parents.map((id) => byParent.get(id)), rest(others)];
  }
  if (swim?.strategy === "custom" && swim.custom.length) {
    const list = swim.custom.map((l) => ({ id: l.id, name: l.name, issues: issues.filter((i) => l.ids.has(i.id)) }));
    // Newer than Jira's assignment: the last lane is the board's catch-all
    const placed = new Set(list.flatMap((l) => l.issues.map((i) => i.id)));
    list.at(-1).issues.push(...issues.filter((i) => !placed.has(i.id)));
    return list;
  }
  if (swim?.strategy === "project") {
    const byProject = new Map();
    for (const i of issues) {
      const p = i.fields?.project ?? { key: "?", name: "No project" };
      if (!byProject.has(p.key)) byProject.set(p.key, { id: p.key, name: `${p.name} (${p.key})`, issues: [] });
      byProject.get(p.key).issues.push(i);
    }
    return [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }
  return [{ id: "all", issues }];
}

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const SIDE_FIELDS = "summary,status,priority,issuetype,assignee";
const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;

export default class Workbench extends View {
  init(initial, cx) {
    this.view = props()?.view ?? initial?.view ?? null;   // "sidebar": a layout's column; else the dialog
    if (this.view) return this.initSide(cx);
    // Read before the dialog takes the focus: the terminal you were in. A remote space's folder is not on this Mac
    const f = focused();
    const space = spaces().find((s) => s.id === f?.space);
    this.cwd = f?.cwd && space && space.machine == null ? f.cwd : home();
    this.client = null;      // the profile of the client you're working for: { file, name, tracker }
    this.problem = "";       // why there's no client to show
    this.board = 0;
    this.mine = load("mine", false);
    this.collapsed = new Set();   // "<board id>/<lane id>", saved per client
    this.me = null;          // your Jira accountId, for "Only mine"
    this.priority = null;    // priority id -> place in Jira's own order, highest first
    this.boards = {};        // board id -> { config, issues, total, at, error }
    this.loading = new Set();
    this.busy = "";          // the roger command running, next to the spinner
    this.busyKey = "";
    this.error = "";
    this.choices = null;     // { label, options: [{ text, args }] } when roger asks which project or branch
    this.selected = null;    // the clicked card, whose actions show under the board
    this.moves = null;       // its transitions once loaded: [{ id, name, to }], or { error }
    this.pending = null;     // the action waiting for its confirmation: { move } or { text, body }
    this.acting = false;
    this.actionError = "";
    this.people = null;      // who can be mentioned: [{ id, name }], loaded at the first "@"
    this.mention = null;     // the name typed after a "@" at the end of the comment, or null
    this.comment = TextareaState.new({ placeholder: "Write a comment… @name mentions", rows: 2 });
    this.comment.set_auto_grow(2, 6);
    // The field doesn't say where the cursor is: only a "@" at the end of the text suggests names
    this.comment.on("change", (_e, cx) => {
      this.mention = this.comment.value().match(/(?:^|\s)@([^\s@]*)$/)?.[1] ?? null;
      if (this.mention != null) this.loadPeople(cx);
      cx.notify();
    });
    this.closed = false;
    cx.spawn(async (cx) => {
      try {
        const profiles = await loadProfiles();
        // The sidebar's Board button names its client; the shortcut goes by the terminal's folder
        const wanted = props()?.client;
        this.client = profiles.find((p) => wanted && p.name === wanted && !p.error && p.tracker) ?? clientFor(profiles, this.cwd);
        if (!this.client) this.problem = profiles.find((p) => p.error)?.error ?? `No client profile yet: write one as ${PROFILES}`;
        else if (this.client.tracker.kind !== "jira") this.problem = `${this.client.name}: "${this.client.tracker.kind}" trackers aren't supported yet`;
      } catch (error) {
        this.problem = `Client profiles: ${error?.message ?? error}`;
      }
      if (this.problem) this.client = null;
      if (this.client) {
        this.board = Math.min(Math.max(load(this.saved("board"), 0), 0), this.client.tracker.boards.length - 1);
        this.collapsed = new Set(load(this.saved("collapsed"), []));
        this.refresh(cx);
      }
      if (!this.closed) cx.notify();
    });
    cx.timer.every(REFRESH_MS, (cx) => { if (!this.closed && this.client) this.refresh(cx); });
  }

  // A preference of this client's: its boards, its lanes
  saved(name) { return `${this.client.name}/${name}`; }

  // The overlay is going (Esc, the shortcut again): a roger still running only gets to notify
  close() { this.closed = true; }

  dismiss() { closeOverlay(props().overlay); }

  refresh(cx) {
    const tracker = this.client.tracker;
    const board = tracker.boards[this.board];
    if (this.loading.has(board.id)) return;
    this.loading.add(board.id);
    cx.notify();
    cx.spawn(async (cx) => {
      const entry = this.boards[board.id] ?? {};
      try {
        this.me ??= (await jira(tracker, "/rest/api/3/myself")).accountId;
        this.priority ??= new Map((await jira(tracker, "/rest/api/3/priority")).map((p, i) => [p.id, i]));
        entry.config ??= await boardConfig(tracker, board);
        Object.assign(entry, await boardIssues(tracker, board, entry.config), { at: new Date(), error: "" });
        entry.page = (await boardPage(tracker, board).catch(() => null)) ?? entry.page;
      } catch (error) {
        entry.error = String(error?.message ?? error);
      }
      this.boards[board.id] = entry;
      this.loading.delete(board.id);
      if (!this.closed) cx.notify();
    });
  }

  select(cx, index) {
    this.board = index;
    save(this.saved("board"), index);
    this.selected = null;
    this.pending = null;
    const entry = this.boards[this.client.tracker.boards[index].id];
    if (!entry?.at || Date.now() - entry.at.getTime() > REFRESH_MS) this.refresh(cx);
    cx.notify();
  }

  // A click on a card opens its actions under the board; again, closes them
  pick(cx, issue) {
    const same = this.selected?.key === issue.key;
    this.selected = same ? null : issue;
    this.pending = null;
    this.actionError = "";
    if (!same) this.loadMoves(cx, issue.key);
    cx.notify();
  }

  // The transitions Jira's workflow allows from the issue's status now
  loadMoves(cx, key) {
    this.moves = null;
    cx.spawn(async (cx) => {
      let moves;
      try { moves = ((await jira(this.client.tracker, `/rest/api/3/issue/${key}/transitions`)).transitions ?? []).filter((m) => m.isAvailable !== false); }
      catch (error) { moves = { error: String(error?.message ?? error) }; }
      if (this.selected?.key !== key) return;
      this.moves = moves;
      if (!this.closed) cx.notify();
    });
  }

  // The people who can work on the boards' projects, once: they're the ones a comment mentions
  loadPeople(cx) {
    if (this.people || this.loadingPeople) return;
    this.loadingPeople = true;
    const projects = new Set(Object.values(this.boards).flatMap((b) => (b.issues ?? []).map((i) => i.fields?.project?.key)).filter(Boolean));
    cx.spawn(async (cx) => {
      try {
        const users = await jira(this.client.tracker, "/rest/api/3/user/assignable/multiProjectSearch", { projectKeys: [...projects].join(","), maxResults: 1000 });
        this.people = users.filter((u) => u.accountType === "atlassian" && u.active)
          .map((u) => ({ id: u.accountId, name: u.displayName })).sort((a, b) => a.name.localeCompare(b.name));
      } catch (error) {
        this.people = [];
        this.actionError = `People: ${error?.message ?? error}`;
      }
      this.loadingPeople = false;
      if (!this.closed) cx.notify();
    });
  }

  // The typed "@name" becomes a chip that carries the person's Jira id
  mentionPerson(cx, person) {
    const text = this.comment.value();
    const at = text.lastIndexOf("@");
    if (at < 0) return;
    this.comment.replace_range_with_token({ start: at, end: text.length }, { id: person.id, text: `@${person.name}` });
    this.comment.replace(" ");
    this.mention = null;
    this.comment.focus();
    cx.notify();
  }

  // The confirmed action: a status move, or the comment as plain text (API v2 takes it without ADF)
  confirm(cx) {
    const issue = this.selected;
    const action = this.pending;
    const tracker = this.client?.tracker;
    if (!issue || !action || !tracker || this.acting) return;
    this.acting = true;
    this.actionError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (action.move) {
          await jiraPost(tracker, `/rest/api/3/issue/${issue.key}/transitions`, { transition: { id: action.move.id } });
          notify({ title: `${issue.key} moved`, body: action.move.to?.name ?? action.move.name, level: "success" });
        } else {
          await jiraPost(tracker, `/rest/api/2/issue/${issue.key}/comment`, { body: action.body });
          notify({ title: `${issue.key}: comment posted`, body: action.text.slice(0, 120), level: "success" });
          if (!this.closed) this.comment.set_value("");
        }
        this.pending = null;
      } catch (error) {
        const why = String(error?.message ?? error);
        if (this.closed) notify({ title: `${issue.key}: not saved`, body: why, level: "error" });
        this.actionError = why;
      }
      this.acting = false;
      if (this.closed) return;
      if (action.move && !this.pending) { this.refresh(cx); this.loadMoves(cx, issue.key); }
      cx.notify();
    });
  }

  // The selected card's actions: where its workflow can move it, and a comment; both ask before writing
  panel(t, issue, button) {
    const f = issue.fields ?? {};
    const k = issue.key;
    const primary = (id, text, action) => button(id, text, action).bg(t.solid).border_color(t.solid).text_color(t.solid_foreground);
    const moves = Array.isArray(this.moves) ? this.moves.filter((m) => m.to?.id !== f.status?.id) : [];
    const text = this.comment.value().trim();
    const p = this.pending;
    const q = this.mention;
    const people = q == null || !Array.isArray(this.people) ? [] : this.people.filter((u) => fold(u.name).includes(fold(q))).slice(0, 6);
    return v_flex().id("actions").flex_none().p(12).gap(10).rounded(9).border_1().border_color(t.accent).bg(t.surface)
      .child(h_flex().items_center().gap(8)
        .child(div().id("actions-key").flex_none().text_size(12).font_medium().text_color(t.accent).cursor_pointer()
          .tooltip("Open in Jira").on_click(() => this.browse(issue)).child(k))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(f.summary ?? ""))
        .child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(f.status?.name ?? ""))
        .child(h_flex().id("actions-close").size(24).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).tooltip("Close").on_click((_e, cx) => this.pick(cx, issue))
          .child(div().text_size(13).text_color(t.muted).child("✕"))))
      .when(Boolean(p), (el) => el.child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(12.5)
          .child(p.move ? `Move ${k} to “${p.move.to?.name ?? p.move.name}”?` : `Post this comment on ${k}?`))
        .when(this.acting, (el) => el.child(div().text_color(t.working).frames(SPINNER, 90)))
        .when(!this.acting, (el) => el
          .child(button("actions-cancel", "Cancel", (_e, cx) => { this.pending = null; cx.notify(); }))
          .child(primary("actions-confirm", p.move ? "Move" : "Post", (_e, cx) => this.confirm(cx))))))
      .when(!p, (el) => el
        .child(h_flex().flex_wrap().items_center().gap(6)
          .child(div().pr(4).text_size(12).text_color(t.muted).child("Move to"))
          .when(this.moves == null, (el) => el.child(div().text_color(t.working).frames(SPINNER, 90)))
          .when(Boolean(this.moves?.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.moves.error)))
          .when(Array.isArray(this.moves) && !moves.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("Nothing allowed from here")))
          .children(moves.map((m) => button(`move-${m.id}`, m.to?.name ?? m.name, (_e, cx) => { this.pending = { move: m }; this.actionError = ""; cx.notify(); })
            .tooltip(m.name))))
        .when(q != null, (el) => el.child(h_flex().flex_wrap().items_center().gap(6)
          .child(div().pr(4).text_size(12).text_color(t.muted).child("Mention"))
          .when(this.people == null, (el) => el.child(div().text_color(t.working).frames(SPINNER, 90)))
          .when(Array.isArray(this.people) && !people.length, (el) => el.child(div().text_size(12).text_color(t.dim).child(`No one called “${q}”`)))
          .children(people.map((u) => button(`mention-${u.id}`, u.name, (_e, cx) => this.mentionPerson(cx, u))))))
        .child(h_flex().items_end().gap(8)
          .child(div().flex_1().min_w(0).child(Textarea.new(this.comment).w_full().px(10).py(6).rounded(8).border_1()
            .border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)))
          .child(button("actions-comment", "Comment", (_e, cx) => {
            if (!text) return;
            this.pending = { text, body: commentBody(this.comment.content()) };
            this.actionError = "";
            cx.notify();
          }).when(!text, (el) => el.opacity(0.5)))))
      .when(Boolean(this.actionError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.actionError)));
  }

  // The sidebar: the focused space's ticket on top, then one section per client with your open tickets.
  // The ticket follows the focus: its key in the space's name or branch, its client by the terminal's folder
  initSide(cx) {
    this.closed = false;
    this.profiles = null;
    this.side = { key: undefined, ticketClient: undefined, ticket: null, mine: {}, errors: {}, at: null, error: "",
      folded: new Set(load("folded", [])) };   // client names whose section is closed
    cx.spawn(async (cx) => {
      try { this.profiles = await loadProfiles(); } catch (error) { this.side.error = String(error?.message ?? error); }
      this.loadAllMine(cx);
      cx.notify();
    });
    cx.timer.every(REFRESH_MS, (cx) => {
      this.loadAllMine(cx);
      const client = this.sideClient();
      if (client) this.loadTicket(cx, client, this.side.key);
    });
  }

  // The clients whose tracker this mod can read
  sideClients() {
    return (this.profiles ?? []).filter((p) => !p.error && p.tracker?.kind === "jira");
  }

  sideClient() {
    return clientFor(this.profiles ?? [], focused()?.cwd ?? home());
  }

  loadAllMine(cx) {
    for (const client of this.sideClients()) this.loadMine(cx, client);
  }

  loadMine(cx, client) {
    const tracker = client.tracker;
    const hidden = tracker.hiddenProjects?.length ? ` AND project not in (${tracker.hiddenProjects.join(",")})` : "";
    cx.spawn(async (cx) => {
      try {
        const found = await jira(tracker, "/rest/api/3/search/jql",
          { jql: `assignee = currentUser() AND statusCategory != Done${hidden} ORDER BY updated DESC`, fields: SIDE_FIELDS, maxResults: 20 });
        this.side.mine[client.name] = found.issues ?? [];
        delete this.side.errors[client.name];
        this.side.at = new Date();
      } catch (error) {
        this.side.errors[client.name] = String(error?.message ?? error);
      }
      if (!this.closed) cx.notify();
    });
  }

  // A client's boards, in the big window
  openBoard(client) {
    openOverlay({ mod: "workbench", props: { client: client.name }, kind: "dialog", width: 1320, height: 820 });
  }

  toggleClient(cx, name) {
    if (!this.side.folded.delete(name)) this.side.folded.add(name);
    save("folded", [...this.side.folded]);
    cx.notify();
  }

  loadTicket(cx, client, key) {
    if (!key) return;
    cx.spawn(async (cx) => {
      const ticket = await jira(client.tracker, `/rest/api/3/issue/${key}`, { fields: SIDE_FIELDS }).catch(() => false);
      if (this.side.key !== key) return;
      this.side.ticket = ticket;
      if (!this.closed) cx.notify();
    });
  }

  // The space working on a ticket, by its name or branch
  spaceOf(key) {
    return spaces().find((s) => `${s.name ?? ""} ${s.branch ?? ""}`.includes(key));
  }

  renderSide(cx) {
    const t = theme();
    const client = this.sideClient();
    const space = spaces().find((s) => s.id === focused()?.space);
    const key = `${space?.name ?? ""} ${space?.branch ?? ""}`.match(TICKET_KEY)?.[0] ?? null;
    if (client && (key !== this.side.key || client.name !== this.side.ticketClient)) {
      Object.assign(this.side, { key, ticketClient: client.name, ticket: null });
      this.loadTicket(cx, client, key);
    }
    const dot = (issue) => {
      const category = issue.fields?.status?.statusCategory?.key;
      return div().size(8).flex_none().rounded_full().bg(category === "done" ? t.done : category === "indeterminate" ? t.working : t.dim);
    };
    const row = (issue, id) => {
      const k = issue.key;
      return h_flex().id(`mine-${id}`).flex_none().items_center().gap(7).px(8).py(5).rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(this.spaceOf(k) ? "Go to its space" : "Open in Jira")
        .on_click(() => { const s = this.spaceOf(k); if (s) run("space.select", { id: s.id }); else this.browse(issue); })
        .child(dot(issue))
        .child(div().flex_none().text_size(11.5).font_medium().text_color(t.muted).child(k))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(issue.fields?.summary ?? ""));
    };
    // A client: its name, how many tickets are open, its boards; folded, only that
    const section = (c, ci) => {
      const folded = this.side.folded.has(c.name);
      const mine = this.side.mine[c.name];
      const error = this.side.errors[c.name];
      return v_flex().id(`client-${ci}`).flex_none().gap(1)
        .child(h_flex().id(`client-head-${ci}`).items_center().gap(6).px(4).py(3).rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleClient(cx, c.name))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(13).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().child(c.name))
          .when(Array.isArray(mine), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(mine.length))))
          .child(h_flex().id(`client-board-${ci}`).h(22).px(7).flex_none().items_center().rounded(6).border_1().border_color(t.input)
            .text_size(11).cursor_pointer().hover((s) => s.bg(t.raised)).tooltip(`${c.name}: the boards`)
            .on_click((_e, cx) => { cx.stop_propagation(); this.openBoard(c); }).child("Board")))
        .when(!folded, (el) => el
          .when(mine == null && !error, (el) => el.child(div().px(8).text_color(t.working).frames(SPINNER, 90)))
          .when(Boolean(error), (el) => el.child(div().px(8).text_size(11.5).text_color(t.blocked).child(error)))
          .when(Array.isArray(mine) && !mine.length, (el) => el.child(div().px(8).text_size(12).text_color(t.dim).child("Nothing open")))
          .children((mine ?? []).map((issue, i) => row(issue, `${ci}-${i}`))));
    };
    const clients = this.sideClients();
    const tk = this.side.ticket;
    const f = tk?.fields ?? {};
    const priority = priorityMark(f.priority?.name, client?.tracker.priorityAliases);
    const here = !key ? div().px(8).text_size(12).text_color(t.dim).child("No ticket in this space")
      : tk === false ? div().px(8).text_size(12).text_color(t.dim).child(`${key} isn't in ${client?.name ?? "Jira"}`)
      : !tk ? div().px(8).text_color(t.working).frames(SPINNER, 90)
      : v_flex().id("here").flex_none().p(10).gap(6).rounded(8).border_1().border_color(t.border).bg(t.background)
        .child(h_flex().items_center().gap(6)
          .child(div().id("here-type").size(10).flex_none().rounded(3).bg(typeColor(f.issuetype)).tooltip(f.issuetype?.name ?? ""))
          .child(div().id("here-key").flex_none().text_size(12).font_medium().text_color(t.accent).cursor_pointer()
            .tooltip("Open in Jira").on_click(() => this.browse(tk)).child(tk.key))
          .child(div().flex_1())
          .when(Boolean(priority), (el) => el.child(div().text_size(12).font_semibold().text_color(priority.color).child(priority.glyph)))
          .child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(f.status?.name ?? "")))
        .child(div().text_size(13).whitespace_normal().child(f.summary ?? ""))
        .child(div().text_size(11.5).text_color(t.dim).child(f.assignee?.displayName ?? "Unassigned"));
    const label = (text) => div().px(8).text_size(11).font_semibold().text_color(t.muted).child(text);
    return v_flex().id("workbench-side").size_full().bg(t.chrome)
      .min_h(0).p(10).gap(10).text_color(t.foreground)
      .child(div().flex_none().px(4).text_size(13).font_semibold().child("Workbench"))
      .child(label("THIS SPACE"))
      .child(here)
      .child(v_flex().id("clients").flex_1().min_h(0).gap(10).overflow_y_scrollbar()
        .when(this.profiles != null && !clients.length, (el) => el.child(div().px(8).text_size(12).text_color(t.dim)
          .child(`No client profile with a Jira tracker: write one as ${PROFILES}`)))
        .children(clients.map(section)))
      .children((this.profiles ?? []).filter((p) => p.error).map((p) => div().px(8).text_size(11.5).text_color(t.blocked).child(p.error)))
      .when(Boolean(this.side.error), (el) => el.child(div().px(8).text_size(11.5).text_color(t.blocked).child(this.side.error)))
      .child(div().flex_none().px(8).text_size(10.5).text_color(t.dim)
        .child(this.side.at ? `updated ${this.side.at.toTimeString().slice(0, 5)}` : ""));
  }

  browse(issue) {
    const origin = (issue.self ?? "").match(/^https:\/\/[^/]+/)?.[0];
    if (origin) exec("open", [`${origin}/browse/${issue.key}`]).catch(() => {});
  }

  start(cx, args) {
    if (this.busy) return;
    cx.spawn(async (cx) => this.launch(cx, args));
  }

  async launch(cx, args) {
    const ticket = args[1];
    this.busy = `roger ${args.join(" ")}`;
    this.busyKey = ticket;
    this.error = "";
    this.choices = null;
    cx.notify();
    let r;
    try { r = await exec("roger", args, { cwd: this.cwd, timeout: 600_000 }); }
    catch (error) { r = { code: -1, stdout: "", stderr: `roger: ${error}` }; }   // timed out, or not on the PATH
    this.busy = "";
    this.busyKey = "";
    if (r.code === 0) {
      const lines = (r.stdout ?? "").trim().split("\n");
      const shown = lines.some((l) => l.includes("is open already"));
      notify({ title: `${ticket} ${shown ? "shown" : "opened"}`, body: lines[0] ?? "", level: "success" });
      if (!this.closed) this.dismiss();
      return;
    }
    const why = failure(r, "roger");
    if (this.closed) return notify({ title: `roger open ${ticket}`, body: why, level: "error" });
    // The same messages the roger dialog reads ("parsed by herdr/roger/main.js" in bin/roger)
    const project = why.match(/which project\? -p (.+)$/);
    const branch = why.match(/several branches, name the one to open: (.+)$/);
    const p = args.indexOf("-p");
    const keep = p < 0 ? [] : args.slice(p, p + 2);   // a project chosen before a branch is asked for
    if (project) {
      this.choices = { label: `${ticket}: which project?`, options: project[1].split(" | ").map((name) => ({ text: name, args: ["open", ticket, "-p", name] })) };
    } else if (branch) {
      this.choices = { label: `${ticket}: which branch?`, options: branch[1].split(", ").map((name) => ({ text: name, args: ["open", name, ...keep] })) };
    } else {
      this.error = `${ticket}: ${why}`;
    }
    cx.notify();
  }

  // A card as Jira draws it: the parent of a subtask outside its story's lane, the summary, the epic, the
  // board's extra fields, then type, key, priority, assignee and the agent button
  card(t, issue, page, inStory) {
    const f = issue.fields ?? {};
    const k = issue.key;
    const starting = this.busyKey === k;
    const extra = page?.cards.get(issue.id);
    const lines = extra?.lines ?? [f.status?.name ?? ""];
    const parent = f.issuetype?.subtask && !inStory ? f.parent : null;
    const priority = priorityMark(f.priority?.name, this.client?.tracker.priorityAliases);
    const who = f.assignee?.displayName;
    const avatar = h_flex().id(`who-${k}`).size(22).flex_none().items_center().justify_center().rounded_full()
      .tooltip(who ?? "Unassigned")
      .when(Boolean(who), (el) => el.bg(AVATAR_COLORS[[...who].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_COLORS.length])
        .text_size(9.5).font_semibold().text_color("#1d2125").child(initials(who)))
      .when(!who, (el) => el.border_1().border_color(t.input));
    return v_flex().id(`card-${k}`).flex_none().rounded(7).border_1().border_color(this.selected?.key === k ? t.accent : t.border)
      .bg(t.background).overflow_hidden().cursor_pointer().on_click((_e, cx) => this.pick(cx, issue))
      .when(Boolean(parent), (el) => el.child(h_flex().id(`up-${k}`).px(9).py(5).gap(6).bg(t.raised).text_size(11).cursor_pointer()
        .tooltip("Open in Jira").on_click((_e, cx) => { cx.stop_propagation(); this.browse(parent); })
        .child(div().flex_none().font_medium().text_color(t.muted).child(parent.key))
        .child(div().min_w(0).truncate().text_color(t.dim).child(parent.fields?.summary ?? ""))))
      .child(v_flex().p(9).gap(6)
        .child(div().text_size(13).whitespace_normal().child(f.summary ?? ""))
        .when(Boolean(extra?.epic?.name), (el) => el.child(h_flex().flex_none().self_start().max_w_full().items_center().gap(5).px(5).py(1)
          .rounded(4).border_1().border_color(extra.epic.color)
          .child(div().size(8).flex_none().rounded(2).bg(extra.epic.color))
          .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(extra.epic.name))))
        .when(lines.length > 0, (el) => el.child(v_flex().gap(1)
          .children(lines.map((line) => div().truncate().text_size(11.5).text_color(t.muted).child(line)))))
        .child(h_flex().items_center().gap(6)
          .child(div().id(`type-${k}`).size(12).flex_none().rounded(3).bg(typeColor(f.issuetype)).tooltip(f.issuetype?.name ?? ""))
          .child(div().id(`key-${k}`).flex_none().text_size(11.5).font_medium().text_color(t.muted).cursor_pointer()
            .hover((s) => s.text_color(t.accent)).tooltip("Open in Jira")
            .on_click((_e, cx) => { cx.stop_propagation(); this.browse(issue); }).child(k))
          .child(div().flex_1())
          .when(Boolean(priority), (el) => el.child(div().id(`prio-${k}`).flex_none().text_size(12.5).font_semibold()
            .text_color(priority.color).tooltip(f.priority.name).child(priority.glyph)))
          .child(avatar)
          .child(h_flex().id(`start-${k}`).size(24).flex_none().items_center().justify_center().rounded(6)
            .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`roger open ${k}`)
            .on_click((_e, cx) => { cx.stop_propagation(); this.start(cx, ["open", k]); })
            .child(starting ? div().text_color(t.working).frames(SPINNER, 90) : image("icons/claude.svg").size(14)))));
  }

  toggleLane(cx, key) {
    if (!this.collapsed.delete(key)) this.collapsed.add(key);
    save(this.saved("collapsed"), [...this.collapsed]);
    cx.notify();
  }

  // The lane's name row (none for the plain board) and, unless folded, its columns side by side
  lane(t, board, columns, page, lane) {
    const key = `${board.id}/${lane.id}`;
    const folded = this.collapsed.has(key);
    const p = lane.parent;
    const count = `(${lane.issues.length} ${p ? "subtask" : "work item"}${lane.issues.length === 1 ? "" : "s"})`;
    const title = h_flex().id(`lane-${lane.id}`).flex_none().items_center().gap(8).px(2).cursor_pointer()
      .on_click((_e, cx) => this.toggleLane(cx, key))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(14).flex_none().text_color(t.muted))
      .when(Boolean(p), (el) => el
        .child(div().id(`parent-${lane.id}`).flex_none().text_size(12).font_medium().text_color(t.accent).cursor_pointer()
          .hover((s) => s.opacity(0.75)).tooltip("Open in Jira")
          .on_click((_e, cx) => { cx.stop_propagation(); this.browse(p); }).child(p.key))
        .child(div().min_w(0).truncate().text_size(13).font_semibold().child(p.fields?.summary ?? "")))
      .when(!p, (el) => el.child(div().min_w(0).truncate().text_size(13).font_semibold().child(lane.name)))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(count))
      .when(Boolean(p?.fields?.status), (el) => el.child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised)
        .text_size(11).text_color(t.muted).child(p.fields.status.name)));
    // By priority, highest first; the sort is stable, so the board's rank order holds within a priority
    const place = (i) => this.priority?.get(i.fields?.priority?.id) ?? Infinity;
    const cells = h_flex().id(`cells-${lane.id}`).flex_none().items_start().gap(10).children(columns.map((col, ci) => {
      const cards = lane.issues.filter((i) => col.statuses.includes(i.fields?.status?.id)).sort((a, b) => place(a) - place(b));
      return v_flex().id(`cell-${lane.id}-${ci}`).flex_1().min_w(0).min_h(64).p(8).gap(8).rounded(9).bg(t.surface)
        .child(h_flex().flex_none().items_center().gap(6).px(2)
          .child(div().min_w(0).truncate().text_size(11).font_semibold().text_color(t.muted).child(col.name.toUpperCase()))
          .child(div().text_size(11).text_color(t.dim).child(String(cards.length))))
        .children(cards.map((issue) => this.card(t, issue, page, Boolean(p))));
    }));
    if (lane.name == null && !p) return cells;
    return v_flex().id(`lanebox-${lane.id}`).flex_none().gap(8).child(title).when(!folded, (el) => el.child(cells));
  }

  render(cx) {
    if (this.view) return this.renderSide(cx);
    const t = theme();
    const boards = this.client?.tracker.boards ?? [];
    const board = boards[this.board];
    const entry = board && this.boards[board.id];
    const loading = Boolean(board && this.loading.has(board.id));
    const isMine = (i) => !this.mine || i.fields?.assignee?.accountId === this.me;
    const issues = (entry?.issues ?? []).filter(isMine);
    const columns = entry?.config?.columns ?? [];
    const sel = this.selected && ((entry?.issues ?? []).find((i) => i.key === this.selected.key) ?? this.selected);
    // Lanes from every issue, so "Only mine" never turns a story into a card; empty lanes go, the plain board stays
    const shown = lanes(entry?.page, entry?.issues ?? [])
      .map((l) => ({ ...l, issues: l.issues.filter(isMine) }))
      .filter((l) => l.issues.length || l.id === "all");
    const button = (id, text, action) => h_flex().id(id).h(28).px(11).flex_none().items_center().rounded(7).border_1()
      .border_color(t.input).bg(t.raised).text_color(t.foreground).text_size(12).font_medium()
      .cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const tab = (b, i) => h_flex().id(`board-${b.id}`).h(28).px(11).flex_none().items_center().rounded(7)
      .text_size(12.5).font_medium().cursor_pointer().hover((s) => s.bg(t.hover))
      .bg(i === this.board ? t.selected : t.popover).text_color(i === this.board ? t.foreground : t.muted)
      .on_click((_e, cx) => this.select(cx, i)).child(b.label);
    const toggle = h_flex().id("mine").flex_none().gap(7).items_center().cursor_pointer()
      .on_click((_e, cx) => { this.mine = !this.mine; save("mine", this.mine); cx.notify(); })
      .child(h_flex().w(28).h(16).p(2).rounded(8).bg(this.mine ? t.accent : t.input)
        .when(this.mine, (el) => el.justify_end())
        .child(div().size(12).rounded_full().bg(t.background)))
      .child(div().text_size(12).text_color(this.mine ? t.foreground : t.muted).child("Only mine"));
    const status = entry?.at
      ? `${issues.length} ${this.mine ? "yours" : "tickets"}` + (entry.total > (entry.issues?.length ?? 0) ? ` (first ${entry.issues.length} of ${entry.total})` : "")
        + ` · updated ${entry.at.toTimeString().slice(0, 5)}`
      : loading || (!this.client && !this.problem) ? "Loading…" : "";
    return v_flex().id("workbench").size_full().min_h(0).p(16).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_none().pr(6).text_size(15).font_semibold().child(this.client?.name ?? "Workbench"))
        .children(boards.map(tab))
        .child(div().flex_1())
        .child(toggle)
        .child(h_flex().id("refresh").size(28).flex_none().items_center().justify_center().rounded(7).cursor_pointer()
          .hover((s) => s.bg(t.hover)).tooltip("Refresh").on_click((_e, cx) => { if (this.client) this.refresh(cx); })
          .child(loading ? div().text_color(t.working).frames(SPINNER, 90) : div().text_size(15).text_color(t.muted).child("↻")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc")))
      .when(Boolean(this.choices), (el) => el.child(h_flex().flex_wrap().items_center().gap(6)
        .child(div().pr(4).text_size(12).text_color(t.muted).child(this.choices.label))
        .children(this.choices.options.map((o, i) => button(`choice-${i}`, o.text, (_e, cx) => this.start(cx, o.args))))))
      .when(Boolean(this.busy), (el) => el.child(h_flex().gap(6).text_size(11.5).text_color(t.dim)
        .child(div().text_color(t.working).frames(SPINNER, 90))
        .child(div().min_w(0).truncate().child(`${this.busy}…`))))
      .when(Boolean(this.problem), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.problem)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .when(Boolean(entry?.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(`Jira: ${entry.error}`)))
      .child(v_flex().id("lanes").flex_1().min_h(0).gap(16).overflow_y_scrollbar()
        .children(entry?.config ? shown.map((l) => this.lane(t, board, columns, entry.page, l)) : []))
      .when(Boolean(sel), (el) => el.child(this.panel(t, sel, button)))
      .child(h_flex().gap(8).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(status))
        .child(div().flex_none().child(`Agents start in ${this.cwd.replace(home(), "~")}`)));
  }
}
