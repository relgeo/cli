import { Command } from "commander";
import chalk from "chalk";
import fs from "fs-extra";
import path from "node:path";
import { compileRelGeo, getDependencyGraph, parseRelGeo, serializeResolvedScene, toDiagnostic } from "@relgeo/core";
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
  color?: boolean;
  config?: string | false;
  input?: string;
  output?: string;
  format?: string;
  unit?: string;
  profile?: string;
  param?: string[];
  sheet?: string;
  view?: string;
  overwrite?: boolean;
}

interface InputSource {
  content: string;
  label: string;
}

interface CliConfig {
  input?: string;
  output?: string;
  format?: string;
  unit?: string;
  profile?: string;
  param?: string[] | Record<string, string | number | boolean>;
  sheet?: string;
  view?: string;
  diagnostics?: string;
  color?: boolean;
  overwrite?: boolean;
}

interface ResolvedCommand {
  input: string;
  options: CommandOptions;
  configPath?: string;
}

const CONFIG_FILE_NAME = ".relgeo.json";
const CONFIG_KEYS = new Set([
  "input",
  "output",
  "format",
  "unit",
  "profile",
  "param",
  "sheet",
  "view",
  "diagnostics",
  "color",
  "overwrite",
]);

function environmentFlag(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function hasArg(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function normalizeParamConfig(value: CliConfig["param"]): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  return Object.entries(value).map(([key, param]) => `${key}=${String(param)}`);
}

function readEnvironmentOptions(): CliConfig {
  const env = process.env;
  const param = env.RELGEO_PARAM
    ? env.RELGEO_PARAM.split(",").map((value) => value.trim()).filter(Boolean)
    : undefined;
  return pickDefined({
    input: env.RELGEO_INPUT,
    output: env.RELGEO_OUTPUT,
    format: env.RELGEO_FORMAT,
    unit: env.RELGEO_UNIT,
    profile: env.RELGEO_PROFILE,
    param,
    sheet: env.RELGEO_SHEET,
    view: env.RELGEO_VIEW,
    diagnostics: env.RELGEO_DIAGNOSTICS,
    color: environmentFlag(env.RELGEO_NO_COLOR) || environmentFlag(env.NO_COLOR) || environmentFlag(env.CI)
      ? false
      : undefined,
    overwrite: env.RELGEO_OVERWRITE === undefined ? undefined : environmentFlag(env.RELGEO_OVERWRITE),
  }) as CliConfig;
}

function validateConfigObject(value: unknown, source: string): CliConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`Config file must contain a JSON object: ${source}`, CLI_EXIT_CODES.usage, "INVALID_CONFIG", {
      phase: "parse",
      path: source,
    });
  }

  const config = value as Record<string, unknown>;
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    throw new CliError(`Unknown config key(s): ${unknown.join(", ")}`, CLI_EXIT_CODES.usage, "INVALID_CONFIG", {
      phase: "validate",
      path: source,
    });
  }

  if (config.param !== undefined && !Array.isArray(config.param) && (typeof config.param !== "object" || config.param === null)) {
    throw new CliError("Config key \"param\" must be an array or object", CLI_EXIT_CODES.usage, "INVALID_CONFIG", {
      phase: "validate",
      path: `${source}.param`,
    });
  }

  for (const key of ["color", "overwrite"]) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      throw new CliError(`Config key \"${key}\" must be boolean`, CLI_EXIT_CODES.usage, "INVALID_CONFIG", {
        phase: "validate",
        path: `${source}.${key}`,
      });
    }
  }

  return {
    ...(config as CliConfig),
    param: normalizeParamConfig(config.param as CliConfig["param"]),
  };
}

async function loadConfig(rawOptions: CommandOptions): Promise<{ config: CliConfig; configPath?: string }> {
  const envConfigPath = process.env.RELGEO_CONFIG;
  const configOption = rawOptions.config;
  if (configurationDisabled(rawOptions)) {
    return { config: {} };
  }

  const requestedPath = typeof configOption === "string" ? configOption : envConfigPath;
  const configPath = requestedPath
    ? path.resolve(process.cwd(), requestedPath)
    : path.join(process.cwd(), CONFIG_FILE_NAME);
  const exists = await fs.pathExists(configPath);
  if (!exists) {
    if (requestedPath) {
      throw new CliError(`Config file not found: ${requestedPath}`, CLI_EXIT_CODES.input, "CONFIG_NOT_FOUND", {
        phase: "parse",
        path: requestedPath,
      });
    }
    return { config: {} };
  }

  let parsed: unknown;
  try {
    parsed = await fs.readJson(configPath);
  } catch {
    throw new CliError(`Unable to parse config file \"${configPath}\"`, CLI_EXIT_CODES.input, "CONFIG_READ_FAILED", {
      phase: "parse",
      path: configPath,
    });
  }
  return { config: validateConfigObject(parsed, configPath), configPath };
}

function configurationDisabled(rawOptions: CommandOptions): boolean {
  return rawOptions.config === false || hasArg("--no-config") || environmentFlag(process.env.RELGEO_NO_CONFIG);
}

function pickDefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

async function resolveCommand(rawInput: string | undefined, rawOptions: CommandOptions): Promise<ResolvedCommand> {
  const loaded = await loadConfig(rawOptions);
  const environmentOptions = readEnvironmentOptions();
  const environment = configurationDisabled(rawOptions)
    ? pickDefined({ color: environmentOptions.color }) as CliConfig
    : environmentOptions;
  const flags = pickDefined(rawOptions);
  const merged = {
    ...loaded.config,
    ...environment,
    ...flags,
    param: rawOptions.param ?? environment.param ?? loaded.config.param,
  } as CommandOptions & { input?: string };
  const input = rawInput ?? merged.input;
  if (!input) {
    throw new CliError("Input path is required (use - for stdin)", CLI_EXIT_CODES.usage, "MISSING_INPUT", {
      phase: "validate",
      path: "input",
    });
  }
  return { input, options: merged, configPath: loaded.configPath };
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
  if (options.color === false || environmentFlag(process.env.NO_COLOR) || environmentFlag(process.env.CI)) {
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

function diagnosticsModeFromArgv(): DiagnosticsMode {
  const args = process.argv.slice(2);
  let requested = process.env.RELGEO_DIAGNOSTICS;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--diagnostics") {
      requested = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--diagnostics=")) {
      requested = argument.slice("--diagnostics=".length);
    }
  }
  return requested === "json" ? "json" : "human";
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

function decodeUtf8(buffer: Buffer, source: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new CliError(`Input is not valid UTF-8: ${source}`, CLI_EXIT_CODES.input, "INVALID_ENCODING", {
      phase: "parse",
      path: source,
    });
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return decodeUtf8(Buffer.concat(chunks), "<stdin>");
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
    const content = decodeUtf8(await fs.readFile(filePath), source);
    if (!content.trim()) {
      throw new CliError("Input is empty", CLI_EXIT_CODES.input, "EMPTY_INPUT", {
        phase: "parse",
        path: source,
      });
    }
    return { content, label: source };
  } catch (error) {
    if (error instanceof CliError) throw error;
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
    view?: string;
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

  if (options.view && format !== "svg") {
    throw new CliError(
      "The --view option is only supported with --format svg",
      CLI_EXIT_CODES.usage,
      "VIEW_FORMAT_MISMATCH",
      { path: "view" },
    );
  }

  if (options.sheet && !document.sheets?.[options.sheet]) {
    throw new CliError(
      `Unknown sheet "${options.sheet}"`,
      CLI_EXIT_CODES.validation,
      "MISSING_SHEET",
      { phase: "resolve", path: "sheet" },
    );
  }

  if (options.view && !document.views?.[options.view]) {
    throw new CliError(
      `Unknown view "${options.view}"`,
      CLI_EXIT_CODES.usage,
      "UNKNOWN_VIEW",
      { path: "view" },
    );
  }

  return { document, format, unit, overrides };
}

function selectSvgView(scene: any, sheetId: string | undefined, viewId: string | undefined): { scene: any; sheetId?: string } {
  if (!viewId) return { scene, sheetId };

  const sheets = scene.sheets ?? {};
  const matchingSheetIds = Object.entries<any>(sheets)
    .filter(([, sheet]) => Array.isArray(sheet.views) && sheet.views.some((placement: any) => placement.use === viewId))
    .map(([id]) => id);

  const selectedSheetId = sheetId ?? (matchingSheetIds.length === 1 ? matchingSheetIds[0] : undefined);
  if (!selectedSheetId) {
    if (matchingSheetIds.length > 1) {
      throw new CliError(`View "${viewId}" is present on multiple sheets; use --sheet`, CLI_EXIT_CODES.usage, "VIEW_REQUIRES_SHEET", {
        phase: "validate",
        path: "view",
      });
    }
    throw new CliError(`View "${viewId}" is not placed on a sheet`, CLI_EXIT_CODES.usage, "VIEW_NOT_ON_SHEET", {
      phase: "validate",
      path: "view",
    });
  }

  const sheet = sheets[selectedSheetId];
  if (!sheet) {
    throw new CliError(`Unknown sheet "${selectedSheetId}"`, CLI_EXIT_CODES.validation, "MISSING_SHEET", {
      phase: "resolve",
      path: "sheet",
    });
  }
  const selectedViews = Array.isArray(sheet.views)
    ? sheet.views.filter((placement: any) => placement.use === viewId)
    : [];
  if (selectedViews.length === 0) {
    throw new CliError(`View "${viewId}" is not placed on sheet "${selectedSheetId}"`, CLI_EXIT_CODES.validation, "VIEW_NOT_ON_SHEET", {
      phase: "resolve",
      path: "view",
    });
  }

  return {
    scene: {
      ...scene,
      sheets: {
        ...sheets,
        [selectedSheetId]: { ...sheet, views: selectedViews },
      },
    },
    sheetId: selectedSheetId,
  };
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

  const candidate = error && typeof error === "object"
    ? error as { code?: unknown }
    : {};
  const diagnostic = toDiagnostic(error);
  const code = typeof candidate.code === "string" ? candidate.code : diagnostic.code;
  const inputCodes = new Set(["INVALID_YAML", "UNSUPPORTED_SPEC_VERSION"]);
  const exitCode = inputCodes.has(code)
    ? CLI_EXIT_CODES.input
    : CLI_EXIT_CODES.validation;
  return new CliError(diagnostic.message, exitCode, code, {
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
  try {
    validateDiagnosticsMode(options.diagnostics);
    return await action();
  } catch (error) {
    const cliError = classifyError(error);
    cliError.title = title;
    const resolvedSource = options.input ?? source;
    cliError.source = resolvedSource === "-" ? "<stdin>" : resolvedSource;
    cliError.diagnosticsMode = (options.diagnostics ?? "human") as DiagnosticsMode;
    throw cliError;
  }
}

function diagnosticFromCliError(error: CliError): RelGeoDiagnostic {
  return {
    code: error.code ?? "CLI_ERROR",
    message: error.message,
    phase: error.phase,
    severity: error.severity,
    path: error.path,
    objectId: error.objectId,
    range: error.range,
  };
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
  cliError.diagnosticsMode ??= diagnosticsModeFromArgv();
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
    .option("--diagnostics <mode>", "diagnostics output mode (human, json)")
    .option("--config <path>", `read defaults from a JSON config file (default: ${CONFIG_FILE_NAME})`)
    .option("--no-config", "ignore config files and configuration environment variables")
    .option("--no-color", "disable color styling")
    .option("--overwrite", "allow replacing an existing output file")
    .option("--no-overwrite", "fail when the output file already exists");
}

program
  .name("relgeo")
  .description("RelGeo CLI - Relation-first parametric geometry engine for the active RelGeo DSL v0.5 surface")
  .version("0.5.0")
  .option("--config <path>", `read defaults from a JSON config file (default: ${CONFIG_FILE_NAME})`)
  .option("--no-config", "ignore config files and configuration environment variables")
  .option("--no-color", "disable color styling")
  .option("--overwrite", "allow replacing an existing output file")
  .option("--no-overwrite", "fail when the output file already exists");

async function writeOutputFile(outputPath: string, outputData: string, overwrite: boolean): Promise<void> {
  const resolvedPath = path.resolve(process.cwd(), outputPath);
  if (!overwrite && await fs.pathExists(resolvedPath)) {
    throw new CliError(`Output file already exists: ${outputPath}`, CLI_EXIT_CODES.output, "OUTPUT_EXISTS", {
      phase: "resolve",
      path: outputPath,
    });
  }

  const parent = path.dirname(resolvedPath);
  const temporaryPath = path.join(parent, `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.ensureDir(parent);
    await fs.writeFile(temporaryPath, outputData, "utf8");
    await fs.rename(temporaryPath, resolvedPath);
  } catch {
    await fs.remove(temporaryPath).catch(() => undefined);
    throw new CliError(`Unable to write output file "${outputPath}"`, CLI_EXIT_CODES.output, "OUTPUT_WRITE_FAILED", {
      phase: "resolve",
      path: outputPath,
    });
  }
}

const STARTER_DOCUMENT = `version: 0.5
objects:
  rectangle:
    type: rect
    size: [100mm, 60mm]
`;

function commandOptions(commandOptions: CommandOptions): CommandOptions {
  const rootOptions = program.opts() as CommandOptions;
  return {
    ...rootOptions,
    ...pickDefined(commandOptions),
    color: hasArg("--no-color") ? false : undefined,
    overwrite: commandOptions.overwrite ?? rootOptions.overwrite,
    config: commandOptions.config ?? rootOptions.config,
  };
}

const infoCommand = addBoundaryOptions(
  program
    .command("info")
    .description("Show information about parameters, profiles, and document structure in a RelGeo file")
    .argument("[file]", "path to the .yaml file or - for stdin (defaults to config input)"),
);

async function runInfoCommand(file: string | undefined, rawOptions: CommandOptions) {
  const options = commandOptions(rawOptions);
  await runCommand("Error reading file", file ?? "<config>", options, async () => {
    const resolved = await resolveCommand(file, options);
    options.input = resolved.input;
    options.diagnostics = resolved.options.diagnostics;
    applyColorMode(resolved.options);
    validateDiagnosticsMode(resolved.options.diagnostics);
    const input = await readInput(resolved.input);
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
}

infoCommand.action(async (file: string | undefined, options: CommandOptions) => runInfoCommand(file, options));

const openCommand = addBoundaryOptions(
  program
    .command("open")
    .description("Select and inspect an existing RelGeo document without launching an editor")
    .argument("[file]", "path to the .yaml file or - for stdin (defaults to config input)"),
);

openCommand.action(async (file: string | undefined, options: CommandOptions) => runInfoCommand(file, options));

const compileCommand = addBoundaryOptions(
  program
    .command("compile")
    .description("Compile a RelGeo YAML file to resolved geometry")
    .argument("[file]", "path to the .yaml file or - for stdin (defaults to config input)")
    .option("-o, --output <path>", "output path (defaults to stdout)")
    .option("-f, --format <format>", `output format (${SUPPORTED_FORMATS.join(", ")})`)
    .option("-u, --unit <unit>", `target unit (${SUPPORTED_UNITS.join(", ")})`)
    .option("--profile <name>", "select a parameter profile from the file")
    .option("-p, --param <keyvalue...>", "override parameters (format: key=value)")
    .option("-s, --sheet <id>", "render a specific sheet (SVG format only)")
    .option("--view <id>", "render a specific view within a sheet (SVG format only)"),
);

compileCommand.action(async (file: string | undefined, options: CommandOptions & {
  output?: string;
  format?: string;
  unit?: string;
  profile?: string;
  param?: string[];
  sheet?: string;
  view?: string;
}) => {
  const rawOptions = commandOptions(options);
  await runCommand("Compilation Failed", file ?? "<config>", rawOptions, async () => {
    const resolved = await resolveCommand(file, rawOptions);
    rawOptions.input = resolved.input;
    rawOptions.diagnostics = resolved.options.diagnostics;
    applyColorMode(resolved.options);
    validateDiagnosticsMode(resolved.options.diagnostics);
    const input = await readInput(resolved.input);
    const validated = validateDocumentOptions(input.content, resolved.options);
    if (resolved.options.diagnostics !== "json" && !environmentFlag(process.env.CI)) {
      console.error(chalk.blue(`Compiling ${input.label}...`));
    }

    const scene = compileRelGeo(input.content, {
      targetUnit: validated.unit,
      profile: resolved.options.profile,
      overrides: validated.overrides,
    });

    let outputData: string;
    if (validated.format === "svg") {
      const selection = selectSvgView(scene, resolved.options.sheet, resolved.options.view);
      outputData = renderToSVG(selection.scene, { sheetId: selection.sheetId });
    } else if (validated.format === "graph") {
      const graph = getDependencyGraph(validated.document.objects ?? {});
      outputData = JSON.stringify(graph, null, 2);
    } else {
      outputData = serializeResolvedScene(scene);
    }

    if (resolved.options.output) {
      await writeOutputFile(resolved.options.output, outputData, resolved.options.overwrite ?? true);
      console.error(chalk.green(`Successfully compiled to ${resolved.options.output} (${validated.format})`));
    } else {
      console.log(outputData);
    }
  });
});

const initCommand = addBoundaryOptions(
  program
    .command("init")
    .description("Create a minimal valid RelGeo v0.5 starter document")
    .argument("[path]", "destination path (default: relgeo.yaml)")
    .option("--force", "replace an existing starter document"),
);

initCommand.action(async (targetPath: string | undefined, rawOptions: CommandOptions & { force?: boolean }) => {
  const options = commandOptions(rawOptions);
  const outputPath = targetPath ?? "relgeo.yaml";
  await runCommand("Initialization Failed", outputPath, options, async () => {
    applyColorMode(options);
    const overwrite = rawOptions.force === true || options.overwrite === true;
    await writeOutputFile(outputPath, STARTER_DOCUMENT, overwrite);
    console.error(chalk.green(`Created ${outputPath}`));
  });
});

const checkCommand = addBoundaryOptions(
  program
    .command("check")
    .alias("validate")
    .description("Validate and resolve a RelGeo YAML file, reporting errors without producing output")
    .argument("[file]", "path to the .yaml file or - for stdin (defaults to config input)")
    .option("-u, --unit <unit>", `target unit (${SUPPORTED_UNITS.join(", ")})`)
    .option("--profile <name>", "select a parameter profile from the file")
    .option("-p, --param <keyvalue...>", "override parameters (format: key=value)"),
);

checkCommand.action(async (file: string | undefined, options: CommandOptions & {
  unit?: string;
  profile?: string;
  param?: string[];
}) => {
  const rawOptions = commandOptions(options);
  await runCommand("Validation Failed", file ?? "<config>", rawOptions, async () => {
    const resolved = await resolveCommand(file, rawOptions);
    rawOptions.input = resolved.input;
    rawOptions.diagnostics = resolved.options.diagnostics;
    applyColorMode(resolved.options);
    validateDiagnosticsMode(resolved.options.diagnostics);
    const input = await readInput(resolved.input);
    const validated = validateDocumentOptions(input.content, {
      unit: resolved.options.unit ?? "mm",
      profile: resolved.options.profile,
      param: resolved.options.param,
    });
    const scene = compileRelGeo(input.content, {
      targetUnit: validated.unit,
      profile: resolved.options.profile,
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
