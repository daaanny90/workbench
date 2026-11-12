// GitLab as a code host: your open merge requests, the ones waiting for your review and the ones nobody
// reviews yet, in the workbench's shape, from one GraphQL request; a failed pipeline retried, a comment
// with @mentions.
// One instance per client and per view.
//
// A change: { id, gid, ref ("!2098"), title, url, project: { path, name }, branch, target, draft, author,
//   authorId (username), pipeline: "success" | "failed" | "running" | "pending" | "canceled" | "skipped" | "manual" | … | null,
//   pipelineId, approved, approvedBy: [name], threads: { open, all }, conflicts, reviewers: [name], updated }
import { post } from "../http.js";

const FIELDS = `id iid title webUrl draft sourceBranch targetBranch updatedAt author { name username } project { fullPath name }
  headPipeline { id status } approved approvedBy { nodes { name } } resolvableDiscussionsCount resolvedDiscussionsCount
  conflicts reviewers { nodes { name } }`;
// groups: where to look for the open merge requests without a reviewer (drafts aside), subgroups included
const changesQuery = (groups) => `query { currentUser { username
  authoredMergeRequests(state: opened, first: 50, sort: UPDATED_DESC) { nodes { ${FIELDS} } }
  reviewRequestedMergeRequests(state: opened, first: 50, sort: UPDATED_DESC) { nodes { ${FIELDS} } } }
  ${groups.map((g, i) => `g${i}: group(fullPath: ${JSON.stringify(g)}) { mergeRequests(state: opened, draft: false,
    reviewerWildcardId: NONE, includeSubgroups: true, first: 50, sort: UPDATED_DESC) { nodes { ${FIELDS} } } }`).join("\n  ")} }`;
const MEMBERS = `query($p: ID!) { project(fullPath: $p) {
  projectMembers(first: 100, relations: [DIRECT, INHERITED]) { nodes { user { username name state bot } } } } }`;
const RETRY = "mutation($id: CiPipelineID!) { pipelineRetry(input: { id: $id }) { errors } }";
const NOTE = "mutation($id: NoteableID!, $body: String!) { createNote(input: { noteableId: $id, body: $body }) { errors } }";

// Pipelines GitLab retries: their failed jobs run again
const RETRYABLE = new Set(["failed", "canceled"]);

function change(m) {
  return {
    id: `${m.project?.fullPath}!${m.iid}`, gid: m.id, ref: `!${m.iid}`, title: m.title ?? "", url: m.webUrl,
    project: { path: m.project?.fullPath ?? "", name: m.project?.name ?? "" },
    branch: m.sourceBranch ?? "", target: m.targetBranch ?? "", draft: Boolean(m.draft), author: m.author?.name ?? "",
    authorId: m.author?.username ?? "",
    pipeline: m.headPipeline?.status?.toLowerCase() ?? null, pipelineId: m.headPipeline?.id ?? null,
    approved: Boolean(m.approved), approvedBy: (m.approvedBy?.nodes ?? []).map((u) => u.name),
    threads: { open: (m.resolvableDiscussionsCount ?? 0) - (m.resolvedDiscussionsCount ?? 0), all: m.resolvableDiscussionsCount ?? 0 },
    conflicts: Boolean(m.conflicts), reviewers: (m.reviewers?.nodes ?? []).map((u) => u.name), updated: m.updatedAt,
  };
}

// The comment's text: each mention chip becomes @username, which GitLab turns into a mention.
// Chip ranges count like JavaScript strings
function commentBody(content) {
  let text = content.text;
  for (const { range, token } of [...content.tokens].sort((a, b) => b.range.start - a.range.start)) {
    text = text.slice(0, range.start) + `@${token.id}` + text.slice(range.end);
  }
  return text.trim();
}

// A mutation's own errors, which come back with a 200
function check(errors) {
  if (errors?.length) throw new Error(errors.join(" "));
}

// config: the profile's code host, { site, keychain, vpn?, unassigned?: { groups, skipAuthors? } }
export function gitlabHost(config) {
  const conn = { service: "GitLab", site: config.site, header: "PRIVATE-TOKEN: @@", keychain: config.keychain };

  async function gql(query, variables = {}) {
    let found;
    try {
      found = await post(conn, "/api/graphql", { query, variables });
    } catch (error) {
      const why = String(error?.message ?? error);
      // Behind a VPN, a closed one answers 403 or doesn't answer
      throw new Error(config.vpn && /\b403\b|resolve host|connect|timed out|unreachable/i.test(why) ? `${why}: is the VPN on?` : why);
    }
    if (found?.errors?.length) throw new Error(found.errors.map((e) => e.message).join(" "));
    return found?.data ?? {};
  }

  return {
    name: "GitLab",
    changeName: "Merge request",

    // { mine, review, unassigned }: yours, the ones waiting for your review, and the others nobody reviews
    // yet in the profile's groups (but the authors it skips, such as a bot); latest first
    async changes() {
      const groups = config.unassigned?.groups ?? [];
      const skip = new Set(config.unassigned?.skipAuthors ?? []);
      const data = await gql(changesQuery(groups));
      const me = data.currentUser;
      return {
        mine: (me?.authoredMergeRequests?.nodes ?? []).map(change),
        review: (me?.reviewRequestedMergeRequests?.nodes ?? []).map(change),
        unassigned: groups.flatMap((_g, i) => data[`g${i}`]?.mergeRequests?.nodes ?? []).map(change)
          .filter((c) => c.authorId !== me?.username && !skip.has(c.authorId))
          .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "")),
      };
    },

    retryable(c) {
      return Boolean(c.pipelineId) && RETRYABLE.has(c.pipeline);
    },

    async retry(c) {
      check((await gql(RETRY, { id: c.pipelineId })).pipelineRetry?.errors);
    },

    // content: the comment field's text and its mention chips
    async comment(c, content) {
      check((await gql(NOTE, { id: c.gid, body: commentBody(content) })).createNote?.errors);
    },

    // Who can be mentioned on a merge request: its project's members, by username
    async people(c) {
      const nodes = (await gql(MEMBERS, { p: c.project.path })).project?.projectMembers?.nodes ?? [];
      const seen = new Set();
      return nodes.map((n) => n.user).filter((u) => u && u.state === "active" && !u.bot && !seen.has(u.username) && seen.add(u.username))
        .map((u) => ({ id: u.username, name: u.name })).sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
