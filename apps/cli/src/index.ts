#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseGlobal } from "./args.js";
import { handleCoreCommand } from "./commands-core.js";
import { handleFrozenCommand } from "./commands-frozen.js";
import { handleReviewCommand } from "./commands-review.js";
import { renderHelp, renderHelpForCommand } from "./help.js";

export async function main(argv: string[]): Promise<void> {
  const { cmd, rest, opts } = parseGlobal(argv);
  const help = renderHelpForCommand(cmd);
  if (help !== undefined) {
    console.log(help);
    return;
  }
  if (await handleCoreCommand(cmd, rest, opts)) return;
  if (await handleReviewCommand(cmd, rest, opts)) return;
  if (await handleFrozenCommand(cmd, rest, opts)) return;
  console.log(renderHelp("default"));
  process.exitCode = 1;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryUrl = pathToFileURL(realpathSync(entry)).href;
    const selfUrl = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return entryUrl === selfUrl;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
