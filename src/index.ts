import { Command } from "commander";
import chalk from "chalk";
import fs from "fs-extra";
import path from "node:path";
import { compileRelGeo, getDependencyGraph, parseRelGeo, toDiagnostic } from "@relgeo/core";
import type { RelGeoDiagnostic, RelGeoDocument } from "@relgeo/core";
import { renderToSVG } from "@relgeo/renderer-svg";

const program = new Command();

export const CLI_EXIT_CODES = {
  success: 0,
  usage: 2,
  input: 3,
  validation: 4,
  output: 5,
} as const;

type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];
type DiagnosticsMode = "human" | "json";
type DiagnosticPhase = RelGeoDiagnostic["phase"];

const SUPPORTED_FORMATS = ["json", "svg", "graph"] as const;
const SUPPORTED_UNITS = ["px", "mm", "cm", "m", "in"] as const;

class CliError extends Error {
  readonly exitCode: CliExitCode;
  readonly code?: string;
  readonly phase: DiagnosticPhase;
  readonly severity = "error" as const;
  readonly path?: string;
  readonly objectId?: string;
  readonly range?: RelGeoDiagnostic["range"];
  title?: string;
  source?: string;
  diagnosticsMode?: DiagnosticsMode;

  constructor(
    message: string,
    exitCode: CliExitCode,
    code?: string,
    details: {
      phase?: DiagnosticPhase;
      path?: string;
      objectId?: string;
      range?: RelGeoDiagnostic["range"];
    } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.phase = details.phase ?? "validate";
    this.path = details.path;
    this.objectId = details.objectId;
    this.range = details.range;
  }
}

interface CommandOptions {
  diagnostics?: string;
  noColor?: boolean;
}

interface InputSource {
  content: string;
  label: string;
}

function parseCliOverride(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;

  const numeric = Number(raw);
  if (!Number.isNaN(numeric) && raw.trim() !== "") {
    return numeric;
  }

  return raw;
}

function applyColorMode(options: CommandOptions = {}) {
  if (options.noColor || process.env.NO_COLOR !== undefined || process.env.CI === "1") {
    (chalk as unknown as { level: number }).level = 0;
  }
}

function validateDiagnosticsMode(raw: string | undefined): DiagnosticsMode {
  const mode = raw ?? "human";
  if (mode !== "human" && mode !== "json") {
    throw new CliError(
      `Unknown diagnostics mode "${mode}". Expected one of: human, json`,
      CLI_EXIT_CODES.usage,
      "UNKNOWN_DIAGNOSTICS_MODE",
      { path: "diagnostics" },
    );
  }
  return mode;
}

function validateFormat(raw: string | undefined): (typeof SUPPORTED_FORMATS)[number] {
  const format = raw ?? "json";
  if (!SUPPORTED_FORMATS.includes(format as (typeof SUPPORTED_FORMATS)[number])) {
    throw new CliError(
      `Unknown format "${format}". Expected one of: ${SUPPORTED_FORMATS.join(", ")}`,
      CLI_EXIT_CODES.usage,
      "UNKNOWN_FORMAT",
      { path: "format" },
    );
  }
  return format as (typeof SUPPORTED_FORMATS)[number];
}

function validateUnit(raw: string | undefined): (typeof SUPPORTED_UNITS)[number] {
  const unit = raw ?? "px";
  if (!SUPPORTED_UNITS.includes(unit as (typeof SUPPORTED_UNITS)[number])) {
    throw new CliError(
      `Unknown unit "${unit}". Expected one of: ${SUPPORTED_UNITS.join(", ")}`,
      CLI_EXIT_CODES.usage,
      "UNKNOWN_UNIT",
      { path: "unit" },
    );
  }
  return unit as (typeof SUPPORTED_UNITS)[number];
}

function parseOverrides(rawValues: string[] | undefined): Record<string, string | number | boolean> {
  const overrides: Record<string, string | number | boolean> = {};
  for (const pair of rawValues ?? []) {
    const separator = pair.indexOf("=");
    if (separator <= 0 || separator === pair.length - 1) {
      throw new CliError(
        `Invalid parameter override "${pair}". Expected key=value`,
        CLI_EXIT_CODES.usage,
        "INVALID_PARAMETER_OVERRIDE",
        { path: "param" },
      );
    }

    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1);
    if (!key || !value.trim()) {
      throw new CliError(
        `Invalid parameter override "${pair}". Expected key=value`,
        CLI_EXIT_CODES.usage,
        "INVALID_PARAMETER_OVERRIDE",
        { path: "param" },
      );
    }
    overrides[key] = parseCliOverride(value);
  }
  return overrides;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readInput(source: string): Promise<InputSource> {
  if (source === "-") {
    const content = await readStdin();
    if (!content.trim()) {
      throw new CliError("Input is empty", CLI_EXIT_CODES.input, "EMPTY_INPUT", {
        phase: "parse",
        path: "<stdin>",
      });
    }
    return { content, label: "<stdin>" };
  }

  const filePath = path.resolve(process.cwd(), source);
  if (!(await fs.pathExists(filePath))) {
    throw new CliError(`File not found: ${source}`, CLI_EXIT_CODES.input, "FILE_NOT_FOUND", {
      phase: "parse",
      path: source,
    });
  }

  try {
    return { content: await fs.readFile(filePath, "utf8"), label: source };
  } catch (error) {
    throw new CliError(`Unable to read file "${source}"`, CLI_EXIT_CODES.input, "INPUT_READ_FAILED", {
      phase: "parse",
      path: source,
    });
  }
}

function validateDocumentOptions(
  content: string,
  options: {
    format?: string;
    unit?: string;
    profile?: string;
    param?: string[];
    sheet?: string;
  },
): { document: RelGeoDocument; format: (typeof SUPPORTED_FORMATS)[number]; unit: (typeof SUPPORTED_UNITS)[number]; overrides: Record<string, string | number | boolean> } {
  const format = validateFormat(options.format);
  const unit = validateUnit(options.unit);
  const overrides = parseOverrides(options.param);
  const document = parseRelGeo(content, { mode: "editor" });

  if (options.profile && !document.profiles?.[options.profile]) {
    throw new CliError(
      `Unknown profile "${options.profile}"`,
      CLI_EXIT_CODES.usage,
      "UNKNOWN_PROFILE",
      { path: "profile" },
    );
  }

  const parameters = document.parameters ?? {};
  for (const key of Object.keys(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(parameters, key)) {
      throw new CliError(
        `Unknown parameter "${key}"`,
        CLI_EXIT_CODES.usage,
        "UNKNOWN_PARAMETER",
        { path: `parameters.${key}` },
      );
    }
  }

  if (options.sheet && format !== "svg") {
    throw new CliError(
      "The --sheet option is only supported with --format svg",
      CLI_EXIT_CODES.usage,
      "SHEET_FORMAT_MISMATCH",
      { path: "sheet" },
    );
  }

  return { document, format, unit, overrides };
}

function isCommanderError(error: unknown): error is { code: string; message: string } {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    && (error as { code: string }).code.startsWith("commander."),
  );
}

function classifyError(error: unknown): CliError {
  if (error instanceof CliError) return error;

  if (isCommanderError(error)) {
    return new CliError(error.message, CLI_EXIT_CODES.usage, "USAGE_ERROR", {
      phase: "validate",
      path: "command",
    });
  }

  const diagnostic = toDiagnostic(error);
  const inputCodes = new Set(["INVALID_YAML", "UNSUPPORTED_SPEC_VERSION"]);
  const exitCode = inputCodes.has(diagnostic.code)
    ? CLI_EXIT_CODES.input
    : CLI_EXIT_CODES.validation;
  return new CliError(diagnostic.message, exitCode, diagnostic.code, {
    phase: diagnostic.phase,
    path: diagnostic.path,
    objectId: diagnostic.objectId,
    range: diagnostic.range,
  });
}

async function runCommand<T>(
  title: string,
  source: string,
  options: CommandOptions,
  action: () => Promise<T>,
): Promise<T> {
  applyColorMode(options);
  validateDiagnosticsMode(options.diagnostics);
  try {
    return await action();
  } catch (error) {
    const cliError = classifyError(error);
    cliError.title = title;
    cliError.source = source === "-" ? "<stdin>" : source;
    cliError.diagnosticsMode = (options.diagnostics ?? "human") as DiagnosticsMode;
    throw cliError;
  }
}

function diagnosticFromCliError(error: CliError): RelGeoDiagnostic {
  return toDiagnostic(error, { fallbackCode: "CLI_ERROR" });
}

function writeHumanError(error: CliError) {
  const diagnostic = diagnosticFromCliError(error);
  const lines = [
    `${error.title ?? "Command Failed"}:`,
    `  [${diagnostic.code}] ${diagnostic.message}`,
    `  Phase: ${diagnostic.phase}`,
  ];
  if (diagnostic.objectId) lines.push(`  Object: ${diagnostic.objectId}`);
  if (diagnostic.path) lines.push(`  Path: ${diagnostic.path}`);
  console.error(lines.join("\n"));
}

function writeJsonError(error: CliError) {
  const diagnostic = diagnosticFromCliError(error);
  console.error(JSON.stringify({
    version: 1,
    command: error.title ?? "Command Failed",
    source: error.source ?? null,
    exitCode: error.exitCode,
    code: diagnostic.code,
    phase: diagnostic.phase,
    severity: diagnostic.severity,
    message: diagnostic.message,
    path: diagnostic.path ?? null,
    objectId: diagnostic.objectId ?? null,
    range: diagnostic.range ?? null,
  }));
}

function handleError(error: unknown) {
  if (isCommanderError(error) && ["commander.helpDisplayed", "commander.version"].includes(error.code)) {
    process.exitCode = CLI_EXIT_CODES.success;
    return;
  }

  const cliError = classifyError(error);
  if (cliError.diagnosticsMode === "json") {
    writeJsonError(cliError);
  } else {
    writeHumanError(cliError);
  }
  process.exitCode = cliError.exitCode;
}

function addBoundaryOptions(command: Command) {
  return command
    .exitOverride((error) => {
      throw error;
    })
    .option("--diagnostics <mode>", "diagnostics output mode (human, json)", "human")
    .option("--no-color", "disable color and progress styling");
}

program
  .name("relgeo")
  .description("RelGeo CLI - Relation-first parametric geometry engine for the active RelGeo DSL v0.5 surface")
  .version("0.5.0")
  .option("--no-color", "disable color and progress styling");

const infoCommand = addBoundaryOptions(
  program
    .command("info")
    .description("Show information about parameters, profiles, and document structure in a RelGeo file")
    .argument("<file>", "path to the .yaml file or - for stdin"),
);

infoCommand.action(async (file: string, options: CommandOptions) => {
  await runCommand("Error reading file", file, options, async () => {
    const input = await readInput(file);
    const document = parseRelGeo(input.content, { mode: "editor" });
    const objects = document.objects ?? {};

    console.log(chalk.blue(`\n--- File Info: ${input.label} ---`));
    console.log(`DSL Version: ${chalk.bold(String(document.version ?? "0.5"))}`);

    console.log(chalk.yellow("\nParameters:"));
    if (document.parameters && Object.keys(document.parameters).length > 0) {
      for (const [key, parameter] of Object.entries<any>(document.parameters)) {
        const type = typeof parameter === "object" ? parameter.type : "number";
        const def = typeof parameter === "object" ? parameter.default : parameter;
        console.log(`  - ${chalk.bold(key)} (${type}): Default = ${def}`);
      }
    } else {
      console.log("  (None)");
    }

    if (document.profiles) {
      console.log(chalk.bold("\nProfiles:"));
      Object.entries(document.profiles).forEach(([name, params]) => {
        console.log(`- ${chalk.cyan(name)}: ${Object.keys(params).join(", ")}`);
      });
    }

    if (document.metaPresets && Object.keys(document.metaPresets).length > 0) {
      console.log(chalk.bold("\nMeta Presets:"));
      Object.entries(document.metaPresets).forEach(([name, preset]) => {
        console.log(`- ${chalk.cyan(name)}: ${Object.keys(preset).join(", ")}`);
      });
    } else if (document.styles && Object.keys(document.styles).length > 0) {
      console.log(chalk.bold("\nStyles (Alias):"));
      Object.entries(document.styles).forEach(([name, preset]) => {
        console.log(`- ${chalk.cyan(name)}: ${Object.keys(preset).join(", ")}`);
      });
    }

    if (document.components && Object.keys(document.components).length > 0) {
      console.log(chalk.bold("\nComponents:"));
      Object.entries(document.components).forEach(([id, component]: any) => {
        const parameterCount = component.parameters ? Object.keys(component.parameters).length : 0;
        const objectCount = component.objects ? Object.keys(component.objects).length : 0;
        console.log(`- ${chalk.cyan(id)} (${parameterCount} params, ${objectCount} objects)`);
      });
    }

    if (document.views && Object.keys(document.views).length > 0) {
      console.log(chalk.bold("\nViews:"));
      Object.entries(document.views).forEach(([id, view]: any) => {
        console.log(`- ${chalk.cyan(id)} (target: ${view.target})`);
      });
    }

    if (document.sheets && Object.keys(document.sheets).length > 0) {
      console.log(chalk.bold("\nSheets:"));
      Object.entries(document.sheets).forEach(([id, sheet]: any) => {
        const viewCount = sheet.views ? sheet.views.length : 0;
        const size = Array.isArray(sheet.size) ? sheet.size.join("x") : sheet.size;
        console.log(`- ${chalk.cyan(id)} (size: ${size}, ${viewCount} views)`);
      });
    }

    console.log(chalk.bold("\nObjects:"));
    Object.entries(objects).forEach(([id, object]: any) => {
      console.log(`- ${chalk.cyan(id)} (${object.type})`);
    });
    console.log("");
  });
});

const compileCommand = addBoundaryOptions(
  program
    .command("compile")
    .description("Compile a RelGeo YAML file to resolved geometry")
    .argument("<file>", "path to the .yaml file or - for stdin")
    .option("-o, --output <path>", "output path (defaults to stdout)")
    .option("-f, --format <format>", `output format (${SUPPORTED_FORMATS.join(", ")})`, "json")
    .option("-u, --unit <unit>", `target unit (${SUPPORTED_UNITS.join(", ")})`, "px")
    .option("--profile <name>", "select a parameter profile from the file")
    .option("-p, --param <keyvalue...>", "override parameters (format: key=value)")
    .option("-s, --sheet <id>", "render a specific sheet (SVG format only)"),
);

compileCommand.action(async (file: string, options: CommandOptions & {
  output?: string;
  format?: string;
  unit?: string;
  profile?: string;
  param?: string[];
  sheet?: string;
}) => {
  await runCommand("Compilation Failed", file, options, async () => {
    const input = await readInput(file);
    const validated = validateDocumentOptions(input.content, options);
    if (options.diagnostics !== "json") {
      console.error(chalk.blue(`Compiling ${input.label}...`));
    }

    const scene = compileRelGeo(input.content, {
      targetUnit: validated.unit,
      profile: options.profile,
      overrides: validated.overrides,
    });

    let outputData: string;
    if (validated.format === "svg") {
      outputData = renderToSVG(scene, { sheetId: options.sheet });
    } else if (validated.format === "graph") {
      const graph = getDependencyGraph(validated.document.objects ?? {});
      outputData = JSON.stringify(graph, null, 2);
    } else {
      outputData = JSON.stringify(scene, null, 2);
    }

    if (options.output) {
      const outputPath = path.resolve(process.cwd(), options.output);
      try {
        await fs.outputFile(outputPath, outputData, "utf8");
      } catch (error) {
        throw new CliError(`Unable to write output file "${options.output}"`, CLI_EXIT_CODES.output, "OUTPUT_WRITE_FAILED", {
          phase: "resolve",
          path: options.output,
        });
      }
      console.error(chalk.green(`Successfully compiled to ${options.output} (${validated.format})`));
    } else {
      console.log(outputData);
    }
  });
});

const checkCommand = addBoundaryOptions(
  program
    .command("check")
    .alias("validate")
    .description("Validate and resolve a RelGeo YAML file, reporting errors without producing output")
    .argument("<file>", "path to the .yaml file or - for stdin")
    .option("-u, --unit <unit>", `target unit (${SUPPORTED_UNITS.join(", ")})`, "mm")
    .option("--profile <name>", "select a parameter profile from the file")
    .option("-p, --param <keyvalue...>", "override parameters (format: key=value)"),
);

checkCommand.action(async (file: string, options: CommandOptions & {
  unit?: string;
  profile?: string;
  param?: string[];
}) => {
  await runCommand("Validation Failed", file, options, async () => {
    const input = await readInput(file);
    const validated = validateDocumentOptions(input.content, {
      unit: options.unit,
      profile: options.profile,
      param: options.param,
    });
    const scene = compileRelGeo(input.content, {
      targetUnit: validated.unit,
      profile: options.profile,
      overrides: validated.overrides,
    });

    const objectCount = Object.keys(scene.objects).length;
    console.log(chalk.green("✓ OK") + chalk.gray(` — ${input.label} | ${objectCount} objects resolved | unit: ${validated.unit}`));

    const nulls = Object.entries(scene.objects)
      .filter(([, value]: any) => value == null)
      .map(([key]) => key);
    if (nulls.length > 0) {
      console.warn(chalk.yellow(`⚠ ${nulls.length} object(s) resolved to null: ${nulls.join(", ")}`));
    }
  });
});

program.exitOverride((error) => {
  throw error;
});
program.configureOutput({
  outputError: () => undefined,
});

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    handleError(error);
  }
}

void main();
