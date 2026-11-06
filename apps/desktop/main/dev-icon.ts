import { join } from "node:path";

// Unpackaged runs execute from apps/desktop/dist, three levels below the repo
// root. Packaged builds embed the .icns in the bundle and never use this.
export const devIconRelativePath = "../../../assets/icons/macos/icon-1024.png";

export function devIconPath(fromDirectory: string) {
  return join(fromDirectory, devIconRelativePath);
}
