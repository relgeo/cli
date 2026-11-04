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

async function makeTempFile(name: string, contents: string, cwd?: string) {
  const dir = cwd ?? await fs.mkdtemp(path.join(os.tmpdir(), "relgeo-cli-test-"));
  if (!cwd) tempDirs.push(dir);
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}

async function makeTempBytes(name: string, contents: Uint8Array) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relgeo-cli-test-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, contents);
  return filePath;
}

async function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = process.env, cwd = packageDir) {
  return execFileAsync("node", [cliBin, ...args], {
    cwd,
    env: extraEnv,
  });
}

function runCliWithInput(args: string[], input: string, extraEnv: NodeJS.ProcessEnv = process.env, cwd = packageDir) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile("node", [cliBin, ...args], {
      cwd,
      env: extraEnv,
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

  it("emits the canonical semantic projection and replays identically across processes", async () => {
    const filePath = await makeTempFile("compile-canonical.yaml", validDoc);
    const first = await runCli(["compile", filePath]);
    const second = await runCli(["compile", filePath]);
    const parsed = JSON.parse(first.stdout);

    expect(parsed.schema).toBe("relgeo.resolved-scene");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.compatibilityLine).toBe("0.5");
    expect(parsed.objectOrder).toEqual(["panel"]);
    expect(first.stdout).toBe(second.stdout);
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

  it("creates and safely protects a starter document", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relgeo-cli-init-"));
    tempDirs.push(dir);
    const starterPath = path.join(dir, "starter.yaml");
    const first = await runCli(["init", starterPath], process.env, dir);

    expect(first.stdout).toBe("");
    expect(first.stderr).toContain("Created");
    expect(await fs.readFile(starterPath, "utf8")).toContain("version: 0.5");
    await expect(runCli(["init", starterPath], process.env, dir)).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("[OUTPUT_EXISTS]"),
    });
    await expect(runCli(["check", starterPath], process.env, dir)).resolves.toMatchObject({
      stdout: expect.stringContaining("OK"),
    });
  });

  it("provides a named open workflow for existing documents", async () => {
    const filePath = await makeTempFile("open.yaml", validDoc);
    const { stdout } = await runCli(["open", filePath, "--no-color"]);

    expect(stdout).toContain("File Info");
    expect(stdout).toContain(filePath);
  });

  it("loads config input and lets environment and flags override it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relgeo-cli-config-"));
    tempDirs.push(dir);
    await makeTempFile("design.yaml", validDoc, dir);
    await fs.writeJson(path.join(dir, ".relgeo.json"), {
      input: "design.yaml",
      format: "graph",
      unit: "mm",
    });
    const explicitConfigPath = path.join(dir, "explicit.json");
    await fs.writeJson(explicitConfigPath, { input: "design.yaml", format: "svg" });

    const configResult = await runCli(["compile"], process.env, dir);
    expect(Array.isArray(JSON.parse(configResult.stdout))).toBe(true);

    const explicitConfigResult = await runCli(["compile", "--config", explicitConfigPath], process.env, dir);
    expect(explicitConfigResult.stdout).toContain("<svg");

    const envResult = await runCli(["compile"], {
      ...process.env,
      RELGEO_FORMAT: "svg",
    }, dir);
    expect(envResult.stdout).toContain("<svg");

    const flagResult = await runCli(["compile", "--format", "json"], {
      ...process.env,
      RELGEO_FORMAT: "svg",
    }, dir);
    expect(JSON.parse(flagResult.stdout).schema).toBe("relgeo.resolved-scene");
  });

  it("makes --no-config explicit and rejects malformed config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relgeo-cli-config-errors-"));
    tempDirs.push(dir);
    await fs.writeJson(path.join(dir, ".relgeo.json"), { input: "missing.yaml" });

    await expect(runCli(["compile", "--no-config"], process.env, dir)).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("[MISSING_INPUT]"),
    });
    await fs.writeFile(path.join(dir, ".relgeo.json"), "{ invalid", "utf8");
    await expect(runCli(["compile"], process.env, dir)).rejects.toMatchObject({
      code: 3,
      stderr: expect.stringContaining("[CONFIG_READ_FAILED]"),
    });
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

  it("forwards profile, parameter, and unit intent to the resolver", async () => {
    const filePath = await makeTempFile("render-options.yaml", validDoc);
    const profiled = await runCli(["compile", filePath, "--profile", "compact", "--unit", "cm"]);
    const profiledScene = JSON.parse(profiled.stdout);
    expect(profiledScene.unit).toBe("cm");
    expect(profiledScene.objects.panel.width).toBeCloseTo(8, 6);

    const overridden = await runCli(["compile", filePath, "--profile", "compact", "--unit", "cm", "--param", "width=200mm"]);
    expect(JSON.parse(overridden.stdout).objects.panel.width).toBeCloseTo(20, 6);

    const candidateFixture = path.resolve(packageDir, "../fixtures/reference/16-v05-evaluator-units-candidate.yaml");
    const candidate = await runCli(["compile", candidateFixture, "--unit", "cm", "--param", "panelWidth=3cm"]);
    const candidateScene = JSON.parse(candidate.stdout);
    expect(candidateScene.unit).toBe("cm");
    expect(candidateScene.objects.panel.width).toBeCloseTo(3, 6);
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

  it("keeps Commander usage failures machine-readable when requested", async () => {
    const filePath = await makeTempFile("unknown-option-json.yaml", validDoc);

    try {
      await runCli(["compile", filePath, "--wat", "--diagnostics", "json"]);
    } catch (error: any) {
      expect(error.code).toBe(2);
      expect(error.stdout).toBe("");
      expect(JSON.parse(error.stderr.trim())).toMatchObject({
        version: 1,
        command: "Command Failed",
        exitCode: 2,
        code: "USAGE_ERROR",
        phase: "validate",
        severity: "error",
      });
    }
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

  it("selects a view within its sheet and rejects invalid view intent", async () => {
    const fixturePath = path.resolve(packageDir, "../fixtures/reference/09-multi-sheet-title-block.yaml");
    const selected = await runCli(["compile", fixturePath, "-f", "svg", "--view", "detail", "--no-color"]);
    expect(selected.stdout).toContain("Viewport: detail");
    expect(selected.stdout).not.toContain("Viewport: front");

    await expect(runCli(["compile", fixturePath, "-f", "svg", "--sheet", "sheetA", "--view", "detail"]))
      .rejects.toMatchObject({ code: 4, stderr: expect.stringContaining("[VIEW_NOT_ON_SHEET]") });
    await expect(runCli(["compile", fixturePath, "-f", "svg", "--view", "missing"]))
      .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("[UNKNOWN_VIEW]") });
    await expect(runCli(["compile", fixturePath, "--format", "json", "--view", "detail"]))
      .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("[VIEW_FORMAT_MISMATCH]") });
  });

  it("keeps CLI render-option fixtures declared in the shared manifest", async () => {
    const manifest = JSON.parse(await fs.readFile(path.resolve(packageDir, "../fixtures/manifest.json"), "utf8"));
    expect(manifest.cliContractCoverage.renderOptions.fixtureIds).toEqual(expect.arrayContaining([
      "v05-evaluator-units-candidate",
      "multi-sheet-title-block",
    ]));
    expect(manifest.cliContractCoverage.renderOptions.selectors).toEqual(expect.arrayContaining([
      "--profile",
      "--param",
      "--unit",
      "--sheet",
      "--view",
    ]));
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

  it("has deterministic overwrite behavior and UTF-8 input rejection", async () => {
    const filePath = await makeTempFile("overwrite.yaml", validDoc);
    const outputPath = path.join(path.dirname(filePath), "overwrite.json");
    await runCli(["compile", filePath, "--output", outputPath]);
    const original = await fs.readFile(outputPath, "utf8");

    await expect(runCli(["compile", filePath, "--output", outputPath, "--no-overwrite"]))
      .rejects.toMatchObject({ code: 5, stderr: expect.stringContaining("[OUTPUT_EXISTS]") });
    expect(await fs.readFile(outputPath, "utf8")).toBe(original);
    await expect(runCli(["compile", filePath, "--output", outputPath, "--overwrite"]))
      .resolves.toMatchObject({ stdout: "" });

    const invalidEncoding = await makeTempBytes("invalid-encoding.yaml", Uint8Array.from([0xff, 0xfe]));
    await expect(runCli(["compile", invalidEncoding])).rejects.toMatchObject({
      code: 3,
      stderr: expect.stringContaining("[INVALID_ENCODING]"),
    });
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

  it("uses the resolved config input as the diagnostic source", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relgeo-cli-config-diagnostics-"));
    tempDirs.push(dir);
    await fs.writeJson(path.join(dir, ".relgeo.json"), {
      input: "missing-from-config.yaml",
      diagnostics: "json",
    });

    try {
      await runCli(["compile"], process.env, dir);
    } catch (error: any) {
      expect(error.code).toBe(3);
      expect(JSON.parse(error.stderr.trim())).toMatchObject({
        code: "FILE_NOT_FOUND",
        source: "missing-from-config.yaml",
        exitCode: 3,
        phase: "parse",
      });
    }
  });

  it("keeps output failures on stderr without a partial-success payload", async () => {
    const filePath = await makeTempFile("output-failure-json.yaml", validDoc);
    const outputDirectory = path.join(path.dirname(filePath), "existing-directory-json");
    await fs.ensureDir(outputDirectory);

    try {
      await runCli(["compile", filePath, "--output", outputDirectory, "--diagnostics", "json"]);
    } catch (error: any) {
      expect(error.code).toBe(5);
      expect(error.stdout).toBe("");
      expect(JSON.parse(error.stderr.trim())).toMatchObject({
        code: "OUTPUT_WRITE_FAILED",
        exitCode: 5,
        phase: "resolve",
      });
      expect(error.stderr).not.toContain("Successfully compiled");
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

  it("keeps CI machine streams quiet and uncolored", async () => {
    const filePath = await makeTempFile("ci.yaml", validDoc);
    const ciEnv = { ...process.env, CI: "1" };
    const { stdout, stderr } = await runCli(["compile", filePath], ciEnv);

    expect(JSON.parse(stdout).schema).toBe("relgeo.resolved-scene");
    expect(stderr).toBe("");
    expect(stdout).not.toContain("\u001b[");
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
