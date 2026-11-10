// Requests to a service, signed with a token from the Keychain.
import { exec, home } from "herdr";

// The last useful line of a failed program: the service's error messages when it sent JSON, else stderr
export function failure(r, name) {
  try {
    const body = JSON.parse(r.stdout);
    const messages = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {}).map((e) => e?.message ?? e),
      ...[body.message, body.error].filter((m) => typeof m === "string")];
    if (messages.length) return messages.join(" ");
  } catch {}
  const last = (text) => (text ?? "").trim().split("\n").filter(Boolean).at(-1);
  return (last(r.stderr) ?? last(r.stdout) ?? `${name} exited with ${r.code}`).replace(/^roger: /, "");
}

// zsh takes the token from the Keychain item ($3) and gives it to curl through a config pipe: it never
// reaches this script nor curl's command line. $2 is the curl option with "@@" where the token goes:
// "user=me@example.com:@@" (basic auth) or "header=PRIVATE-TOKEN: @@". $1 site, $4 path
const AUTH = 'tok=$(security find-generic-password -s workbench -a "$3" -w 2>/dev/null)'
  + ' || { print -u2 "the Keychain has no workbench item \\"$3\\""; exit 1; }; '
  + 'auth() { print -r -- "${2%%=*} = \\"${${2#*=}//@@/$tok}\\"" }; ';

// conn: { user } signs with basic auth, { header: "Name: … @@" } with that header
const credential = (conn) => (conn.user != null ? `user=${conn.user}:@@` : `header=${conn.header}`);

async function curl(service, script, args) {
  let r;
  try { r = await exec("/bin/zsh", ["-c", AUTH + script, "zsh", ...args], { cwd: home(), timeout: 30_000 }); }
  catch (error) { throw new Error(`${service} is unreachable: ${error}`); }
  if (r.code !== 0) {
    const why = failure(r, "curl");
    throw new Error(/\b401\b/.test(why) ? `${why}: is the token in the Keychain item "${args[2]}" right?` : why);
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;   // some writes answer 204, no body
}

// GET <site><path>?<params>, signed with the token in the Keychain item `keychain`
export function get(conn, path, params = {}) {
  const query = Object.entries(params).flatMap(([k, v]) => ["--data-urlencode", `${k}=${v}`]);
  return curl(conn.service, 'exec curl -sS --fail-with-body --max-time 25 -K <(auth "$@") -G "$1$4" "${@:5}"',
    [conn.site, credential(conn), conn.keychain, path, ...query]);
}

// POST <site><path> with a JSON body (never starts with "@", so curl never reads a file)
export function post(conn, path, body) {
  return curl(conn.service, 'exec curl -sS --fail-with-body --max-time 25 -K <(auth "$@") -X POST -H "Content-Type: application/json"'
    + ' -H "Accept: application/json" --data-binary "$5" "$1$4"', [conn.site, credential(conn), conn.keychain, path, JSON.stringify(body)]);
}
