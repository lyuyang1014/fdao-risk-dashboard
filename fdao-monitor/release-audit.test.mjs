import assert from "node:assert/strict";
import test from "node:test";
import { decodeMyInfos } from "./release-audit.mjs";

test("decodeMyInfos decodes releasable, locked and released LP", () => {
  const hex = (value) => BigInt(value).toString(16).padStart(64, "0");
  const decoded = decodeMyInfos(
    "0x" +
      hex(8n * 10n ** 18n) +
      hex(13n * 10n ** 18n) +
      hex(2n * 10n ** 18n),
  );
  assert.deepEqual(decoded, {
    releasableLp: 8,
    lockedLp: 13,
    releasedLp: 2,
  });
});
