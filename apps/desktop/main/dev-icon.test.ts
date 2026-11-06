import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devIconPath } from "./dev-icon";

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

it("finds the brand tile from the directory the built main runs in", () => {
  const path = devIconPath(join(repositoryRoot, "apps/desktop/dist"));
  expect(path).toBe(join(repositoryRoot, "assets/icons/macos/icon-1024.png"));
  expect(existsSync(path)).toBe(true);
});
