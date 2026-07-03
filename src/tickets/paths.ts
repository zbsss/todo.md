export function ticketPathRelativeToProject(ticketFilePath: string, projectPath: string) {
  const normalizedProjectPath = stripTrailingPathSeparators(projectPath);

  if (!normalizedProjectPath) {
    return ticketFilePath;
  }

  const directPrefix = `${normalizedProjectPath}${pathSeparatorAfterPrefix(ticketFilePath, normalizedProjectPath)}`;

  if (ticketFilePath.startsWith(directPrefix)) {
    return ticketFilePath.slice(directPrefix.length);
  }

  const normalizedTicketFilePath = normalizeSeparators(ticketFilePath);
  const normalizedProjectPrefix = `${stripTrailingPathSeparators(normalizeSeparators(projectPath))}/`;

  if (normalizedTicketFilePath.startsWith(normalizedProjectPrefix)) {
    return normalizedTicketFilePath.slice(normalizedProjectPrefix.length);
  }

  if (isLikelyWindowsPath(normalizedTicketFilePath) || isLikelyWindowsPath(normalizedProjectPrefix)) {
    const lowerTicketFilePath = normalizedTicketFilePath.toLowerCase();
    const lowerProjectPrefix = normalizedProjectPrefix.toLowerCase();

    if (lowerTicketFilePath.startsWith(lowerProjectPrefix)) {
      return normalizedTicketFilePath.slice(normalizedProjectPrefix.length);
    }
  }

  return ticketFilePath;
}

function pathSeparatorAfterPrefix(path: string, prefix: string) {
  const separator = path[prefix.length];
  return separator === "\\" ? "\\" : "/";
}

function stripTrailingPathSeparators(path: string) {
  return path.replace(/[\\/]+$/, "");
}

function normalizeSeparators(path: string) {
  return path.replace(/\\/g, "/");
}

function isLikelyWindowsPath(path: string) {
  return /^[a-z]:\//i.test(path) || path.startsWith("//");
}
