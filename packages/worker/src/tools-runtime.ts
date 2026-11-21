import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ToolsRuntimeState = {
  mcpEnabledIds: string[];
  skillEnabledIds: string[];
};

export function toolsRuntimePath(dataDir: string): string {
  return join(dataDir, "tools-runtime.json");
}

export function loadToolsRuntime(dataDir: string): ToolsRuntimeState | null {
  const path = toolsRuntimePath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ToolsRuntimeState;
    return {
      mcpEnabledIds: Array.isArray(raw.mcpEnabledIds) ? raw.mcpEnabledIds : [],
      skillEnabledIds: Array.isArray(raw.skillEnabledIds) ? raw.skillEnabledIds : [],
    };
  } catch {
    return null;
  }
}

export function saveToolsRuntime(dataDir: string, state: ToolsRuntimeState): void {
  writeFileSync(toolsRuntimePath(dataDir), JSON.stringify(state, null, 2));
}
