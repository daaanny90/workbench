// GitLab as a code host: your open merge requests and the ones waiting for your review, in the
// workbench's shape, from one GraphQL request. One instance per client and per view.
//
// A change: { id, ref ("!2098"), title, url, project: { path, name }, branch, target, draft, author,
//   pipeline: "success" | "failed" | "running" | "pending" | "canceled" | "skipped" | "manual" | … | null,
//   approved, approvedBy: [name], threads: { open, all }, conflicts, reviewers: [name], updated }
import { post } from "../http.js";

const FIELDS = `iid title webUrl draft sourceBranch targetBranch updatedAt author { name } project { fullPath name }
  headPipeline { status } approved approvedBy { nodes { name } } resolvableDiscussionsCount resolvedDiscussionsCount
  conflicts reviewers { nodes { name } }`;
const QUERY = `query { currentUser {
  authoredMergeRequests(state: opened, first: 50, sort: UPDATED_DESC) { nodes { ${FIELDS} } }
  reviewRequestedMergeRequests(state: opened, first: 50, sort: UPDATED_DESC) { nodes { ${FIELDS} } } } }`;

function change(m) {
  return {
    id: `${m.project?.fullPath}!${m.iid}`, ref: `!${m.iid}`, title: m.title ?? "", url: m.webUrl,
    project: { path: m.project?.fullPath ?? "", name: m.project?.name ?? "" },
    branch: m.sourceBranch ?? "", target: m.targetBranch ?? "", draft: Boolean(m.draft), author: m.author?.name ?? "",
    pipeline: m.headPipeline?.status?.toLowerCase() ?? null,
    approved: Boolean(m.approved), approvedBy: (m.approvedBy?.nodes ?? []).map((u) => u.name),
    threads: { open: (m.resolvableDiscussionsCount ?? 0) - (m.resolvedDiscussionsCount ?? 0), all: m.resolvableDiscussionsCount ?? 0 },
    conflicts: Boolean(m.conflicts), reviewers: (m.reviewers?.nodes ?? []).map((u) => u.name), updated: m.updatedAt,
  };
}

// config: the profile's code host, { site, keychain, vpn? }
export function gitlabHost(config) {
  const conn = { service: "GitLab", site: config.site, header: "PRIVATE-TOKEN: @@", keychain: config.keychain };
  return {
    name: "GitLab",
    changeName: "Merge request",

    // { mine, review }: yours and the ones waiting for your review, latest first
    async changes() {
      let found;
      try {
        found = await post(conn, "/api/graphql", { query: QUERY });
      } catch (error) {
        const why = String(error?.message ?? error);
        // Behind a VPN, a closed one answers 403 or doesn't answer
        throw new Error(config.vpn && /\b403\b|resolve host|connect|timed out|unreachable/i.test(why) ? `${why}: is the VPN on?` : why);
      }
      if (found?.errors?.length) throw new Error(found.errors.map((e) => e.message).join(" "));
      const me = found?.data?.currentUser;
      return {
        mine: (me?.authoredMergeRequests?.nodes ?? []).map(change),
        review: (me?.reviewRequestedMergeRequests?.nodes ?? []).map(change),
      };
    },
  };
}
