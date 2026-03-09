import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tempDir = await mkdtemp(join(tmpdir(), "i8n-tests-"));
const outFile = join(tempDir, "syntax-tests.cjs");

try {
  await build({
    entryPoints: ["tests/syntaxConsistency.test.ts"],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    sourcemap: false,
  });

  const { stdout, stderr } = await execFileAsync("node", ["--test", outFile], {
    cwd: process.cwd(),
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
