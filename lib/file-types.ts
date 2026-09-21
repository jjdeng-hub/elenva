export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
export const DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export type DocumentPreviewKind = "pdf" | "docx";

export const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

export const AUDIO_EXT_TO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  weba: "audio/webm",
};

export const VIDEO_EXT_TO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
};

export const DOCUMENT_EXT_TO_MIME: Record<DocumentPreviewKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function getBaseName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? "";
}

export function getFileExt(filePath: string): string {
  return getBaseName(filePath).toLowerCase().split(".").pop() ?? "";
}

export function getImageMime(filePath: string): string | null {
  return IMAGE_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function getAudioMime(filePath: string): string | null {
  return AUDIO_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function getVideoMime(filePath: string): string | null {
  return VIDEO_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function getDocumentMime(filePath: string): string | null {
  return DOCUMENT_EXT_TO_MIME[getFileExt(filePath) as DocumentPreviewKind] ?? null;
}

export function documentPreviewKind(filePath: string): DocumentPreviewKind | null {
  const ext = getFileExt(filePath);
  if (ext === "pdf" || ext === "docx") return ext;
  return null;
}

export function isImagePath(filePath: string): boolean {
  return getImageMime(filePath) !== null;
}

export function isAudioPath(filePath: string): boolean {
  return getAudioMime(filePath) !== null;
}

export function isVideoPath(filePath: string): boolean {
  return getVideoMime(filePath) !== null;
}

export function isDocumentPreviewPath(filePath: string): boolean {
  return documentPreviewKind(filePath) !== null;
}

/**
 * 明确**不支持预览**的扩展名（压缩包、可执行文件、字体、二进制数据库等）。
 *
 * 为什么需要显式名单：只靠内容嗅探能兜住大部分情况，但给出「为什么不能看」的
 * 说法更清楚 —— 用户点了 .zip 应该直接被告知不支持，而不是等半秒再看到乱码。
 * 内容嗅探仍然保留，用于兜住没有扩展名或名单外的二进制文件。
 */
export const BINARY_EXTENSIONS = new Set([
  // 压缩 / 归档
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst", "lz4", "cab", "iso",
  // 可执行 / 库 / 中间产物
  "exe", "dll", "so", "dylib", "bin", "obj", "o", "a", "lib", "class", "jar", "wasm", "node", "pyc",
  "pdb", "ilk", "exp", "msi", "apk", "deb", "rpm", "dmg",
  // 字体
  "woff", "woff2", "ttf", "otf", "eot",
  // 二进制数据
  "db", "sqlite", "sqlite3", "mdb", "parquet", "avro", "pkl", "pickle", "npy", "npz", "pth",
  // 媒体容器（这些应由各自的 MIME 分支处理，列在这里是兜底）
  "mp4", "webm", "mkv", "avi", "mov", "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac",
  "pdf", "docx", "xlsx", "pptx", "psd", "sketch", "ai", "indd",
]);

export function isBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(getFileExt(filePath));
}

const SNIFF_BYTES = 8 * 1024;

/**
 * 内容嗅探：出现 NUL 字节，或前 8KB 里不可打印字节占比过高 → 判为二进制。
 * 用来兜住没有扩展名、或扩展名不在名单里的二进制文件（否则会被当文本读成乱码）。
 */
export function looksBinaryBuffer(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, SNIFF_BYTES);
  if (limit === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < limit; i += 1) {
    const byte = buffer[i];
    if (byte === 0) return true;
    // 允许 \t \n \r \f \b 与常规可打印字节；其余（含 DEL）都算可疑
    const printable = (byte >= 0x20 && byte !== 0x7f) || byte === 0x09 || byte === 0x0a
      || byte === 0x0d || byte === 0x0c || byte === 0x08 || byte >= 0x80;
    if (!printable) suspicious += 1;
  }
  // UTF-8 中文等多字节字符走 byte >= 0x80，不会计入可疑
  return suspicious / limit > 0.1;
}
