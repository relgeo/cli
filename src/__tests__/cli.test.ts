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

function runCliWithInput(args: string[], input: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile("node", [cliBin, ...args], {
      cwd: packageDir,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe("@relgeo/cli smoke surface", () => {
  it("shows the aligned CLI version banner", async () => {
    const { stdout } = await runCli(["--version"]);

    expect(stdout.trim()).toBe("0.5.0");
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

  it("compiles valid input from stdin without contaminating stdout", async () => {
    const { stdout, stderr } = await runCliWithInput(["compile", "-", "--format", "json"], validDoc);
    const parsed = JSON.parse(stdout);

    expect(parsed.objects.panel.type).toBe("rect");
    expect(stderr).toContain("Compiling <stdin>");
  });

  it("keeps an explicit file path ahead of unrelated stdin", async () => {
    const filePath = await makeTempFile("path-precedence.yaml", validDoc);
    const { stdout } = await runCliWithInput(["compile", filePath, "--format", "json"], "not the selected source");

    expect(JSON.parse(stdout).objects.panel.type).toBe("rect");
  });

  it("fails deterministically for empty stdin", async () => {
    await expect(runCliWithInput(["compile", "-"], "")).rejects.toMatchObject({
      code: 3,
      stderr: expect.stringContaining("[EMPTY_INPUT]"),
    });
  });

  it("accepts string-like parameter overrides such as lengths", async () => {
    const filePath = await makeTempFile("compile-json-override.yaml", validDoc);
    const { stdout } = await runCli(["compile", filePath, "-p", "width=200mm"]);
    const parsed = JSON.parse(stdout);

    expect(parsed.objects.panel.width).toBeGreaterThan(0);
  });

  it("rejects unsupported formats instead of falling back to JSON", async () => {
    const filePath = await makeTempFile("unknown-format.yaml", validDoc);

    await expect(runCli(["compile", filePath, "--format", "not-a-format"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("[UNKNOWN_FORMAT]"),
    });
  });

  it("rejects malformed and unknown parameter overrides", async () => {
    const filePath = await makeTempFile("invalid-param.yaml", validDoc);

    await expect(runCli(["compile", filePath, "--param", "broken"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("[INVALID_PARAMETER_OVERRIDE]"),
    });
    await expect(runCli(["compile", filePath, "--param", "missing=10"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("[UNKNOWN_PARAMETER]"),
    });
  });

  it("rejects unknown options with the usage exit code", async () => {
    const filePath = await makeTempFile("unknown-option.yaml", validDoc);

    await expect(runCli(["compile", filePath, "--wat"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("unknown option"),
    });
  });

  it("rejects unknown profiles and units", async () => {
    const filePath = await makeTempFile("invalid-options.yaml", validDoc);

    await expect(runCli(["compile", filePath, "--profile", "missing"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("[UNKNOWN_PROFILE]"),
    });
    await expect(runCli(["compile", filePath, "--unit", "deg"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("[UNKNOWN_UNIT]"),
    });
  });

  it("compiles valid input to SVG", async () => {
    const filePath = await makeTempFile("compile-svg.yaml", validDoc);
    const { stdout } = await runCli(["compile", filePath, "-f", "svg"]);

    expect(stdout).toContain("<svg");
    expect(stdout).toContain("</svg>");
  });

  it("fails explicitly for an unknown SVG sheet", async () => {
    const filePath = await makeTempFile("compile-svg-missing-sheet.yaml", validDoc);

    await expect(runCli(["compile", filePath, "-f", "svg", "--sheet", "missing"]))
      .rejects.toMatchObject({
        code: 4,
        stderr: expect.stringContaining("[MISSING_SHEET]"),
      });
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

  it("supports profile selection for validation", async () => {
    const filePath = await makeTempFile("check-profile.yaml", validDoc);
    const { stdout } = await runCli(["check", filePath, "--profile", "compact"]);

    expect(stdout).toContain("OK");
    expect(stdout).toContain("unit: mm");
  });

  it("writes output files and keeps the success message on stderr", async () => {
    const filePath = await makeTempFile("output.yaml", validDoc);
    const outputPath = path.join(path.dirname(filePath), "nested", "output.json");
    const { stdout, stderr } = await runCli(["compile", filePath, "--output", outputPath]);

    expect(stdout).toBe("");
    expect(stderr).toContain("Successfully compiled");
    expect(JSON.parse(await fs.readFile(outputPath, "utf8")).objects.panel.type).toBe("rect");
  });

  it("reports output write failures with a distinct exit code", async () => {
    const filePath = await makeTempFile("output-failure.yaml", validDoc);
    const outputDirectory = path.join(path.dirname(filePath), "existing-directory");
    await fs.ensureDir(outputDirectory);

    await expect(runCli(["compile", filePath, "--output", outputDirectory])).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("[OUTPUT_WRITE_FAILED]"),
    });
  });

  it("emits a stable JSON diagnostic envelope", async () => {
    const filePath = await makeTempFile("diagnostic.yaml", invalidDoc);

    await expect(runCli(["compile", filePath, "--diagnostics", "json"]))
      .rejects.toMatchObject({ code: 4 });

    try {
      await runCli(["compile", filePath, "--diagnostics", "json"]);
    } catch (error: any) {
      const envelope = JSON.parse(error.stderr.trim());
      expect(envelope).toMatchObject({
        version: 1,
        exitCode: 4,
        severity: "error",
        source: filePath,
      });
      expect(envelope.code).toBeTruthy();
      expect(envelope.phase).toBeTruthy();
      expect(envelope.message).toBeTruthy();
      expect(envelope.stderr).toBeUndefined();
    }
  });

  it("emits JSON diagnostics for missing files and runtime failures", async () => {
    await expect(runCli(["compile", "missing-diagnostic.yaml", "--diagnostics", "json"]))
      .rejects.toMatchObject({ code: 3 });

    try {
      await runCli(["compile", "missing-diagnostic.yaml", "--diagnostics", "json"]);
    } catch (error: any) {
      expect(JSON.parse(error.stderr.trim())).toMatchObject({
        version: 1,
        code: "FILE_NOT_FOUND",
        phase: "parse",
        exitCode: 3,
      });
    }

    const runtimeFixture = path.resolve(packageDir, "../fixtures/reference/19-v05-runtime-empty-boolean.yaml");
    try {
      await runCli(["compile", runtimeFixture, "--diagnostics", "json"]);
    } catch (error: any) {
      expect(error.code).toBe(4);
      expect(JSON.parse(error.stderr.trim())).toMatchObject({
        version: 1,
        code: "BOOLEAN_EMPTY_RESULT",
        phase: "runtime",
        exitCode: 4,
      });
    }
  });

  it("supports explicit no-color output", async () => {
    const filePath = await makeTempFile("no-color.yaml", validDoc);
    const { stdout, stderr } = await runCli(["info", filePath, "--no-color"]);
    const compile = await runCli(["compile", filePath, "--no-color"]);
    const check = await runCli(["check", filePath, "--no-color"]);

    expect(stdout).not.toContain("\u001b[");
    expect(stderr).toBe("");
    expect(compile.stdout).not.toContain("\u001b[");
    expect(compile.stderr).not.toContain("\u001b[");
    expect(check.stdout).not.toContain("\u001b[");
    expect(check.stderr).not.toContain("\u001b[");
  });

  it("validates a valid document with check", async () => {
    const filePath = await makeTempFile("check.yaml", validDoc);
    const { stdout } = await runCli(["check", filePath]);

    expect(stdout).toContain("OK");
    expect(stdout).toContain("objects resolved");
  });

  it("fails for missing files", async () => {
    await expect(runCli(["compile", "missing-file.yaml"])).rejects.toMatchObject({
      code: 3,
      stderr: expect.stringContaining("File not found"),
    });
  });

  it("fails for invalid input", async () => {
    const filePath = await makeTempFile("invalid.yaml", invalidDoc);

    await expect(runCli(["compile", filePath])).rejects.toMatchObject({
      code: 4,
      stderr: expect.stringContaining("Compilation Failed"),
    });
  });
});
