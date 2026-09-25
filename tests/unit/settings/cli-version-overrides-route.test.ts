/**
 * GET/PUT /api/settings/cli-versions — management auth, validation rejection,
 * clear-on-null, persistence, and the settings-write hot reload that keeps the
 * in-memory override store in sync with the DB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setupSettingsFixture, mockSettings } from "../_mocks/settings.ts";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const fixture = setupSettingsFixture("cli-versions-route");

process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
// Forces `isAuthRequired` to return true even before a management password is
// configured: without it a loopback Request counts as an unauthenticated local
// operator and the auth cases below would silently assert 200.
process.env.INITIAL_PASSWORD = "test-initial-password";

// Every `await import` MUST precede the first test(): node:test only registers
// tests declared before the first top-level await in the module. The fixture
// above also has to run first so DATA_DIR is isolated before the DB loads.
const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const route = await import("../../../src/app/api/settings/cli-versions/route.ts");
const cliVersions = await import("../../../src/shared/constants/cliVersions.ts");
const claude = await import("../../../src/shared/constants/claudeCodeClient.ts");

const ROUTE_URL = "http://localhost/api/settings/cli-versions";

test.beforeEach(async () => {
  await fixture.resetStorage();
  cliVersions.setCliVersionOverrides({});
  // Hermetic: a developer shell exporting these would otherwise change what
  // "no override" resolves to and make the source=default assertions flaky.
  delete process.env.CLAUDE_CODE_CLIENT_VERSION;
  delete process.env.CODEX_CLIENT_VERSION;
});

test.after(() => {
  core.resetDbInstance();
  fixture.cleanup();
});

test("GET /api/settings/cli-versions requires a management session", async () => {
  const res = await route.GET(new Request(ROUTE_URL));
  assert.equal(res.status, 401);
});

test("PUT /api/settings/cli-versions requires a management session", async () => {
  const res = await route.PUT(
    new Request(ROUTE_URL, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claude: "2.1.260" }),
    })
  );
  assert.equal(res.status, 401);
  assert.equal(cliVersions.getCliVersionOverride("claude"), null);
});

test("GET reports one row per kind with effective, source and pinned", async () => {
  const res = await route.GET(await makeManagementSessionRequest(ROUTE_URL));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<Record<string, unknown>> };
  assert.deepEqual(body.items.map((item) => item.key).sort(), ["claude", "codex"]);

  const row = body.items.find((item) => item.key === "claude");
  assert.ok(row, "claude row should be present");
  assert.equal(row.version, null);
  assert.equal(row.effective, claude.CLAUDE_CODE_CLIENT_VERSION);
  assert.equal(row.source, "default");
  assert.equal(row.pinned, claude.CLAUDE_CODE_CLIENT_VERSION);
});

test("a settings write hot-reloads the store and GET reports source=settings", async () => {
  await mockSettings({ cliVersionOverrides: { claude: "2.1.260" } });
  assert.equal(claude.getClaudeCodeClientVersion(), "2.1.260");

  const res = await route.GET(await makeManagementSessionRequest(ROUTE_URL));
  const body = (await res.json()) as { items: Array<Record<string, unknown>> };
  const row = body.items.find((item) => item.key === "claude");
  assert.ok(row, "claude row should be present");
  assert.equal(row.version, "2.1.260");
  assert.equal(row.effective, "2.1.260");
  assert.equal(row.source, "settings");
});

test("PUT applies the override in-memory and persists it for the next boot", async () => {
  const res = await route.PUT(
    await makeManagementSessionRequest(ROUTE_URL, {
      method: "PUT",
      body: { claude: "2.1.260", codex: "0.156.0" },
    })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(cliVersions.getCliVersionOverrides(), {
    claude: "2.1.260",
    codex: "0.156.0",
  });

  // Persisted: a simulated cold boot re-hydrates from the settings row.
  cliVersions.setCliVersionOverrides({});
  const settings = await settingsDb.getSettings();
  assert.deepEqual(settings.cliVersionOverrides, { claude: "2.1.260", codex: "0.156.0" });
  assert.equal(cliVersions.hydrateCliVersionOverrides(settings), true);
  assert.equal(claude.getClaudeCodeClientVersion(), "2.1.260");
});

test("PUT rejects a malformed version loudly instead of silently dropping it", async () => {
  const res = await route.PUT(
    await makeManagementSessionRequest(ROUTE_URL, {
      method: "PUT",
      body: { claude: "bad version value" },
    })
  );
  assert.equal(res.status, 400);
  assert.deepEqual(cliVersions.getCliVersionOverrides(), {});
});

test("PUT rejects an empty update and unknown keys", async () => {
  const empty = await route.PUT(
    await makeManagementSessionRequest(ROUTE_URL, { method: "PUT", body: {} })
  );
  assert.equal(empty.status, 400);

  const unknown = await route.PUT(
    await makeManagementSessionRequest(ROUTE_URL, {
      method: "PUT",
      body: { copilot: "1.0.82" },
    })
  );
  assert.equal(unknown.status, 400);
  assert.deepEqual(cliVersions.getCliVersionOverrides(), {});
});

test("PUT clears one override with null and the source falls back to default", async () => {
  await route.PUT(
    await makeManagementSessionRequest(ROUTE_URL, {
      method: "PUT",
      body: { claude: "2.1.260", codex: "0.156.0" },
    })
  );

  const res = await route.PUT(
    await makeManagementSessionRequest(ROUTE_URL, { method: "PUT", body: { claude: null } })
  );
  assert.equal(res.status, 200);
  // Only claude is cleared; an omitted key keeps its value.
  assert.deepEqual(cliVersions.getCliVersionOverrides(), { codex: "0.156.0" });

  const body = (await res.json()) as { items: Array<Record<string, unknown>> };
  const row = body.items.find((item) => item.key === "claude");
  assert.ok(row, "claude row should be present");
  assert.equal(row.version, null);
  assert.equal(row.effective, claude.CLAUDE_CODE_CLIENT_VERSION);
  assert.equal(row.source, "default");
});
