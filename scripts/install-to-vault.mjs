/**
 * Install the freshly built plugin into an Obsidian vault.
 *
 *   npm run install-vault -- "/path/to/Vault"
 *   OBSIDIAN_VAULT="/path/to/Vault" npm run install-vault
 *
 * Copies the three files Obsidian loads (main.js, manifest.json, styles.css)
 * into <vault>/.obsidian/plugins/<plugin id>/. Never touches data.json, which
 * holds that vault's own settings, API keys and reading positions.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vault = process.argv[2] ?? process.env.OBSIDIAN_VAULT;
if (!vault) {
	console.error('Usage: npm run install-vault -- "/path/to/Vault"  (or set OBSIDIAN_VAULT)');
	process.exit(1);
}
const vaultRoot = resolve(vault);
if (!existsSync(join(vaultRoot, ".obsidian"))) {
	console.error(`Not an Obsidian vault (no .obsidian folder): ${vaultRoot}`);
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
const target = join(vaultRoot, ".obsidian", "plugins", manifest.id);
mkdirSync(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	copyFileSync(join(pluginDir, file), join(target, file));
}
console.log(`Installed ${manifest.name} ${manifest.version} into ${target}`);
console.log("Reload the plugin in Obsidian (Settings → Community plugins) to pick it up.");
