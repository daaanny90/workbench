// Jira as a tracker: its boards with their own columns and swimlanes, tickets in the workbench's shape,
// status moves and comments. One instance per client and per view: what it keeps lives on the instance.
//
// A ticket: { id, key, url, title,
//   status: { id, name, category: "todo" | "doing" | "done" }, type: { name, color, subtask },
//   priority: { name, level: "highest" | "high" | "medium" | "low" | "lowest" | null, rank },
//   assignee: { id, name } | null, parent: { id, key, url, title, status } | null, project: { key, name } | null,
//   lines: [text], epic: { name, color } | null, and on a board its column's index }
import { get, post } from "../http.js";

const FIELDS = "summary,status,assignee,priority,issuetype,parent,project";
const PAGE = 100;
const MAX_ISSUES = 500;
const CATEGORIES = { new: "todo", indeterminate: "doing", done: "done" };

// Jira's epic label colors by name
const EPIC_COLORS = {
  blue: "#579dff", dark_blue: "#0c66e4", green: "#4bce97", dark_green: "#1f845a", teal: "#6cc3e0", dark_teal: "#227d9b",
  yellow: "#e2b203", dark_yellow: "#b38600", orange: "#fea362", dark_orange: "#c25100", red: "#f87168", dark_red: "#c9372c",
  purple: "#9f8fef", dark_purple: "#6e5dc6", grey: "#8590a2", dark_grey: "#626f86",
};

// The issue type's color, as on Jira's icons
function typeColor(name = "") {
  if (/bug/i.test(name)) return "#e5493a";
  if (/story/i.test(name)) return "#63ba3c";
  if (/epic|ops/i.test(name)) return "#904ee2";
  return "#4bade8";
}

// The priority's level by Jira's standard names; a profile maps its own ones ("priorityAliases"),
// anything else has none
function priorityLevel(name = "", aliases = {}) {
  const level = aliases[name] ?? name;
  if (/highest|blocker|critical/i.test(level)) return "highest";
  if (/high|major/i.test(level)) return "high";
  if (/medium/i.test(level)) return "medium";
  if (/lowest|trivial/i.test(level)) return "lowest";
  if (/low|minor/i.test(level)) return "low";
  return null;
}

function plain(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

// The comment for API v2, plain text: each mention chip becomes [~accountid:…], which notifies that
// person. Chip ranges count like JavaScript strings, so umlauts and emoji before a chip don't shift it
function commentBody(content) {
  let text = content.text;
  for (const { range, token } of [...content.tokens].sort((a, b) => b.range.start - a.range.start)) {
    text = text.slice(0, range.start) + `[~accountid:${token.id}]` + text.slice(range.end);
  }
  return text.trim();
}

// The tickets as the board's lanes, in Jira's order: [{ id, name?, parent?, tickets }]. One lane without
// a name is the plain board
function lanes(page, tickets) {
  const rest = (list) => ({ id: "other", name: "Everything else", tickets: list });
  if (page?.strategy === "parentChild") {
    // Only subtasks: stories under an epic have a parent too. A story with subtasks is its lane, not a card
    const byParent = new Map();
    for (const t of tickets) {
      if (!t.type.subtask || !t.parent) continue;
      if (!byParent.has(t.parent.id)) byParent.set(t.parent.id, { id: t.parent.key, parent: t.parent, tickets: [] });
      byParent.get(t.parent.id).tickets.push(t);
    }
    // In the stories' own rank order, as Jira does; a story that isn't on the board after them
    const rank = new Map(tickets.map((t, n) => [t.id, n]));
    const place = (id) => rank.get(id) ?? tickets.length;
    const parents = [...byParent.keys()].sort((a, b) => place(a) - place(b));
    const others = tickets.filter((t) => !byParent.has(t.id) && !(t.type.subtask && byParent.has(t.parent?.id)));
    return [...parents.map((id) => byParent.get(id)), rest(others)];
  }
  if (page?.strategy === "custom" && page.custom.length) {
    const list = page.custom.map((l) => ({ id: l.id, name: l.name, tickets: tickets.filter((t) => l.ids.has(t.id)) }));
    // Newer than Jira's assignment: the last lane is the board's catch-all
    const placed = new Set(list.flatMap((l) => l.tickets.map((t) => t.id)));
    list.at(-1).tickets.push(...tickets.filter((t) => !placed.has(t.id)));
    return list;
  }
  if (page?.strategy === "project") {
    const byProject = new Map();
    for (const t of tickets) {
      const p = t.project ?? { key: "?", name: "No project" };
      if (!byProject.has(p.key)) byProject.set(p.key, { id: p.key, name: `${p.name} (${p.key})`, tickets: [] });
      byProject.get(p.key).tickets.push(t);
    }
    return [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }
  return [{ id: "all", tickets }];
}

// config: the profile's tracker, { site, user, keychain, boards, hiddenColumns?, hiddenProjects?, priorityAliases? }
export function jiraTracker(config) {
  const conn = { service: "Jira", site: config.site, user: config.user, keychain: config.keychain };
  const hiddenProjects = config.hiddenProjects ?? [];   // e.g. another team's tickets on the same boards
  const notHidden = hiddenProjects.length ? ` AND project not in (${hiddenProjects.join(",")})` : "";
  const url = (key) => `${config.site}/browse/${key}`;
  let me = null;               // your accountId
  let ranks = null;            // priority id -> place in Jira's own order, highest first
  const kept = new Map();      // board id -> { config, page }: what a refresh reuses

  function ticket(i, extra) {
    const f = i.fields ?? {};
    const p = f.parent;
    return {
      id: i.id, key: i.key, url: url(i.key), title: f.summary ?? "",
      status: { id: f.status?.id, name: f.status?.name ?? "", category: CATEGORIES[f.status?.statusCategory?.key] ?? "todo" },
      type: { name: f.issuetype?.name ?? "", color: typeColor(f.issuetype?.name), subtask: Boolean(f.issuetype?.subtask) },
      priority: { name: f.priority?.name ?? "", level: priorityLevel(f.priority?.name, config.priorityAliases), rank: ranks?.get(f.priority?.id) ?? Infinity },
      assignee: f.assignee ? { id: f.assignee.accountId, name: f.assignee.displayName } : null,
      parent: p ? { id: p.id, key: p.key, url: url(p.key), title: p.fields?.summary ?? "", status: p.fields?.status?.name ?? "" } : null,
      project: f.project ? { key: f.project.key, name: f.project.name } : null,
      lines: extra?.lines ?? [f.status?.name ?? ""],
      epic: extra?.epic ?? null,
    };
  }

  // The board's visible columns and the JQL that fetches only their issues
  async function boardConfig(board) {
    const c = await get(conn, `/rest/agile/1.0/board/${board.id}/configuration`);
    const hiddenColumns = new Set(config.hiddenColumns ?? []);
    const columns = c.columnConfig.columns
      .filter((col) => !hiddenColumns.has(col.name) && col.statuses.length)
      .map((col) => ({ name: col.name, statuses: col.statuses.map((s) => s.id) }));
    const sub = c.subQuery?.query;
    const jql = `status in (${columns.flatMap((col) => col.statuses).join(",")})` + (sub ? ` AND (${sub})` : "") + notHidden;
    return { columns, jql };
  }

  // The board endpoint adds the board's own filter and keeps its rank order
  async function boardIssues(board, cfg) {
    const issues = [];
    let total = 0;
    for (let startAt = 0; startAt < MAX_ISSUES; startAt += PAGE) {
      const page = await get(conn, `/rest/agile/1.0/board/${board.id}/issue`, { jql: cfg.jql, fields: FIELDS, startAt, maxResults: PAGE });
      total = page.total ?? 0;
      issues.push(...(page.issues ?? []));
      if (!page.issues?.length || issues.length >= total) break;
    }
    return { issues, total };
  }

  // How the board groups and draws its issues, from the data Jira's own board page loads. Query lanes
  // come with Jira's own assignment of issues, first matching query wins; each card brings the board's
  // extra fields (deployment flags, status, reviewer) and its epic
  async function boardPage(board) {
    const data = await get(conn, "/rest/greenhopper/1.0/xboard/work/allData.json", { rapidViewId: board.id });
    const s = data.swimlanesData ?? {};
    return {
      strategy: s.swimlaneStrategy,
      custom: (s.customSwimlanesData?.swimlanes ?? []).map((l) => ({ id: String(l.id), name: l.name, ids: new Set((l.issueIds ?? []).map(String)) })),
      cards: new Map((data.issuesData?.issues ?? []).map((i) => [String(i.id), {
        lines: (i.extraFields ?? []).map((f) => f.text || plain(f.html ?? "")).filter(Boolean),
        epic: i.epicField ? { name: i.epicField.text ?? i.epicField.summary ?? "", color: EPIC_COLORS[i.epicField.color] ?? EPIC_COLORS.grey } : null,
      }])),
    };
  }

  return {
    name: "Jira",
    boards: config.boards,

    async me() {
      me ??= (await get(conn, "/rest/api/3/myself")).accountId;
      return me;
    },

    // A board: its columns, its lanes in Jira's order (from every ticket: filter after), its tickets with
    // their column, and how many there are in all. The board page is an internal endpoint: when it fails
    // the board keeps its last version, or shows plain columns and plain cards
    async board(board) {
      const k = kept.get(board.id) ?? {};
      kept.set(board.id, k);
      ranks ??= new Map((await get(conn, "/rest/api/3/priority")).map((p, n) => [p.id, n]));
      k.config ??= await boardConfig(board);
      const { issues, total } = await boardIssues(board, k.config);
      k.page = (await boardPage(board).catch(() => null)) ?? k.page;
      const columns = k.config.columns;
      const tickets = issues.map((i) => ({ ...ticket(i, k.page?.cards.get(i.id)),
        column: columns.findIndex((col) => col.statuses.includes(i.fields?.status?.id)) }));
      return { columns: columns.map((col) => ({ name: col.name })), lanes: lanes(k.page, tickets), tickets, total };
    },

    // Your open tickets, latest first
    async mine() {
      const found = await get(conn, "/rest/api/3/search/jql",
        { jql: `assignee = currentUser() AND statusCategory != Done${notHidden} ORDER BY updated DESC`, fields: FIELDS, maxResults: 20 });
      return (found.issues ?? []).map((i) => ticket(i));
    },

    async ticket(key) {
      return ticket(await get(conn, `/rest/api/3/issue/${key}`, { fields: FIELDS }));
    },

    // Where the workflow allows the ticket to go from its status now: [{ id, name, hint, to }]
    async moves(key) {
      const found = await get(conn, `/rest/api/3/issue/${key}/transitions`);
      return (found.transitions ?? []).filter((m) => m.isAvailable !== false)
        .map((m) => ({ id: m.id, name: m.to?.name ?? m.name, hint: m.name, to: m.to?.id }));
    },

    move(key, move) {
      return post(conn, `/rest/api/3/issue/${key}/transitions`, { transition: { id: move.id } });
    },

    // content: the comment field's text and its mention chips
    comment(key, content) {
      return post(conn, `/rest/api/2/issue/${key}/comment`, { body: commentBody(content) });
    },

    // Who can be mentioned: the people who can work on these tickets' projects
    async people(tickets) {
      const projects = [...new Set(tickets.map((t) => t.project?.key).filter(Boolean))];
      const users = await get(conn, "/rest/api/3/user/assignable/multiProjectSearch", { projectKeys: projects.join(","), maxResults: 1000 });
      return users.filter((u) => u.accountType === "atlassian" && u.active)
        .map((u) => ({ id: u.accountId, name: u.displayName })).sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
