import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ContractError, parseSong } from "./song";

const fixtureRoot = fileURLToPath(
  new URL("../../../fixtures/contracts/song/", import.meta.url),
);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${fixtureRoot}${name}`, "utf8")) as unknown;
}

describe("TC-CON-001 Song schema compatibility", () => {
  it.each(["song-v1-legacy.json", "song-v1-current.json"])(
    "accepts supported fixture %s",
    async (name) => {
      expect(parseSong(await fixture(name)).schemaVersion).toBe(1);
    },
  );

  it("preserves optional extra fields in the current major", async () => {
    const song = parseSong(await fixture("song-v1-extra.json"));
    expect(song.futureDisplayHint).toBe("compact");
  });

  it("rejects an unknown major version", async () => {
    const unsupported = await fixture("song-v2-unsupported.json");
    expect(() => parseSong(unsupported)).toThrowError(
      expect.objectContaining<Partial<ContractError>>({
        code: "SCHEMA_VERSION_UNSUPPORTED",
      }),
    );
  });
});
