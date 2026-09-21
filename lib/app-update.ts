const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function parseStableVersion(version: string): [number, number, number] | null {
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match) return null;

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts as [number, number, number];
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  const candidateParts = parseStableVersion(candidate);
  const currentParts = parseStableVersion(current);
  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

/**
 * 发布仓库（`owner/repo`）。确定后填上，更新提示里就会出现跳转链接；
 * 留空则只提示版本号、不给链接。
 */
const RELEASE_REPOSITORY: string | null = null;

export function getReleaseUrl(version: string): string {
  if (!RELEASE_REPOSITORY || !parseStableVersion(version)) return "";
  return `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`;
}
