import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { chmodSync, copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const resourcesDir = join(repoRoot, "src-tauri", "resources");
const bundledBunRoot = join(resourcesDir, "bundled-bun");
const externalAgentsRoot = join(resourcesDir, "external_agents", "claude-agent-acp", "0.26.0");
const packageName = "@agentclientprotocol/claude-agent-acp";
const packageVersion = "0.26.0";

function log(message) {
  console.log(`[prepare-claude-runtime] ${message}`);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    // Windows requires shell: true to find .cmd files like npm.cmd
    const useShell = process.platform === "win32" || options.shell;
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: useShell,
      ...options,
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
    child.on("error", rejectPromise);
  });
}

function currentPlatformKey() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64";
  return null;
}

function bunExecutableName() {
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function bunDownloadUrl(platformKey) {
  // Bun release naming: darwin-aarch64, darwin-x64, linux-x64, windows-x64
  const releasePlatform = platformKey.replace("arm64", "aarch64").replace("win32", "windows");
  return `https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-${releasePlatform}.zip`;
}

function download(url, destination) {
  return new Promise((resolvePromise, rejectPromise) => {
    https
      .get(url, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return resolvePromise(download(response.headers.location, destination));
        }
        if (response.statusCode !== 200) {
          rejectPromise(new Error(`HTTP ${response.statusCode} while downloading ${url}`));
          return;
        }
        ensureDir(dirname(destination));
        pipeline(response, createWriteStream(destination)).then(resolvePromise).catch(rejectPromise);
      })
      .on("error", rejectPromise);
  });
}

async function extractZip(zipPath, targetDir) {
  ensureDir(targetDir);
  if (process.platform === "win32") {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${targetDir}" -Force`,
    ]);
    return;
  }
  await run("unzip", ["-o", zipPath, "-d", targetDir]);
}

async function prepareBundledBun() {
  const platformKey = currentPlatformKey();
  if (!platformKey) {
    log(`Skipping Bun download for unsupported platform ${process.platform}-${process.arch}`);
    return;
  }

  const targetDir = join(bundledBunRoot, platformKey);
  const targetBinary = join(targetDir, bunExecutableName());
  if (existsSync(targetBinary)) {
    log(`Bundled Bun already present at ${targetBinary}`);
    return;
  }

  const zipPath = join(resourcesDir, `.cache-bun-${platformKey}.zip`);
  const extractDir = join(resourcesDir, `.cache-bun-${platformKey}`);
  rmSync(extractDir, { recursive: true, force: true });
  ensureDir(targetDir);

  log(`Downloading Bun for ${platformKey}`);
  await download(bunDownloadUrl(platformKey), zipPath);
  log(`Extracting Bun to ${targetDir}`);
  await extractZip(zipPath, extractDir);

  // Bun release naming: bun-darwin-aarch64, bun-darwin-x64, etc.
  const releasePlatform = platformKey.replace("arm64", "aarch64").replace("win32", "windows");
  const extractedBinary = join(extractDir, "bun-" + releasePlatform, bunExecutableName());
  if (!existsSync(extractedBinary)) {
    throw new Error(`Expected extracted Bun binary at ${extractedBinary}`);
  }
  copyFileSync(extractedBinary, targetBinary);
  if (process.platform !== "win32") {
    chmodSync(targetBinary, 0o755);
  }
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
}

async function prepareBundledAdapter() {
  ensureDir(externalAgentsRoot);
  const packageJsonPath = join(externalAgentsRoot, "package.json");
  try {
    if (existsSync(packageJsonPath)) {
      const existing = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (existing.name === packageName && existing.version === packageVersion) {
        log(`Bundled Claude adapter already present at ${externalAgentsRoot}`);
        return;
      }
    }
  } catch {
    // Replace invalid directory contents.
  }

  rmSync(externalAgentsRoot, { recursive: true, force: true });
  ensureDir(dirname(externalAgentsRoot));
  log(`Installing ${packageName}@${packageVersion} into ${externalAgentsRoot}`);
  await run("npm", [
    "install",
    "--no-save",
    "--prefix",
    externalAgentsRoot,
    `${packageName}@${packageVersion}`,
  ], { cwd: repoRoot });

  const installedRoot = join(externalAgentsRoot, "node_modules", "@agentclientprotocol", "claude-agent-acp");
  if (!existsSync(installedRoot)) {
    throw new Error(`Expected installed adapter package at ${installedRoot}`);
  }

  for (const entry of ["package.json", "README.md", "LICENSE"]) {
    const path = join(installedRoot, entry);
    if (existsSync(path)) {
      copyFileSync(path, join(externalAgentsRoot, entry));
    }
  }

  const bin = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")).bin;
  writeFileSync(
    join(externalAgentsRoot, "oneagent-bundled-adapter.json"),
    JSON.stringify({ packageName, packageVersion, installedRoot, bin }, null, 2),
  );
}

async function main() {
  ensureDir(resourcesDir);
  await prepareBundledBun();
  await prepareBundledAdapter();
  log("Claude runtime resources are ready.");
}

main().catch((error) => {
  console.error(`[prepare-claude-runtime] ${error.message}`);
  process.exitCode = 1;
});
