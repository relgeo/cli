import { Command } from "commander";
import chalk from "chalk";
import fs from "fs-extra";
import path from "path";
import { compileRelGeo, getDependencyGraph, parseRelGeo } from "relgeo-core";
import { renderToSVG } from "relgeo-renderer-svg";

const program = new Command();

function parseCliOverride(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;

  const numeric = Number(raw);
  if (!Number.isNaN(numeric) && raw.trim() !== "") {
    return numeric;
  }

  return raw;
}

program
  .name("relgeo")
  .description("RelGeo CLI - Relation-first parametric geometry engine for the active RelGeo DSL v0.5 surface")
  .version("0.4.0");

program
  .command("info")
  .description("Show information about parameters, profiles, and document structure in a RelGeo file")
  .argument("<file>", "path to the .yaml file")
  .action(async (file) => {
    try {
      const filePath = path.resolve(process.cwd(), file);
      if (!(await fs.pathExists(filePath))) {
        console.error(chalk.red(`Error: File not found: ${file}`));
        process.exit(1);
      }

      const content = await fs.readFile(filePath, "utf-8");
      // Use parseRelGeo in editor mode to get doc even if invalid
      const { parseRelGeo } = await import("relgeo-core");
      const doc = parseRelGeo(content, { mode: "editor" });

      console.log(chalk.blue(`\n--- File Info: ${path.basename(file)} ---`));
      console.log(`DSL Version: ${chalk.bold(String(doc.version ?? "0.5"))}`);
      
      console.log(chalk.yellow("\nParameters:"));
      if (doc.parameters && Object.keys(doc.parameters).length > 0) {
        for (const [key, p] of Object.entries<any>(doc.parameters)) {
          const type = typeof p === "object" ? p.type : "number";
          const def = typeof p === "object" ? p.default : p;
          console.log(`  - ${chalk.bold(key)} (${type}): Default = ${def}`);
        }
      } else {
        console.log("  (None)");
      }

      if (doc.profiles) {
        console.log(chalk.bold("\nProfiles:"));
        Object.entries(doc.profiles).forEach(([name, params]: any) => {
          console.log(`- ${chalk.cyan(name)}: ${Object.keys(params).join(", ")}`);
        });
      }

      if (doc.metaPresets && Object.keys(doc.metaPresets).length > 0) {
        console.log(chalk.bold("\nMeta Presets:"));
        Object.entries(doc.metaPresets).forEach(([name, preset]: any) => {
          console.log(`- ${chalk.cyan(name)}: ${Object.keys(preset).join(", ")}`);
        });
      } else if (doc.styles && Object.keys(doc.styles).length > 0) {
        console.log(chalk.bold("\nStyles (Alias):"));
        Object.entries(doc.styles).forEach(([name, preset]: any) => {
          console.log(`- ${chalk.cyan(name)}: ${Object.keys(preset).join(", ")}`);
        });
      }

      if (doc.components && Object.keys(doc.components).length > 0) {
        console.log(chalk.bold("\nComponents:"));
        Object.entries(doc.components).forEach(([id, comp]: any) => {
          const paramCount = comp.parameters ? Object.keys(comp.parameters).length : 0;
          const objCount = comp.objects ? Object.keys(comp.objects).length : 0;
          console.log(`- ${chalk.cyan(id)} (${paramCount} params, ${objCount} objects)`);
        });
      }

      if (doc.views && Object.keys(doc.views).length > 0) {
        console.log(chalk.bold("\nViews:"));
        Object.entries(doc.views).forEach(([id, view]: any) => {
          console.log(`- ${chalk.cyan(id)} (target: ${view.target})`);
        });
      }

      if (doc.sheets && Object.keys(doc.sheets).length > 0) {
        console.log(chalk.bold("\nSheets:"));
        Object.entries(doc.sheets).forEach(([id, sheet]: any) => {
          const viewCount = sheet.views ? sheet.views.length : 0;
          const sizeStr = Array.isArray(sheet.size) ? sheet.size.join("x") : sheet.size;
          console.log(`- ${chalk.cyan(id)} (size: ${sizeStr}, ${viewCount} views)`);
        });
      }

      console.log(chalk.bold("\nObjects:"));
      Object.entries(doc.objects).forEach(([id, obj]: any) => {
        console.log(`- ${chalk.cyan(id)} (${obj.type})`);
      });
      console.log("");
    } catch (error: any) {
      console.error(chalk.red("Error reading file:"), error.message);
      process.exit(1);
    }
  });

program
  .command("compile")
  .description("Compile a RelGeo YAML file to resolved geometry")
  .argument("<file>", "path to the .yaml file")
  .option("-o, --output <path>", "output path (defaults to stdout)")
  .option("-f, --format <format>", "output format (json, svg, graph)", "json")
  .option("-u, --unit <unit>", "target unit (px, mm, cm, m, deg, rad)", "px")
  .option("--profile <name>", "select a parameter profile from the file")
  .option("-p, --param <keyvalue...>", "override parameters (format: key=value)")
  .option("-s, --sheet <id>", "render a specific sheet (SVG format only)")
  .action(async (file, options) => {
    try {
      const filePath = path.resolve(process.cwd(), file);
      if (!(await fs.pathExists(filePath))) {
        console.error(chalk.red(`Error: File not found: ${file}`));
        process.exit(1);
      }

      const content = await fs.readFile(filePath, "utf-8");
      
      // Parse overrides
      const overrides: Record<string, string | number | boolean> = {};
      if (options.param) {
        options.param.forEach((pair: string) => {
          const [key, val] = pair.split("=");
          if (key && val) {
            overrides[key] = parseCliOverride(val);
          }
        });
      }

      console.error(chalk.blue(`Compiling ${file}...`));
      
      const scene = compileRelGeo(content, {
        targetUnit: options.unit as any,
        profile: options.profile,
        overrides,
      });

      let outputData = "";
      if (options.format === "svg") {
        outputData = renderToSVG(scene, { sheetId: options.sheet });
      } else if (options.format === "graph") {
        const doc = parseRelGeo(content, { mode: "editor" });
        const graph = getDependencyGraph(doc.objects);
        outputData = JSON.stringify(graph, null, 2);
      } else {
        outputData = JSON.stringify(scene, null, 2);
      }

      if (options.output) {
        const outputPath = path.resolve(process.cwd(), options.output);
        await fs.outputFile(outputPath, outputData);
        console.log(chalk.green(`Successfully compiled to ${options.output} (${options.format})`));
      } else {
        console.log(outputData);
      }
    } catch (error: any) {
      console.error(chalk.red("\nCompilation Failed:"));
      if (error.code) {
        console.error(chalk.yellow(`[${error.code}]`), error.message);
      } else {
        console.error(error.message);
      }
      
      if (error.objectId) {
        console.error(chalk.gray(`Object: ${error.objectId}`));
      }
      if (error.path) {
        console.error(chalk.gray(`Path: ${error.path}`));
      }
      
      process.exit(1);
    }
  });

program
  .command("check")
  .alias("validate")
  .description("Validate and resolve a RelGeo YAML file, reporting errors without producing output")
  .argument("<file>", "path to the .yaml file")
  .option("-u, --unit <unit>", "target unit (px, mm, cm, m, deg, rad)", "mm")
  .option("-p, --param <keyvalue...>", "override parameters (format: key=value)")
  .action(async (file, options) => {
    try {
      const filePath = path.resolve(process.cwd(), file);
      if (!(await fs.pathExists(filePath))) {
        console.error(chalk.red(`Error: File not found: ${file}`));
        process.exit(1);
      }

      const content = await fs.readFile(filePath, "utf-8");

      const overrides: Record<string, string | number | boolean> = {};
      if (options.param) {
        options.param.forEach((pair: string) => {
          const [key, val] = pair.split("=");
          if (key && val) overrides[key] = parseCliOverride(val);
        });
      }

      const scene = compileRelGeo(content, {
        targetUnit: options.unit as any,
        overrides,
      });

      const objCount = Object.keys(scene.objects).length;
      console.log(chalk.green(`✓ OK`) + chalk.gray(` — ${path.basename(file)} | ${objCount} objects resolved | unit: ${options.unit}`));

      // Print any warnings (objects that resolved to null)
      const nulls = Object.entries(scene.objects)
        .filter(([, v]: any) => v == null)
        .map(([k]) => k);
      if (nulls.length > 0) {
        console.warn(chalk.yellow(`⚠ ${nulls.length} object(s) resolved to null: ${nulls.join(", ")}`));
      }
    } catch (error: any) {
      console.error(chalk.red("\n✗ INVALID:"), path.basename(file));
      if (error.code) {
        console.error(chalk.yellow(`  [${error.code}]`), error.message);
      } else {
        console.error(`  ${error.message}`);
      }
      if (error.objectId) {
        console.error(chalk.gray(`  Object: ${error.objectId}`));
      }
      process.exit(1);
    }
  });

program.parse();
