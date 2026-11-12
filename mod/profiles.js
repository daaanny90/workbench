// Clients: one workbench.json each, next to its code. See README.md for what goes in it.
import { exec, home, appHome, readTextFile } from "herdr";

// Where the profiles are, a zsh glob: "profiles" in the mod's data folder's config.json, or else this
const PROFILES = "~/clients/*/workbench.json";
let glob = PROFILES;

// The glob the last loadProfiles read
export function profilesGlob() {
  return glob;
}

// Every client's profile, { file, name, tracker }, or { file, error } when it can't be read
export async function loadProfiles() {
  try { glob = JSON.parse(await readTextFile(`${appHome()}/data/workbench/config.json`)).profiles ?? PROFILES; }
  catch { glob = PROFILES; }
  const r = await exec("/bin/zsh", ["-c", `print -rl -- ${glob}(N)`], { cwd: home() });
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
