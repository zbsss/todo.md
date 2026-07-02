export function resolveMarkdownImageSrc(
  src: string,
  projectPath?: string,
  fileSrcConverter?: (path: string) => string
) {
  const trimmed = src.trim();

  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) {
    return trimmed;
  }

  const relativePath = normalizeTaskImagePath(trimmed);

  if (!relativePath || !projectPath) {
    return null;
  }

  if (!fileSrcConverter) {
    return relativePath;
  }

  return fileSrcConverter(joinFilePath(projectPath, ".tasks", relativePath));
}

export function normalizeTaskImagePath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const relativePath = normalized.startsWith(".tasks/images/")
    ? normalized.slice(".tasks/".length)
    : normalized;
  const parts = relativePath.split("/");

  if (parts.length < 2 || parts[0] !== "images") {
    return null;
  }

  if (parts.some((part) => !part || part === "." || part === "..")) {
    return null;
  }

  return relativePath;
}

export function joinFilePath(base: string, ...segments: string[]) {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const normalizedSegments = segments.map((segment) =>
    segment
      .replaceAll("\\", separator)
      .replaceAll("/", separator)
      .replace(/^[\\/]+|[\\/]+$/g, "")
  );

  return [base.replace(/[\\/]+$/, ""), ...normalizedSegments].join(separator);
}

export function imageExtensionForMime(mimeType: string) {
  switch (mimeType.split(";")[0].trim().toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    default:
      return null;
  }
}

export function bytesToDataUrl(mimeType: string, bytes: number[]) {
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }

  return `data:${mimeType};base64,${btoa(binary)}`;
}
