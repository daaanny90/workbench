// Sessions: the agents at work on a ticket or a merge request. A session is a Herdr space: its ticket is the
// key in its name or branch, its merge request the one on its branch, its agents the ones in its tabs.
import { spaces, agents } from "herdr";

export const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;
// Most urgent first: an agent asking, one that finished while you weren't looking, one at work, one waiting
const URGENCY = { blocked: 0, done: 1, working: 2, idle: 3 };

export function urgency(status) {
  return URGENCY[status] ?? 4;
}

// Every space: { space, key, branch, agents (most urgent first), status (its most urgent), since (working
// since, ms), changed (ms) }
export function sessions() {
  const bySpace = new Map();
  for (const a of agents()) {
    if (!bySpace.has(a.space)) bySpace.set(a.space, []);
    bySpace.get(a.space).push(a);
  }
  return spaces().map((s) => {
    const list = (bySpace.get(s.id) ?? []).sort((a, b) => urgency(a.status) - urgency(b.status) || b.seq - a.seq);
    const working = s.tabs.map((t) => t.working_since).filter(Boolean);
    const changed = s.tabs.map((t) => t.changed_at).filter(Boolean);
    return {
      space: s, key: `${s.name ?? ""} ${s.branch ?? ""}`.match(TICKET_KEY)?.[0] ?? null, branch: s.branch,
      agents: list, status: list[0]?.status ?? null,
      since: working.length ? Math.min(...working) : null, changed: changed.length ? Math.max(...changed) : 0,
    };
  });
}

// A merge request's session: the space on its branch
export function onBranch(list, branch) {
  return branch ? list.find((x) => x.branch === branch) ?? null : null;
}

// A ticket's session: the space with its key, the one where an agent is most urgent when there are several
export function ofKey(list, key) {
  return key ? list.filter((x) => x.key === key).sort((a, b) => urgency(a.status) - urgency(b.status))[0] ?? null : null;
}

// "12m", "1h05" since a time in ms
export function elapsed(since) {
  const minutes = Math.max(0, Math.floor((Date.now() - since) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}
