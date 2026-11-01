/**
 * Cut a GitHub release that BRAT can install from.
 *
 *   npm run release -- 1.0.2-fmr.3
 *
 * Sets the version in manifest.json, package.json and versions.json, builds,
 * commits, tags (no "v" prefix, as Obsidian expects), pushes, and creates a
 * GitHub release carrying main.js, manifest.json and styles.css — the three
 * files BRAT downloads. Needs a clean working tree and the `gh` CLI.
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, opts = {}) =>
	execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: opts.capture ? "pipe" : "inherit" });
const fail = (msg) => {
	console.error(msg);
	process.exit(1);
};

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
	fail("Usage: npm run release -- <version>   e.g. 1.0.2-fmr.3");
}
if (run("git", ["status", "--porcelain"], { capture: true }).trim()) {
	fail("Commit or stash your changes first — the release must match what's pushed.");
}
if (run("git", ["tag", "--list", version], { capture: true }).trim()) {
	fail(`Tag ${version} already exists. Pick a higher version.`);
}

const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");

const versionsPath = join(root, "versions.json");
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync(versionsPath, JSON.stringify(versions, null, "\t") + "\n");

// Text replace, not a JSON rewrite, so the rest of package.json keeps its formatting.
const pkgPath = join(root, "package.json");
writeFileSync(pkgPath, readFileSync(pkgPath, "utf8").replace(/("version":\s*")[^"]*(")/, `$1${version}$2`));

run("npm", ["run", "build"]);
run("git", ["add", "manifest.json", "versions.json", "package.json"]);
run("git", ["commit", "-m", `Release ${version}`]);
run("git", ["tag", version]);
run("git", ["push"]);
run("git", ["push", "origin", version]);
run("gh", ["release", "create", version, "main.js", "manifest.json", "styles.css",
	"--title", version, "--generate-notes", "--latest"]);
console.log(`\nReleased ${version}. BRAT will pick it up on its next update check.`);
