# workbench

A [Herdr](https://herdr.dev) mod for a client's tickets and merge requests: its Jira boards with their
own swimlanes, cards like Jira's, status moves and comments with @mentions; its GitLab merge requests,
yours and the ones waiting for your review, with a failed pipeline's retry and comments. Every write
asks for a confirmation first. GitHub comes next.

## Install

```sh
ln -s "$PWD/mod" ~/.config/herdr-app/mods/workbench   # from this folder
```

and bind a key in `~/.config/herdr-app/keys.json`: `"cmd-shift-b": "mod.open:workbench"`. For agents
that tag their branch, put `bin/workbench-tag` on your `PATH`
(`ln -s "$PWD/bin/workbench-tag" ~/.local/bin/`); it needs `jq`.

For the sidebar (the focused space's ticket and yours), add a column to your own layout, e.g. a
copy of `main` as `layouts/workbench-column.json`, at the end of the root's `children`:

```json
{ "id": "workbench", "type": "column", "size": { "px": 300 }, "min": 240, "max": 480, "background": "chrome",
  "children": [{ "id": "workbench-side", "type": "block", "content": { "mod": "workbench", "props": { "view": "sidebar" } } }] }
```

For the sessions (every space working on a ticket or a merge request, most urgent first: an agent asking,
one that finished, one at work, one waiting; with the ticket's title, the merge request's pipeline and the
agents of its tabs), give a block the view `sessions`, for example in place of the Spaces list:
`{ "mod": "workbench", "props": { "view": "sessions" } }`. A space is a ticket's session when its name or
branch has the key, a merge request's when it's on its branch: tickets and merge requests show the state of
their session too, and a click on it goes to its agent.

A branch can carry a tag, such as `R2 ✓` after a second review round or `answered`, shown on its session's row
and on its ticket and merge request, also once the session is closed. A click on it (🏷 when there's none)
picks the next round, a usual tag or your own, "by tag" groups the sessions by their tag, and an agent tags
its branch with `workbench-tag TEXT`, `workbench-tag --round` or `workbench-tag --clear`. Tags and rounds are
kept in the mod's data folder (`tags.json`). To have agents tag what they did, end the profile's `tasks` with
it, e.g. "When you have given me the review, run `workbench-tag --round`".

## A client

One `workbench.json` per client, in `~/clients/<client>/`. The mod picks the client whose
folder holds the terminal you were in; anywhere else, the first one.

```json
{
  "name": "ACME",
  "tracker": {
    "kind": "jira",
    "site": "https://acme.atlassian.net",
    "user": "me@acme.example",
    "keychain": "acme-jira",
    "boards": [{ "id": 12, "label": "Development" }],
    "hiddenColumns": ["Backlog"],
    "hiddenProjects": ["OPS"],
    "priorityAliases": { "Fire": "highest" }
  },
  "code": {
    "kind": "gitlab",
    "site": "https://gitlab.acme.example",
    "keychain": "acme-gitlab",
    "vpn": true
  }
}
```

- `folders` (optional): where the client's code lives, if not next to the profile.
- `hiddenColumns`, `hiddenProjects`, `priorityAliases` are optional.
- `code` (optional): the code host, for your merge requests and the ones waiting for your review. `vpn`
  turns a 403 or no answer into "is the VPN on?". The GitLab token needs `read_api`, and `api` to retry
  pipelines and comment.
- `code.tasks` (optional): the first message of an agent started on a merge request's branch, `{url}` being
  the merge request's link: `review` for someone else's, `answer` for the review of yours. The agent starts
  through [roger](https://github.com/daaanny90/claude-radio) (`roger open <branch> --task …`) in the
  branch's worktree, from the repository in the client's folders whose origin is the merge request's
  project; roger must know that repository.

```json
"tasks": { "review": "/code-review {url}", "answer": "/answer-review {url}" }
```

The token never goes in the profile. Copy it, then store it in the Keychain under the profile's
`keychain` name:

```sh
security add-generic-password -U -s workbench -a acme-jira -w "$(pbpaste)"
```
