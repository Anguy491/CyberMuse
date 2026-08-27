import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const artifactRoot = join(repoRoot, "artifacts", "m4");
const resourceRoot = join(artifactRoot, "tauri-resources");
const manifestPath = join(resourceRoot, "runtime-manifest.json");
const dependencies = JSON.parse(
  readFileSync(join(repoRoot, "docs", "quality", "dependencies.json"), "utf8"),
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function fail(message) {
  throw new Error(`M4_SUPPLY_CHAIN_FAILED: ${message}`);
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(digest.digest("hex")));
  });
}

async function assertArtifact(label, path, sizeBytes, expectedSha256) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`${label} is missing`);
  }
  const size = statSync(path).size;
  if (size !== sizeBytes) {
    fail(`${label} size is ${size}, expected ${sizeBytes}`);
  }
  const actualSha256 = await sha256(path);
  if (actualSha256 !== expectedSha256) {
    fail(`${label} SHA-256 mismatch`);
  }
  return { label, sizeBytes: size, sha256: actualSha256 };
}

execFileSync(
  process.execPath,
  [join(repoRoot, "tooling", "check-licenses.mjs")],
  {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  },
);

if (
  dependencies.schemaVersion !== 1 ||
  !["M5", "M6"].includes(dependencies.milestone)
) {
  fail("dependency review is not a compatible schemaVersion 1 inventory");
}
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
  fail("runtime manifest schema is invalid");
}

const runtimeFiles = new Map();
let runtimeBytes = 0;
for (const file of manifest.files) {
  if (runtimeFiles.has(file.relativePath)) {
    fail(`duplicate runtime path ${file.relativePath}`);
  }
  if (
    typeof file.relativePath !== "string" ||
    file.relativePath.includes("..") ||
    file.relativePath.startsWith("/") ||
    typeof file.sizeBytes !== "number" ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  ) {
    fail("malformed runtime manifest entry");
  }
  const path = join(resourceRoot, ...file.relativePath.split("/"));
  const verified = await assertArtifact(
    `runtime:${file.relativePath}`,
    path,
    file.sizeBytes,
    file.sha256,
  );
  runtimeFiles.set(file.relativePath, verified);
  runtimeBytes += verified.sizeBytes;
}

for (const forbiddenRoot of [
  "spleeter",
  "tensorflow",
  "scipy",
  "jax",
  "jaxlib",
  "norbert",
  "httpx",
  "cryptography",
]) {
  const prefix = `analyzer/_internal/${forbiddenRoot}`.toLowerCase();
  if (
    [...runtimeFiles.keys()].some((path) =>
      path.toLowerCase().startsWith(prefix),
    )
  ) {
    fail(`excluded dependency leaked into runtime: ${forbiddenRoot}`);
  }
}

const requiredRuntimeHashes = new Map([
  [
    "ffmpeg/ffmpeg.exe",
    "f4326d7a480fb9e81a34440e775a70ebcf263a0c5fbc45678ffc594a9a7eccf3",
  ],
  [
    "ffmpeg/ffprobe.exe",
    "1c9b4e13cdc83bf7a4e2f40a69716a62eddc6810a7a6abaacbc568ffaf77c8e9",
  ],
  [
    "analyzer/_internal/msvcp140.dll",
    "7c26614e1d733892c2deac7e245ce115504b1d80592dd0a01b08e3e5a55f89ca",
  ],
  [
    "analyzer/_internal/msvcp140_1.dll",
    "206c931bf90fdad8816de3b5e2ef80b2bcaa9406c89ecc05fe6fddffe251e982",
  ],
  [
    "analyzer/_internal/vcruntime140.dll",
    "d1f4225df2cd877dbf130d5668a021dce3f94118455ff5ec952061c30afc9ce7",
  ],
  [
    "analyzer/_internal/vcruntime140_1.dll",
    "a7146c08f89fe5b04541ab507cdb59ff7b44534d4ba3c668a426c6450a03434e",
  ],
]);
for (const [relativePath, expectedSha256] of requiredRuntimeHashes) {
  if (runtimeFiles.get(relativePath)?.sha256 !== expectedSha256) {
    fail(`unapproved critical runtime ${relativePath}`);
  }
}

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  fail("LOCALAPPDATA is unavailable");
}
const modelRoot = join(localAppData, "CyberMuse", "models");
const approvedArtifacts = [
  await assertArtifact(
    "model:demucs-htdemucs@spectral-v1.0.0",
    join(
      modelRoot,
      "demucs-htdemucs",
      "spectral-v1.0.0",
      "htdemucs.spectral.onnx",
    ),
    209_469_333,
    "c3395410b1319976683bc874d97461655a9ea6089bbb0f3bd163d3829db13d02",
  ),
  await assertArtifact(
    "model:swiftf0@0.1.2",
    join(modelRoot, "swiftf0", "0.1.2", "swift_f0-0.1.2-py3-none-any.whl"),
    379_040,
    "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717",
  ),
  await assertArtifact(
    "tool:ffmpeg-lgpl-shared@n9.0.1-6-g9d4ca21220",
    join(
      localAppData,
      "CyberMuse",
      "tools",
      "ffmpeg-lgpl-shared",
      "n9.0.1-6-g9d4ca21220",
      "ffmpeg-lgpl-shared.zip",
    ),
    67_200_663,
    "f551da3fa645a2399b5e7422ffb07e05abfdb8b05e36fb7f7877a5ced8891267",
  ),
];

const ffmpegOutput = execFileSync(
  join(resourceRoot, "ffmpeg", "ffmpeg.exe"),
  ["-version"],
  {
    cwd: join(resourceRoot, "ffmpeg"),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  },
);
const configuration = ffmpegOutput
  .split(/\r?\n/u)
  .find((line) => line.startsWith("configuration:"));
if (
  !ffmpegOutput.includes("ffmpeg version n9.0.1-6-g9d4ca21220") ||
  !configuration?.includes("--enable-shared") ||
  configuration.includes("--enable-gpl") ||
  configuration.includes("--enable-nonfree")
) {
  fail("FFmpeg build flags are not the approved LGPL shared configuration");
}

const report = {
  schemaVersion: 1,
  testCase: "TC-SUP-001",
  generatedAt: new Date().toISOString(),
  status: "passed",
  dependencyInventory: {
    milestone: dependencies.milestone,
    reviewedDirectDependencies: dependencies.directDependencies.length,
    reviewedTransitiveExceptions: dependencies.transitiveExceptions.length,
    reviewedPythonLicenseExceptions:
      dependencies.pythonLicenseExceptions.length,
  },
  runtime: {
    manifestFiles: runtimeFiles.size,
    manifestPayloadBytes: runtimeBytes,
    analyzer: runtimeFiles.get("analyzer/cybermuse-analyzer.exe"),
    ffmpegConfiguration: configuration,
    vcRuntimeVersion: "14.51.36247.0",
    excludedFromDistribution: [
      "scipy",
      "jax",
      "jaxlib",
      "norbert",
      "httpx",
      "cryptography",
      "spleeter",
      "tensorflow",
    ],
  },
  approvedArtifacts,
  modelLicenses: [
    {
      modelId: "demucs-htdemucs",
      version: "spectral-v1.0.0",
      license: "MIT",
    },
    { modelId: "swiftf0", version: "0.1.2", license: "MIT" },
  ],
  rejectedCandidates: [
    {
      candidate: "Spleeter 2stems / TensorFlow sidecar",
      reason: "superseded by ADR-021 after a collapsed real-song cache case",
    },
    {
      candidate: "python-audio-separator runtime wrapper",
      reason:
        "dynamic model discovery/download behavior exceeds the approved network surface",
    },
  ],
  networkBoundary:
    "Only the Rust model manager may access the network after exact user consent; packaged analyzer and installed-model runs are network-free.",
};

mkdirSync(artifactRoot, { recursive: true });
writeFileSync(
  join(artifactRoot, "supply-chain.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
console.log(
  `M4 supply chain: PASS (${runtimeFiles.size} runtime files, ${runtimeBytes} bytes)`,
);
