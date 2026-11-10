# workbench

A [Herdr](https://herdr.dev) mod for a client's tickets: its Jira boards with their own swimlanes,
cards like Jira's, status moves and comments with @mentions. GitLab and GitHub come next.

## Install

```sh
ln -s "$PWD/mod" ~/.config/herdr-app/mods/workbench   # from this folder
```

and bind a key in `~/.config/herdr-app/keys.json`: `"cmd-shift-b": "mod.open:workbench"`.

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
  }
}
```

- `folders` (optional): where the client's code lives, if not next to the profile.
- `hiddenColumns`, `hiddenProjects`, `priorityAliases` are optional.

The token never goes in the profile. Copy it, then store it in the Keychain under the profile's
`keychain` name:

```sh
security add-generic-password -U -s workbench -a acme-jira -w "$(pbpaste)"
```
