import { afterEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = path.resolve(import.meta.dirname, "../..");
const cliBin = path.join(packageDir, "bin/relgeo.js");

const validDoc = `version: 0.5
parameters:
  width:
    type: length
    default: 120mm
profiles:
  compact:
    width: 80mm
metaPresets:
  finalCut:
    role: final
    stroke: "#111827"
objects:
  panel:
    type: rect
    size: [width, 80mm]
    metaPreset: finalCut
`;

const invalidDoc = `version: 0.5
objects:
  broken:
    type: rect
    size: [missingWidth, 80mm]
`;

const tempDirs: string[] = [];

async function makeTempFile(name: string, contents: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relgeo-cli-test-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}

async function runCli(args: string[]) {
  return execFileAsync("node", [cliBin, ...args], {
    cwd: packageDir,
    env: process.env,
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe("relgeo-cli smoke surface", () => {
  it("shows the aligned CLI version banner", async () => {
    const { stdout } = await runCli(["--version"]);

    expect(stdout.trim()).toBe("0.4.0");
  });

  it("prints file info for a valid document", async () => {
    const filePath = await makeTempFile("info.yaml", validDoc);
    const { stdout } = await runCli(["info", filePath]);

    expect(stdout).toContain("File Info");
    expect(stdout).toContain("DSL Version: 0.5");
    expect(stdout).toContain("Parameters:");
    expect(stdout).toContain("Profiles:");
    expect(stdout).toContain("Meta Presets:");
    expect(stdout).toContain("panel");
  });

  it("compiles valid input to JSON by default", async () => {
    const filePath = await makeTempFile("compile-json.yaml", validDoc);
    const { stdout, stderr } = await runCli(["compile", filePath]);
    const parsed = JSON.parse(stdout);

    expect(stderr).toContain("Compiling");
    expect(parsed.objects.panel.type).toBe("rect");
  });

  it("accepts string-like parameter overrides such as lengths", async () => {
    const filePath = await makeTempFile("compile-json-override.yaml", validDoc);
    const { stdout } = await runCli(["compile", filePath, "-p", "width=200mm"]);
    const parsed = JSON.parse(stdout);

    expect(parsed.objects.panel.width).toBeGreaterThan(0);
  });

  it("compiles valid input to SVG", async () => {
    const filePath = await makeTempFile("compile-svg.yaml", validDoc);
    const { stdout } = await runCli(["compile", filePath, "-f", "svg"]);

    expect(stdout).toContain("<svg");
    expect(stdout).toContain("</svg>");
  });

  it("compiles dependency graph output", async () => {
    const filePath = await makeTempFile("compile-graph.yaml", validDoc);
    const { stdout } = await runCli(["compile", filePath, "-f", "graph"]);
    const parsed = JSON.parse(stdout);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "panel" }),
      ]),
    );
  });

  it("validates a valid document with check", async () => {
    const filePath = await makeTempFile("check.yaml", validDoc);
    const { stdout } = await runCli(["check", filePath]);

    expect(stdout).toContain("OK");
    expect(stdout).toContain("objects resolved");
  });

  it("fails for missing files", async () => {
    await expect(runCli(["compile", "missing-file.yaml"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("File not found"),
    });
  });

  it("fails for invalid input", async () => {
    const filePath = await makeTempFile("invalid.yaml", invalidDoc);

    await expect(runCli(["compile", filePath])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Compilation Failed"),
    });
  });
});
