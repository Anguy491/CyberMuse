import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const inventory = JSON.parse(
  readFileSync("docs/quality/dependencies.json", "utf8"),
);

const requiredFields = [
  "ecosystem",
  "name",
  "version",
  "scope",
  "license",
  "purpose",
  "owningModule",
  "sourceRepository",
  "artifactUrl",
  "distributionForm",
  "alternativesConsidered",
];

const approvedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
]);

function fail(message) {
  throw new Error(`LICENSE_CHECK_FAILED: ${message}`);
}

function packageKey(ecosystem, name, version) {
  return `${ecosystem}:${name}@${version}`;
}

const directKeys = new Set();
for (const dependency of inventory.directDependencies) {
  for (const field of requiredFields) {
    if (
      typeof dependency[field] !== "string" ||
      dependency[field].length === 0
    ) {
      fail(`${dependency.name ?? "unknown"} is missing ${field}`);
    }
  }
  const key = packageKey(
    dependency.ecosystem,
    dependency.name,
    dependency.version,
  );
  if (directKeys.has(key)) {
    fail(`duplicate direct record ${key}`);
  }
  directKeys.add(key);
}

function assertNpmManifest(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (String(version).startsWith("workspace:")) {
        continue;
      }
      if (!directKeys.has(packageKey("npm", name, String(version)))) {
        fail(`missing npm review for ${name}@${version}`);
      }
    }
  }
}

assertNpmManifest("package.json");
assertNpmManifest("apps/desktop/package.json");
assertNpmManifest("packages/audio/package.json");

const npmLicenses = JSON.parse(
  process.platform === "win32"
    ? execFileSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", "pnpm licenses list --json --prod"],
        { encoding: "utf8" },
      )
    : execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], {
        encoding: "utf8",
      }),
);

for (const expression of Object.keys(npmLicenses)) {
  if (/AGPL|GPL|SSPL|UNKNOWN|UNLICENSED/i.test(expression)) {
    fail(`forbidden npm production license ${expression}`);
  }
}

const cargoToml = readFileSync("apps/desktop/src-tauri/Cargo.toml", "utf8");
for (const name of [
  "tauri-build",
  "tauri",
  "serde",
  "serde_json",
  "windows-sys",
]) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cargoToml.match(
    new RegExp(
      `^${escapedName}\\s*=\\s*(?:"=([^"]+)"|\\{[^\\n]*version\\s*=\\s*"=([^"]+)")`,
      "m",
    ),
  );
  const version = match?.[1] ?? match?.[2];
  if (version === undefined) {
    fail(`cannot read exact Cargo version for ${name}`);
  }
  if (!directKeys.has(packageKey("cargo", name, version))) {
    fail(`missing Cargo review for ${name}@${version}`);
  }
}

const cargoCommand = (() => {
  if (process.platform !== "win32") {
    return "cargo";
  }
  const userProfile = process.env.USERPROFILE;
  const installed =
    userProfile === undefined
      ? ""
      : join(userProfile, ".cargo", "bin", "cargo.exe");
  return existsSync(installed) ? installed : "cargo.exe";
})();

const cargoMetadata = JSON.parse(
  execFileSync(
    cargoCommand,
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--filter-platform",
      "x86_64-pc-windows-msvc",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  ),
);
const resolvedIds = new Set(cargoMetadata.resolve.nodes.map((node) => node.id));
const mplExceptions = new Set(
  inventory.transitiveExceptions
    .filter(
      (exception) =>
        exception.license === "MPL-2.0" && exception.decision === "approved",
    )
    .flatMap((exception) => exception.packages),
);

for (const dependency of cargoMetadata.packages) {
  if (!resolvedIds.has(dependency.id) || dependency.source === null) {
    continue;
  }
  const expression = dependency.license;
  if (typeof expression !== "string" || expression.length === 0) {
    fail(`unknown cargo license for ${dependency.name}@${dependency.version}`);
  }
  if (/AGPL|SSPL/i.test(expression)) {
    fail(`forbidden cargo license ${expression} for ${dependency.name}`);
  }
  const tokens = expression.match(/[A-Za-z0-9.-]+/g) ?? [];
  const licenseTokens = tokens.filter(
    (token) => !["AND", "OR", "WITH", "LLVM-exception"].includes(token),
  );
  for (const token of licenseTokens) {
    if (!approvedLicenses.has(token)) {
      fail(`unreviewed cargo license token ${token} for ${dependency.name}`);
    }
  }
  if (
    expression === "MPL-2.0" &&
    !mplExceptions.has(`${dependency.name}@${dependency.version}`)
  ) {
    fail(
      `MPL-2.0 package lacks an exact exception: ${dependency.name}@${dependency.version}`,
    );
  }
}

console.log(
  `License review passed: ${directKeys.size} direct records, ${resolvedIds.size} Windows Cargo packages.`,
);
