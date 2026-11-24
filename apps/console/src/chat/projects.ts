export const defaultProject = "GongYuAI";
export const defaultProjectLabel = "默认对话区";

export function projectLabel(name: string) {
  if (name === defaultProject) return defaultProjectLabel;
  if (name === defaultProjectLabel) return `${name}（自建项目）`;
  return name;
}
