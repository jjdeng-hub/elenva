#!/usr/bin/env node
"use strict";

const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { getHelpText, parseLaunchOptions } = require("./elenva-web-options");
const { wireChildProcessLifecycle } = require("./process-lifecycle");

let launchOptions;
try {
  launchOptions = parseLaunchOptions();
} catch (error) {
  fs.writeSync(process.stderr.fd, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

if (launchOptions.help) {
  fs.writeSync(process.stdout.fd, getHelpText());
  process.exit(0);
}

const { port, hostname, openBrowser, appMode } = launchOptions;

const pkgDir = path.join(__dirname, "..");
const nextDir = path.join(pkgDir, ".next");

// Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
// may not exist when installed via npx).
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
} catch {
  // Fallback: locate next package root and derive the bin path manually.
  try {
    const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
    nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
  } catch {
    nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
  }
}

/**
 * 找到可用的 Chromium 系浏览器（Edge / Chrome）。
 * 用它以「App 模式」打开 —— 没有地址栏与标签页、任务栏独立图标，视觉上就是桌面应用。
 * 找不到时返回 null，由调用方退回系统默认浏览器。
 */
function resolveChromium() {
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || "";
    return [
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ].find((candidate) => candidate && fs.existsSync(candidate)) || null;
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ].find((candidate) => fs.existsSync(candidate)) || null;
  }
  return null;
}

const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const passwordEnabled = Boolean(process.env.PI_WEB_PASSWORD);

if (!fs.existsSync(nextDir)) {
  console.error("Build artifacts not found. Please reinstall the package.");
  process.exit(1);
}

if (!loopbackHostnames.has(hostname)) {
  if (passwordEnabled) {
    console.warn(
      `Warning: elenva-web is listening on ${hostname} with password authentication over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
    );
  } else {
    console.warn(
      `Warning: elenva-web is listening on ${hostname} without authentication. Only use this on a trusted network.`,
    );
  }
}

const nextArgs = ["start", "-p", port, "-H", hostname];

// Always run next's JS entry with node directly — avoids .bin symlink issues
// and path-with-spaces problems on Windows when shell: true is used.
const child = spawn(process.execPath, [nextBin, ...nextArgs], {
  cwd: pkgDir,
  stdio: ["inherit", "pipe", "inherit"],
  env: { ...process.env, PI_WEB_HOSTNAME: hostname },
});
wireChildProcessLifecycle(child);

let browserOpened = false;
const url = `http://${hostname}:${port}`;

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (openBrowser && !browserOpened && text.includes("Ready")) {
    browserOpened = true;
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";
    // Avoid `shell: true` to suppress Node.js DEP0190 deprecation
    // ("Passing args to a child process with shell option true can lead to
    // security vulnerabilities, as the arguments are not escaped").
    // Pass a structured argv so Node.js handles escaping instead of
    // concatenating the args into a shell command string.
    let opener;
    const chromium = appMode ? resolveChromium() : null;
    if (chromium) {
      // App 模式：无地址栏、无标签页的独立窗口，任务栏独立图标
      opener = spawn(chromium, [`--app=${url}`, "--window-size=1440,900", "--no-first-run"], {
        stdio: "ignore",
        detached: true,
      });
    } else if (isWindows) {
      // `start` is a cmd.exe built-in, so invoke cmd directly. The empty
      // title argument is required by `start` before the target URL.
      opener = spawn(process.env.ComSpec || "cmd.exe", ["/c", "start", "", url], {
        stdio: "ignore",
        detached: true,
      });
    } else if (isMac) {
      opener = spawn("open", [url], { stdio: "ignore", detached: true });
    } else {
      opener = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    }

    opener.on("error", (error) => {
      console.warn(`Could not open browser automatically: ${error.message}`);
    });

    opener.unref();
  }
});
