import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtime = join(root, ".runtime/babeldoc");
function run(args, env = process.env) {
  const result = spawnSync("uv", args, { cwd: root, env, stdio: "inherit" });
  if (result.error || result.status !== 0)
    throw new Error("BabelDOC runtime preparation failed");
}
await mkdir(runtime, { recursive: true });
run([
  "python",
  "install",
  "3.12.11",
  "--install-dir",
  join(runtime, "python"),
  "--no-bin",
  "--no-registry",
]);
const found = spawnSync(
  "uv",
  ["python", "find", "3.12.11", "--managed-python"],
  {
    env: { ...process.env, UV_PYTHON_INSTALL_DIR: join(runtime, "python") },
    encoding: "utf8",
  },
);
if (found.status !== 0) throw new Error("Managed Python was not found");
const python = found.stdout.trim();
await rm(join(runtime, "site"), { recursive: true, force: true });
run([
  "pip",
  "install",
  "--upgrade",
  "--python",
  python,
  "--target",
  join(runtime, "site"),
  "--require-hashes",
  "-r",
  join(root, "scripts/babeldoc/requirements.lock"),
]);
// Upstream 0.6.4 fixes its cache to the home directory. Redirect only its asset
// directory so the desktop bundle can carry verified fonts/models offline.
const constants = join(runtime, "site/babeldoc/const.py");
let source = await readFile(constants, "utf8");
const original = 'CACHE_FOLDER = Path.home() / ".cache" / "babeldoc"';
const replacement = 'CACHE_FOLDER = Path(os.environ["NEOREAD_BABELDOC_CACHE"])';
if (!source.includes(original) && !source.includes(replacement))
  throw new Error("BabelDOC cache compatibility patch no longer applies");
await writeFile(constants, source.replace(original, replacement));
const translationCache = join(runtime, "site/babeldoc/translator/cache.py");
source = await readFile(translationCache, "utf8");
if (!source.includes("from babeldoc.const import CACHE_FOLDER"))
  throw new Error("BabelDOC translation cache patch no longer applies");
await writeFile(
  translationCache,
  source.replace(
    "from babeldoc.const import CACHE_FOLDER",
    'import os\nCACHE_FOLDER = Path(os.environ.get("NEOREAD_BABELDOC_WORK", "."))',
  ),
);
for (const file of ["worker.py", "positions.py", "layout.py"])
  await cp(join(root, "scripts/babeldoc", file), join(runtime, file));
// Keep the adapter source, reproducible dependency list and modification notice
// alongside upstream Python sources/licenses in the distributable runtime.
await cp(join(root, "scripts/babeldoc"), join(runtime, "neoread-source"), {
  recursive: true,
  filter: (path) => !path.includes("__pycache__"),
});
await cp(
  join(root, "scripts/prepare-babeldoc.mjs"),
  join(runtime, "neoread-source/prepare-babeldoc.mjs"),
);
await mkdir(join(runtime, "assets"), { recursive: true });
const warmup = spawnSync(
  python,
  ["-c", "from babeldoc.assets.assets import warmup; warmup()"],
  {
    cwd: runtime,
    env: {
      ...process.env,
      PYTHONPATH: join(runtime, "site"),
      PYTHONNOUSERSITE: "1",
      NEOREAD_BABELDOC_CACHE: join(runtime, "assets"),
    },
    stdio: "inherit",
  },
);
if (warmup.error || warmup.status !== 0)
  throw new Error("BabelDOC assets preparation failed");
await writeFile(
  join(runtime, "runtime.json"),
  JSON.stringify(
    { version: "0.6.4", python: relative(runtime, python) },
    null,
    2,
  ),
);
console.log(`BabelDOC 0.6.4 runtime ready: ${runtime}`);
