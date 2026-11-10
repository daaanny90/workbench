// Requests to a service, signed with a token from the Keychain.
import { exec, home } from "herdr";

// The last useful line of a failed program: the service's error messages when it sent JSON, else stderr
export function failure(r, name) {
  try {
    const body = JSON.parse(r.stdout);
    const messages = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})];
    if (messages.length) return messages.join(" ");
  } catch {}
  const last = (text) => (text ?? "").trim().split("\n").filter(Boolean).at(-1);
  return (last(r.stderr) ?? last(r.stdout) ?? `${name} exited with ${r.code}`).replace(/^roger: /, "");
}

// zsh takes the token from the Keychain item ($3) and gives it to curl through a config pipe: it never
// reaches this script nor curl's command line ($1 site, $2 user, $4 path)
const AUTH = 'tok=$(security find-generic-password -s workbench -a "$3" -w 2>/dev/null)'
  + ' || { print -u2 "the Keychain has no workbench item \\"$3\\""; exit 1; }; '
  + 'auth() { print -r -- "user = \\"$2:$tok\\"" }; ';

async function curl(service, script, args) {
  let r;
  try { r = await exec("/bin/zsh", ["-c", AUTH + script, "zsh", ...args], { cwd: home(), timeout: 30_000 }); }
  catch (error) { throw new Error(`${service} is unreachable: ${error}`); }
  if (r.code !== 0) {
    const why = failure(r, "curl");
    throw new Error(/error: 401\b/.test(why) ? `${why}: is the token in the Keychain item "${args[2]}" right?` : why);
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;   // some writes answer 204, no body
}

// GET <site><path>?<params>, as `user` with the token in the Keychain item `keychain`
export function get({ service, site, user, keychain }, path, params = {}) {
  const query = Object.entries(params).flatMap(([k, v]) => ["--data-urlencode", `${k}=${v}`]);
  return curl(service, 'exec curl -sS --fail-with-body --max-time 25 -K <(auth "$@") -G "$1$4" "${@:5}"',
    [site, user, keychain, path, ...query]);
}

// POST <site><path> with a JSON body (never starts with "@", so curl never reads a file)
export function post({ service, site, user, keychain }, path, body) {
  return curl(service, 'exec curl -sS --fail-with-body --max-time 25 -K <(auth "$@") -X POST -H "Content-Type: application/json"'
    + ' -H "Accept: application/json" --data-binary "$5" "$1$4"', [site, user, keychain, path, JSON.stringify(body)]);
}
