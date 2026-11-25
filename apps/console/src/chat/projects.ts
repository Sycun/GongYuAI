export const defaultProject = "GongYuAI";
export const defaultProjectLabel = "默认对话区";

export function projectName(id: string, storedName?: string) {
  if (id === defaultProject) return defaultProjectLabel;
  return storedName?.trim() || id;
}

export function projectLabel(id: string, storedName?: string) {
  if (id === defaultProject) return defaultProjectLabel;
  const name = projectName(id, storedName);
  if (name === defaultProjectLabel) return `${name}（自建项目）`;
  return name;
}

export function isDuplicateProjectName(
  candidate: string,
  activeProjectIds: readonly string[],
  nameOf: (id: string) => string,
) {
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  return trimmed === defaultProjectLabel
    || trimmed === defaultProject
    || activeProjectIds.some(id => id !== defaultProject && nameOf(id) === trimmed);
}
