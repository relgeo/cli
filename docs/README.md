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

### `check <file>`

Digunakan untuk memvalidasi dan resolve dokumen tanpa menghasilkan output final.

Contoh:

```bash
pnpm relgeo check path/to/design.yaml
pnpm relgeo validate path/to/design.yaml
```

---

## 5. Option Summary

Option penting yang saat ini tersedia:

1. `-o, --output <path>` untuk menyimpan output
2. `-f, --format <format>` untuk memilih `json`, `svg`, atau `graph`
3. `-u, --unit <unit>` untuk target unit
4. `--profile <name>` untuk memilih profile dokumen
5. `-p, --param <key=value...>` untuk parameter override
6. `-s, --sheet <id>` untuk memilih sheet target saat export SVG

Contoh:

```bash
pnpm relgeo compile design.yaml -p width=200mm -p inspectable=true
pnpm relgeo compile design.yaml -f svg --sheet A4-01 -o output.svg
```

---

## 6. Boundary Penting

`@relgeo/cli` bukan:

1. editor interaktif
2. pengganti `@relgeo/core` untuk integrasi runtime
3. pengganti documentation normatif language spec

CLI adalah surface operasional untuk terminal.

---

## 7. Development

Untuk smoke test:

```bash
pnpm test
```

Untuk menjalankan CLI selama development tanpa build final:

```bash
pnpm tsx src/index.ts compile ../playground/src/assets/examples/basics/01_fundamentals.yaml
```

---

## 8. Hubungan Dengan Website Docs

Halaman website docs untuk `CLI` sebaiknya dibaca sebagai:

1. entry surface
2. jalur onboarding singkat
3. pengarah ke package surface yang tepat

Sedangkan dokumen ini adalah rumah yang lebih dekat ke package itu sendiri.
