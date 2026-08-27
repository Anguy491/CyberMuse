import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const outputRoot = join(repoRoot, "artifacts", "m6");
const resourceRoot = join(repoRoot, "artifacts", "m4", "tauri-resources");
const inventory = JSON.parse(
  readFileSync(join(repoRoot, "docs", "quality", "dependencies.json"), "utf8"),
);
const finalize = process.argv.includes("--finalize");

function fail(message) {
  throw new Error(`M6_RELEASE_ASSETS_FAILED: ${message}`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  const digest = createHash("sha256");
  digest.update(readFileSync(path));
  return digest.digest("hex");
}

function walk(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files.sort();
}

function command(name) {
  if (process.platform !== "win32") return name;
  if (name !== "cargo") return process.env.ComSpec ?? "cmd.exe";
  const installed = join(
    process.env.USERPROFILE ?? "",
    ".cargo",
    "bin",
    "cargo.exe",
  );
  return existsSync(installed) ? installed : "cargo.exe";
}

function pnpm(args) {
  if (process.platform === "win32") {
    return run(command("pnpm"), ["/d", "/s", "/c", `pnpm ${args.join(" ")}`]);
  }
  return run("pnpm", args);
}

run(process.execPath, [join(repoRoot, "tooling", "check-licenses.mjs")]);
if (inventory.schemaVersion !== 1 || inventory.milestone !== "M6") {
  fail("docs/quality/dependencies.json is not the M6 schemaVersion 1 review");
}
if (!existsSync(resourceRoot)) {
  fail(
    "M4 frozen runtime resources are missing; run pnpm build:analyzer first",
  );
}

const npmLicenseGroups = JSON.parse(
  pnpm(["licenses", "list", "--json", "--prod"]),
);
const npmPackages = Object.entries(npmLicenseGroups).flatMap(
  ([expression, packages]) =>
    packages.flatMap((item) =>
      item.versions.map((version) => ({
        ecosystem: "npm",
        name: item.name,
        version,
        license: expression,
        downloadLocation: item.homepage ?? "NOASSERTION",
        sourceDirectory: item.paths[0],
      })),
    ),
);

const cargoMetadata = JSON.parse(
  run(command("cargo"), [
    "metadata",
    "--format-version",
    "1",
    "--locked",
    "--filter-platform",
    "x86_64-pc-windows-msvc",
  ]),
);
const resolvedCargoIds = new Set(
  cargoMetadata.resolve.nodes.map((node) => node.id),
);
const cargoPackages = cargoMetadata.packages
  .filter((item) => resolvedCargoIds.has(item.id) && item.source !== null)
  .map((item) => ({
    ecosystem: "cargo",
    name: item.name,
    version: item.version,
    license: item.license ?? "NOASSERTION",
    downloadLocation: item.repository ?? item.source ?? "NOASSERTION",
    sourceDirectory: dirname(item.manifest_path),
    licenseFile:
      item.license_file === null
        ? null
        : resolve(dirname(item.manifest_path), item.license_file),
  }));

function header(metadata, name) {
  const match = metadata.match(new RegExp(`^${name}:\\s*(.+)$`, "imu"));
  return match?.[1]?.trim() ?? null;
}

const pythonPackages = walk(resourceRoot)
  .filter(
    (path) =>
      basename(path).toLowerCase() === "metadata" &&
      basename(dirname(path)).toLowerCase().endsWith(".dist-info"),
  )
  .map((path) => {
    const metadata = readFileSync(path, "utf8");
    return {
      ecosystem: "python",
      name: header(metadata, "Name") ?? basename(dirname(path)),
      version: header(metadata, "Version") ?? "NOASSERTION",
      license:
        header(metadata, "License-Expression") ??
        header(metadata, "License") ??
        "NOASSERTION",
      downloadLocation:
        header(metadata, "Project-URL")?.split(",").slice(1).join(",").trim() ??
        header(metadata, "Home-page") ??
        "NOASSERTION",
    };
  });

const uniquePackages = new Map();
for (const item of [...npmPackages, ...cargoPackages, ...pythonPackages]) {
  uniquePackages.set(`${item.ecosystem}:${item.name}@${item.version}`, item);
}
for (const item of inventory.directDependencies.filter((dependency) =>
  ["binary", "runtime", "model", "tool"].includes(dependency.ecosystem),
)) {
  uniquePackages.set(`${item.ecosystem}:${item.name}@${item.version}`, {
    ecosystem: item.ecosystem,
    name: item.name,
    version: item.version,
    license: item.license,
    downloadLocation: item.artifactUrl,
  });
}

function spdxId(item) {
  const safe = `${item.ecosystem}-${item.name}-${item.version}`.replace(
    /[^A-Za-z0-9.-]/gu,
    "-",
  );
  return `SPDXRef-Package-${safe}-${sha256Text(`${item.ecosystem}:${item.name}@${item.version}`).slice(0, 10)}`;
}

function declaredLicense(expression) {
  if (
    expression === "NOASSERTION" ||
    expression.length > 180 ||
    /\bfor\b|;|…|\bWITH\s+PyInstaller/iu.test(expression)
  ) {
    return "NOASSERTION";
  }
  return expression;
}

const packageList = [...uniquePackages.values()].sort((a, b) =>
  `${a.ecosystem}:${a.name}@${a.version}`.localeCompare(
    `${b.ecosystem}:${b.name}@${b.version}`,
  ),
);
const packageFingerprint = sha256Text(
  packageList
    .map(
      (item) =>
        `${item.ecosystem}:${item.name}@${item.version}:${item.license}`,
    )
    .join("\n"),
);
const appSpdxId = "SPDXRef-Package-CyberMuse";
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "CyberMuse-0.1.0-Windows-x64",
  documentNamespace: `https://spdx.org/spdxdocs/cybermuse-0.1.0-${packageFingerprint}`,
  creationInfo: {
    created: new Date().toISOString(),
    creators: ["Tool: CyberMuse m6-release-assets"],
  },
  packages: [
    {
      SPDXID: appSpdxId,
      name: "CyberMuse",
      versionInfo: "0.1.0",
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
      primaryPackagePurpose: "APPLICATION",
    },
    ...packageList.map((item) => ({
      SPDXID: spdxId(item),
      name: item.name,
      versionInfo: item.version,
      downloadLocation: item.downloadLocation ?? "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: declaredLicense(item.license),
      licenseComments: `Reviewed metadata: ${item.license}`,
      copyrightText: "NOASSERTION",
      primaryPackagePurpose: item.ecosystem === "tool" ? "OTHER" : "LIBRARY",
    })),
  ],
  relationships: [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: appSpdxId,
    },
    ...packageList.map((item) => ({
      spdxElementId: appSpdxId,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: spdxId(item),
    })),
  ],
};

const noticeGroups = new Map();
function addNotice(packageName, source, text) {
  const normalized = text.replace(/\r\n/gu, "\n").trim();
  if (normalized.length === 0 || normalized.includes("\0")) return;
  const digest = sha256Text(normalized);
  const group = noticeGroups.get(digest) ?? {
    packages: new Set(),
    sources: new Set(),
    text: normalized,
  };
  group.packages.add(packageName);
  group.sources.add(source);
  noticeGroups.set(digest, group);
}

function isNoticeFile(path) {
  return /^(license|licence|copying|notice|copyright)([._-].*)?$/iu.test(
    basename(path),
  );
}

function collectNoticeFiles(packageName, label, directory, recursive = false) {
  if (directory === undefined || !existsSync(directory)) return;
  const candidates = recursive
    ? walk(directory)
    : readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(directory, entry.name));
  for (const path of candidates.filter(isNoticeFile)) {
    if (statSync(path).size > 2 * 1024 * 1024) continue;
    addNotice(
      packageName,
      `${label}/${basename(path)}`,
      readFileSync(path, "utf8"),
    );
  }
}

for (const item of npmPackages) {
  collectNoticeFiles(
    `${item.name}@${item.version}`,
    `npm:${item.name}@${item.version}`,
    item.sourceDirectory,
  );
}
for (const item of cargoPackages) {
  collectNoticeFiles(
    `${item.name}@${item.version}`,
    `cargo:${item.name}@${item.version}`,
    item.sourceDirectory,
  );
  if (item.licenseFile !== null && existsSync(item.licenseFile)) {
    addNotice(
      `${item.name}@${item.version}`,
      `cargo:${item.name}@${item.version}/${basename(item.licenseFile)}`,
      readFileSync(item.licenseFile, "utf8"),
    );
  }
}
collectNoticeFiles(
  "frozen Python and FFmpeg runtime",
  "runtime",
  resourceRoot,
  true,
);

addNotice(
  "NSIS@3.11 distributed zlib stub",
  "reviewed:NSIS-3.11/COPYING-zlib-section",
  `Copyright (C) 1999-2025 Contributors

This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software.

Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`,
);
addNotice(
  "nsis-tauri-utils@0.5.3",
  "reviewed:tauri-apps/nsis-tauri-utils/LICENSE_MIT",
  `MIT License

Copyright (c) 2022 Tauri Programme within The Commons Conservancy

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
);
addNotice(
  "OpenKara HTDemucs spectral-core@spectral-v1.0.0",
  "reviewed:thedavidweng/openkara-models/infra-2026-08-12-001/LICENSE+NOTICE",
  `OpenKara Models — release 2026-08-12-001
Copyright (c) 2026 Davy

Third-party model weights are derived from Demucs by Alexandre Défossez
(https://github.com/adefossez/demucs), released under the MIT License.

Producer:
  repo:      thedavidweng/openkara-models
  commit:    98a1aeb245894337f48b67a907951d2770e22405
  workflow:  ort-publish.yml
  run_id:    31670494161

MIT License

Copyright (c) 2026 Davy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
);

const packageIndex = packageList
  .map(
    (item) =>
      `- ${item.ecosystem}:${item.name}@${item.version} — ${item.license}`,
  )
  .join("\n");
const noticeSections = [...noticeGroups.entries()]
  .sort(([, a], [, b]) =>
    [...a.packages].join(",").localeCompare([...b.packages].join(",")),
  )
  .map(
    ([digest, group]) =>
      `================================================================================\nPACKAGES: ${[...group.packages].sort().join(", ")}\nSOURCES: ${[...group.sources].sort().join(", ")}\nTEXT SHA-256: ${digest}\n================================================================================\n${group.text}`,
  )
  .join("\n\n");
const notices = `CyberMuse 0.1.0 — THIRD-PARTY NOTICES

This file covers the exact production, frozen-runtime and Windows installer components recorded by the M6 dependency review. Identical license texts are deduplicated and attributed to every package that supplied them. Development-only tools may appear in the SPDX SBOM but are not represented as shipped application code.

PACKAGE AND LICENSE INDEX
${packageIndex}

LICENSE AND NOTICE TEXTS
${noticeSections}
`;
for (const forbidden of [
  repoRoot,
  process.env.USERPROFILE,
  process.env.LOCALAPPDATA,
]) {
  if (
    forbidden !== undefined &&
    notices.toLowerCase().includes(forbidden.toLowerCase())
  ) {
    fail("generated notices contain an absolute local path");
  }
}

const modelManifest = {
  schemaVersion: 1,
  applicationVersion: "0.1.0",
  generatedAt: new Date().toISOString(),
  networkPolicy:
    "Each exact model is downloaded only after user consent, verified by SHA-256 and then used offline.",
  models: inventory.directDependencies
    .filter((item) => item.ecosystem === "model")
    .map((item) => ({
      modelId:
        item.name === "OpenKara HTDemucs spectral-core"
          ? "demucs-htdemucs"
          : "swiftf0",
      version: item.version,
      sourceUrl: item.artifactUrl,
      sha256: item.artifactSha256,
      sizeBytes: item.sizeBytes,
      license: item.license,
      decision: item.decision,
    })),
};

mkdirSync(outputRoot, { recursive: true });
const supplyAssetPaths = [
  join(outputRoot, "cybermuse-0.1.0.spdx.json"),
  join(outputRoot, "THIRD_PARTY_NOTICES.txt"),
  join(outputRoot, "model-manifest.json"),
];
if (finalize) {
  for (const path of supplyAssetPaths) {
    if (!existsSync(path)) {
      fail(`--finalize requires the pre-bundle asset ${basename(path)}`);
    }
  }
} else {
  writeFileSync(
    supplyAssetPaths[0],
    `${JSON.stringify(sbom, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(supplyAssetPaths[1], notices.replace(/\n/gu, "\r\n"), "utf8");
  writeFileSync(
    supplyAssetPaths[2],
    `${JSON.stringify(modelManifest, null, 2)}\n`,
    "utf8",
  );
}

const releaseCandidates = [
  join(repoRoot, "target", "release", "cybermuse-desktop.exe"),
  join(outputRoot, "cybermuse-0.1.0.spdx.json"),
  join(outputRoot, "THIRD_PARTY_NOTICES.txt"),
  join(outputRoot, "model-manifest.json"),
  ...walk(join(repoRoot, "target", "release", "bundle", "nsis")).filter(
    (path) => path.toLowerCase().endsWith(".exe"),
  ),
];
if (finalize && !releaseCandidates.some((path) => /setup\.exe$/iu.test(path))) {
  fail("--finalize requires a generated NSIS setup.exe");
}
const gitCommit = run("git", ["rev-parse", "HEAD"]).trim();
const gitStatus = run("git", ["status", "--porcelain=v1"]).trim();
const releaseManifest = {
  schemaVersion: 1,
  applicationVersion: "0.1.0",
  generatedAt: new Date().toISOString(),
  target: "x86_64-pc-windows-msvc",
  installerType: "NSIS currentUser zlib",
  signed: false,
  commit: gitCommit,
  dirtyWorktree: gitStatus.length > 0,
  cleanHostGateSatisfied: false,
  distributionAllowed: false,
  artifacts: releaseCandidates
    .filter((path) => existsSync(path))
    .map((path) => ({
      relativePath: relative(repoRoot, path).replaceAll("\\", "/"),
      sizeBytes: statSync(path).size,
      sha256: sha256File(path),
    })),
};
writeFileSync(
  join(outputRoot, "release-manifest.json"),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
  "utf8",
);

console.log(
  `M6 release assets: PASS (${packageList.length} packages, ${noticeGroups.size} notice texts, finalize=${finalize})`,
);
