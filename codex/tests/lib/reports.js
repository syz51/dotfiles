import { mkdir, realpath, lstat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
export async function reportDirectory(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw Error("Report directory must be a child of supplied TMPDIR");
  let current = await realpath(root);
  for (const part of rel.split("/")) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw Error("Unsafe report directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  return current;
}
