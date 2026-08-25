import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ContractError } from "./song";
import {
  parseAnalysisManifest,
  parseAnalyzerControl,
  parseAnalyzerProtocolMessage,
  parseAnalyzerProtocolTrace,
  parseAnalyzerRequest,
  parseModelCatalog,
  parseModelManifest,
  parseReferenceTrack,
  parseTauriAnalyzerPayloads,
} from "./analyzer";

const fixtureRoot = fileURLToPath(
  new URL("../../../fixtures/contracts/analyzer/", import.meta.url),
);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${fixtureRoot}${name}`, "utf8")) as unknown;
}

describe("TC-CON-001 analyzer schema compatibility", () => {
  it("accepts the current manifest and reference track", async () => {
    expect(
      parseAnalysisManifest(await fixture("analysis-manifest-v1-current.json"))
        .schemaVersion,
    ).toBe(1);
    expect(
      parseReferenceTrack(await fixture("reference-track-v1-current.json"))
        .frames,
    ).toHaveLength(3);
  });

  it("preserves additive fields in the current major", async () => {
    const manifest = parseAnalysisManifest(
      await fixture("analysis-manifest-v1-extra.json"),
    );
    expect(manifest.futureDiagnosticHint).toBe("local-only");
  });

  it("rejects an unknown manifest major", async () => {
    const unsupported = await fixture("analysis-manifest-v2-unsupported.json");
    expect(() => parseAnalysisManifest(unsupported)).toThrowError(
      expect.objectContaining<Partial<ContractError>>({
        code: "SCHEMA_VERSION_UNSUPPORTED",
      }),
    );
  });

  it("rejects path escape and mismatched voiced fields", async () => {
    const manifest = (await fixture(
      "analysis-manifest-v1-current.json",
    )) as Record<string, unknown>;
    const artifacts = manifest.artifacts as Array<Record<string, unknown>>;
    const firstArtifact = artifacts[0];
    expect(firstArtifact).toBeDefined();
    if (firstArtifact === undefined) return;
    firstArtifact.relativePath = "../escape.wav";
    expect(() => parseAnalysisManifest(manifest)).toThrowError(
      expect.objectContaining<Partial<ContractError>>({
        code: "SCHEMA_INVALID",
      }),
    );

    const track = (await fixture("reference-track-v1-current.json")) as Record<
      string,
      unknown
    >;
    const frames = track.frames as Array<Record<string, unknown>>;
    const voicedFrame = frames[1];
    expect(voicedFrame).toBeDefined();
    if (voicedFrame === undefined) return;
    voicedFrame.hz = null;
    expect(() => parseReferenceTrack(track)).toThrowError(
      expect.objectContaining<Partial<ContractError>>({
        code: "SCHEMA_INVALID",
      }),
    );
  });

  it("validates shared AnalyzerRequest, protocol, cancel and model fixtures", async () => {
    const request = parseAnalyzerRequest(
      await fixture("analyzer-request-v1-current.json"),
    );
    expect(request.inputPath.length).toBeGreaterThan(180);
    expect(request.inputPath).toContain("歌曲 根目录");
    expect(
      parseAnalyzerProtocolTrace(await fixture("protocol-v1-current.json")),
    ).toHaveLength(9);
    const terminals = (await fixture("protocol-v1-terminals.json")) as Record<
      string,
      unknown
    >;
    expect(parseAnalyzerProtocolMessage(terminals.failed).type).toBe("failed");
    expect(parseAnalyzerProtocolMessage(terminals.cancelled).type).toBe(
      "cancelled",
    );
    expect(
      parseAnalyzerControl(await fixture("cancel-v1-current.json")).type,
    ).toBe("cancel");
    expect(
      parseModelCatalog(await fixture("model-catalog-v1-current.json")).models,
    ).toHaveLength(2);
    expect(
      parseModelManifest(await fixture("model-manifest-v1-current.json"))
        .modelId,
    ).toBe("swiftf0");
    expect(
      parseTauriAnalyzerPayloads(
        await fixture("tauri-payloads-v1-current.json"),
      ).analysisProgress,
    ).toBeDefined();
  });

  it("accepts additive request fields and rejects unknown major or invalid numeric values", async () => {
    expect(
      parseAnalyzerRequest(await fixture("analyzer-request-v1-extra.json"))
        .futureDiagnosticHint,
    ).toBe("ignored");
    const unsupported = await fixture("analyzer-request-v2-unsupported.json");
    expect(() => parseAnalyzerRequest(unsupported)).toThrowError(
      expect.objectContaining<Partial<ContractError>>({
        code: "SCHEMA_VERSION_UNSUPPORTED",
      }),
    );

    const request = (await fixture(
      "analyzer-request-v1-current.json",
    )) as Record<string, unknown>;
    const config = request.config as Record<string, unknown>;
    config.pitchMinHz = Number.NaN;
    expect(() => parseAnalyzerRequest(request)).toThrowError(
      expect.objectContaining<Partial<ContractError>>({
        code: "SCHEMA_INVALID",
      }),
    );
  });
});
