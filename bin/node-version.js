"use strict";

const MIN_NODE_VERSION = "22.19.0";

function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function isNodeVersionSupported(version) {
  const current = parseNodeVersion(version);
  const minimum = parseNodeVersion(MIN_NODE_VERSION);
  if (!current || !minimum) return false;

  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

function getUnsupportedNodeVersionMessage(version) {
  return [
    `ELENVA Web requires Node.js ${MIN_NODE_VERSION} or newer.`,
    `Current Node.js version: ${version}.`,
    "Upgrade Node.js and try again: https://nodejs.org/",
  ].join("\n");
}

module.exports = {
  MIN_NODE_VERSION,
  getUnsupportedNodeVersionMessage,
  isNodeVersionSupported,
};

// 作为 CLI 直接运行（`node bin/node-version.js`）时执行一次检查：
// 通过则静默退出 0；失败打印可行动的提示并退出 1。
// npm 的 predev / prebuild / prestart 钩子走这里，dev.cmd 的 launcher 复用同一份提示。
if (require.main === module) {
  if (!isNodeVersionSupported(process.versions.node)) {
    process.stderr.write(`${getUnsupportedNodeVersionMessage(process.versions.node)}\n`);
    process.exit(1);
  }
}
