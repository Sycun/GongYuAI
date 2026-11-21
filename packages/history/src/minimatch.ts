/** Tiny glob matcher for evidence patterns (`*` and `**`). */
export function minimatch(path: string, pattern: string): boolean {
  const normPath = path.replace(/\\/g, "/");
  const normPat = pattern.replace(/\\/g, "/");
  if (normPat === "**" || normPat === "*") return true;

  const escapeRegex = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const parts = normPat.split("**");
  let re = "^";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    re += part
      .split("*")
      .map((seg) => escapeRegex(seg).replace(/\?/g, "."))
      .join("[^/]*");
    if (i < parts.length - 1) re += ".*";
  }
  re += "$";
  return new RegExp(re).test(normPath);
}
