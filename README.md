# RelGeo CLI

Command-line interface for the **RelGeo** relation-first geometry runtime. This tool allows you to validate and compile RelGeo YAML documents into resolved geometry JSON or SVG from your terminal.

## Versioning

The CLI package metadata version is currently `0.4.0`, while the active RelGeo DSL contract is `v0.5`. These are separate versioning systems: the CLI package number identifies the package release metadata, and the DSL version identifies the language contract accepted by the toolchain.

For package-owned docs that should grow closer to this package over time, see `docs/README.md`.

CLI ini mengikuti kontrak bahasa aktif repo saat ini, yaitu `RelGeo DSL v0.5`.

Secara konseptual, CLI ini bekerja pada dokumen gambar vektor deklaratif yang ditulis sebagai source, lalu meneruskannya ke pipeline parse, validate, resolve, dan render.

Status packaging saat ini:

* CLI ini adalah command surface utama RelGeo
* jalur konsumsi yang paling sehat saat ini masih melalui monorepo ini
* packaging registry atau distribusi terpisah perlu diperlakukan sebagai langkah publish tersendiri

Pakai package ini jika Anda ingin:

* memvalidasi dokumen RelGeo dari terminal
* mengompilasi ke JSON, SVG, atau graph tanpa membuka UI
* memasukkan RelGeo ke workflow shell atau CI ringan

Jika yang Anda butuhkan berbeda:

* gunakan `relgeo-core` untuk integrasi runtime di kode
* gunakan `relgeo-renderer-svg` bila Anda sudah punya resolved scene dan hanya ingin output SVG
* gunakan `relgeo-playground` untuk workflow interaktif di browser

## Installation

Within the monorepo:

```bash
pnpm install
```

## Usage

### Inspect File Info
Show available parameters, profiles, metadata presets, and document structure in a RelGeo file.

```bash
pnpm relgeo info path/to/design.yaml
```

### Compile to JSON (Default)
Compiles a RelGeo YAML file and prints the resolved geometry JSON to stdout.

```bash
pnpm relgeo compile path/to/design.yaml
```

### Compile with Profile
Select a predefined profile from the YAML file.

```bash
pnpm relgeo compile design.yaml --profile kecil
```

### Compile with Parameter Overrides
Override specific parameters manually. Nilai override tidak dibatasi angka saja; length/string/boolean yang sah di surface bahasa aktif juga bisa dikirim.

```bash
pnpm relgeo compile design.yaml -p lebarRumah=2000 -p tinggiRumah=1200
pnpm relgeo compile design.yaml -p width=200mm -p inspectable=true
```

### Compile to SVG
Generates SVG markup for the design.

```bash
pnpm relgeo compile design.yaml -f svg
```

### Compile Dependency Graph JSON
Emits the dependency graph instead of resolved scene geometry.

```bash
pnpm relgeo compile design.yaml -f graph
```

### Compile a Specific Sheet to SVG
Select a sheet when the document defines `sheets:`.

```bash
pnpm relgeo compile design.yaml -f svg --sheet A4-01
```

### Validate Without Producing Output
Checks the document and exits with status suitable for CI.

```bash
pnpm relgeo check design.yaml
pnpm relgeo validate design.yaml
```

### Save to File
You can save the output (JSON or SVG) to a specific file.

```bash
pnpm relgeo compile design.yaml -o output.json
pnpm relgeo compile design.yaml -f svg -o output.svg
```

### Specify Target Unit
```bash
pnpm relgeo compile design.yaml -u mm
```

## Commands

### `info <file>`
Displays:
- **Parameters**: Name, type, and default value.
- **Profiles**: List of available profiles and the keys they modify.
- **Meta Presets**: Reusable metadata bundles (`metaPresets`, dengan `styles` sebagai alias kompatibilitas).
- **DSL Version**: Nilai `version` dokumen aktif.

### `compile <file>`
Processes the input YAML file through the active RelGeo pipeline:
1. **Parsing**: Validates YAML structure.
2. **Validation**: Checks for semantic errors.
3. **Resolution**: Calculates all coordinates and parametric values.
4. **Bounding Box**: Calculates the final global scene bounds.

### `check <file>`
Validates and resolves a RelGeo file without emitting JSON/SVG output.

## Options
- `-o, --output <path>`: Path to save the output.
- `-f, --format <format>`: Output format (`json`, `svg`, or `graph`). Default is `json`.
- `-u, --unit <unit>`: Target unit for resolution (default: `px`).
- `--profile <name>`: Select a profile defined in the YAML.
- `-p, --param <key=value...>`: Override parameters manually.
- `-s, --sheet <id>`: Target sheet for SVG rendering.

## Development

Run CLI smoke tests:

```bash
pnpm test
```

To run the CLI during development without building:

```bash
# From the CLI repository
pnpm tsx src/index.ts compile path/to/01_fundamentals.yaml
```
