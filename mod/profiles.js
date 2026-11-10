// Clients: one workbench.json each, next to its code. See README.md for what goes in it.
import { exec, home, readTextFile } from "herdr";

export const PROFILES = "~/clients/*/workbench.json";

// Every client's profile, { file, name, tracker }, or { file, error } when it can't be read
export async function loadProfiles() {
  const r = await exec("/bin/zsh", ["-c", `print -rl -- ${PROFILES}(N)`], { cwd: home() });
  const profiles = [];
  for (const file of (r.stdout ?? "").split("\n").filter(Boolean)) {
    try { profiles.push({ file, ...JSON.parse(await readTextFile(file)) }); }
    catch (error) { profiles.push({ file, error: `${file.replace(home(), "~")}: ${error?.message ?? error}` }); }
  }
  return profiles;
}

// The client whose folders hold the terminal you were in (by default, the profile's own folder);
// anywhere else, the first one, unless fallback is false
export function clientFor(profiles, cwd, fallback = true) {
  const usable = profiles.filter((p) => !p.error && p.tracker);
  const inside = (folder) => { const f = folder.replace(/^~/, home()); return cwd === f || cwd.startsWith(`${f}/`); };
  return usable.find((p) => (p.folders ?? [p.file.replace(/\/[^/]+$/, "")]).some(inside)) ?? (fallback ? usable[0] ?? null : null);
}
