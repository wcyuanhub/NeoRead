import { afterEach, expect, test } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePythonAliasesPortable } from "./babeldoc-runtime-links.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "neoread-python-links-"));
  directories.push(root);
  const python = join(root, "python");
  await mkdir(join(python, "cpython-3.12.11"), { recursive: true });
  return { root, python };
}

test.skipIf(process.platform === "win32")(
  "keeps uv aliases readable after relocating the runtime and repeated preparation",
  async () => {
    const { root, python } = await fixture();
    const target = join(python, "cpython-3.12.11");
    await writeFile(join(target, "python"), "portable-interpreter");
    await symlink(target, join(python, "cpython-3.12"), "dir");
    await makePythonAliasesPortable(python);
    await makePythonAliasesPortable(python);
    expect(await readlink(join(python, "cpython-3.12"))).toBe(
      "cpython-3.12.11",
    );
    const relocated = join(root, "installed-python");
    await rename(python, relocated);
    expect(await readFile(join(relocated, "cpython-3.12/python"), "utf8")).toBe(
      "portable-interpreter",
    );
  },
);

test.skipIf(process.platform === "win32")(
  "rejects aliases outside the runtime without changing their target",
  async () => {
    const { root, python } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside);
    const link = join(python, "cpython-3.12");
    await symlink(outside, link, "dir");
    await expect(makePythonAliasesPortable(python)).rejects.toThrow(
      "inside the bundled runtime",
    );
    expect(await readlink(link)).toBe(outside);
  },
);
