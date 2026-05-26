#!/usr/bin/env node

/**
 * Cross-platform version sync script.
 *
 * Reads version from GITHUB_REF_NAME env var (strips 'v' prefix) or CLI argument.
 * Updates version in:
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/Cargo.toml
 *   - package.json
 *
 * Usage:
 *   node scripts/sync-version.mjs          # Uses GITHUB_REF_NAME env var
 *   node scripts/sync-version.mjs v1.2.3   # Explicit version with 'v' prefix
 *   node scripts/sync-version.mjs 1.2.3    # Explicit version without 'v' prefix
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "..");

function getVersion() {
  // Try CLI argument first, then GITHUB_REF_NAME env var
  let version = process.argv[2] || process.env.GITHUB_REF_NAME;

  if (!version) {
    console.error(
      "Error: No version provided. Pass as CLI argument or set GITHUB_REF_NAME env var."
    );
    process.exit(1);
  }

  // Strip 'v' prefix if present
  return version.replace(/^v/, "");
}

function updateTauriConf(version) {
  const filePath = resolve(rootDir, "src-tauri/tauri.conf.json");
  const content = JSON.parse(readFileSync(filePath, "utf-8"));
  const oldVersion = content.version;
  content.version = version;
  writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf-8");
  console.log(
    `  src-tauri/tauri.conf.json: ${oldVersion} -> ${content.version}`
  );
}

function updateCargoToml(version) {
  const filePath = resolve(rootDir, "src-tauri/Cargo.toml");
  let content = readFileSync(filePath, "utf-8");

  // Match only the top-level package version line
  const versionRegex = /^(version = ")[^"]*(")$/m;
  const match = content.match(versionRegex);
  if (!match) {
    console.error("Error: Could not find version field in Cargo.toml");
    process.exit(1);
  }

  const oldVersion = match[1] + match[2];
  content = content.replace(versionRegex, `$1${version}$2`);
  writeFileSync(filePath, content, "utf-8");
  console.log(
    `  src-tauri/Cargo.toml: ${match[2].replace(/"/g, "")} -> ${version}`
  );
}

function updatePackageJson(version) {
  const filePath = resolve(rootDir, "package.json");
  const content = JSON.parse(readFileSync(filePath, "utf-8"));
  const oldVersion = content.version;
  content.version = version;
  writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf-8");
  console.log(`  package.json: ${oldVersion} -> ${content.version}`);
}

// Main
const version = getVersion();
console.log(`Syncing version: ${version}`);

updateTauriConf(version);
updateCargoToml(version);
updatePackageJson(version);

console.log("Version sync complete.");
