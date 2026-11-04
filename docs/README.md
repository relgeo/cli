# @relgeo/cli Docs

Status dokumen: `Active Package Docs`

Dokumen ini adalah rumah awal untuk dokumentasi package `@relgeo/cli`.

Website docs boleh memberi pengantar atau entry surface, tetapi dokumentasi yang lebih dekat ke perilaku package sebaiknya hidup di sini, berdampingan dengan source package-nya.

---

## 1. Peran Package

`@relgeo/cli` adalah surface terminal utama RelGeo.

Package ini digunakan ketika pengguna ingin:

1. memvalidasi dokumen RelGeo dari shell
2. mengompilasi dokumen menjadi JSON, SVG, atau graph
3. memasukkan RelGeo ke workflow shell atau CI ringan
4. bekerja tanpa membuka UI browser

CLI ini mengikuti kontrak bahasa aktif repo saat ini, yaitu `RelGeo DSL v0.5`.

---

## 2. Positioning

Gunakan `@relgeo/cli` jika kebutuhan Anda adalah:

1. automation
2. command-line workflow
3. compile atau validate tanpa UI

Jika kebutuhan Anda berbeda:

1. gunakan `relgeo-playground` untuk workflow interaktif berbasis browser
2. gunakan `@relgeo/core` untuk integrasi runtime langsung di kode
3. gunakan `@relgeo/renderer-svg` bila Anda sudah punya resolved scene dan hanya ingin output SVG

---

## 3. Bentuk Surface Saat Ini

Pada snapshot repo aktif saat ini:

1. package ini adalah command surface utama RelGeo
2. jalur konsumsi paling sehat masih melalui monorepo ini
3. packaging registry atau distribusi terpisah tetap diperlakukan sebagai langkah publish tersendiri

---

## 4. Command Summary

### `info <file>`

Digunakan untuk membaca struktur dokumen.

Surface ini menampilkan hal-hal seperti:

1. parameters
2. profiles
3. meta presets
4. version dokumen aktif

Contoh:

```bash
pnpm relgeo info path/to/design.yaml
```

### `compile <file>`

Digunakan untuk mengompilasi source RelGeo melalui pipeline aktif:

1. parsing
2. validation
3. resolution
4. output generation

Contoh:

```bash
pnpm relgeo compile path/to/design.yaml
pnpm relgeo compile path/to/design.yaml -f svg
pnpm relgeo compile path/to/design.yaml -f graph
```

File-taking commands accept `-` as stdin for pipeline use:

```bash
cat design.yaml | pnpm relgeo compile - --format json
```

An explicit path takes precedence over stdin. Empty input and read failures are
reported as non-zero input errors.

The input may be omitted when configuration supplies `input`. A literal `-`
always means stdin. The CLI never reads stdin as a fallback when an explicit
path is present. Source files and stdin are decoded as strict UTF-8; empty
sources and invalid UTF-8 are input failures.

### `check <file>`

Digunakan untuk memvalidasi dan resolve dokumen tanpa menghasilkan output final.

Contoh:

```bash
pnpm relgeo check path/to/design.yaml
pnpm relgeo validate path/to/design.yaml
```

### `init [path]`

Creates a minimal valid RelGeo v0.5 starter document. The default destination
is `relgeo.yaml`. Existing files are protected; use `--force` (or
`--overwrite`) to replace one. The generated file is written as UTF-8.

### `open [file]`

Selects and inspects an existing document without launching an editor. It is a
named alias for the CLI inspection workflow and follows the same path/stdin and
config-input rules as `info`.

---

## 5. Option Summary

Option penting yang saat ini tersedia:

1. `-o, --output <path>` untuk menyimpan output
2. `-f, --format <format>` untuk memilih `json`, `svg`, atau `graph`
3. `-u, --unit <unit>` untuk target unit
4. `--profile <name>` untuk memilih profile dokumen
5. `-p, --param <key=value...>` untuk parameter override
6. `-s, --sheet <id>` untuk memilih sheet target saat export SVG
7. `--view <id>` untuk memilih view di dalam sheet saat export SVG
8. `--diagnostics <mode>` untuk memilih `human` atau `json`
9. `--no-color` untuk mematikan styling terminal
10. `--config <path>` untuk memilih config JSON secara eksplisit
11. `--no-config` untuk menonaktifkan config file dan config environment
12. `--overwrite` / `--no-overwrite` untuk mengontrol penimpaan output

Target unit yang didukung adalah `px`, `mm`, `cm`, `m`, dan `in`. Format,
profile, unit, parameter, dan selector yang tidak dikenal ditolak sebelum
pipeline compile berjalan.

Contoh:

```bash
pnpm relgeo compile design.yaml -p width=200mm -p inspectable=true
pnpm relgeo compile design.yaml -f svg --sheet A4-01 --view front -o output.svg
```

Output JSON/SVG/graph tanpa `--output` hanya ditulis ke stdout. Dengan
`--output`, parent directory dibuat bila perlu dan pesan sukses ditulis ke
stderr.

Output file selalu UTF-8 dan ditulis melalui file sementara lalu rename. Default
compile mengizinkan overwrite agar kompatibel dengan workflow yang sudah ada;
`--no-overwrite` mengubah existing-target menjadi exit code `5` tanpa pesan
sukses atau artefak parsial. `init` memakai kebijakan aman: tidak overwrite
kecuali `--force`/`--overwrite` diberikan.

Untuk automation, `--diagnostics json` menulis satu envelope JSON stabil ke
stderr dengan `version`, `source`, `exitCode`, `code`, `phase`, `severity`,
`message`, `path`, `objectId`, dan `range`. Exit code: `0` sukses, `2` usage,
`3` input, `4` validation/runtime/render, dan `5` output/write.

## 6. Config dan noninteractive contract

Config hanya berbentuk JSON object. Tanpa flag khusus, CLI membaca `.relgeo.json`
di current working directory. `--config <path>` atau `RELGEO_CONFIG` memilih
file lain; path relatif diselesaikan terhadap current working directory.

Precedence ditetapkan sebagai berikut (kanan menang): built-in defaults →
config file → `RELGEO_*` environment → command-line flags. `--no-config` atau
`RELGEO_NO_CONFIG=1` menonaktifkan config file. Supported config keys adalah
`input`, `output`, `format`, `unit`, `profile`, `param`, `sheet`,
`diagnostics`, `color`, dan `overwrite`. Environment equivalents are
`RELGEO_INPUT`, `RELGEO_OUTPUT`, `RELGEO_FORMAT`, `RELGEO_UNIT`,
`RELGEO_PROFILE`, `RELGEO_PARAM` (comma-separated), `RELGEO_SHEET`,
`RELGEO_VIEW`, `RELGEO_DIAGNOSTICS`, dan `RELGEO_OVERWRITE`.

`NO_COLOR=1`, `RELGEO_NO_COLOR=1`, dan any truthy `CI` value disable styling;
CI also suppresses progress messages. `--no-color` is the explicit CLI form.
stdout remains reserved for requested data; human progress and diagnostics use
stderr, while `--diagnostics json` emits one JSON envelope on stderr for a
failure.

Document `watch`/rebuild, daemon, dan JSON-RPC modes are intentionally outside
this one-shot CLI contract. The package does not watch source/config files or
keep a rebuild session alive; adding that lifecycle requires a separate scope
decision covering debounce, recovery, shutdown, and stream behavior.

---

## 7. Boundary Penting

`@relgeo/cli` bukan:

1. editor interaktif
2. pengganti `@relgeo/core` untuk integrasi runtime
3. pengganti documentation normatif language spec

CLI adalah surface operasional untuk terminal.

---

## 8. Development

Untuk smoke test:

```bash
pnpm test
```

Untuk menjalankan CLI selama development tanpa build final:

```bash
pnpm tsx src/index.ts compile ../playground/src/assets/examples/basics/01_fundamentals.yaml
```

---

## 9. Hubungan Dengan Website Docs

Halaman website docs untuk `CLI` sebaiknya dibaca sebagai:

1. entry surface
2. jalur onboarding singkat
3. pengarah ke package surface yang tepat

Sedangkan dokumen ini adalah rumah yang lebih dekat ke package itu sendiri.
