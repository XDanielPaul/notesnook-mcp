import { mkdirSync, realpathSync, rmdirSync } from "node:fs";

export function acquireProfileLock(directory: string) {
  const lockPath = `${realpathSync(directory)}.lock`;
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(
        `Profile is locked: ${lockPath}. Stop the other MCP/CLI process first. ` +
        "After a crash, remove this empty lock directory manually only after confirming no process is using the profile."
      );
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    rmdirSync(lockPath);
    released = true;
  };
}
