import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

const EMAIL = "science.browser@puppetmaster.test";
const PASSWORD = "science-browser-2026";
const RUN_ID = process.env.SCIENCE_E2E_RUN_ID ?? "local";
const STUDY_NAME = `Browser thermal pilot ${RUN_ID}`;
const PROFILE_NAME = `Browser Fixture CPU ${RUN_ID}`;
const ARTIFACT_NAME = "Deterministic pilot notebook";
const VALIDATION_METRIC = `Synthetic browser checksum binding ${RUN_ID}`;
const VALIDATION_PROTOCOL = "browser-fixture-protocol-v1";
const VALIDATION_LIMITATION =
  "Synthetic retained browser evidence only; this is not scientific domain acceptance.";
const NOTEBOOK = resolve(
  process.cwd(),
  "services/science-runtime/fixtures/notebooks/deterministic-pilot.ipynb",
);

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "AUTHENTICATE" }).click();
  await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible();
}

async function openScience(page: Page) {
  await page.getByRole("button", { name: /SCIENCE OPERATIONS/ }).click();
  await expect(page.getByText("BUS LIVE", { exact: true })).toBeVisible();
}

async function hold(_page: Page, control: Locator) {
  await expect(control).toBeEnabled();
  await control.press("Enter", { delay: 800 });
}

async function openDetails(summary: Locator) {
  const details = summary.locator("..");
  if (await details.getAttribute("open") !== null) return;
  await summary.focus();
  await summary.press("Enter");
  await expect(details).toHaveAttribute("open", "");
}

async function authorizeScienceRun(page: Page) {
  await page.getByRole("button", { name: /NEXUS/ }).click();
  const pending = page.locator(".appr").filter({ hasText: "Approve science run" }).first();
  await expect(pending).toBeVisible();
  await hold(page, pending.getByTitle("Hold to authorize"));
  await expect(pending).toBeHidden();
}

async function waitForSucceededManifest(page: Page) {
  await openScience(page);
  await expect(page.locator(".sci-run-list").getByText("SUCCEEDED", { exact: true }).first()).toBeVisible({
    timeout: 45_000,
  });
  await page.getByRole("tab", { name: "MANIFEST" }).click();
  await expect(page.getByText("MANIFEST COMPLETE", { exact: true })).toBeVisible({ timeout: 30_000 });
}

async function retainScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function retainJson(testInfo: TestInfo, name: string, value: unknown) {
  const path = testInfo.outputPath(`${name}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
  await testInfo.attach(name, { path, contentType: "application/json" });
}

function fmtBytes(value: number): string {
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function canonicalScienceJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      const source = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(source).sort().map((key) => [key, normalize(source[key])]),
      );
    }
    return input;
  };
  const encoded = JSON.stringify(normalize(value));
  if (encoded === undefined) throw new Error("Science evidence is not JSON serializable.");
  return encoded;
}

interface RunOutputEvidence {
  artifactVersionId: string;
  logicalName?: string;
  semanticRole: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
}

interface RunEvidence {
  id: string;
  manifestHash: string;
  state: string;
  outputs: RunOutputEvidence[];
}

interface RenderEvidence {
  id: string;
  runId: string;
  artifactVersionId: string;
  state: string;
  mode: string;
  provider: string;
  source: {
    artifactVersionId: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    logicalName: string;
  };
}

interface ValidationChecksumEvidence {
  artifactVersionId: string;
  semanticRole: string;
  sha256: string;
  sizeBytes: number;
}

interface ValidationEvidence {
  id: string;
  workspaceId: string;
  runId: string;
  revision: number;
  baselineRunId: string | null;
  kind: string;
  metric: string;
  tolerance: number;
  observedValue: number;
  units: string;
  methodProtocolId: string;
  decision: boolean;
  limitationsReason: string;
  reviewerId: string;
  reviewerRole: string;
  runManifestHash: string;
  runOutputChecksums: ValidationChecksumEvidence[];
  baselineManifestHash: string | null;
  baselineOutputChecksums: ValidationChecksumEvidence[] | null;
  recordHash: string;
}

function validationRecordHash(value: ValidationEvidence): string {
  const checksums = (items: ValidationChecksumEvidence[] | null) =>
    items?.map((item) => ({
      ...item,
      artifactVersionId: item.artifactVersionId.toLowerCase(),
    })) ?? null;
  const payload = {
    schemaVersion: 2,
    id: value.id.toLowerCase(),
    workspaceId: value.workspaceId.toLowerCase(),
    runId: value.runId.toLowerCase(),
    revision: value.revision,
    baselineRunId: value.baselineRunId?.toLowerCase() ?? null,
    kind: value.kind,
    metric: value.metric,
    tolerance: value.tolerance,
    observedValue: value.observedValue,
    units: value.units,
    methodProtocolId: value.methodProtocolId,
    decision: value.decision,
    limitationsReason: value.limitationsReason,
    reviewerId: value.reviewerId.toLowerCase(),
    reviewerRole: value.reviewerRole,
    runManifestHash: value.runManifestHash,
    runOutputChecksums: checksums(value.runOutputChecksums),
    baselineManifestHash: value.baselineManifestHash,
    baselineOutputChecksums: checksums(value.baselineOutputChecksums),
  };
  return createHash("sha256").update(canonicalScienceJson(payload)).digest("hex");
}

async function expectTableValue(table: Locator, label: string, value: string) {
  const header = table.getByRole("rowheader", { name: label, exact: true });
  await expect(header).toHaveCount(1);
  await expect(header.locator("..").locator("td")).toHaveText(value);
}

test.describe("Science Operations retained browser release evidence", () => {
  test.beforeAll(async ({ request }) => {
    const status = await request.get("/api/auth/status");
    expect(status.ok()).toBeTruthy();
    const body = await status.json() as { needsSetup: boolean };
    if (body.needsSetup) {
      const setup = await request.post("/api/auth/setup", {
        data: { email: EMAIL, name: "Science Browser Operator", password: PASSWORD },
      });
      expect(setup.status()).toBe(201);
    }
  });

  test("operator completes the admitted study-to-comparison lifecycle", async ({ page }, testInfo) => {
    await login(page);
    await openScience(page);

    await expect(page.getByText("PILOT NOT ADMITTED", { exact: true })).toBeVisible();
    await page.getByPlaceholder("Required audit reason for this workspace admission change").fill(
      `Retained browser release evidence ${RUN_ID}`,
    );
    await hold(page, page.getByTitle("Hold to admit this workspace to the Science pilot"));
    await expect(page.getByText("PILOT ADMITTED", { exact: true })).toBeVisible();

    const profileControl = page.locator("details.sci-admin-profiles");
    await openDetails(profileControl.getByText("COMPUTE PROFILE CONTROL · ADMIN", { exact: true }));
    await profileControl.getByLabel("Name").fill(PROFILE_NAME);
    await profileControl.getByLabel("Provider").selectOption("local_container");
    await profileControl.getByLabel("Immutable image digest").fill(
      "sha256:1445edcf2ab7a2400b0851810d78bf572ad104afc8518f5cd207d88c528b72d6",
    );
    await profileControl.getByLabel("Kernel").fill("python-fixture-v1");
    await profileControl.getByLabel("CPU millicores ceiling").fill("1000");
    await profileControl.getByLabel("Memory MiB ceiling").fill("512");
    await profileControl.getByLabel("GPU ceiling").fill("0");
    await profileControl.getByLabel("Wall seconds ceiling").fill("300");
    await profileControl.getByLabel("Dependency lock JSON").fill('{"python":"fixture"}');
    await hold(page, profileControl.getByTitle("Hold to create this compute profile"));
    await expect(page.getByText(`Compute profile created: ${PROFILE_NAME}.`, { exact: true })).toBeVisible();

    const createStudy = page.locator("details.sci-rail-action").filter({ hasText: "CREATE STUDY" });
    await openDetails(createStudy.getByText("＋ CREATE STUDY", { exact: true }));
    await createStudy.getByLabel("Study name").fill(STUDY_NAME);
    await hold(page, createStudy.getByTitle("Hold to create a non-regulated study"));
    await expect(page.getByRole("option", { name: new RegExp(STUDY_NAME) })).toBeVisible();

    const studies = page.getByRole("listbox", { name: "Scientific studies" });
    await studies.focus();
    await studies.press("Home");
    await expect(studies).toHaveAttribute("aria-activedescendant", /option-/);
    await page.keyboard.press("Tab");
    await expect(studies).not.toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(studies).toBeFocused();

    const ingest = page.locator("details.sci-rail-action").filter({ hasText: "INGEST ARTIFACT" });
    await openDetails(ingest.getByText("⇪ INGEST ARTIFACT", { exact: true }));
    await ingest.getByLabel("Logical name").fill(ARTIFACT_NAME);
    await ingest.getByLabel("Kind").selectOption("notebook");
    await ingest.getByLabel("Format").fill("ipynb");
    await ingest.locator('input[type="file"]').setInputFiles(NOTEBOOK);
    await hold(page, ingest.getByTitle("Hold to create and upload this immutable artifact version"));
    await expect(page.getByText(`Artifact uploaded: ${ARTIFACT_NAME}.`, { exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: new RegExp(ARTIFACT_NAME) })).toBeVisible();

    await page.getByRole("tab", { name: "CONFIGURE" }).click();
    await page.getByRole("combobox", { name: "Compute profile", exact: true }).selectOption({
      label: `${PROFILE_NAME} · local_container`,
    });
    const inputs = page.getByRole("group", { name: /Immutable input versions/ });
    await inputs.getByRole("checkbox").check();
    await inputs.getByLabel(new RegExp(`Semantic role for ${ARTIFACT_NAME}`)).fill("notebook");
    await page.getByLabel(/Parameters \(canonical JSON/).fill(
      '{"units":{"length":"mm"},"randomSeeds":{"solver":42}}',
    );
    await page.getByRole("spinbutton", { name: "CPU cores", exact: true }).fill("1");
    await page.getByRole("spinbutton", { name: "Memory MiB", exact: true }).fill("256");
    await page.getByRole("spinbutton", { name: "GPU count", exact: true }).fill("0");
    await page.getByRole("spinbutton", { name: "Wall limit sec", exact: true }).fill("60");
    await hold(page, page.getByTitle("Hold to submit billable computation for authorization"));
    await expect(page.getByText("Run submitted; durable state is authoritative.", { exact: true })).toBeVisible();

    await authorizeScienceRun(page);
    await waitForSucceededManifest(page);
    await retainScreenshot(page, testInfo, "succeeded-manifest");

    await hold(page, page.getByTitle("Hold to submit a new run from this exact manifest"));
    await expect(page.getByText("Manifest re-run submitted as a new immutable run.", { exact: true })).toBeVisible();
    await authorizeScienceRun(page);
    await waitForSucceededManifest(page);

    await page.getByRole("button", { name: "COMPARE", exact: true }).click();
    await expect(page.getByText(/Compared OP .* with OP .* Differences:/)).toBeVisible();
    await retainScreenshot(page, testInfo, "rerun-comparison");
  });

  test("static render and immutable review bind the exact succeeded-run evidence", async ({ page }, testInfo) => {
    await login(page);
    await openScience(page);

    await expect(page.locator(".sci-run-list").getByText("SUCCEEDED", { exact: true }).first()).toBeVisible();
    const outputSelect = page.getByRole("combobox", { name: "Exact ready PNG render output" });
    await expect(outputSelect).toBeEnabled();
    const selectedOutput = await outputSelect.locator("option:checked").evaluate((option) => ({
      artifactVersionId: (option as HTMLOptionElement).value,
      label: option.textContent?.trim() ?? "",
    }));
    expect(selectedOutput.artifactVersionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(selectedOutput.label).toMatch(/SHA [0-9a-f]{12}$/i);

    const renderRequestPromise = page.waitForRequest((request) =>
      request.method() === "POST" && /\/api\/science\/runs\/[^/]+\/render-sessions$/.test(
        new URL(request.url()).pathname,
      ));
    const renderResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && /\/api\/science\/runs\/[^/]+\/render-sessions$/.test(
        new URL(response.url()).pathname,
      ));
    const gatewayResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "GET" &&
      /\/api\/science\/render-sessions\/[^/]+\/gateway$/.test(new URL(response.url()).pathname),
    );
    const imageResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "GET" &&
      /\/api\/science\/artifact-versions\/[^/]+\/content$/.test(new URL(response.url()).pathname) &&
      response.headers()["content-type"]?.toLowerCase().startsWith("image/png"),
    );
    await hold(page, page.getByTitle("Hold to start a short-lived isolated render session"));
    const [renderRequest, renderResponse, gatewayResponse, imageResponse] = await Promise.all([
      renderRequestPromise,
      renderResponsePromise,
      gatewayResponsePromise,
      imageResponsePromise,
    ]);
    expect(renderResponse.status()).toBe(201);
    expect(gatewayResponse.status()).toBeGreaterThanOrEqual(300);
    expect(gatewayResponse.status()).toBeLessThan(400);
    expect(imageResponse.status()).toBe(200);
    expect(new URL(gatewayResponse.url()).origin).toBe(new URL(page.url()).origin);
    expect(new URL(imageResponse.url()).origin).toBe(new URL(page.url()).origin);

    const renderInput = renderRequest.postDataJSON() as {
      artifactVersionId: string;
      mode: string;
      idempotencyKey: string;
    };
    expect(renderInput).toMatchObject({
      artifactVersionId: selectedOutput.artifactVersionId,
      mode: "static",
    });
    expect(renderInput.idempotencyKey.length).toBeGreaterThan(0);
    const renderBody = await renderResponse.json() as { session: RenderEvidence };
    const session = renderBody.session;
    expect(session).toMatchObject({
      state: "ready",
      mode: "static",
      provider: "static",
      artifactVersionId: selectedOutput.artifactVersionId,
    });
    expect(session.source.artifactVersionId).toBe(selectedOutput.artifactVersionId);

    const runResponse = await page.request.get(`/api/science/runs/${encodeURIComponent(session.runId)}`);
    expect(runResponse.ok()).toBeTruthy();
    const { run } = await runResponse.json() as { run: RunEvidence };
    expect(run.state).toBe("succeeded");
    expect(run.manifestHash).toMatch(/^[0-9a-f]{64}$/i);
    const exactOutput = run.outputs.find(
      (output) => output.artifactVersionId === selectedOutput.artifactVersionId,
    );
    expect(exactOutput, "The selected renderer source must be linked to the exact succeeded run.").toBeTruthy();
    expect(exactOutput).toMatchObject({
      artifactVersionId: session.source.artifactVersionId,
      sha256: session.source.sha256,
      sizeBytes: session.source.sizeBytes,
      mediaType: session.source.mediaType,
      logicalName: session.source.logicalName,
    });
    expect(selectedOutput.label).toContain(exactOutput!.logicalName ?? exactOutput!.semanticRole);
    expect(selectedOutput.label).toContain(exactOutput!.sha256.slice(0, 12));
    expect(selectedOutput.label).toContain(fmtBytes(exactOutput!.sizeBytes));

    const staticImage = page.getByRole("img", {
      name: `${session.source.logicalName} static visualization`,
    });
    await expect(staticImage).toBeVisible();
    await expect.poll(() => staticImage.evaluate((image) => ({
      complete: (image as HTMLImageElement).complete,
      naturalWidth: (image as HTMLImageElement).naturalWidth,
      naturalHeight: (image as HTMLImageElement).naturalHeight,
      origin: new URL((image as HTMLImageElement).currentSrc).origin,
    }))).toEqual({
      complete: true,
      naturalWidth: 32,
      naturalHeight: 32,
      origin: new URL(page.url()).origin,
    });
    await retainScreenshot(page, testInfo, "exact-static-render");

    await page.getByRole("combobox", { name: "Viewport rendering mode" }).selectOption("table");
    const sourceTable = page.getByRole("table", {
      name: "Structured non-WebGL artifact and run summary",
    });
    await expectTableValue(sourceTable, "RENDER SOURCE", session.source.logicalName);
    await expectTableValue(sourceTable, "ARTIFACT VERSION ID", exactOutput!.artifactVersionId);
    await expectTableValue(sourceTable, "SHA-256", exactOutput!.sha256);
    await expectTableValue(sourceTable, "SIZE", fmtBytes(exactOutput!.sizeBytes));
    await expectTableValue(sourceTable, "MEDIA TYPE", "image/png");
    await expectTableValue(sourceTable, "MODE", "STATIC");
    await expectTableValue(sourceTable, "PROVIDER", "STATIC");
    await expectTableValue(sourceTable, "RUN", run.id);
    await expectTableValue(sourceTable, "SESSION STATE", "READY");
    await retainScreenshot(page, testInfo, "exact-static-render-source");

    const closeResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === `/api/science/render-sessions/${session.id}`,
    );
    await page.getByRole("button", { name: "CLOSE RENDER", exact: true }).click();
    const closeResponse = await closeResponsePromise;
    expect(closeResponse.status()).toBe(200);
    await expect(page.getByText("Render session closed.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "CLOSE RENDER", exact: true })).toBeHidden();
    const replayedClose = await page.evaluate(async (sessionId) => {
      const response = await fetch(`/api/science/render-sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      return { status: response.status, body: await response.json() };
    }, session.id);
    expect(replayedClose.status).toBe(200);
    expect(replayedClose.body).toMatchObject({
      ok: true,
      session: { id: session.id, state: "revoked" },
    });

    await page.getByRole("tab", { name: "MANIFEST" }).click();
    await expect(page.getByText("MANIFEST COMPLETE", { exact: true })).toBeVisible();
    const author = page.locator("details.sci-validation-author");
    await openDetails(author.getByText("APPEND DOMAIN REVIEW · ADMIN / OWNER", { exact: true }));
    await author.getByLabel("Metric").fill(VALIDATION_METRIC);
    await author.getByLabel("Tolerance (zero or greater)").fill("0.001");
    await author.getByLabel("Observed value").fill("0.0004");
    await author.getByLabel("Units").fill("relative error");
    await author.getByLabel("Method / protocol identifier").fill(VALIDATION_PROTOCOL);
    await author.getByLabel("Limitations / reason (mandatory)").fill(VALIDATION_LIMITATION);

    const validationResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/science/runs/${run.id}/validations`,
    );
    await hold(page, author.getByTitle("Hold to append an immutable, session-attributed validation revision"));
    const validationResponse = await validationResponsePromise;
    expect(validationResponse.status()).toBe(201);
    const validationBody = await validationResponse.json() as { validation: ValidationEvidence };
    const validation = validationBody.validation;
    expect(validation).toMatchObject({
      runId: run.id,
      revision: 1,
      baselineRunId: null,
      kind: "domain-validation",
      metric: VALIDATION_METRIC,
      tolerance: 0.001,
      observedValue: 0.0004,
      units: "relative error",
      methodProtocolId: VALIDATION_PROTOCOL,
      decision: true,
      limitationsReason: VALIDATION_LIMITATION,
      runManifestHash: run.manifestHash,
      baselineManifestHash: null,
      baselineOutputChecksums: null,
    });
    expect(validation.reviewerRole).toMatch(/^(admin|owner)$/);
    expect(validation.runOutputChecksums.length).toBeGreaterThan(0);
    for (const checksum of validation.runOutputChecksums) {
      const linkedOutput = run.outputs.find(
        (output) => output.artifactVersionId === checksum.artifactVersionId,
      );
      expect(linkedOutput).toMatchObject(checksum);
    }
    const computedRecordHash = validationRecordHash(validation);
    expect(validation.recordHash).toBe(computedRecordHash);
    await retainJson(testInfo, "domain-validation-source-verification", {
      valid: true,
      validationId: validation.id,
      runId: run.id,
      manifestHash: run.manifestHash,
      outputChecksums: validation.runOutputChecksums,
      recordHash: validation.recordHash,
      computedRecordHash,
    });

    await expect(page.getByText(
      new RegExp(`Immutable validation revision ${validation.revision} appended\\.`),
    )).toBeVisible();
    const summary = page.getByRole("button", { name: new RegExp(VALIDATION_METRIC) });
    await expect(summary).toContainText("REV 1 · DOMAIN");
    await expect(summary).toContainText("PASS");
    if (await summary.getAttribute("aria-pressed") !== "true") await summary.click();
    const detail = page.getByRole("region", { name: "Selected validation detail" });
    await expect(detail.getByText(validation.recordHash, { exact: true })).toBeVisible();
    await expect(detail.getByText(run.manifestHash, { exact: true })).toBeVisible();
    await expect(detail.getByText(VALIDATION_PROTOCOL, { exact: true })).toBeVisible();
    await expect(detail.getByText(VALIDATION_LIMITATION, { exact: true })).toBeVisible();
    const checksumDetail = detail.locator("details.sci-validation-checksums");
    await openDetails(checksumDetail.getByText(
      `CANDIDATE OUTPUTS (${validation.runOutputChecksums.length})`,
      { exact: true },
    ));
    for (const checksum of validation.runOutputChecksums) {
      await expect(checksumDetail.getByText(checksum.artifactVersionId, { exact: true })).toBeVisible();
      await expect(checksumDetail.locator(`small[title="${checksum.sha256}"]`)).toBeVisible();
    }
    await retainScreenshot(page, testInfo, "immutable-domain-validation-detail");
  });

  test("keyboard, axe, reduced-motion, and mobile release gates remain measurable", async ({ page }, testInfo) => {
    await login(page);
    await openScience(page);

    const studies = page.getByRole("listbox", { name: "Scientific studies" });
    await studies.focus();
    await studies.press("End");
    const activeId = await studies.getAttribute("aria-activedescendant");
    expect(activeId, "The virtual listbox must expose its keyboard selection through aria-activedescendant.").toBeTruthy();
    await expect(page.locator(`#${activeId}`)).toHaveAttribute("aria-selected", "true");

    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    const axePath = testInfo.outputPath("axe-results.json");
    await mkdir(dirname(axePath), { recursive: true });
    await writeFile(axePath, JSON.stringify(axe, null, 2), "utf8");
    await testInfo.attach("axe-results", { path: axePath, contentType: "application/json" });
    const severe = axe.violations.filter((violation) =>
      violation.impact === "serious" || violation.impact === "critical"
    );
    const incompleteSevere = axe.incomplete.filter((result) =>
      result.impact === "serious" || result.impact === "critical"
    );
    if (incompleteSevere.length > 0) {
      testInfo.annotations.push({
        type: "axe-incomplete-manual-review",
        description: incompleteSevere
          .map((result) => `${result.id}:${result.nodes.length}`)
          .join(", "),
      });
    }
    expect.soft(
      severe,
      `Serious/critical axe findings:\n${severe.map((item) => `${item.id}: ${item.help}`).join("\n")}`,
    ).toEqual([]);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator(".science-ops")).toHaveClass(/reduced-motion/);
    const motionLeak = await page.locator(".science-ops").evaluate((root) => {
      const offenders: string[] = [];
      for (const element of root.querySelectorAll<HTMLElement>("*")) {
        if (element.getClientRects().length === 0) continue;
        const style = getComputedStyle(element);
        const durations = `${style.animationDuration},${style.transitionDuration}`
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
        if (durations.some((part) => part.endsWith("s") && Number.parseFloat(part) > 0.001)) {
          offenders.push(`${element.tagName.toLowerCase()}.${element.className}`);
        }
      }
      return offenders.slice(0, 20);
    });
    expect.soft(
      motionLeak,
      "Visible Science elements must collapse animation/transition duration under reduced motion.",
    ).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const undersized = await page.locator(
      ".science-ops button:not([disabled]), .science-ops input:not([disabled]), " +
        ".science-ops select:not([disabled]), .science-ops textarea:not([disabled]), " +
        ".science-ops summary, .science-ops [role='listbox']",
    ).evaluateAll((elements) => elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (element.getClientRects().length === 0 || rect.bottom < 0 || rect.top > window.innerHeight) return [];
      if (rect.width >= 24 && rect.height >= 24) return [];
      return [{
        target: `${element.tagName.toLowerCase()}${element.getAttribute("title") ? `[title="${element.getAttribute("title")}"]` : ""}`,
        label: (element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 80),
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      }];
    }));
    expect.soft(
      undersized,
      `Visible mobile targets below 24×24 CSS px:\n${JSON.stringify(undersized, null, 2)}`,
    ).toEqual([]);
    await retainScreenshot(page, testInfo, "mobile-reduced-motion");
  });

  test("event bus reconnect performs an authoritative REST resync", async ({ page }) => {
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      const sockets: WebSocket[] = [];
      const TrackedWebSocket = new Proxy(NativeWebSocket, {
        construct(Target, args) {
          const socket = Reflect.construct(Target, args) as WebSocket;
          sockets.push(socket);
          return socket;
        },
      });
      Object.defineProperty(window, "WebSocket", { value: TrackedWebSocket });
      Object.defineProperty(window, "__scienceSockets", { value: sockets });
    });
    await login(page);
    await openScience(page);
    await page.evaluate(() => {
      const transitions: string[] = [];
      Object.defineProperty(window, "__scienceSyncTransitions", { value: transitions, configurable: true });
      const target = document.querySelector(".sci-connection > span:first-child");
      if (!target) throw new Error("Science connection status is missing.");
      const record = () => transitions.push(target.textContent?.trim() ?? "");
      record();
      new MutationObserver(record).observe(target, { childList: true, characterData: true, subtree: true });
    });
    await page.evaluate(() => {
      const sockets = (window as typeof window & { __scienceSockets?: WebSocket[] }).__scienceSockets ?? [];
      const socket = sockets.at(-1);
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("The tracked Science event-bus WebSocket is not open.");
      }
      socket.close(4000, "retained browser reconnect evidence");
    });
    await expect(page.getByText("BUS DISCONNECTED", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("BUS LIVE", { exact: true })).toBeVisible({ timeout: 30_000 });
    const transitions = await page.evaluate(() =>
      (window as typeof window & { __scienceSyncTransitions?: string[] }).__scienceSyncTransitions ?? []
    );
    expect(transitions).toContain("BUS DISCONNECTED");
    expect(transitions).toContain("REST RESYNC");
  });
});
