// Workbench: a client's tickets and merge requests in Herdr. A dialog with its boards and its merge
// requests (keys.json: "cmd-shift-b": "mod.open:workbench") and a sidebar for a layout's column
// (props.view "sidebar").
// - Clients: one profile per client (profiles.js), chosen by the folder of the terminal you were in. It
//   says which tracker and code host, which boards, and which Keychain items hold the tokens.
// - Providers read a tracker (providers/jira.js) or a code host (providers/gitlab.js) and give tickets
//   and changes in one shape. Everything is read; the only writes are a ticket's status move, a merge
//   request's pipeline retry, or a comment, from the panel under the board, each after a confirmation.
// - Start: the agent button runs `roger open <key>` in the folder of the terminal you were in, like the
//   roger dialog (mods/roger); when roger asks which project or branch, its options become buttons.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { props, openOverlay, closeOverlay, theme, focused, spaces, exec, home, notify, run } from "herdr";
import { failure } from "./http.js";
import { PROFILES, loadProfiles, clientFor } from "./profiles.js";
import { jiraTracker } from "./providers/jira.js";
import { gitlabHost } from "./providers/gitlab.js";

const REFRESH_MS = 60_000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;
const AVATAR_COLORS = ["#579dff", "#4bce97", "#e2b203", "#fea362", "#f87168", "#9f8fef", "#6cc3e0", "#e774bb"];
// A priority's arrow, by its level
const PRIORITY_MARKS = {
  highest: { glyph: "↑↑", color: "#e5493a" },
  high: { glyph: "↑", color: "#f15c45" },
  medium: { glyph: "=", color: "#f5a623" },
  low: { glyph: "↓", color: "#4bade8" },
  lowest: { glyph: "↓↓", color: "#4bade8" },
};

// A pipeline's color, by its status
const PIPELINE_COLORS = {
  success: "#22a06b", failed: "#e5493a", running: "#579dff", pending: "#e2b203", created: "#e2b203",
  preparing: "#e2b203", waiting_for_resource: "#e2b203", scheduled: "#e2b203",
};

// The tracker a client's profile names, or null for a kind this mod can't read
function trackerOf(client) {
  return client?.tracker?.kind === "jira" ? jiraTracker(client.tracker) : null;
}

// The code host a client's profile names, or null: none, or a kind this mod can't read
function codeOf(client) {
  return client?.code?.kind === "gitlab" ? gitlabHost(client.code) : null;
}

// What a merge request needs at a glance: its pipeline, approvals, open threads, conflicts
function changeFacts(c) {
  return [
    c.pipeline ? `pipeline ${c.pipeline}` : "no pipeline",
    c.approved ? `approved${c.approvedBy.length ? ` by ${c.approvedBy.join(", ")}` : ""}` : "not approved",
    c.threads.open ? `${c.threads.open} open thread${c.threads.open === 1 ? "" : "s"}` : null,
    c.conflicts ? "conflicts" : null,
  ].filter(Boolean);
}

// For matching names as typed: "jurg" finds "Jürgen"
function fold(text) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// "Ada Lovelace / ACME" -> "AL"
function initials(name) {
  return name.split(" / ")[0].split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export default class Workbench extends View {
  init(initial, cx) {
    this.view = props()?.view ?? initial?.view ?? null;   // "sidebar": a layout's column; else the dialog
    if (this.view) return this.initSide(cx);
    // Read before the dialog takes the focus: the terminal you were in. A remote space's folder is not on this Mac
    const f = focused();
    const space = spaces().find((s) => s.id === f?.space);
    this.cwd = f?.cwd && space && space.machine == null ? f.cwd : home();
    this.client = null;      // the profile of the client you're working for: { file, name, tracker }
    this.tracker = null;     // its tracker's provider
    this.problem = "";       // why there's no client to show
    this.board = 0;
    this.mine = load("mine", false);
    this.collapsed = new Set();   // "<board id>/<lane id>", saved per client
    this.me = null;          // your id in the tracker, for "Only mine"
    this.boards = {};        // board id -> { columns, lanes, tickets, total, at, error }
    this.code = null;        // the client's code host's provider, if it has one: its tab follows the boards
    this.changes = { mine: null, review: null, at: null, error: "" };
    this.loadingChanges = false;
    this.repos = null;       // code host project path -> its local checkout, found at the first agent started
    this.loading = new Set();
    this.busy = "";          // the roger command running, next to the spinner
    this.busyKey = "";
    this.error = "";
    this.choices = null;     // { label, options: [{ text, args }] } when roger asks which project or branch
    this.selected = null;    // the clicked card, whose actions show under the board
    this.selectedChange = null;   // the same on the merge requests tab
    this.moves = null;       // its moves once loaded: [{ id, name, hint, to }], or { error }
    this.pending = null;     // the action waiting for its confirmation: { move }, { retry } or { text, content }
    this.acting = false;
    this.actionError = "";
    this.people = null;      // who can be mentioned: [{ id, name }], loaded at the first "@"
    this.peopleOf = null;    // whose: "tracker", or a merge request's project
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
        this.tracker = trackerOf(this.client);
        this.code = codeOf(this.client);
        if (!this.client) this.problem = profiles.find((p) => p.error)?.error ?? `No client profile yet: write one as ${PROFILES}`;
        else if (!this.tracker) this.problem = `${this.client.name}: "${this.client.tracker.kind}" trackers aren't supported yet`;
      } catch (error) {
        this.problem = `Client profiles: ${error?.message ?? error}`;
      }
      if (this.problem) { this.client = null; this.tracker = null; }
      if (this.client) {
        this.board = Math.min(Math.max(load(this.saved("board"), 0), 0), this.tracker.boards.length - (this.code ? 0 : 1));
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

  // The tab after the boards: the code host's merge requests
  onChanges() {
    return Boolean(this.code) && this.board === this.tracker.boards.length;
  }

  refresh(cx) {
    if (this.onChanges()) return this.loadChanges(cx);
    const tracker = this.tracker;
    const board = tracker.boards[this.board];
    if (this.loading.has(board.id)) return;
    this.loading.add(board.id);
    cx.notify();
    cx.spawn(async (cx) => {
      const entry = this.boards[board.id] ?? {};
      try {
        this.me ??= await tracker.me();
        Object.assign(entry, await tracker.board(board), { at: new Date(), error: "" });
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
    this.selectedChange = null;
    this.pending = null;
    const entry = this.onChanges() ? this.changes : this.boards[this.tracker.boards[index].id];
    if (!entry?.at || Date.now() - entry.at.getTime() > REFRESH_MS) this.refresh(cx);
    cx.notify();
  }

  loadChanges(cx) {
    if (this.loadingChanges) return;
    this.loadingChanges = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try { Object.assign(this.changes, await this.code.changes(), { at: new Date(), error: "" }); }
      catch (error) { this.changes.error = String(error?.message ?? error); }
      this.loadingChanges = false;
      if (!this.closed) cx.notify();
    });
  }

  // A merge request as a card: pipeline, reference, project, draft; title; branches; approvals, open
  // threads, conflicts; reviewers (yours) or author (to review). A click opens its actions; the
  // reference opens it on the code host
  changeCard(t, c, id, yours) {
    const facts = changeFacts(c);
    const who = yours ? (c.reviewers.length ? `Review: ${c.reviewers.join(", ")}` : "No reviewer") : `By ${c.author}`;
    return v_flex().id(`change-${id}`).w(300).flex_none().p(10).gap(6).rounded(8).border_1()
      .border_color(this.selectedChange?.id === c.id ? t.accent : t.border).bg(t.background)
      .cursor_pointer().hover((s) => s.border_color(t.input)).on_click((_e, cx) => this.pickChange(cx, c))
      .child(h_flex().items_center().gap(6)
        .child(div().size(8).flex_none().rounded_full().bg(PIPELINE_COLORS[c.pipeline] ?? t.dim))
        .child(div().id(`change-ref-${id}`).flex_none().text_size(11.5).font_medium().text_color(t.muted).cursor_pointer()
          .hover((s) => s.text_color(t.accent)).tooltip(`Open in ${this.code.name}`)
          .on_click((_e, cx) => { cx.stop_propagation(); this.browse(c); }).child(c.ref))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(c.project.name))
        .when(c.draft, (el) => el.child(div().flex_none().px(5).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child("Draft"))))
      .child(div().text_size(13).whitespace_normal().child(c.title))
      .child(div().truncate().text_size(11.5).text_color(t.dim).child(`${c.branch} → ${c.target}`))
      .child(div().text_size(11.5).text_color(c.conflicts || c.pipeline === "failed" ? t.blocked : t.muted).child(facts.join(" · ")))
      .child(h_flex().items_center().gap(6)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(who))
        .when(Boolean(this.client.code?.tasks?.[yours ? "answer" : "review"]), (el) => el.child(this.agentButton(t, c, id, yours))));
  }

  // Claude on the merge request's branch: a review of someone else's, the answers to the review of yours
  agentButton(t, c, id, yours) {
    const kind = yours ? "answer" : "review";
    return h_flex().id(`change-agent-${id}`).size(24).flex_none().items_center().justify_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(yours ? "Answer the review with an agent" : "Review it with an agent")
      .on_click((_e, cx) => { cx.stop_propagation(); this.startChange(cx, c, kind); })
      .child(this.busyKey === c.id ? div().text_color(t.working).frames(SPINNER, 90) : image("icons/claude.svg").size(14));
  }

  // A click on a merge request opens its actions under the list; again, closes them
  pickChange(cx, c) {
    this.selectedChange = this.selectedChange?.id === c.id ? null : c;
    this.pending = null;
    this.actionError = "";
    cx.notify();
  }

  // A click on a card opens its actions under the board; again, closes them
  pick(cx, ticket) {
    const same = this.selected?.key === ticket.key;
    this.selected = same ? null : ticket;
    this.pending = null;
    this.actionError = "";
    if (!same) this.loadMoves(cx, ticket.key);
    cx.notify();
  }

  // Where the tracker's workflow allows the ticket to go from its status now
  loadMoves(cx, key) {
    this.moves = null;
    cx.spawn(async (cx) => {
      let moves;
      try { moves = await this.tracker.moves(key); }
      catch (error) { moves = { error: String(error?.message ?? error) }; }
      if (this.selected?.key !== key) return;
      this.moves = moves;
      if (!this.closed) cx.notify();
    });
  }

  // Who a comment can mention, once each: on the boards, the people who can work on their tickets; on a
  // merge request, its project's members
  loadPeople(cx) {
    const change = this.onChanges() ? this.selectedChange : null;
    const of = change ? `code:${change.project.path}` : "tracker";
    if (this.peopleOf !== of) Object.assign(this, { peopleOf: of, people: null, loadingPeople: false });
    if (this.people || this.loadingPeople) return;
    this.loadingPeople = true;
    const tickets = Object.values(this.boards).flatMap((b) => b.tickets ?? []);
    cx.spawn(async (cx) => {
      let people;
      try {
        people = change ? await this.code.people(change) : await this.tracker.people(tickets);
      } catch (error) {
        people = [];
        this.actionError = `People: ${error?.message ?? error}`;
      }
      if (this.peopleOf !== of) return;   // another list was asked for meanwhile
      this.people = people;
      this.loadingPeople = false;
      if (!this.closed) cx.notify();
    });
  }

  // The typed "@name" becomes a chip that carries the person's id in the tracker
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

  // The confirmed action on a merge request: a pipeline retry, or the comment as it was when Comment was clicked
  confirmChange(cx) {
    const c = this.selectedChange;
    const action = this.pending;
    const code = this.code;
    if (!c || !action || !code || this.acting) return;
    this.acting = true;
    this.actionError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (action.retry) {
          await code.retry(c);
          notify({ title: `${c.ref}: pipeline retried`, body: c.title, level: "success" });
        } else {
          await code.comment(c, action.content);
          notify({ title: `${c.ref}: comment posted`, body: action.text.slice(0, 120), level: "success" });
          if (!this.closed) this.comment.set_value("");
        }
        this.pending = null;
      } catch (error) {
        const why = String(error?.message ?? error);
        if (this.closed) notify({ title: `${c.ref}: not saved`, body: why, level: "error" });
        this.actionError = why;
      }
      this.acting = false;
      if (this.closed) return;
      if (!this.pending) this.loadChanges(cx);
      cx.notify();
    });
  }

  // The confirmed action: a status move, or the comment as it was when Comment was clicked
  confirm(cx) {
    if (this.onChanges()) return this.confirmChange(cx);
    const ticket = this.selected;
    const action = this.pending;
    const tracker = this.tracker;
    if (!ticket || !action || !tracker || this.acting) return;
    this.acting = true;
    this.actionError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (action.move) {
          await tracker.move(ticket.key, action.move);
          notify({ title: `${ticket.key} moved`, body: action.move.name, level: "success" });
        } else {
          await tracker.comment(ticket.key, action.content);
          notify({ title: `${ticket.key}: comment posted`, body: action.text.slice(0, 120), level: "success" });
          if (!this.closed) this.comment.set_value("");
        }
        this.pending = null;
      } catch (error) {
        const why = String(error?.message ?? error);
        if (this.closed) notify({ title: `${ticket.key}: not saved`, body: why, level: "error" });
        this.actionError = why;
      }
      this.acting = false;
      if (this.closed) return;
      if (action.move && !this.pending) { this.refresh(cx); this.loadMoves(cx, ticket.key); }
      cx.notify();
    });
  }

  // The names matching the "@name" being typed, as buttons that make it a mention chip
  mentionRow(t, button) {
    const q = this.mention;
    const people = !Array.isArray(this.people) ? [] : this.people.filter((u) => fold(u.name).includes(fold(q))).slice(0, 6);
    return h_flex().flex_wrap().items_center().gap(6)
      .child(div().pr(4).text_size(12).text_color(t.muted).child("Mention"))
      .when(this.people == null, (el) => el.child(div().text_color(t.working).frames(SPINNER, 90)))
      .when(Array.isArray(this.people) && !people.length, (el) => el.child(div().text_size(12).text_color(t.dim).child(`No one called “${q}”`)))
      .children(people.map((u) => button(`mention-${u.id}`, u.name, (_e, cx) => this.mentionPerson(cx, u))));
  }

  // The comment field and its button, which asks for a confirmation before posting
  commentRow(t, button) {
    const text = this.comment.value().trim();
    return h_flex().items_end().gap(8)
      .child(div().flex_1().min_w(0).child(Textarea.new(this.comment).w_full().px(10).py(6).rounded(8).border_1()
        .border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)))
      .child(button("actions-comment", "Comment", (_e, cx) => {
        if (!text) return;
        this.pending = { text, content: this.comment.content() };
        this.actionError = "";
        cx.notify();
      }).when(!text, (el) => el.opacity(0.5)));
  }

  // The confirmation row: the question, Cancel and the action, or a spinner while it runs
  confirmRow(t, button, question, label) {
    const primary = (id, text, action) => button(id, text, action).bg(t.solid).border_color(t.solid).text_color(t.solid_foreground);
    return h_flex().items_center().gap(8)
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(question))
      .when(this.acting, (el) => el.child(div().text_color(t.working).frames(SPINNER, 90)))
      .when(!this.acting, (el) => el
        .child(button("actions-cancel", "Cancel", (_e, cx) => { this.pending = null; cx.notify(); }))
        .child(primary("actions-confirm", label, (_e, cx) => this.confirm(cx))));
  }

  // Yours: among the ones you opened
  isMine(c) {
    return (this.changes.mine ?? []).some((x) => x.id === c.id);
  }

  // The selected merge request's actions: open it, start an agent on it, retry its pipeline when it
  // failed, comment; the writes ask before going out
  changePanel(t, c, button) {
    const p = this.pending;
    return v_flex().id("change-actions").flex_none().p(12).gap(10).rounded(9).border_1().border_color(t.accent).bg(t.surface)
      .child(h_flex().items_center().gap(8)
        .child(div().id("change-actions-ref").flex_none().text_size(12).font_medium().text_color(t.accent).cursor_pointer()
          .tooltip(`Open in ${this.code.name}`).on_click(() => this.browse(c)).child(c.ref))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(c.title))
        .child(h_flex().flex_none().items_center().gap(5).px(6).py(1).rounded(4).bg(t.raised)
          .child(div().size(7).rounded_full().bg(PIPELINE_COLORS[c.pipeline] ?? t.dim))
          .child(div().text_size(11).text_color(t.muted).child(c.pipeline ? `pipeline ${c.pipeline}` : "no pipeline")))
        .child(h_flex().id("change-actions-close").size(24).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).tooltip("Close").on_click((_e, cx) => this.pickChange(cx, c))
          .child(div().text_size(13).text_color(t.muted).child("✕"))))
      .child(div().truncate().text_size(11.5).text_color(t.muted).child(`${c.project.name} · ${c.branch} → ${c.target}`))
      .when(Boolean(p), (el) => el.child(p?.retry
        ? this.confirmRow(t, button, `Retry the failed jobs of ${c.ref}'s pipeline?`, "Retry")
        : this.confirmRow(t, button, `Post this comment on ${c.ref}?`, "Post")))
      .when(!p, (el) => el
        .child(h_flex().flex_wrap().items_center().gap(6)
          .child(button("change-open", `Open in ${this.code.name}`, () => this.browse(c)))
          .when(Boolean(this.client.code?.tasks?.[this.isMine(c) ? "answer" : "review"]), (el) => el.child(button("change-agent",
            this.isMine(c) ? "Answer the review with an agent" : "Review with an agent",
            (_e, cx) => this.startChange(cx, c, this.isMine(c) ? "answer" : "review"))))
          .when(this.code.retryable(c), (el) => el.child(button("change-retry", "Retry pipeline", (_e, cx) => {
            this.pending = { retry: true };
            this.actionError = "";
            cx.notify();
          }))))
        .when(this.mention != null, (el) => el.child(this.mentionRow(t, button)))
        .child(this.commentRow(t, button)))
      .when(Boolean(this.actionError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.actionError)));
  }

  // The selected card's actions: where its workflow can move it, and a comment; both ask before writing
  panel(t, ticket, button) {
    const k = ticket.key;
    const moves = Array.isArray(this.moves) ? this.moves.filter((m) => m.to !== ticket.status?.id) : [];
    const p = this.pending;
    return v_flex().id("actions").flex_none().p(12).gap(10).rounded(9).border_1().border_color(t.accent).bg(t.surface)
      .child(h_flex().items_center().gap(8)
        .child(div().id("actions-key").flex_none().text_size(12).font_medium().text_color(t.accent).cursor_pointer()
          .tooltip(`Open in ${this.tracker.name}`).on_click(() => this.browse(ticket)).child(k))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(ticket.title ?? ""))
        .child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(ticket.status?.name ?? ""))
        .child(h_flex().id("actions-close").size(24).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).tooltip("Close").on_click((_e, cx) => this.pick(cx, ticket))
          .child(div().text_size(13).text_color(t.muted).child("✕"))))
      .when(Boolean(p), (el) => el.child(p?.move
        ? this.confirmRow(t, button, `Move ${k} to “${p.move.name}”?`, "Move")
        : this.confirmRow(t, button, `Post this comment on ${k}?`, "Post")))
      .when(!p, (el) => el
        .child(h_flex().flex_wrap().items_center().gap(6)
          .child(div().pr(4).text_size(12).text_color(t.muted).child("Move to"))
          .when(this.moves == null, (el) => el.child(div().text_color(t.working).frames(SPINNER, 90)))
          .when(Boolean(this.moves?.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.moves.error)))
          .when(Array.isArray(this.moves) && !moves.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("Nothing allowed from here")))
          .children(moves.map((m) => button(`move-${m.id}`, m.name, (_e, cx) => { this.pending = { move: m }; this.actionError = ""; cx.notify(); })
            .tooltip(m.hint))))
        .when(this.mention != null, (el) => el.child(this.mentionRow(t, button)))
        .child(this.commentRow(t, button)))
      .when(Boolean(this.actionError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.actionError)));
  }

  // The sidebar: the focused space's ticket on top, then one section per client with your open tickets.
  // The ticket follows the focus: its key in the space's name or branch, its client by the terminal's folder
  initSide(cx) {
    this.closed = false;
    this.profiles = null;
    this.trackers = new Map();   // client name -> its tracker's provider
    this.hosts = new Map();      // client name -> its code host's provider, or null
    this.side = { key: undefined, ticketClient: undefined, ticket: null, mine: {}, errors: {}, at: null, error: "",
      changes: {}, codeErrors: {},   // client name -> { mine, review }, or why not
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

  // One provider per client, kept for the sidebar's life
  trackerFor(client) {
    if (!this.trackers.has(client.name)) this.trackers.set(client.name, trackerOf(client));
    return this.trackers.get(client.name);
  }

  hostFor(client) {
    if (!this.hosts.has(client.name)) this.hosts.set(client.name, codeOf(client));
    return this.hosts.get(client.name);
  }

  // The clients whose tracker this mod can read
  sideClients() {
    return (this.profiles ?? []).filter((p) => !p.error && p.tracker && this.trackerFor(p));
  }

  sideClient() {
    const client = clientFor(this.profiles ?? [], focused()?.cwd ?? home());
    return client && this.trackerFor(client) ? client : null;
  }

  loadAllMine(cx) {
    for (const client of this.sideClients()) {
      this.loadMine(cx, client);
      if (this.hostFor(client)) this.loadSideChanges(cx, client);
    }
  }

  loadSideChanges(cx, client) {
    cx.spawn(async (cx) => {
      try {
        this.side.changes[client.name] = await this.hostFor(client).changes();
        delete this.side.codeErrors[client.name];
      } catch (error) {
        this.side.codeErrors[client.name] = String(error?.message ?? error);
      }
      if (!this.closed) cx.notify();
    });
  }

  // The space on a merge request's branch
  spaceOfBranch(branch) {
    return branch ? spaces().find((s) => s.branch === branch) : null;
  }

  loadMine(cx, client) {
    cx.spawn(async (cx) => {
      try {
        this.side.mine[client.name] = await this.trackerFor(client).mine();
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
      const ticket = await this.trackerFor(client).ticket(key).catch(() => false);
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
    const dot = (ticket) => {
      const category = ticket.status?.category;
      return div().size(8).flex_none().rounded_full().bg(category === "done" ? t.done : category === "doing" ? t.working : t.dim);
    };
    const row = (ticket, id, tracker) => {
      const k = ticket.key;
      return h_flex().id(`mine-${id}`).flex_none().items_center().gap(7).px(8).py(5).rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(this.spaceOf(k) ? "Go to its space" : `Open in ${tracker.name}`)
        .on_click(() => { const s = this.spaceOf(k); if (s) run("space.select", { id: s.id }); else this.browse(ticket); })
        .child(dot(ticket))
        .child(div().flex_none().text_size(11.5).font_medium().text_color(t.muted).child(k))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(ticket.title ?? ""));
    };
    const changeRow = (change, id, host) => {
      const s = this.spaceOfBranch(change.branch);
      return h_flex().id(`change-${id}`).flex_none().items_center().gap(7).px(8).py(5).rounded(6).cursor_pointer()
        .hover((st) => st.bg(t.hover)).tooltip(s ? "Go to its space" : `Open in ${host.name}`)
        .on_click(() => { if (s) run("space.select", { id: s.id }); else this.browse(change); })
        .child(div().size(8).flex_none().rounded_full().bg(PIPELINE_COLORS[change.pipeline] ?? t.dim))
        .child(div().flex_none().text_size(11.5).font_medium().text_color(t.muted).child(change.ref))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(change.draft ? t.muted : t.foreground).child(change.title))
        .when(change.threads.open > 0 || change.conflicts, (el) => el.child(div().flex_none().text_size(11).text_color(t.blocked)
          .child(change.conflicts ? "!" : `${change.threads.open}💬`)));
    };
    const small = (text) => div().px(8).pt(4).text_size(10.5).font_semibold().text_color(t.dim).child(text);
    // A client's merge requests, under its tickets: yours, then the ones waiting for your review
    const changesOf = (c, ci) => {
      const host = this.hostFor(c);
      const found = this.side.changes[c.name];
      const error = this.side.codeErrors[c.name];
      return v_flex().id(`client-changes-${ci}`).flex_none().gap(1)
        .when(!found && !error, (el) => el.child(small("MERGE REQUESTS")).child(div().px(8).text_color(t.working).frames(SPINNER, 90)))
        .when(Boolean(error), (el) => el.child(small("MERGE REQUESTS")).child(div().px(8).text_size(11.5).text_color(t.blocked).child(`${host.name}: ${error}`)))
        .when(Boolean(found), (el) => el
          .child(small(`YOUR ${host.changeName.toUpperCase()}S · ${found.mine.length}`))
          .children(found.mine.map((change, i) => changeRow(change, `${ci}-m${i}`, host)))
          .child(small(`TO REVIEW · ${found.review.length}`))
          .children(found.review.map((change, i) => changeRow(change, `${ci}-r${i}`, host))));
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
          .children((mine ?? []).map((ticket, i) => row(ticket, `${ci}-${i}`, this.trackerFor(c))))
          .when(Boolean(this.hostFor(c)), (el) => el.child(changesOf(c, ci))));
    };
    const clients = this.sideClients();
    const tk = this.side.ticket;
    const priority = PRIORITY_MARKS[tk?.priority?.level];
    const here = !key ? div().px(8).text_size(12).text_color(t.dim).child("No ticket in this space")
      : tk === false ? div().px(8).text_size(12).text_color(t.dim).child(`${key} isn't in ${client?.name ?? "the tracker"}`)
      : !tk ? div().px(8).text_color(t.working).frames(SPINNER, 90)
      : v_flex().id("here").flex_none().p(10).gap(6).rounded(8).border_1().border_color(t.border).bg(t.background)
        .child(h_flex().items_center().gap(6)
          .child(div().id("here-type").size(10).flex_none().rounded(3).bg(tk.type.color).tooltip(tk.type.name))
          .child(div().id("here-key").flex_none().text_size(12).font_medium().text_color(t.accent).cursor_pointer()
            .tooltip(`Open in ${this.trackerFor(client).name}`).on_click(() => this.browse(tk)).child(tk.key))
          .child(div().flex_1())
          .when(Boolean(priority), (el) => el.child(div().text_size(12).font_semibold().text_color(priority.color).child(priority.glyph)))
          .child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(tk.status.name)))
        .child(div().text_size(13).whitespace_normal().child(tk.title))
        .child(div().text_size(11.5).text_color(t.dim).child(tk.assignee?.name ?? "Unassigned"));
    // The merge request of the focused space's branch, from the lists already loaded
    const branch = space?.branch;
    const hc = branch ? Object.values(this.side.changes).flatMap((f) => [...f.mine, ...f.review]).find((c) => c.branch === branch) : null;
    const hereChange = hc && v_flex().id("here-change").flex_none().p(10).gap(4).rounded(8).border_1().border_color(t.border).bg(t.background)
      .cursor_pointer().hover((s) => s.border_color(t.input)).tooltip("Open the merge request").on_click(() => this.browse(hc))
      .child(h_flex().items_center().gap(6)
        .child(div().size(8).flex_none().rounded_full().bg(PIPELINE_COLORS[hc.pipeline] ?? t.dim))
        .child(div().flex_none().text_size(12).font_medium().text_color(t.accent).child(hc.ref))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(hc.project.name))
        .when(hc.draft, (el) => el.child(div().flex_none().px(5).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child("Draft"))))
      .child(div().text_size(11.5).whitespace_normal().text_color(hc.conflicts || hc.pipeline === "failed" ? t.blocked : t.muted)
        .child(changeFacts(hc).join(" · ")));
    const label = (text) => div().px(8).text_size(11).font_semibold().text_color(t.muted).child(text);
    return v_flex().id("workbench-side").size_full().bg(t.chrome)
      .min_h(0).p(10).gap(10).text_color(t.foreground)
      .child(div().flex_none().px(4).text_size(13).font_semibold().child("Workbench"))
      .child(label("THIS SPACE"))
      .child(here)
      .when(Boolean(hc), (el) => el.child(hereChange))
      .child(v_flex().id("clients").flex_1().min_h(0).gap(10).overflow_y_scrollbar()
        .when(this.profiles != null && !clients.length, (el) => el.child(div().px(8).text_size(12).text_color(t.dim)
          .child(`No client profile with a tracker this mod reads: write one as ${PROFILES}`)))
        .children(clients.map(section)))
      .children((this.profiles ?? []).filter((p) => p.error).map((p) => div().px(8).text_size(11.5).text_color(t.blocked).child(p.error)))
      .when(Boolean(this.side.error), (el) => el.child(div().px(8).text_size(11.5).text_color(t.blocked).child(this.side.error)))
      .child(div().flex_none().px(8).text_size(10.5).text_color(t.dim)
        .child(this.side.at ? `updated ${this.side.at.toTimeString().slice(0, 5)}` : ""));
  }

  browse(ticket) {
    if (ticket.url) exec("open", [ticket.url]).catch(() => {});
  }

  // The local checkout of a code host's project (its path, "group/repo"): a repository in the client's folders
  // whose origin is that project. Worktrees ("<repo>--<branch>") are skipped, roger finds them itself
  async repoFor(path) {
    if (!this.repos) {
      const folders = (this.client.folders ?? [this.client.file.replace(/\/[^/]+$/, "")]).map((f) => f.replace(/^~/, home()));
      const script = 'for d in "$@"; do for r in $d/*(/N); do [[ $r == *--* ]] && continue; '
        + 'u=$(git -C $r remote get-url origin 2>/dev/null) && print -r -- "$r\t$u"; done; done';
      const r = await exec("/bin/zsh", ["-c", script, "zsh", ...folders], { cwd: home() });
      this.repos = new Map((r.stdout ?? "").split("\n").filter(Boolean).map((line) => {
        const [dir, url] = line.split("\t");
        // ssh://git@host:4222/group/repo.git, git@host:group/repo.git, https://host/group/repo
        const project = url.replace(/\.git$/, "").replace(/^[a-z+]+:\/\/[^/]+\//, "").replace(/^[^@/]+@[^:]+:/, "");
        return [project, dir];
      }));
    }
    return this.repos.get(path) ?? null;
  }

  // An agent on a merge request's branch, through roger: in its worktree (made when missing), with the
  // profile's first message for it: "review" for someone else's, "answer" for the review of yours
  startChange(cx, c, kind) {
    const task = this.client.code?.tasks?.[kind]?.replaceAll("{url}", c.url);
    if (!task || this.busy) return;
    cx.spawn(async (cx) => {
      const repo = await this.repoFor(c.project.path).catch(() => null);
      if (!repo) {
        this.error = `${c.ref}: no checkout of ${c.project.path} in ${this.client.name}'s folders`;
        return cx.notify();
      }
      await this.launch(cx, ["open", c.branch, "--task", task], { cwd: repo, key: c.id, label: c.ref });
    });
  }

  start(cx, args) {
    if (this.busy) return;
    cx.spawn(async (cx) => this.launch(cx, args));
  }

  // opts: cwd (default: the terminal you were in), key (the card showing the spinner), label (in messages)
  async launch(cx, args, opts = {}) {
    const ticket = opts.label ?? args[1];
    this.busy = `roger ${args.join(" ")}`;
    this.busyKey = opts.key ?? args[1];
    this.error = "";
    this.choices = null;
    cx.notify();
    let r;
    try { r = await exec("roger", args, { cwd: opts.cwd ?? this.cwd, timeout: 600_000 }); }
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

  // A card as the tracker draws it: the parent of a subtask outside its story's lane, the title, the
  // epic, the board's extra lines, then type, key, priority, assignee and the agent button
  card(t, ticket, inStory) {
    const k = ticket.key;
    const starting = this.busyKey === k;
    const lines = ticket.lines ?? [];
    const parent = ticket.type.subtask && !inStory ? ticket.parent : null;
    const priority = PRIORITY_MARKS[ticket.priority.level];
    const who = ticket.assignee?.name;
    const open = `Open in ${this.tracker.name}`;
    const avatar = h_flex().id(`who-${k}`).size(22).flex_none().items_center().justify_center().rounded_full()
      .tooltip(who ?? "Unassigned")
      .when(Boolean(who), (el) => el.bg(AVATAR_COLORS[[...who].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_COLORS.length])
        .text_size(9.5).font_semibold().text_color("#1d2125").child(initials(who)))
      .when(!who, (el) => el.border_1().border_color(t.input));
    return v_flex().id(`card-${k}`).flex_none().rounded(7).border_1().border_color(this.selected?.key === k ? t.accent : t.border)
      .bg(t.background).overflow_hidden().cursor_pointer().on_click((_e, cx) => this.pick(cx, ticket))
      .when(Boolean(parent), (el) => el.child(h_flex().id(`up-${k}`).px(9).py(5).gap(6).bg(t.raised).text_size(11).cursor_pointer()
        .tooltip(open).on_click((_e, cx) => { cx.stop_propagation(); this.browse(parent); })
        .child(div().flex_none().font_medium().text_color(t.muted).child(parent.key))
        .child(div().min_w(0).truncate().text_color(t.dim).child(parent.title))))
      .child(v_flex().p(9).gap(6)
        .child(div().text_size(13).whitespace_normal().child(ticket.title))
        .when(Boolean(ticket.epic?.name), (el) => el.child(h_flex().flex_none().self_start().max_w_full().items_center().gap(5).px(5).py(1)
          .rounded(4).border_1().border_color(ticket.epic.color)
          .child(div().size(8).flex_none().rounded(2).bg(ticket.epic.color))
          .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(ticket.epic.name))))
        .when(lines.length > 0, (el) => el.child(v_flex().gap(1)
          .children(lines.map((line) => div().truncate().text_size(11.5).text_color(t.muted).child(line)))))
        .child(h_flex().items_center().gap(6)
          .child(div().id(`type-${k}`).size(12).flex_none().rounded(3).bg(ticket.type.color).tooltip(ticket.type.name))
          .child(div().id(`key-${k}`).flex_none().text_size(11.5).font_medium().text_color(t.muted).cursor_pointer()
            .hover((s) => s.text_color(t.accent)).tooltip(open)
            .on_click((_e, cx) => { cx.stop_propagation(); this.browse(ticket); }).child(k))
          .child(div().flex_1())
          .when(Boolean(priority), (el) => el.child(div().id(`prio-${k}`).flex_none().text_size(12.5).font_semibold()
            .text_color(priority.color).tooltip(ticket.priority.name).child(priority.glyph)))
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
  lane(t, board, columns, lane) {
    const key = `${board.id}/${lane.id}`;
    const folded = this.collapsed.has(key);
    const p = lane.parent;
    const count = `(${lane.tickets.length} ${p ? "subtask" : "work item"}${lane.tickets.length === 1 ? "" : "s"})`;
    const title = h_flex().id(`lane-${lane.id}`).flex_none().items_center().gap(8).px(2).cursor_pointer()
      .on_click((_e, cx) => this.toggleLane(cx, key))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(14).flex_none().text_color(t.muted))
      .when(Boolean(p), (el) => el
        .child(div().id(`parent-${lane.id}`).flex_none().text_size(12).font_medium().text_color(t.accent).cursor_pointer()
          .hover((s) => s.opacity(0.75)).tooltip(`Open in ${this.tracker.name}`)
          .on_click((_e, cx) => { cx.stop_propagation(); this.browse(p); }).child(p.key))
        .child(div().min_w(0).truncate().text_size(13).font_semibold().child(p.title)))
      .when(!p, (el) => el.child(div().min_w(0).truncate().text_size(13).font_semibold().child(lane.name)))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(count))
      .when(Boolean(p?.status), (el) => el.child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised)
        .text_size(11).text_color(t.muted).child(p.status)));
    // By priority, highest first; the sort is stable, so the board's rank order holds within a priority
    const cells = h_flex().id(`cells-${lane.id}`).flex_none().items_start().gap(10).children(columns.map((col, ci) => {
      const cards = lane.tickets.filter((x) => x.column === ci).sort((a, b) => a.priority.rank - b.priority.rank);
      return v_flex().id(`cell-${lane.id}-${ci}`).flex_1().min_w(0).min_h(64).p(8).gap(8).rounded(9).bg(t.surface)
        .child(h_flex().flex_none().items_center().gap(6).px(2)
          .child(div().min_w(0).truncate().text_size(11).font_semibold().text_color(t.muted).child(col.name.toUpperCase()))
          .child(div().text_size(11).text_color(t.dim).child(String(cards.length))))
        .children(cards.map((ticket) => this.card(t, ticket, Boolean(p))));
    }));
    if (lane.name == null && !p) return cells;
    return v_flex().id(`lanebox-${lane.id}`).flex_none().gap(8).child(title).when(!folded, (el) => el.child(cells));
  }

  render(cx) {
    if (this.view) return this.renderSide(cx);
    const t = theme();
    const boards = this.tracker?.boards ?? [];
    const onChanges = this.onChanges();
    const board = boards[this.board];
    const entry = board && this.boards[board.id];
    const loading = onChanges ? this.loadingChanges : Boolean(board && this.loading.has(board.id));
    const changes = this.changes;
    const isMine = (x) => !this.mine || x.assignee?.id === this.me;
    const tickets = (entry?.tickets ?? []).filter(isMine);
    const columns = entry?.columns ?? [];
    const sel = this.selected && ((entry?.tickets ?? []).find((x) => x.key === this.selected.key) ?? this.selected);
    const selChange = this.selectedChange
      && ([...(this.changes.mine ?? []), ...(this.changes.review ?? [])].find((x) => x.id === this.selectedChange.id) ?? this.selectedChange);
    // Lanes come from every ticket, so "Only mine" never turns a story into a card; empty lanes go, the plain board stays
    const shown = (entry?.lanes ?? [])
      .map((l) => ({ ...l, tickets: l.tickets.filter(isMine) }))
      .filter((l) => l.tickets.length || l.id === "all");
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
    const status = onChanges
      ? (changes.at ? `${(changes.mine?.length ?? 0) + (changes.review?.length ?? 0)} open · updated ${changes.at.toTimeString().slice(0, 5)}` : "Loading…")
      : entry?.at
      ? `${tickets.length} ${this.mine ? "yours" : "tickets"}` + (entry.total > (entry.tickets?.length ?? 0) ? ` (first ${entry.tickets.length} of ${entry.total})` : "")
        + ` · updated ${entry.at.toTimeString().slice(0, 5)}`
      : loading || (!this.client && !this.problem) ? "Loading…" : "";
    // The merge requests tab: yours, then the ones waiting for your review
    const group = (title, list, yours) => v_flex().flex_none().gap(8)
      .child(h_flex().items_center().gap(8).px(2)
        .child(div().text_size(13).font_semibold().child(title))
        .when(Array.isArray(list), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(`(${list.length})`))))
      .when(Array.isArray(list) && !list.length, (el) => el.child(div().px(2).text_size(12).text_color(t.dim).child("None")))
      .child(h_flex().flex_wrap().items_start().gap(10)
        .children((list ?? []).map((c, i) => this.changeCard(t, c, `${yours ? "mine" : "review"}-${i}`, yours))));
    return v_flex().id("workbench").size_full().min_h(0).p(16).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_none().pr(6).text_size(15).font_semibold().child(this.client?.name ?? "Workbench"))
        .children(boards.map(tab))
        .when(Boolean(this.code), (el) => el.child(tab({ id: "changes", label: `${this.code.changeName}s` }, boards.length)))
        .child(div().flex_1())
        .when(!onChanges, (el) => el.child(toggle))
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
      .when(!onChanges && Boolean(entry?.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(`${this.tracker.name}: ${entry.error}`)))
      .when(onChanges && Boolean(changes.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(`${this.code.name}: ${changes.error}`)))
      .when(!onChanges, (el) => el.child(v_flex().id("lanes").flex_1().min_h(0).gap(16).overflow_y_scrollbar()
        .children(entry?.columns ? shown.map((l) => this.lane(t, board, columns, l)) : [])))
      .when(onChanges, (el) => el.child(v_flex().id("changes").flex_1().min_h(0).gap(20).overflow_y_scrollbar()
        .child(group("Yours", changes.mine, true))
        .child(group("To review", changes.review, false))))
      .when(!onChanges && Boolean(sel), (el) => el.child(this.panel(t, sel, button)))
      .when(onChanges && Boolean(selChange), (el) => el.child(this.changePanel(t, selChange, button)))
      .child(h_flex().gap(8).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(status))
        .child(div().flex_none().child(`Agents start in ${this.cwd.replace(home(), "~")}`)));
  }
}
