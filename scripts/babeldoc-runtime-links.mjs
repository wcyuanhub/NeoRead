import { readdir, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

// uv creates minor-version aliases with absolute paths into the build checkout.
// Keep those aliases inside the runtime when macOS signs or relocates the app.
export async function makePythonAliasesPortable(directory) {
  const root = await realpath(directory);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const link = join(root, entry.name);
    const target = relative(root, await realpath(link));
    if (
      !target ||
      target === ".." ||
      target.startsWith(`..${sep}`) ||
      isAbsolute(target)
    )
      throw new Error(
        "Python runtime alias must stay inside the bundled runtime",
      );
    if ((await readlink(link)) === target) continue;
    await unlink(link);
    await symlink(target, link, "dir");
  }
}
