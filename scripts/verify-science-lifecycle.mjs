#!/usr/bin/env node

import assert from "node:assert/strict";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import {
  ScienceConflictError,
  SCHEMA_MIGRATIONS,
  acquireScienceRunLease,
  appendScienceRunEvent,
  archiveScienceStudy,
  beginScienceUpload,
  claimScienceUploadFinalization,
  claimScienceArtifactVersionRetention,
  claimScienceUploadTransfer,
  claimScienceRun,
  cleanupScienceArtifactVersionQuarantine,
  cleanupExpiredScienceUploads,
  cleanupExpiredScienceRenderSessions,
  countActiveScienceRuns,
  createDb,
  createScienceArtifact,
  createScienceArtifactVersion,
  createScienceComputeProfile,
  createScienceDomainValidation,
  createScienceRenderSession,
  createScienceRun,
  createScienceStudy,
  createUser,
  deleteScienceProviderOutputReservationAfterCommit,
  deleteExpiredScienceArtifactVersionAfterDiscard,
  deleteExpiredScienceUploadAfterDiscard,
  tombstoneTerminalScienceRenderSessionAfterClose,
  deferScienceArtifactVersionCleanup,
  deferScienceRenderSessionCleanup,
  deferScienceUploadCleanup,
  finalizeScienceUpload,
  getScienceDomainValidationForRun,
  getScienceWorkspaceAdmission,
  getLatestScienceRunEvent,
  getScienceArtifactByLogicalName,
  getScienceArtifactVersionForWorkspace,
  getScienceRenderSessionForWorkspace,
  getScienceRunByMissionForWorkspace,
  getScienceRunForWorkspace,
  getScienceRunSubmitAttempt,
  getScienceStudyForWorkspace,
  getScienceUploadByTokenHash,
  heartbeatScienceRenderSession,
  linkScienceRunArtifact,
  listScienceAdminActionQueue,
  listScienceDomainValidations,
  listRecoverableScienceRuns,
  listScienceRunArtifacts,
  listScienceRunEvents,
  listScienceStudies,
  migrate,
  quarantineScienceUpload,
  recordScienceRunSubmitAttempt,
  recordScienceUploadProgress,
  releaseScienceRunLease,
  renewScienceUploadTransfer,
  renewScienceUploadFinalization,
  renewScienceRunLease,
  requestScienceRunApproval,
  resolveScienceRunApproval,
  setScienceWorkspaceAdmission,
  scienceDomainValidationRunLockOrder,
  setScienceRunProviderHandle,
  setScienceRenderSessionProviderHandle,
  transitionScienceArtifactVersion,
  transitionScienceRenderSession,
  transitionScienceRun,
  upsertMembership,
  verifyScienceDomainValidationRecordHash,
  workspaces,
} from "../packages/db/dist/index.js";

const SHA_INPUT = "1".repeat(64);
const SHA_OUTPUT = "2".repeat(64);
const SHA_UPLOAD_2 = "3".repeat(64);
const SHA_UPLOAD_3 = "4".repeat(64);
const SHA_UPLOAD_4 = "5".repeat(64);
const SHA_CHILD = "6".repeat(64);
const TOKEN_1 = "a".repeat(64);
const TOKEN_2 = "b".repeat(64);
const TOKEN_3 = "c".repeat(64);
const TOKEN_4 = "f".repeat(64);
const TOKEN_RENDER = "d".repeat(64);
const TOKEN_RENDER_LIVE = "e".repeat(64);
const TOKEN_RENDER_TERMINAL = "f".repeat(64);
const IMAGE = `sha256:${"e".repeat(64)}`;
const WORKSPACE_STORAGE_LIMIT = 1024 * 1024;
const RESOURCE_CEILING = {
  cpuMillicores: 4_000,
  memoryMb: 8_192,
  gpuCount: 1,
  wallTimeSeconds: 3_600,
};
const RESOURCE_REQUEST = {
  cpuMillicores: 1_000,
  memoryMb: 2_048,
  gpuCount: 0,
  wallTimeSeconds: 300,
};

async function expectConflict(action, pattern) {
  await assert.rejects(
    action,
    (error) =>
      error instanceof ScienceConflictError &&
      (pattern === undefined || pattern.test(error.message)),
  );
}

async function seed(handle) {
  const [workspaceA] = await handle.db
    .insert(workspaces)
    .values({ name: "Science verification A" })
    .returning();
  const [workspaceB] = await handle.db
    .insert(workspaces)
    .values({ name: "Science verification B" })
    .returning();
  const user = await createUser(handle.db, {
    email: "science-verification@example.test",
    name: "Science Verifier",
    passwordHash: "not-a-real-password-hash",
  });
  await upsertMembership(handle.db, {
    userId: user.id,
    workspaceId: workspaceA.id,
    role: "owner",
  });
  return { workspaceA, workspaceB, user };
}

async function verifyLegacyUpgrade() {
  const handle = await createDb({ ephemeral: true });
  try {
    await handle.db.execute(sql.raw(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    ));
    for (const statement of SCHEMA_MIGRATIONS[0].statements) {
      await handle.db.execute(sql.raw(statement));
    }
    await handle.db.execute(sql.raw(
      "INSERT INTO schema_migrations(version, name) VALUES (1, 'legacy-baseline')",
    ));
    await Promise.all([migrate(handle), migrate(handle), migrate(handle)]);
    const result = await handle.db.execute(
      sql.raw("SELECT version, name FROM schema_migrations ORDER BY version"),
    );
    const rows = result.rows ?? result;
    assert.deepEqual(
      rows.map((row) => Number(row.version)),
      SCHEMA_MIGRATIONS.map((migration) => migration.version),
    );
    assert.deepEqual(
      rows.map((row) => row.name),
      SCHEMA_MIGRATIONS.map((migration) => migration.name),
    );
    await handle.db.execute(sql.raw("SELECT count(*) FROM science_runs"));
  } finally {
    await handle.close();
  }
}

async function verifyMigrationRollbackIsAtomic() {
  const handle = await createDb({ ephemeral: true });
  const failingMigration = {
    version: 999_999,
    name: "verification-only-atomic-rollback",
    statements: [
      "CREATE TABLE science_migration_atomic_probe (id integer PRIMARY KEY)",
      "SELECT * FROM science_migration_deliberate_missing_relation",
    ],
    allowUnavailableVector: false,
  };
  try {
    await migrate(handle);
    SCHEMA_MIGRATIONS.push(failingMigration);
    await assert.rejects(
      () => migrate(handle),
      /science_migration_deliberate_missing_relation/,
    );
    const ledgerResult = await handle.db.execute(sql.raw(
      `SELECT count(*) AS copies
         FROM schema_migrations
        WHERE version = ${failingMigration.version}`,
    ));
    const ledgerRows = ledgerResult.rows ?? ledgerResult;
    assert.equal(Number(ledgerRows[0].copies), 0, "failed migration must not be recorded");
    await assert.rejects(
      () =>
        handle.db.execute(
          sql.raw("SELECT count(*) FROM science_migration_atomic_probe"),
        ),
      /science_migration_atomic_probe/,
      "DDL before a failed statement must roll back with its migration",
    );
  } finally {
    const index = SCHEMA_MIGRATIONS.indexOf(failingMigration);
    if (index !== -1) SCHEMA_MIGRATIONS.splice(index, 1);
    await handle.close();
  }
}

async function verifyRewrittenV12DriftIsRejected() {
  const handle = await createDb({ ephemeral: true });
  const originalMigrations = [...SCHEMA_MIGRATIONS];
  try {
    SCHEMA_MIGRATIONS.splice(
      0,
      SCHEMA_MIGRATIONS.length,
      ...originalMigrations.filter((migration) => migration.version <= 11),
    );
    await migrate(handle);
    await handle.db.execute(sql.raw(`
      CREATE TABLE science_domain_validations (
        id uuid PRIMARY KEY,
        workspace_id uuid,
        run_id uuid,
        record_hash text
      )
    `));
    await handle.db.execute(sql.raw(`
      INSERT INTO schema_migrations(version, name)
      VALUES (12, 'science-append-only-domain-validation')
    `));
    SCHEMA_MIGRATIONS.splice(0, SCHEMA_MIGRATIONS.length, ...originalMigrations);
    await assert.rejects(
      () => migrate(handle),
      /science migration 13 schema drift: migration 12 lacks rewritten revision\/created_at\/record_hash columns/i,
      "an older unreleased v12 ledger must fail fast rather than silently install an untrustworthy head",
    );
    const ledgerResult = await handle.db.execute(sql.raw(
      "SELECT count(*) AS copies FROM schema_migrations WHERE version = 13",
    ));
    assert.equal(Number((ledgerResult.rows ?? ledgerResult)[0].copies), 0);
    const headResult = await handle.db.execute(sql.raw(
      "SELECT to_regclass('public.science_domain_validation_heads')::text AS relation",
    ));
    assert.equal((headResult.rows ?? headResult)[0].relation, null);
  } finally {
    SCHEMA_MIGRATIONS.splice(0, SCHEMA_MIGRATIONS.length, ...originalMigrations);
    await handle.close();
  }
}

async function verifyLifecycle(databaseUrl) {
  const handle = await createDb(
    databaseUrl ? { databaseUrl } : { ephemeral: true },
  );
  try {
    await Promise.all(
      Array.from({ length: 6 }, () => migrate(handle)),
    );
    await migrate(handle);
    assert.deepEqual(
      SCHEMA_MIGRATIONS.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    );
    const ledgerResult = await handle.db.execute(
      sql.raw(
        "SELECT version, name, count(*) AS copies FROM schema_migrations GROUP BY version, name ORDER BY version",
      ),
    );
    const ledgerRows = ledgerResult.rows ?? ledgerResult;
    assert.deepEqual(
      ledgerRows.map((row) => ({
        version: Number(row.version),
        name: row.name,
        copies: Number(row.copies),
      })),
      SCHEMA_MIGRATIONS.map((migration) => ({
        version: migration.version,
        name: migration.name,
        copies: 1,
      })),
    );
    const { workspaceA, workspaceB, user } = await seed(handle);

    const defaultAdmissionA = await getScienceWorkspaceAdmission(handle.db, workspaceA.id);
    const defaultAdmissionB = await getScienceWorkspaceAdmission(handle.db, workspaceB.id);
    assert.deepEqual(
      {
        id: defaultAdmissionA.id,
        admitted: defaultAdmissionA.admitted,
        updatedBy: defaultAdmissionA.updatedBy,
        updatedAt: defaultAdmissionA.updatedAt,
      },
      { id: null, admitted: false, updatedBy: null, updatedAt: null },
      "a migrated workspace without an admission row must fail closed",
    );
    assert.equal(defaultAdmissionB.admitted, false);
    const admittedA = await setScienceWorkspaceAdmission(handle.db, {
      workspaceId: workspaceA.id,
      admitted: true,
      updatedBy: user.id,
    });
    assert.equal(admittedA.admitted, true);
    assert.equal(admittedA.workspaceId, workspaceA.id);
    assert.equal(admittedA.updatedBy, user.id);
    assert.ok(admittedA.id);
    assert.ok(admittedA.updatedAt instanceof Date);
    assert.equal(
      (await getScienceWorkspaceAdmission(handle.db, workspaceA.id)).admitted,
      true,
      "admission must survive a repository reconstruction/read",
    );
    assert.deepEqual(
      {
        id: (await getScienceWorkspaceAdmission(handle.db, workspaceB.id)).id,
        admitted: (await getScienceWorkspaceAdmission(handle.db, workspaceB.id)).admitted,
      },
      { id: null, admitted: false },
      "admitting one workspace must neither admit nor disclose state for another",
    );

    // Aggregate storage admission is serialized on the workspace, not merely
    // on an artifact or study. These fixtures deliberately use separate
    // studies so two concurrent transactions can race for the same quota.
    const [uploadQuotaWorkspace] = await handle.db
      .insert(workspaces)
      .values({ name: "Science upload quota verification" })
      .returning();
    const uploadQuotaStudies = await Promise.all([
      createScienceStudy(handle.db, {
        workspaceId: uploadQuotaWorkspace.id,
        name: "Quota upload A",
        createdBy: user.id,
      }),
      createScienceStudy(handle.db, {
        workspaceId: uploadQuotaWorkspace.id,
        name: "Quota upload B",
        createdBy: user.id,
      }),
    ]);
    const uploadQuotaArtifacts = await Promise.all(
      uploadQuotaStudies.map((quotaStudy, index) =>
        createScienceArtifact(handle.db, {
          workspaceId: uploadQuotaWorkspace.id,
          studyId: quotaStudy.id,
          logicalName: `quota-upload-${index}`,
          kind: "dataset",
          format: "binary",
          createdBy: user.id,
        }),
      ),
    );
    const uploadQuotaLimit = 12;
    const uploadQuotaExpiry = new Date(Date.now() + 120_000);
    const racingUploadInputs = uploadQuotaArtifacts.map((artifact, index) => ({
      workspaceId: uploadQuotaWorkspace.id,
      artifactId: artifact.id,
      tokenHash: (index === 0 ? "7" : "8").repeat(64),
      expectedSizeBytes: 7,
      expectedSha256: (index === 0 ? "9" : "a").repeat(64),
      quarantineKey: `quarantine/quota-race-${index}`,
      expiresAt: uploadQuotaExpiry,
      maxWorkspaceStorageBytes: uploadQuotaLimit,
    }));
    const racingUploads = await Promise.allSettled(
      racingUploadInputs.map((input) => beginScienceUpload(handle.db, input)),
    );
    assert.equal(
      racingUploads.filter((result) => result.status === "fulfilled").length,
      1,
      "workspace row fencing must admit only one racing upload reservation",
    );
    const losingUpload = racingUploads.find((result) => result.status === "rejected");
    assert.ok(
      losingUpload?.reason instanceof ScienceConflictError &&
        /storage quota/i.test(losingUpload.reason.message),
      "the racing upload that would exceed aggregate quota must fail closed",
    );
    const winningUploadIndex = racingUploads.findIndex(
      (result) => result.status === "fulfilled",
    );
    const winningUploadResult = racingUploads[winningUploadIndex];
    assert.equal(winningUploadResult.status, "fulfilled");
    const winningUploadInput = racingUploadInputs[winningUploadIndex];
    const winningTransferLeaseId = "20000000-0000-4000-8000-000000000001";
    await claimScienceUploadTransfer(handle.db, {
      workspaceId: uploadQuotaWorkspace.id,
      tokenHash: winningUploadInput.tokenHash,
      leaseId: winningTransferLeaseId,
      leaseExpiresAt: uploadQuotaExpiry,
    });
    await recordScienceUploadProgress(handle.db, {
      workspaceId: uploadQuotaWorkspace.id,
      tokenHash: winningUploadInput.tokenHash,
      leaseId: winningTransferLeaseId,
      receivedBytes: 7,
      readyExpiresAt: uploadQuotaExpiry,
    });
    const retainedQuotaVersion = await createScienceArtifactVersion(handle.db, {
      workspaceId: uploadQuotaWorkspace.id,
      artifactId: uploadQuotaArtifacts[1 - winningUploadIndex].id,
      storageKey: "science/quota/manual-retained",
      sha256: "b".repeat(64),
      sizeBytes: 3,
      mediaType: "application/octet-stream",
      metadata: { fixture: "quota-retained" },
      maxWorkspaceStorageBytes: uploadQuotaLimit,
      createdBy: user.id,
    });
    const otherReservation = await beginScienceUpload(handle.db, {
      workspaceId: uploadQuotaWorkspace.id,
      artifactId: uploadQuotaArtifacts[1 - winningUploadIndex].id,
      tokenHash: "0".repeat(64),
      expectedSizeBytes: 2,
      expectedSha256: "d".repeat(64),
      quarantineKey: "quarantine/quota-other-reservation",
      expiresAt: uploadQuotaExpiry,
      maxWorkspaceStorageBytes: uploadQuotaLimit,
    });
    assert.equal(otherReservation.created, true);
    const completedQuotaVersion = await createScienceArtifactVersion(handle.db, {
      workspaceId: uploadQuotaWorkspace.id,
      artifactId: winningUploadInput.artifactId,
      storageKey: "science/quota/manual-completed",
      sha256: winningUploadInput.expectedSha256,
      sizeBytes: winningUploadInput.expectedSizeBytes,
      mediaType: "application/octet-stream",
      metadata: { fixture: "quota-completion" },
      uploadReservationId: winningUploadResult.value.upload.id,
      maxWorkspaceStorageBytes: uploadQuotaLimit,
      createdBy: user.id,
    });
    assert.equal(completedQuotaVersion.created, true);
    const duplicateQuotaVersion = await createScienceArtifactVersion(handle.db, {
      workspaceId: uploadQuotaWorkspace.id,
      artifactId: winningUploadInput.artifactId,
      storageKey: "science/quota/manual-completed",
      sha256: winningUploadInput.expectedSha256,
      sizeBytes: winningUploadInput.expectedSizeBytes,
      mediaType: "application/octet-stream",
      metadata: { fixture: "quota-completion" },
      uploadReservationId: winningUploadResult.value.upload.id,
      maxWorkspaceStorageBytes: uploadQuotaLimit,
      createdBy: user.id,
    });
    assert.equal(
      duplicateQuotaVersion.created,
      false,
      "a deduplicated immutable version must not be charged again",
    );
    const readyQuotaVersion = await transitionScienceArtifactVersion(handle.db, {
      workspaceId: uploadQuotaWorkspace.id,
      versionId: completedQuotaVersion.version.id,
      to: "ready",
    });
    const quotaFinalizationLeaseId = "10000000-0000-4000-8000-000000000001";
    await claimScienceUploadFinalization(handle.db, {
      workspaceId: uploadQuotaWorkspace.id,
      tokenHash: winningUploadInput.tokenHash,
      leaseId: quotaFinalizationLeaseId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await finalizeScienceUpload(handle.db, {
      workspaceId: uploadQuotaWorkspace.id,
      tokenHash: winningUploadInput.tokenHash,
      leaseId: quotaFinalizationLeaseId,
      artifactVersionId: readyQuotaVersion.id,
      actualSha256: readyQuotaVersion.sha256,
    });
    await expectConflict(
      () =>
        createScienceArtifactVersion(handle.db, {
          workspaceId: uploadQuotaWorkspace.id,
          artifactId: uploadQuotaArtifacts[1 - winningUploadIndex].id,
          storageKey: "science/quota/one-byte-over",
          sha256: "e".repeat(64),
          sizeBytes: 1,
          mediaType: "application/octet-stream",
          maxWorkspaceStorageBytes: uploadQuotaLimit,
          createdBy: user.id,
        }),
      /storage quota/i,
    );
    await quarantineScienceUpload(handle.db, {
      workspaceId: uploadQuotaWorkspace.id,
      tokenHash: otherReservation.upload.tokenHash,
      error: "quota retention verification",
    });
    await expectConflict(
      () =>
        createScienceArtifactVersion(handle.db, {
          workspaceId: uploadQuotaWorkspace.id,
          artifactId: uploadQuotaArtifacts[1 - winningUploadIndex].id,
          storageKey: "science/quota/quarantined-reservation-over",
          sha256: "f".repeat(64),
          sizeBytes: 1,
          mediaType: "application/octet-stream",
          maxWorkspaceStorageBytes: uploadQuotaLimit,
          createdBy: user.id,
        }),
      /storage quota/i,
    );

    const [expiredQuotaWorkspace] = await handle.db
      .insert(workspaces)
      .values({ name: "Science expired reservation quota verification" })
      .returning();
    const expiredQuotaStudy = await createScienceStudy(handle.db, {
      workspaceId: expiredQuotaWorkspace.id,
      name: "Expired quota reservation",
      createdBy: user.id,
    });
    const expiredQuotaArtifact = await createScienceArtifact(handle.db, {
      workspaceId: expiredQuotaWorkspace.id,
      studyId: expiredQuotaStudy.id,
      logicalName: "expired-quota-reservation",
      kind: "dataset",
      format: "binary",
      createdBy: user.id,
    });
    const expiredQuotaBase = Date.now();
    const expiredQuotaUpload = await beginScienceUpload(handle.db, {
      workspaceId: expiredQuotaWorkspace.id,
      artifactId: expiredQuotaArtifact.id,
      tokenHash: "6".repeat(64),
      expectedSizeBytes: 4,
      expectedSha256: "7".repeat(64),
      quarantineKey: "quarantine/quota-expired",
      expiresAt: new Date(expiredQuotaBase + 10_000),
      maxWorkspaceStorageBytes: 4,
    });
    const expiredQuotaRows = await cleanupExpiredScienceUploads(handle.db, {
      workspaceId: expiredQuotaWorkspace.id,
      now: new Date(expiredQuotaBase + 20_000),
    });
    assert.deepEqual(
      expiredQuotaRows.map((upload) => upload.id),
      [expiredQuotaUpload.upload.id],
    );
    await expectConflict(
      () =>
        createScienceArtifactVersion(handle.db, {
          workspaceId: expiredQuotaWorkspace.id,
          artifactId: expiredQuotaArtifact.id,
          storageKey: "science/quota/expired-before-delete-proof",
          sha256: "8".repeat(64),
          sizeBytes: 1,
          mediaType: "application/octet-stream",
          maxWorkspaceStorageBytes: 4,
          createdBy: user.id,
        }),
      /storage quota/i,
    );
    assert.equal(
      await deleteExpiredScienceUploadAfterDiscard(handle.db, {
        workspaceId: expiredQuotaWorkspace.id,
        uploadId: expiredQuotaUpload.upload.id,
      }),
      true,
    );
    assert.equal(
      (
        await createScienceArtifactVersion(handle.db, {
          workspaceId: expiredQuotaWorkspace.id,
          artifactId: expiredQuotaArtifact.id,
          storageKey: "science/quota/after-delete-proof",
          sha256: "8".repeat(64),
          sizeBytes: 1,
          mediaType: "application/octet-stream",
          maxWorkspaceStorageBytes: 4,
          createdBy: user.id,
        })
      ).created,
      true,
    );

    const [versionQuotaWorkspace] = await handle.db
      .insert(workspaces)
      .values({ name: "Science version quota verification" })
      .returning();
    const versionQuotaStudies = await Promise.all([
      createScienceStudy(handle.db, {
        workspaceId: versionQuotaWorkspace.id,
        name: "Quota version A",
        createdBy: user.id,
      }),
      createScienceStudy(handle.db, {
        workspaceId: versionQuotaWorkspace.id,
        name: "Quota version B",
        createdBy: user.id,
      }),
    ]);
    const versionQuotaArtifacts = await Promise.all(
      versionQuotaStudies.map((quotaStudy, index) =>
        createScienceArtifact(handle.db, {
          workspaceId: versionQuotaWorkspace.id,
          studyId: quotaStudy.id,
          logicalName: `quota-version-${index}`,
          kind: "result",
          format: "binary",
          createdBy: user.id,
        }),
      ),
    );
    const racingVersions = await Promise.allSettled(
      versionQuotaArtifacts.map((artifact, index) =>
        createScienceArtifactVersion(handle.db, {
          workspaceId: versionQuotaWorkspace.id,
          artifactId: artifact.id,
          storageKey: `science/quota/provider-${index}`,
          sha256: (index === 0 ? "1" : "2").repeat(64),
          sizeBytes: 6,
          mediaType: "application/octet-stream",
          maxWorkspaceStorageBytes: 10,
          createdBy: user.id,
        }),
      ),
    );
    assert.equal(
      racingVersions.filter((result) => result.status === "fulfilled").length,
      1,
      "workspace row fencing must admit only one racing provider/version object",
    );
    const winningVersion = racingVersions.find(
      (result) => result.status === "fulfilled",
    )?.value.version;
    assert.ok(winningVersion);
    const quarantinedQuotaVersion = await transitionScienceArtifactVersion(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      versionId: winningVersion.id,
      to: "quarantined",
    });
    for (const status of ["quarantined", "expired"]) {
      const current =
        status === "expired"
          ? await transitionScienceArtifactVersion(handle.db, {
              workspaceId: versionQuotaWorkspace.id,
              versionId: quarantinedQuotaVersion.id,
              to: "expired",
            })
          : quarantinedQuotaVersion;
      assert.equal(current.status, status);
      await expectConflict(
        () =>
          createScienceArtifactVersion(handle.db, {
            workspaceId: versionQuotaWorkspace.id,
            artifactId: versionQuotaArtifacts.find(
              (artifact) => artifact.id !== winningVersion.artifactId,
            ).id,
            storageKey: `science/quota/status-${status}`,
            sha256: (status === "expired" ? "4" : "3").repeat(64),
            sizeBytes: 5,
            mediaType: "application/octet-stream",
            maxWorkspaceStorageBytes: 10,
            createdBy: user.id,
          }),
        /storage quota/i,
      );
    }
    assert.equal(
      await deleteExpiredScienceArtifactVersionAfterDiscard(handle.db, {
        workspaceId: versionQuotaWorkspace.id,
        versionId: winningVersion.id,
      }),
      true,
      "expired bytes release quota only after the repository receives discard proof",
    );
    const cleanupQuotaVersion = await createScienceArtifactVersion(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      artifactId: versionQuotaArtifacts.find(
        (artifact) => artifact.id !== winningVersion.artifactId,
      ).id,
      storageKey: "science/quota/provider-cleanup",
      sha256: "5".repeat(64),
      sizeBytes: 4,
      mediaType: "application/octet-stream",
      cleanupEligible: true,
      maxWorkspaceStorageBytes: 10,
      createdBy: user.id,
    });
    await transitionScienceArtifactVersion(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      versionId: cleanupQuotaVersion.version.id,
      to: "quarantined",
    });
    const cleanupQuotaCandidates = await cleanupScienceArtifactVersionQuarantine(
      handle.db,
      {
        workspaceId: versionQuotaWorkspace.id,
        olderThan: new Date(Date.now() + 1_000),
      },
    );
    assert.deepEqual(
      cleanupQuotaCandidates.map((version) => version.id),
      [cleanupQuotaVersion.version.id],
      "cleanup-eligible quarantined versions must remain retry-discoverable",
    );
    assert.equal(
      await deleteExpiredScienceArtifactVersionAfterDiscard(handle.db, {
        workspaceId: versionQuotaWorkspace.id,
        versionId: cleanupQuotaVersion.version.id,
      }),
      true,
    );
    const retainedAfterCleanup = await createScienceArtifactVersion(handle.db, {
          workspaceId: versionQuotaWorkspace.id,
          artifactId: cleanupQuotaVersion.version.artifactId,
          storageKey: "science/quota/provider-after-cleanup",
          sha256: "6".repeat(64),
          sizeBytes: 4,
          mediaType: "application/octet-stream",
          maxWorkspaceStorageBytes: 10,
          createdBy: user.id,
        });
    assert.equal(
      retainedAfterCleanup.created,
      true,
      "version quota is released only after discard proof and tombstone finalization",
    );
    assert.equal(
      retainedAfterCleanup.version.version,
      cleanupQuotaVersion.version.version + 1,
      "an expired tombstone must prevent reuse of its immutable version ordinal",
    );
    const readyRetentionVersion = await transitionScienceArtifactVersion(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      versionId: retainedAfterCleanup.version.id,
      to: "ready",
    });
    await expectConflict(
      () => claimScienceArtifactVersionRetention(handle.db, {
        workspaceId: versionQuotaWorkspace.id,
        versionId: readyRetentionVersion.id,
        expectedSha256: "0".repeat(64),
      }),
      /confirmation checksum/i,
    );
    const retentionClaim = await claimScienceArtifactVersionRetention(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      versionId: readyRetentionVersion.id,
      expectedSha256: readyRetentionVersion.sha256,
    });
    assert.equal(retentionClaim.status, "expired");
    assert.equal(
      await deleteExpiredScienceArtifactVersionAfterDiscard(handle.db, {
        workspaceId: versionQuotaWorkspace.id,
        versionId: readyRetentionVersion.id,
      }),
      true,
      "confirmed unreferenced ready content must release retained quota after discard",
    );
    const retainedReadyTombstone = await getScienceArtifactVersionForWorkspace(
      handle.db,
      versionQuotaWorkspace.id,
      readyRetentionVersion.id,
    );
    assert.equal(retainedReadyTombstone?.status, "expired");
    assert.equal(retainedReadyTombstone?.cleanupEligible, false);
    const rotationVersions = [];
    for (const [suffix, sha] of [["a", "7".repeat(64)], ["b", "8".repeat(64)]]) {
      const created = await createScienceArtifactVersion(handle.db, {
        workspaceId: versionQuotaWorkspace.id,
        artifactId: readyRetentionVersion.artifactId,
        storageKey: `science/quota/cleanup-rotation-${suffix}`,
        sha256: sha,
        sizeBytes: 0,
        mediaType: "application/octet-stream",
        cleanupEligible: true,
        maxWorkspaceStorageBytes: 10,
        createdBy: user.id,
      });
      rotationVersions.push(await transitionScienceArtifactVersion(handle.db, {
        workspaceId: versionQuotaWorkspace.id,
        versionId: created.version.id,
        to: "quarantined",
      }));
    }
    const rotationNow = new Date();
    const rotationCandidates = await cleanupScienceArtifactVersionQuarantine(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      olderThan: new Date(rotationNow.getTime() + 1_000),
      now: rotationNow,
      limit: 10,
    });
    assert.deepEqual(
      new Set(rotationCandidates.map((version) => version.id)),
      new Set(rotationVersions.map((version) => version.id)),
    );
    const deferredVersion = rotationCandidates[0];
    const laterVersion = rotationCandidates[1];
    await deferScienceArtifactVersionCleanup(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      versionId: deferredVersion.id,
      retryAt: new Date(rotationNow.getTime() + 60_000),
    });
    const rotatedCandidates = await cleanupScienceArtifactVersionQuarantine(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      olderThan: new Date(rotationNow.getTime() + 1_000),
      now: new Date(rotationNow.getTime() + 1_000),
      limit: 10,
    });
    assert.equal(
      rotatedCandidates.some((version) => version.id === deferredVersion.id),
      false,
      "a failed cleanup row must remain quota-charged but back off durably",
    );
    assert.equal(
      rotatedCandidates.some((version) => version.id === laterVersion.id),
      true,
      "a deferred prefix row must not starve later cleanup candidates",
    );
    for (const version of rotationVersions) {
      await deleteExpiredScienceArtifactVersionAfterDiscard(handle.db, {
        workspaceId: versionQuotaWorkspace.id,
        versionId: version.id,
      });
    }

    const providerReservationNow = new Date();
    const providerReservationToken = "e".repeat(64);
    const providerTransferLeaseId = "20000000-0000-4000-8000-000000000006";
    const providerReservation = await beginScienceUpload(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      artifactId: readyRetentionVersion.artifactId,
      tokenHash: providerReservationToken,
      expectedSizeBytes: 0,
      expectedSha256: "c".repeat(64),
      quarantineKey: "quarantine/provider-promotion-fence",
      expiresAt: new Date(providerReservationNow.getTime() + 120_000),
      maxWorkspaceStorageBytes: 10,
    });
    await claimScienceUploadTransfer(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      tokenHash: providerReservationToken,
      leaseId: providerTransferLeaseId,
      leaseExpiresAt: new Date(providerReservationNow.getTime() + 120_000),
      now: providerReservationNow,
    });
    await recordScienceUploadProgress(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      tokenHash: providerReservationToken,
      leaseId: providerTransferLeaseId,
      receivedBytes: 0,
      readyExpiresAt: new Date(providerReservationNow.getTime() + 120_000),
      retainTransferLease: true,
      now: new Date(providerReservationNow.getTime() + 1),
    });
    const providerPendingVersion = await createScienceArtifactVersion(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      artifactId: readyRetentionVersion.artifactId,
      storageKey: "science/quota/provider-promotion-fence",
      sha256: "c".repeat(64),
      sizeBytes: 0,
      mediaType: "application/octet-stream",
      cleanupEligible: true,
      uploadReservationId: providerReservation.upload.id,
      uploadReservationMode: "provider_output",
      maxWorkspaceStorageBytes: 10,
      createdBy: user.id,
    });
    assert.equal(
      (
        await getScienceUploadByTokenHash(
          handle.db,
          versionQuotaWorkspace.id,
          providerReservationToken,
        )
      )?.id,
      providerReservation.upload.id,
      "provider reservation must survive pending-version admission and promotion",
    );
    const providerPromotionCleanup = await cleanupScienceArtifactVersionQuarantine(
      handle.db,
      {
        workspaceId: versionQuotaWorkspace.id,
        olderThan: new Date(providerReservationNow.getTime() + 5_000),
        now: new Date(providerReservationNow.getTime() + 60_000),
      },
    );
    assert.equal(
      providerPromotionCleanup.some(
        (version) => version.id === providerPendingVersion.version.id,
      ),
      false,
      "a live provider-output reservation must fence pending-version cleanup",
    );
    const providerTerminalVersion = await transitionScienceArtifactVersion(handle.db, {
      workspaceId: versionQuotaWorkspace.id,
      versionId: providerPendingVersion.version.id,
      to: "quarantined",
    });
    assert.equal(
      await deleteScienceProviderOutputReservationAfterCommit(handle.db, {
        workspaceId: versionQuotaWorkspace.id,
        uploadId: providerReservation.upload.id,
        artifactVersionId: providerTerminalVersion.id,
        leaseId: providerTransferLeaseId,
        now: new Date(providerReservationNow.getTime() + 2),
      }),
      true,
    );
    assert.equal(
      await getScienceUploadByTokenHash(
        handle.db,
        versionQuotaWorkspace.id,
        providerReservationToken,
      ),
      null,
    );
    const providerTerminalCleanup = await cleanupScienceArtifactVersionQuarantine(
      handle.db,
      {
        workspaceId: versionQuotaWorkspace.id,
        olderThan: new Date(providerReservationNow.getTime() + 5_000),
        now: new Date(providerReservationNow.getTime() + 60_000),
      },
    );
    assert.ok(
      providerTerminalCleanup.some((version) => version.id === providerTerminalVersion.id),
      "provider-version cleanup must resume only after terminal reservation release",
    );
    assert.equal(
      await deleteExpiredScienceArtifactVersionAfterDiscard(handle.db, {
        workspaceId: versionQuotaWorkspace.id,
        versionId: providerTerminalVersion.id,
      }),
      true,
    );

    const study = await createScienceStudy(handle.db, {
      workspaceId: workspaceA.id,
      name: "Deterministic CFD fixture",
      description: "Non-regulated deterministic verification",
      createdBy: user.id,
    });
    assert.equal(
      (await getScienceStudyForWorkspace(handle.db, workspaceA.id, study.id))?.id,
      study.id,
    );
    assert.equal(
      await getScienceStudyForWorkspace(handle.db, workspaceB.id, study.id),
      null,
    );

    const inputArtifact = await createScienceArtifact(handle.db, {
      workspaceId: workspaceA.id,
      studyId: study.id,
      logicalName: "mesh-input",
      kind: "geometry",
      format: "application/vnd.test.mesh",
      createdBy: user.id,
    });
    assert.equal(
      (
        await getScienceArtifactByLogicalName(handle.db, {
          workspaceId: workspaceA.id,
          studyId: study.id,
          logicalName: "mesh-input",
        })
      )?.id,
      inputArtifact.id,
    );
    assert.equal(
      await getScienceArtifactByLogicalName(handle.db, {
        workspaceId: workspaceB.id,
        studyId: study.id,
        logicalName: "mesh-input",
      }),
      null,
    );

    const inputVersionResult = await createScienceArtifactVersion(handle.db, {
      workspaceId: workspaceA.id,
      artifactId: inputArtifact.id,
      storageKey: `science/${study.id}/mesh-input/v1`,
      sha256: SHA_INPUT,
      sizeBytes: 12,
      mediaType: "application/octet-stream",
      metadata: { coordinateSystem: "cartesian" },
      maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
      createdBy: user.id,
    });
    const duplicateVersion = await createScienceArtifactVersion(handle.db, {
      workspaceId: workspaceA.id,
      artifactId: inputArtifact.id,
      storageKey: `science/${study.id}/mesh-input/v1`,
      sha256: SHA_INPUT,
      sizeBytes: 12,
      mediaType: "application/octet-stream",
      metadata: { coordinateSystem: "cartesian" },
      maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
      createdBy: user.id,
    });
    assert.equal(inputVersionResult.created, true);
    assert.equal(duplicateVersion.created, false);
    assert.equal(duplicateVersion.version.id, inputVersionResult.version.id);
    await expectConflict(
      () =>
        createScienceArtifactVersion(handle.db, {
          workspaceId: workspaceA.id,
          artifactId: inputArtifact.id,
          storageKey: `science/${study.id}/mesh-input/v2`,
          sha256: SHA_CHILD,
          sizeBytes: 13,
          mediaType: "application/octet-stream",
          parentVersionId: inputVersionResult.version.id,
          maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
          createdBy: user.id,
        }),
      /parent must be ready/,
    );

    const uploadExpiry = new Date(Date.now() + 60_000);
    const firstUpload = await beginScienceUpload(handle.db, {
      workspaceId: workspaceA.id,
      artifactId: inputArtifact.id,
      tokenHash: TOKEN_1,
      expectedSizeBytes: 12,
      expectedSha256: SHA_INPUT,
      quarantineKey: `quarantine/${study.id}/mesh-input`,
      expiresAt: uploadExpiry,
      maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
    });
    const duplicateUpload = await beginScienceUpload(handle.db, {
      workspaceId: workspaceA.id,
      artifactId: inputArtifact.id,
      tokenHash: TOKEN_1,
      expectedSizeBytes: 12,
      expectedSha256: SHA_INPUT,
      quarantineKey: `quarantine/${study.id}/mesh-input`,
      expiresAt: uploadExpiry,
      maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
    });
    assert.equal(firstUpload.created, true);
    assert.equal(duplicateUpload.created, false);

    const externalCapTokens = ["12".repeat(32), "34".repeat(32)];
    const externalCapUploads = await Promise.all(
      externalCapTokens.map((tokenHash, index) => beginScienceUpload(handle.db, {
        workspaceId: workspaceA.id,
        artifactId: inputArtifact.id,
        tokenHash,
        expectedSizeBytes: 0,
        expectedSha256: SHA_INPUT,
        quarantineKey: `quarantine/${study.id}/external-cap-${index}`,
        expiresAt: uploadExpiry,
        maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
      })),
    );
    const externalCapLeaseIds = [
      "20000000-0000-4000-8000-000000000010",
      "20000000-0000-4000-8000-000000000011",
    ];
    const externalCapStart = new Date();
    const externalCapClaims = await Promise.allSettled(
      externalCapTokens.map((tokenHash, index) => claimScienceUploadTransfer(handle.db, {
        workspaceId: workspaceA.id,
        tokenHash,
        leaseId: externalCapLeaseIds[index],
        leaseExpiresAt: new Date(externalCapStart.getTime() + 100),
        external: true,
        maxConcurrentExternalStreamsPerWorkspace: 1,
        now: externalCapStart,
      })),
    );
    assert.equal(
      externalCapClaims.filter((result) => result.status === "fulfilled").length,
      1,
      "workspace-row serialization must admit exactly one external stream",
    );
    const externalWinner = externalCapClaims.findIndex(
      (result) => result.status === "fulfilled",
    );
    const externalLoser = 1 - externalWinner;
    await renewScienceUploadTransfer(handle.db, {
      workspaceId: workspaceA.id,
      tokenHash: externalCapTokens[externalWinner],
      leaseId: externalCapLeaseIds[externalWinner],
      now: new Date(externalCapStart.getTime() + 50),
      leaseExpiresAt: new Date(externalCapStart.getTime() + 250),
    });
    await expectConflict(
      () => claimScienceUploadTransfer(handle.db, {
        workspaceId: workspaceA.id,
        tokenHash: externalCapTokens[externalLoser],
        leaseId: externalCapLeaseIds[externalLoser],
        leaseExpiresAt: new Date(externalCapStart.getTime() + 300),
        external: true,
        maxConcurrentExternalStreamsPerWorkspace: 1,
        now: new Date(externalCapStart.getTime() + 150),
      }),
      /external upload stream concurrency limit of 1/,
    );
    await claimScienceUploadTransfer(handle.db, {
      workspaceId: workspaceA.id,
      tokenHash: externalCapTokens[externalLoser],
      leaseId: externalCapLeaseIds[externalLoser],
      leaseExpiresAt: new Date(externalCapStart.getTime() + 500),
      external: true,
      maxConcurrentExternalStreamsPerWorkspace: 1,
      now: new Date(externalCapStart.getTime() + 251),
    });
    for (let index = 0; index < externalCapTokens.length; index++) {
      await quarantineScienceUpload(handle.db, {
        workspaceId: workspaceA.id,
        tokenHash: externalCapTokens[index],
        error: "external concurrency fence verification cleanup",
        cleanupEligible: true,
      });
      assert.equal(await deleteExpiredScienceUploadAfterDiscard(handle.db, {
        workspaceId: workspaceA.id,
        uploadId: externalCapUploads[index].upload.id,
      }), true);
    }

    const transferLeaseIds = [
      "20000000-0000-4000-8000-000000000002",
      "20000000-0000-4000-8000-000000000003",
    ];
    const transferClaims = await Promise.allSettled(
      transferLeaseIds.map((leaseId) => claimScienceUploadTransfer(handle.db, {
        workspaceId: workspaceA.id,
        tokenHash: TOKEN_1,
        leaseId,
        leaseExpiresAt: uploadExpiry,
      })),
    );
    assert.equal(
      transferClaims.filter((result) => result.status === "fulfilled").length,
      1,
      "exactly one concurrent upload request must claim the byte stream",
    );
    const rejectedTransfer = transferClaims.find(
      (result) => result.status === "rejected",
    );
    assert.ok(
      rejectedTransfer?.reason instanceof ScienceConflictError,
      "the losing upload request must fail as a science conflict",
    );
    const winningTransferIndex = transferClaims.findIndex(
      (result) => result.status === "fulfilled",
    );
    await recordScienceUploadProgress(handle.db, {
      workspaceId: workspaceA.id,
      tokenHash: TOKEN_1,
      leaseId: transferLeaseIds[winningTransferIndex],
      receivedBytes: 12,
      readyExpiresAt: uploadExpiry,
    });
    const inputVersion = await transitionScienceArtifactVersion(handle.db, {
      workspaceId: workspaceA.id,
      versionId: inputVersionResult.version.id,
      to: "ready",
    });
    const childVersion = await createScienceArtifactVersion(handle.db, {
      workspaceId: workspaceA.id,
      artifactId: inputArtifact.id,
      storageKey: `science/${study.id}/mesh-input/v2`,
      sha256: SHA_CHILD,
      sizeBytes: 13,
      mediaType: "application/octet-stream",
      parentVersionId: inputVersion.id,
      maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
      createdBy: user.id,
    });
    assert.equal(childVersion.created, true);
    assert.equal(childVersion.version.parentVersionId, inputVersion.id);
    const inputFinalizationLeaseId = "10000000-0000-4000-8000-000000000002";
    await claimScienceUploadFinalization(handle.db, {
      workspaceId: workspaceA.id,
      tokenHash: TOKEN_1,
      leaseId: inputFinalizationLeaseId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const completedUpload = await finalizeScienceUpload(handle.db, {
      workspaceId: workspaceA.id,
      tokenHash: TOKEN_1,
      leaseId: inputFinalizationLeaseId,
      artifactVersionId: inputVersion.id,
      actualSha256: SHA_INPUT,
    });
    assert.equal(completedUpload.state, "completed");

    const outputArtifact = await createScienceArtifact(handle.db, {
      workspaceId: workspaceA.id,
      studyId: study.id,
      logicalName: "pressure-result",
      kind: "result",
      format: "application/vnd.test.result",
      createdBy: user.id,
    });
    const outputVersionPending = await createScienceArtifactVersion(handle.db, {
      workspaceId: workspaceA.id,
      artifactId: outputArtifact.id,
      storageKey: `science/${study.id}/pressure-result/v1`,
      sha256: SHA_OUTPUT,
      sizeBytes: 24,
      mediaType: "application/octet-stream",
      maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
      createdBy: user.id,
    });
    const outputVersion = await transitionScienceArtifactVersion(handle.db, {
      workspaceId: workspaceA.id,
      versionId: outputVersionPending.version.id,
      to: "ready",
    });

    const profile = await createScienceComputeProfile(handle.db, {
      workspaceId: workspaceA.id,
      name: "Local deterministic Python",
      providerKind: "local_container",
      imageDigest: IMAGE,
      kernelName: "python3",
      resourceBounds: RESOURCE_CEILING,
      config: { network: "none" },
    });
    await expectConflict(
      () =>
        createScienceRun(handle.db, {
          workspaceId: workspaceA.id,
          studyId: study.id,
          computeProfileId: profile.id,
          resourceRequest: { ...RESOURCE_REQUEST, memoryMb: 16_384 },
          idempotencyKey: "too-large",
          inputs: [{ artifactVersionId: inputVersion.id, semanticRole: "mesh" }],
          createdBy: user.id,
        }),
      /exceeds profile ceiling/,
    );

    const createdRun = await createScienceRun(handle.db, {
      workspaceId: workspaceA.id,
      studyId: study.id,
      computeProfileId: profile.id,
      resourceRequest: RESOURCE_REQUEST,
      idempotencyKey: "run-1",
      inputs: [{ artifactVersionId: inputVersion.id, semanticRole: "mesh" }],
      parameters: { reynolds: 12_000 },
      createdBy: user.id,
    });
    const duplicateRun = await createScienceRun(handle.db, {
      workspaceId: workspaceA.id,
      studyId: study.id,
      computeProfileId: profile.id,
      resourceRequest: RESOURCE_REQUEST,
      idempotencyKey: "run-1",
      inputs: [{ artifactVersionId: inputVersion.id, semanticRole: "mesh" }],
      parameters: { reynolds: 12_000 },
      createdBy: user.id,
    });
    assert.equal(createdRun.created, true);
    assert.equal(duplicateRun.created, false);
    assert.equal(duplicateRun.run.id, createdRun.run.id);
    assert.equal(createdRun.mission.kind, "science");
    assert.equal(createdRun.mission.subjectId, createdRun.run.id);
    await expectConflict(
      () => claimScienceArtifactVersionRetention(handle.db, {
        workspaceId: workspaceA.id,
        versionId: inputVersion.id,
        expectedSha256: inputVersion.sha256,
      }),
      /run-linked/i,
    );
    assert.equal(
      (
        await getScienceRunByMissionForWorkspace(
          handle.db,
          workspaceA.id,
          createdRun.mission.id,
        )
      )?.id,
      createdRun.run.id,
    );

    const concurrentIntents = [
      [{ artifactVersionId: inputVersion.id, semanticRole: "primary" }],
      [{ artifactVersionId: outputVersion.id, semanticRole: "alternate" }],
    ];
    const concurrentResults = await Promise.allSettled(
      concurrentIntents.map((inputs) =>
        createScienceRun(handle.db, {
          workspaceId: workspaceA.id,
          studyId: study.id,
          computeProfileId: profile.id,
          resourceRequest: RESOURCE_REQUEST,
          idempotencyKey: "run-concurrent",
          inputs,
          createdBy: user.id,
        }),
      ),
    );
    const concurrentSuccesses = concurrentResults
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === "fulfilled");
    const concurrentFailures = concurrentResults.filter(
      (result) => result.status === "rejected",
    );
    assert.equal(concurrentSuccesses.length, 1);
    assert.equal(concurrentFailures.length, 1);
    assert.ok(
      concurrentFailures[0].reason instanceof ScienceConflictError,
      "the losing concurrent intent must fail as a science conflict",
    );
    const concurrentWinner = concurrentSuccesses[0];
    const concurrentRun = concurrentWinner.result.value;
    const winningInputs = concurrentIntents[concurrentWinner.index];
    assert.equal(concurrentRun.created, true);
    assert.deepEqual(
      (
        await listScienceRunArtifacts(handle.db, {
          workspaceId: workspaceA.id,
          runId: concurrentRun.run.id,
          direction: "input",
        })
      ).items.map((link) => ({
        artifactVersionId: link.artifactVersionId,
        semanticRole: link.semanticRole,
      })),
      winningInputs,
    );
    const concurrentReplay = await createScienceRun(handle.db, {
      workspaceId: workspaceA.id,
      studyId: study.id,
      computeProfileId: profile.id,
      resourceRequest: RESOURCE_REQUEST,
      idempotencyKey: "run-concurrent",
      inputs: winningInputs,
      createdBy: user.id,
    });
    assert.equal(concurrentReplay.created, false);
    await expectConflict(
      () =>
        createScienceRun(handle.db, {
          workspaceId: workspaceA.id,
          studyId: study.id,
          computeProfileId: profile.id,
          resourceRequest: RESOURCE_REQUEST,
          idempotencyKey: "run-concurrent",
          inputs: concurrentIntents[1 - concurrentWinner.index],
          createdBy: user.id,
        }),
      /different inputs/,
    );
    const concurrentApproval = await requestScienceRunApproval(handle.db, {
      workspaceId: workspaceA.id,
      runId: concurrentRun.run.id,
      expectedGeneration: 0,
      prompt: "Reject the idempotency concurrency fixture",
    });
    await resolveScienceRunApproval(handle.db, {
      workspaceId: workspaceA.id,
      runId: concurrentRun.run.id,
      expectedGeneration: 0,
      approvalId: concurrentApproval.approval.id,
      decision: "rejected",
    });
    const approval = await requestScienceRunApproval(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 0,
      prompt: "Approve deterministic CFD run",
    });
    assert.equal(approval.run.state, "awaiting_approval");
    assert.equal(approval.event.sequence, 1);
    await expectConflict(
      () =>
        transitionScienceRun(handle.db, {
          workspaceId: workspaceA.id,
          runId: createdRun.run.id,
          expectedGeneration: 0,
          to: "queued",
        }),
      /resolveScienceRunApproval/,
    );
    const approved = await resolveScienceRunApproval(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 0,
      approvalId: approval.approval.id,
      decision: "approved",
      maxActiveRuns: 1,
    });
    assert.equal(approved.run.state, "queued");
    assert.equal(approved.event.sequence, 2);
    assert.equal(await countActiveScienceRuns(handle.db, workspaceA.id), 1);
    assert.deepEqual(
      (await listRecoverableScienceRuns(handle.db, { workspaceId: workspaceA.id })).map(
        (run) => run.id,
      ),
      [createdRun.run.id],
    );

    const secondRun = await createScienceRun(handle.db, {
      workspaceId: workspaceA.id,
      studyId: study.id,
      computeProfileId: profile.id,
      resourceRequest: RESOURCE_REQUEST,
      idempotencyKey: "run-2",
      inputs: [{ artifactVersionId: inputVersion.id, semanticRole: "mesh" }],
      createdBy: user.id,
    });
    const secondApproval = await requestScienceRunApproval(handle.db, {
      workspaceId: workspaceA.id,
      runId: secondRun.run.id,
      expectedGeneration: 0,
      prompt: "Approve second run",
    });
    await expectConflict(
      () =>
        resolveScienceRunApproval(handle.db, {
          workspaceId: workspaceA.id,
          runId: secondRun.run.id,
          expectedGeneration: 0,
          approvalId: secondApproval.approval.id,
          decision: "approved",
          maxActiveRuns: 1,
        }),
      /quota/,
    );

    const claimed = await claimScienceRun(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 0,
    });
    assert.equal(claimed.executionGeneration, 1);
    await expectConflict(
      () =>
        appendScienceRunEvent(handle.db, {
          workspaceId: workspaceA.id,
          runId: createdRun.run.id,
          expectedGeneration: 0,
          leaseOwner: "worker-a",
          eventType: "science.run.progress",
          payload: { percent: 1 },
        }),
      /generation is stale/,
    );
    const leaseExpiry = new Date(Date.now() + 120_000);
    await acquireScienceRunLease(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 1,
      leaseOwner: "worker-a",
      leaseExpiresAt: leaseExpiry,
    });
    const submitAttempt = await recordScienceRunSubmitAttempt(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 1,
      leaseOwner: "worker-a",
      providerKind: "local_container",
      providerInstanceId: "runtime-instance-a",
      idempotencyKey: `${createdRun.run.id}:1`,
    });
    assert.equal(submitAttempt.created, true);
    assert.equal(submitAttempt.event?.eventType, "science.run.submit_attempted");
    assert.deepEqual(
      await getScienceRunSubmitAttempt(handle.db, {
        workspaceId: workspaceA.id,
        runId: createdRun.run.id,
        expectedGeneration: 1,
      }),
      submitAttempt.attempt,
    );
    const submitAttemptReplay = await recordScienceRunSubmitAttempt(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 1,
      leaseOwner: "worker-a",
      providerKind: "local_container",
      providerInstanceId: "runtime-instance-a",
      idempotencyKey: `${createdRun.run.id}:1`,
    });
    assert.equal(submitAttemptReplay.created, false);
    assert.equal(submitAttemptReplay.event, null);
    await expectConflict(
      () =>
        recordScienceRunSubmitAttempt(handle.db, {
          workspaceId: workspaceA.id,
          runId: createdRun.run.id,
          expectedGeneration: 1,
          leaseOwner: "worker-a",
          providerKind: "local_container",
          providerInstanceId: "runtime-instance-b",
          idempotencyKey: `${createdRun.run.id}:1`,
        }),
      /identity is immutable/,
    );
    await expectConflict(
      () =>
        acquireScienceRunLease(handle.db, {
          workspaceId: workspaceA.id,
          runId: createdRun.run.id,
          expectedGeneration: 1,
          leaseOwner: "worker-b",
          leaseExpiresAt: new Date(Date.now() + 180_000),
        }),
      /live worker lease/,
    );
    await renewScienceRunLease(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 1,
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date(leaseExpiry.getTime() + 60_000),
    });
    await releaseScienceRunLease(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 1,
      leaseOwner: "worker-a",
    });
    await acquireScienceRunLease(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 1,
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date(Date.now() + 180_000),
    });
    await setScienceRunProviderHandle(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 1,
      leaseOwner: "worker-a",
      providerHandle: "container:fixture",
    });
    const running = await transitionScienceRun(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 1,
      leaseOwner: "worker-a",
      to: "running",
    });
    assert.equal(running.state, "running");
    await expectConflict(
      () =>
        appendScienceRunEvent(handle.db, {
          workspaceId: workspaceA.id,
          runId: createdRun.run.id,
          expectedGeneration: 1,
          leaseOwner: "worker-b",
          eventType: "science.run.progress",
          payload: { percent: 5 },
        }),
      /another worker/,
    );
    const progress = await appendScienceRunEvent(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 1,
      leaseOwner: "worker-a",
      eventType: "science.run.progress",
      payload: { percent: 50 },
    });
    assert.equal(progress.sequence, 6);
    await linkScienceRunArtifact(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 1,
      leaseOwner: "worker-a",
      artifactVersionId: outputVersion.id,
      direction: "output",
      semanticRole: "pressure-field",
    });
    const finalizing = await transitionScienceRun(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 1,
      leaseOwner: "worker-a",
      to: "finalizing",
    });
    const manifest = {
      schemaVersion: 1,
      studyId: study.id,
      runId: createdRun.run.id,
      missionId: createdRun.mission.id,
      inputs: [
        {
          artifactVersionId: inputVersion.id,
          sha256: inputVersion.sha256,
          sizeBytes: inputVersion.sizeBytes,
          semanticRole: "mesh",
        },
      ],
      outputs: [
        {
          artifactVersionId: outputVersion.id,
          sha256: outputVersion.sha256,
          sizeBytes: outputVersion.sizeBytes,
          semanticRole: "pressure-field",
        },
      ],
      codeArtifactVersionId: null,
      sourceRevision: "fixture-revision",
      compute: {
        ...createdRun.run.profileSnapshot,
        requestedResources: RESOURCE_REQUEST,
        adapterVersion: "local-container-test-1",
        dependencyLock: { python: "3.12" },
      },
      parameters: { reynolds: 12_000 },
      units: { pressure: "Pa" },
      randomSeeds: { solver: 7 },
      environment: { TZ: "UTC" },
      actorId: user.id,
      approvalIds: [approval.approval.id],
      policyIds: [],
      toolCalls: ["solver.execute"],
      startedAt: finalizing.startedAt?.toISOString() ?? null,
      finishedAt: new Date().toISOString(),
      history: [],
      validations: [{ name: "residual", passed: true }],
      limitations: [],
      complete: true,
      gaps: [],
    };
    await expectConflict(
      () => transitionScienceRun(handle.db, {
        workspaceId: workspaceA.id,
        runId: createdRun.run.id,
        expectedGeneration: 1,
        leaseOwner: "worker-a",
        to: "succeeded",
        manifest,
      }),
      /source revision is unverified.*immutable code input/i,
    );
    const structurallyUnderreportedManifest = {
      ...manifest,
      sourceRevision: null,
      compute: {
        ...manifest.compute,
        dependencyLock: {},
      },
      complete: false,
      // The caller names the code gap but tries to hide the missing lock.
      gaps: ["manifest.codeArtifactVersionId"],
    };
    await expectConflict(
      () => transitionScienceRun(handle.db, {
        workspaceId: workspaceA.id,
        runId: createdRun.run.id,
        expectedGeneration: 1,
        leaseOwner: "worker-a",
        to: "succeeded",
        manifest: structurallyUnderreportedManifest,
      }),
      /complete and gaps must exactly match the current structural assessment/i,
    );
    const incompleteManifest = {
      ...manifest,
      sourceRevision: null,
      complete: false,
      gaps: ["manifest.codeArtifactVersionId"],
    };
    const succeeded = await transitionScienceRun(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      expectedGeneration: 1,
      leaseOwner: "worker-a",
      to: "succeeded",
      manifest: incompleteManifest,
    });
    assert.equal(succeeded.state, "succeeded");
    assert.match(succeeded.manifestHash, /^[0-9a-f]{64}$/);
    assert.equal(succeeded.leaseOwner, null);
    assert.equal(succeeded.leaseExpiresAt, null);
    assert.deepEqual(
      scienceDomainValidationRunLockOrder(
        succeeded.id.toUpperCase(),
        workspaceB.id,
      ),
      scienceDomainValidationRunLockOrder(
        succeeded.id,
        workspaceB.id.toUpperCase(),
      ),
      "mixed-case representations of one pair must never reverse the run-lock order",
    );
    await assert.rejects(
      () => createScienceDomainValidation(handle.db, {
        workspaceId: workspaceA.id,
        runId: succeeded.id,
        reviewerId: user.id,
        reviewerRole: "admin",
        kind: "domain-validation",
        metric: "synthetic-output-count",
        tolerance: 0,
        observedValue: succeeded.manifest.outputs.length,
        units: "count",
        methodProtocolId: "synthetic-lifecycle-protocol/v1",
        decision: true,
        limitationsReason: "Synthetic lifecycle fixture; not release or domain evidence.",
      }),
      /reviewer must be a current admin or owner/i,
      "a repository caller cannot spoof a different reviewer role",
    );
    await assert.rejects(
      () => createScienceDomainValidation(handle.db, {
        workspaceId: workspaceA.id,
        runId: succeeded.id,
        reviewerId: user.id,
        reviewerRole: "owner",
        kind: "domain-validation",
        metric: "synthetic-output-count",
        tolerance: 0,
        observedValue: succeeded.manifest.outputs.length,
        units: "count",
        methodProtocolId: "synthetic-lifecycle-protocol/v1",
        decision: true,
        limitationsReason: "Synthetic lifecycle fixture; not release or domain evidence.",
        createdAt: new Date("2000-01-01T00:00:00.000Z"),
      }),
      /revision and createdAt are database-assigned/i,
      "a repository caller cannot control validation precedence or display time",
    );
    const rejectedValidationAudits = await handle.db.execute(sql.raw(
      "SELECT count(*) AS copies FROM audit_log WHERE target LIKE 'science_domain_validations:%'",
    ));
    assert.equal(Number((rejectedValidationAudits.rows ?? rejectedValidationAudits)[0].copies), 0);
    const domainValidation = await createScienceDomainValidation(handle.db, {
      workspaceId: workspaceA.id.toUpperCase(),
      runId: succeeded.id.toUpperCase(),
      reviewerId: user.id.toUpperCase(),
      reviewerRole: "owner",
      kind: "domain-validation",
      metric: "synthetic-output-count",
      tolerance: 0,
      observedValue: succeeded.manifest.outputs.length,
      units: "count",
      methodProtocolId: "synthetic-lifecycle-protocol/v1",
      decision: true,
      limitationsReason: "Synthetic lifecycle fixture; not release or domain evidence.",
    });
    assert.equal(domainValidation.runManifestHash, succeeded.manifestHash);
    assert.equal(domainValidation.workspaceId, workspaceA.id);
    assert.equal(domainValidation.runId, succeeded.id);
    assert.equal(domainValidation.reviewerId, user.id);
    assert.equal(domainValidation.revision, 1);
    assert.deepEqual(domainValidation.runOutputChecksums, succeeded.manifest.outputs);
    assert.equal(domainValidation.reviewerId, user.id);
    assert.equal(domainValidation.reviewerRole, "owner");
    assert.equal(verifyScienceDomainValidationRecordHash(domainValidation), true);
    assert.equal(
      verifyScienceDomainValidationRecordHash({
        ...domainValidation,
        decision: !domainValidation.decision,
      }),
      false,
      "the stable record hash must detect a changed review decision",
    );
    assert.equal(
      verifyScienceDomainValidationRecordHash({
        ...domainValidation,
        revision: domainValidation.revision + 1,
      }),
      false,
      "the stable record hash must bind the candidate-run revision",
    );
    const validationAudits = await handle.db.execute(sql`
      SELECT actor_kind, actor_id, action, target
        FROM audit_log
       WHERE target = ${`science_domain_validations:${domainValidation.id}`}
    `);
    assert.deepEqual(validationAudits.rows ?? validationAudits, [{
      actor_kind: "system",
      actor_id: "science-db",
      action: "science.db.insert",
      target: `science_domain_validations:${domainValidation.id}`,
    }], "direct repository writes retain the explicit database-system fallback audit");
    const validationHeadResult = await handle.db.execute(sql`
      SELECT id, workspace_id, run_id, kind, scope_baseline_run_id,
             validation_id, revision, record_hash, head_hash
        FROM science_domain_validation_heads
       WHERE workspace_id = ${workspaceA.id}
         AND run_id = ${succeeded.id}
         AND kind = 'domain-validation'
         AND scope_baseline_run_id = ${succeeded.id}
    `);
    const [validationHead] = validationHeadResult.rows ?? validationHeadResult;
    assert.equal(validationHead.validation_id, domainValidation.id);
    assert.equal(Number(validationHead.revision), 1);
    assert.equal(validationHead.record_hash, domainValidation.recordHash);
    assert.match(validationHead.head_hash, /^[0-9a-f]{64}$/);
    const validationHeadAudits = await handle.db.execute(sql`
      SELECT actor_kind, actor_id, action, target, detail
        FROM audit_log
       WHERE target = ${`science_domain_validation_heads:${validationHead.id}`}
    `);
    assert.deepEqual(validationHeadAudits.rows ?? validationHeadAudits, [{
      actor_kind: "system",
      actor_id: "science-db",
      action: "science.db.insert",
      target: `science_domain_validation_heads:${validationHead.id}`,
      detail: {
        operation: "insert",
        table: "science_domain_validation_heads",
        validationId: domainValidation.id,
        revision: 1,
        recordHash: domainValidation.recordHash,
        headHash: validationHead.head_hash,
      },
    }], "the mutable scope head must retain its own atomic integrity trail");
    const validationPage = await listScienceDomainValidations(handle.db, {
      workspaceId: workspaceA.id,
      runId: succeeded.id,
      page: { offset: 0, limit: 10 },
    });
    assert.deepEqual(validationPage.items.map((entry) => entry.id), [domainValidation.id]);
    assert.deepEqual(
      Object.keys(validationPage.items[0]).sort(),
      [
        "baselineManifestHash",
        "baselineRunId",
        "createdAt",
        "decision",
        "id",
        "kind",
        "limitationsReason",
        "methodProtocolId",
        "metric",
        "observedValue",
        "recordHash",
        "reviewerId",
        "reviewerRole",
        "revision",
        "runId",
        "runManifestHash",
        "tolerance",
        "units",
      ].sort(),
      "validation pages must be strict bounded summaries without checksum arrays",
    );
    assert.deepEqual(
      await getScienceDomainValidationForRun(handle.db, {
        workspaceId: workspaceA.id,
        runId: succeeded.id,
        validationId: domainValidation.id,
      }),
      domainValidation,
      "one-record detail retains the immutable checksum bindings",
    );
    const concurrentValidations = await Promise.all([false, true].map((decision, index) =>
      createScienceDomainValidation(handle.db, {
        workspaceId: workspaceA.id,
        runId: succeeded.id,
        reviewerId: user.id,
        reviewerRole: "owner",
        kind: "domain-validation",
        metric: `synthetic-concurrent-${index}`,
        tolerance: 0,
        observedValue: index,
        units: "count",
        methodProtocolId: "synthetic-lifecycle-protocol/v1",
        decision,
        limitationsReason: "Synthetic lifecycle fixture; not release or domain evidence.",
      })
    ));
    assert.deepEqual(
      concurrentValidations.map((entry) => entry.revision).sort((left, right) => left - right),
      [2, 3],
      "the candidate-run lock must serialize concurrent positive revisions",
    );
    const revisedValidationPage = await listScienceDomainValidations(handle.db, {
      workspaceId: workspaceA.id,
      runId: succeeded.id,
      page: { offset: 0, limit: 10 },
    });
    assert.deepEqual(
      revisedValidationPage.items.map((entry) => entry.revision),
      [3, 2, 1],
      "summary order must use revision rather than display time",
    );
    const latestDomainValidation = concurrentValidations.reduce((latest, entry) =>
      entry.revision > latest.revision ? entry : latest
    );
    const advancedHeadResult = await handle.db.execute(sql`
      SELECT id, validation_id, revision, record_hash, head_hash
        FROM science_domain_validation_heads
       WHERE workspace_id = ${workspaceA.id}
         AND run_id = ${succeeded.id}
         AND kind = 'domain-validation'
         AND scope_baseline_run_id = ${succeeded.id}
    `);
    const [advancedHead] = advancedHeadResult.rows ?? advancedHeadResult;
    assert.equal(advancedHead.id, validationHead.id, "head identity must stay stable as it advances");
    assert.equal(advancedHead.validation_id, latestDomainValidation.id);
    assert.equal(Number(advancedHead.revision), 3);
    assert.equal(advancedHead.record_hash, latestDomainValidation.recordHash);
    assert.notEqual(advancedHead.head_hash, validationHead.head_hash);
    const advancedHeadAudits = await handle.db.execute(sql`
      SELECT action
        FROM audit_log
       WHERE target = ${`science_domain_validation_heads:${advancedHead.id}`}
       ORDER BY created_at
    `);
    assert.deepEqual(
      (advancedHeadAudits.rows ?? advancedHeadAudits).map((entry) => entry.action),
      ["science.db.insert", "science.db.update", "science.db.update"],
      "each monotonic scope-head advance must be actor-attributed atomically",
    );

    await handle.db.execute(sql.raw("DROP TABLE science_domain_validation_heads"));
    await handle.db.execute(sql.raw(
      "DELETE FROM schema_migrations WHERE version = 13",
    ));
    await migrate(handle);
    const rebuiltHeadResult = await handle.db.execute(sql`
      SELECT id, validation_id, revision, record_hash, head_hash
        FROM science_domain_validation_heads
       WHERE workspace_id = ${workspaceA.id}
         AND run_id = ${succeeded.id}
         AND kind = 'domain-validation'
         AND scope_baseline_run_id = ${succeeded.id}
    `);
    const [rebuiltHead] = rebuiltHeadResult.rows ?? rebuiltHeadResult;
    assert.equal(rebuiltHead.id, advancedHead.id, "v12 backfill must derive deterministic scope identity");
    assert.equal(rebuiltHead.validation_id, latestDomainValidation.id);
    assert.equal(Number(rebuiltHead.revision), 3);
    assert.equal(rebuiltHead.record_hash, latestDomainValidation.recordHash);
    assert.match(rebuiltHead.head_hash, /^[0-9a-f]{64}$/);
    const v13LedgerResult = await handle.db.execute(sql.raw(
      "SELECT name, count(*) AS copies FROM schema_migrations WHERE version = 13 GROUP BY name",
    ));
    const [v13Ledger] = v13LedgerResult.rows ?? v13LedgerResult;
    assert.deepEqual({ name: v13Ledger.name, copies: Number(v13Ledger.copies) }, {
      name: "science-domain-validation-scope-heads",
      copies: 1,
    }, "a populated rewritten-v12 schema must upgrade and backfill deterministically");
    await expectConflict(
      () => createScienceDomainValidation(handle.db, {
        workspaceId: workspaceB.id,
        runId: succeeded.id,
        reviewerId: user.id,
        reviewerRole: "owner",
        kind: "domain-validation",
        metric: "synthetic-output-count",
        tolerance: 0,
        observedValue: succeeded.manifest.outputs.length,
        units: "count",
        methodProtocolId: "synthetic-lifecycle-protocol/v1",
        decision: true,
        limitationsReason: "Synthetic lifecycle fixture; not release or domain evidence.",
      }),
      /does not exist in workspace/i,
    );
    assert.deepEqual(await listScienceDomainValidations(handle.db, {
      workspaceId: workspaceB.id,
      runId: succeeded.id,
      page: { offset: 0, limit: 10 },
    }), { items: [], nextOffset: null });
    assert.equal(await getScienceDomainValidationForRun(handle.db, {
      workspaceId: workspaceB.id,
      runId: succeeded.id,
      validationId: domainValidation.id,
    }), null, "validation detail must not cross workspace scope");
    await assert.rejects(
      () => handle.db.execute(sql`
        UPDATE science_domain_validations
           SET decision = false
         WHERE id = ${domainValidation.id}
      `),
      /append-only/i,
    );
    const immutableValidationAudits = await handle.db.execute(sql`
      SELECT count(*) AS copies
        FROM audit_log
       WHERE target = ${`science_domain_validations:${domainValidation.id}`}
    `);
    assert.equal(
      Number((immutableValidationAudits.rows ?? immutableValidationAudits)[0].copies),
      1,
      "rejected append-only mutations must roll back their generic audit rows",
    );
    await assert.rejects(
      () => handle.db.execute(sql`
        DELETE FROM science_domain_validations
         WHERE id = ${domainValidation.id}
      `),
      /append-only/i,
    );
    await expectConflict(
      () =>
        linkScienceRunArtifact(handle.db, {
          workspaceId: workspaceA.id,
          runId: createdRun.run.id,
          expectedGeneration: 1,
          artifactVersionId: outputVersion.id,
          direction: "output",
          semanticRole: "late-output",
        }),
      /immutable/,
    );
    const events = await listScienceRunEvents(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      page: { offset: 0, limit: 20 },
    });
    assert.deepEqual(
      events.items.map((event) => event.sequence),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(
      (await getLatestScienceRunEvent(handle.db, workspaceA.id, createdRun.run.id))
        ?.sequence,
      8,
    );

    const rejected = await resolveScienceRunApproval(handle.db, {
      workspaceId: workspaceA.id,
      runId: secondRun.run.id,
      expectedGeneration: 0,
      approvalId: secondApproval.approval.id,
      decision: "rejected",
      maxActiveRuns: 1,
    });
    assert.equal(rejected.run.state, "cancelled");
    assert.equal(await countActiveScienceRuns(handle.db, workspaceA.id), 0);

    const renderBase = Date.now();
    const renderReplayFields = (requestKeyHash) => ({
      requestKeyHash,
      intentFingerprint: requestKeyHash,
      providerKind: "static",
      mode: "static",
      sourceSha256: outputVersion.sha256,
      sourceMediaType: outputVersion.mediaType,
      sourceSizeBytes: outputVersion.sizeBytes,
      sourceLogicalName: outputArtifact.logicalName,
      replayExpiresAt: new Date(renderBase + 24 * 60 * 60_000),
    });
    const render = await createScienceRenderSession(handle.db, {
      workspaceId: workspaceA.id,
      runId: createdRun.run.id,
      artifactVersionId: outputVersion.id,
      ...renderReplayFields(TOKEN_RENDER),
      tokenHash: TOKEN_RENDER,
      audience: "science-render-verification",
      ownerId: user.id,
      expiresAt: new Date(renderBase + 60_000),
      maxConcurrentSessions: 16,
    });
    const renderWithProvider = await setScienceRenderSessionProviderHandle(handle.db, {
      workspaceId: workspaceA.id,
      sessionId: render.session.id,
      ownerId: user.id,
      providerHandle: "render:fixture",
    });
    assert.equal(renderWithProvider.providerHandle, "render:fixture");
    assert.equal(
      (
        await setScienceRenderSessionProviderHandle(handle.db, {
          workspaceId: workspaceA.id,
          sessionId: render.session.id,
          ownerId: user.id,
          providerHandle: "render:fixture",
        })
      ).providerHandle,
      "render:fixture",
    );
    const readyRender = await transitionScienceRenderSession(handle.db, {
      workspaceId: workspaceA.id,
      sessionId: render.session.id,
      ownerId: user.id,
      to: "ready",
    });
    assert.equal(readyRender.state, "ready");
    await expectConflict(
      () => createScienceRenderSession(handle.db, {
        workspaceId: workspaceA.id,
        artifactVersionId: outputVersion.id,
        ...renderReplayFields("7".repeat(64)),
        tokenHash: "7".repeat(64),
        audience: "science-render-over-quota-verification",
        ownerId: user.id,
        expiresAt: new Date(renderBase + 60_000),
        maxConcurrentSessions: 1,
      }),
      /concurrency limit/i,
    );
    assert.equal(
      (
        await heartbeatScienceRenderSession(handle.db, {
          workspaceId: workspaceA.id,
          sessionId: readyRender.id,
          ownerId: user.id,
          extendExpiresAt: new Date(renderBase + 120_000),
        })
      ).state,
      "ready",
    );
    const liveRender = await createScienceRenderSession(handle.db, {
      workspaceId: workspaceA.id,
      artifactVersionId: outputVersion.id,
      ...renderReplayFields(TOKEN_RENDER_LIVE),
      tokenHash: TOKEN_RENDER_LIVE,
      audience: "science-render-live-verification",
      ownerId: user.id,
      expiresAt: new Date(renderBase + 240_000),
      maxConcurrentSessions: 16,
    });
    const terminalRender = await createScienceRenderSession(handle.db, {
      workspaceId: workspaceA.id,
      artifactVersionId: outputVersion.id,
      ...renderReplayFields(TOKEN_RENDER_TERMINAL),
      tokenHash: TOKEN_RENDER_TERMINAL,
      audience: "science-render-terminal-verification",
      ownerId: user.id,
      expiresAt: new Date(renderBase + 60_000),
      maxConcurrentSessions: 16,
    });
    await transitionScienceRenderSession(handle.db, {
      workspaceId: workspaceA.id,
      sessionId: terminalRender.session.id,
      ownerId: user.id,
      to: "revoked",
    });
    const renderCleanupAt = new Date(renderBase + 180_000);
    const renderCleanupResults = await Promise.all([
      cleanupExpiredScienceRenderSessions(handle.db, {
        workspaceId: workspaceA.id,
        now: renderCleanupAt,
      }),
      cleanupExpiredScienceRenderSessions(handle.db, {
        workspaceId: workspaceA.id,
        now: renderCleanupAt,
      }),
    ]);
    assert.deepEqual(
      renderCleanupResults.flat().map((session) => session.id),
      [readyRender.id],
      "concurrent render cleanup must have one winner",
    );
    assert.equal(
      (
        await getScienceRenderSessionForWorkspace(
          handle.db,
          workspaceA.id,
          liveRender.session.id,
        )
      )?.state,
      "starting",
      "unexpired render sessions are ineligible",
    );
    assert.equal(
      (
        await getScienceRenderSessionForWorkspace(
          handle.db,
          workspaceA.id,
          terminalRender.session.id,
        )
      )?.state,
      "revoked",
      "terminal render sessions are ineligible even after expiry",
    );

    const uploadBase = Date.now();
    const expiringUpload = await beginScienceUpload(handle.db, {
      workspaceId: workspaceA.id,
      artifactId: outputArtifact.id,
      tokenHash: TOKEN_2,
      expectedSizeBytes: 0,
      expectedSha256: SHA_UPLOAD_2,
      quarantineKey: `quarantine/${study.id}/expiry`,
      expiresAt: new Date(uploadBase + 10_000),
      maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
    });
    const quarantinedUpload = await beginScienceUpload(handle.db, {
      workspaceId: workspaceA.id,
      artifactId: outputArtifact.id,
      tokenHash: TOKEN_3,
      expectedSizeBytes: 0,
      expectedSha256: SHA_UPLOAD_3,
      quarantineKey: `quarantine/${study.id}/invalid`,
      expiresAt: new Date(uploadBase + 10_000),
      maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
    });
    assert.equal(
      (
        await quarantineScienceUpload(handle.db, {
          workspaceId: workspaceA.id,
          tokenHash: quarantinedUpload.upload.tokenHash,
          error: "scanner rejected fixture",
        })
      ).state,
      "quarantined",
    );
    const liveUpload = await beginScienceUpload(handle.db, {
      workspaceId: workspaceA.id,
      artifactId: outputArtifact.id,
      tokenHash: TOKEN_4,
      expectedSizeBytes: 0,
      expectedSha256: SHA_UPLOAD_4,
      quarantineKey: `quarantine/${study.id}/live`,
      expiresAt: new Date(uploadBase + 10_000),
      maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
    });
    const liveTransferLeaseId = "20000000-0000-4000-8000-000000000004";
    await claimScienceUploadTransfer(handle.db, {
      workspaceId: workspaceA.id,
      tokenHash: liveUpload.upload.tokenHash,
      leaseId: liveTransferLeaseId,
      leaseExpiresAt: new Date(uploadBase + 50_000),
      now: new Date(uploadBase + 1_000),
    });
    const finalizingUpload = await beginScienceUpload(handle.db, {
      workspaceId: workspaceA.id,
      artifactId: outputArtifact.id,
      tokenHash: "9".repeat(64),
      expectedSizeBytes: 0,
      expectedSha256: "a".repeat(64),
      quarantineKey: `quarantine/${study.id}/finalizing`,
      expiresAt: new Date(uploadBase + 10_000),
      maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
    });
    const finalizingTransferLeaseId = "20000000-0000-4000-8000-000000000005";
    await claimScienceUploadTransfer(handle.db, {
      workspaceId: workspaceA.id,
      tokenHash: finalizingUpload.upload.tokenHash,
      leaseId: finalizingTransferLeaseId,
      leaseExpiresAt: new Date(uploadBase + 20_000),
      now: new Date(uploadBase + 1_000),
    });
    await expectConflict(
      () => claimScienceUploadFinalization(handle.db, {
        workspaceId: workspaceA.id,
        tokenHash: finalizingUpload.upload.tokenHash,
        leaseId: "10000000-0000-4000-8000-000000000009",
        leaseExpiresAt: new Date(uploadBase + 30_000),
        now: new Date(uploadBase + 1_250),
      }),
      /cannot claim finalization/i,
    );
    await recordScienceUploadProgress(handle.db, {
      workspaceId: workspaceA.id,
      tokenHash: finalizingUpload.upload.tokenHash,
      leaseId: finalizingTransferLeaseId,
      receivedBytes: 0,
      readyExpiresAt: new Date(uploadBase + 30_000),
      now: new Date(uploadBase + 1_500),
    });
    const finalizingLeaseId = "10000000-0000-4000-8000-000000000003";
    await claimScienceUploadFinalization(handle.db, {
      workspaceId: workspaceA.id,
      tokenHash: finalizingUpload.upload.tokenHash,
      leaseId: finalizingLeaseId,
      now: new Date(uploadBase + 2_000),
      leaseExpiresAt: new Date(uploadBase + 40_000),
    });
    await expectConflict(
      () => claimScienceUploadFinalization(handle.db, {
        workspaceId: workspaceA.id,
        tokenHash: finalizingUpload.upload.tokenHash,
        leaseId: "10000000-0000-4000-8000-000000000004",
        now: new Date(uploadBase + 3_000),
        leaseExpiresAt: new Date(uploadBase + 50_000),
      }),
      /cannot claim finalization/i,
    );
    await renewScienceUploadFinalization(handle.db, {
      workspaceId: workspaceA.id,
      tokenHash: finalizingUpload.upload.tokenHash,
      leaseId: finalizingLeaseId,
      now: new Date(uploadBase + 30_000),
      leaseExpiresAt: new Date(uploadBase + 90_000),
    });
    const uploadProtectedVersions = [];
    for (const [label, upload] of [
      ["pending", expiringUpload],
      ["uploading", liveUpload],
      ["finalizing", finalizingUpload],
    ]) {
      const created = await createScienceArtifactVersion(handle.db, {
        workspaceId: workspaceA.id,
        artifactId: outputArtifact.id,
        storageKey: `science/upload-protection/${label}`,
        sha256: upload.upload.expectedSha256,
        sizeBytes: 0,
        mediaType: "application/octet-stream",
        cleanupEligible: true,
        maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
        createdBy: user.id,
      });
      uploadProtectedVersions.push(created.version);
    }
    const activeUploadVersionCleanup = await cleanupScienceArtifactVersionQuarantine(
      handle.db,
      {
        workspaceId: workspaceA.id,
        olderThan: new Date(Date.now() + 5_000),
        now: new Date(uploadBase + 5_000),
      },
    );
    assert.equal(
      activeUploadVersionCleanup.some((candidate) =>
        uploadProtectedVersions.some((version) => version.id === candidate.id)),
      false,
      "pending versions with live pending/uploading/finalizing uploads must be cleanup-fenced",
    );
    for (const version of uploadProtectedVersions) {
      assert.equal(
        (await getScienceArtifactVersionForWorkspace(
          handle.db,
          workspaceA.id,
          version.id,
        ))?.status,
        "pending",
      );
    }
    const uploadCleanupAt = new Date(uploadBase + 20_000);
    const uploadCleanupResults = await Promise.all([
      cleanupExpiredScienceUploads(handle.db, {
        workspaceId: workspaceA.id,
        now: uploadCleanupAt,
      }),
      cleanupExpiredScienceUploads(handle.db, {
        workspaceId: workspaceA.id,
        now: uploadCleanupAt,
      }),
    ]);
    const cleanupIds = new Set(
      uploadCleanupResults.flat().map((upload) => upload.id),
    );
    assert.deepEqual(
      [...cleanupIds].sort(),
      [expiringUpload.upload.id, quarantinedUpload.upload.id].sort(),
      "cleanup must include newly expired and prior quarantined reservations",
    );
    const retryableCleanup = await cleanupExpiredScienceUploads(handle.db, {
      workspaceId: workspaceA.id,
      now: uploadCleanupAt,
    });
    assert.deepEqual(
      new Set(retryableCleanup.map((upload) => upload.id)),
      new Set([expiringUpload.upload.id, quarantinedUpload.upload.id]),
      "a crash after terminalization must not hide reservations from retry cleanup",
    );
    assert.equal(
      (
        await getScienceUploadByTokenHash(
          handle.db,
          workspaceA.id,
          quarantinedUpload.upload.tokenHash,
        )
      )?.state,
      "quarantined",
      "quarantined reservations remain charged until discard proof",
    );
    assert.equal(
      (
        await getScienceUploadByTokenHash(
          handle.db,
          workspaceA.id,
          liveUpload.upload.tokenHash,
        )
      )?.state,
      "uploading",
      "unexpired uploads are ineligible",
    );
    assert.equal(
      (
        await getScienceUploadByTokenHash(
          handle.db,
          workspaceA.id,
          finalizingUpload.upload.tokenHash,
        )
      )?.state,
      "finalizing",
      "a renewed finalization lease must fence the cleanup worker",
    );
    await renewScienceUploadTransfer(handle.db, {
      workspaceId: workspaceA.id,
      tokenHash: liveUpload.upload.tokenHash,
      leaseId: liveTransferLeaseId,
      leaseExpiresAt: new Date(uploadBase + 80_000),
      now: new Date(uploadBase + 40_000),
    });
    const renewedTransferCleanup = await cleanupExpiredScienceUploads(handle.db, {
      workspaceId: workspaceA.id,
      now: new Date(uploadBase + 60_000),
    });
    assert.equal(
      renewedTransferCleanup.some((upload) => upload.id === liveUpload.upload.id),
      false,
      "a renewed byte-transfer lease must survive past the original upload expiry",
    );
    const finalizerExpiryCleanup = await cleanupExpiredScienceUploads(handle.db, {
      workspaceId: workspaceA.id,
      now: new Date(uploadBase + 100_000),
    });
    assert.ok(
      finalizerExpiryCleanup.some((upload) => upload.id === finalizingUpload.upload.id),
      "an abandoned finalizer becomes retry-cleanable after its renewed lease expires",
    );
    const abandonedUploadVersionCleanup = await cleanupScienceArtifactVersionQuarantine(
      handle.db,
      {
        workspaceId: workspaceA.id,
        olderThan: new Date(Date.now() + 5_000),
        now: new Date(uploadBase + 100_000),
      },
    );
    assert.ok(
      uploadProtectedVersions.every((version) =>
        abandonedUploadVersionCleanup.some((candidate) => candidate.id === version.id)),
      "artifact cleanup must resume after every matching upload lease has expired",
    );

    const queueRetryAt = new Date(Date.now() + 120_000);
    assert.equal(await deferScienceUploadCleanup(handle.db, {
      workspaceId: workspaceA.id,
      uploadId: quarantinedUpload.upload.id,
      retryAt: queueRetryAt,
    }), true);
    assert.equal(await deferScienceArtifactVersionCleanup(handle.db, {
      workspaceId: workspaceA.id,
      versionId: uploadProtectedVersions[0].id,
      retryAt: queueRetryAt,
    }), true);
    assert.equal(await deferScienceRenderSessionCleanup(handle.db, {
      workspaceId: workspaceA.id,
      sessionId: terminalRender.session.id,
      retryAt: queueRetryAt,
    }), true);

    const actionRun = await createScienceRun(handle.db, {
      workspaceId: workspaceA.id,
      studyId: study.id,
      computeProfileId: profile.id,
      resourceRequest: RESOURCE_REQUEST,
      idempotencyKey: "admin-action-queue-run",
      inputs: [{ artifactVersionId: inputVersion.id, semanticRole: "mesh" }],
      createdBy: user.id,
    });
    const actionApproval = await requestScienceRunApproval(handle.db, {
      workspaceId: workspaceA.id,
      runId: actionRun.run.id,
      expectedGeneration: 0,
      prompt: "Approve admin action queue fixture",
    });
    await resolveScienceRunApproval(handle.db, {
      workspaceId: workspaceA.id,
      runId: actionRun.run.id,
      expectedGeneration: 0,
      approvalId: actionApproval.approval.id,
      decision: "approved",
      maxActiveRuns: 1,
    });
    const actionClaim = await claimScienceRun(handle.db, {
      workspaceId: workspaceA.id,
      runId: actionRun.run.id,
      expectedGeneration: 0,
    });
    const actionLeaseOwner = "admin-action-queue-worker";
    await acquireScienceRunLease(handle.db, {
      workspaceId: workspaceA.id,
      runId: actionRun.run.id,
      expectedGeneration: actionClaim.executionGeneration,
      leaseOwner: actionLeaseOwner,
      leaseExpiresAt: new Date(Date.now() + 120_000),
    });
    await transitionScienceRun(handle.db, {
      workspaceId: workspaceA.id,
      runId: actionRun.run.id,
      expectedGeneration: actionClaim.executionGeneration,
      leaseOwner: actionLeaseOwner,
      to: "cancelling",
      eventPayload: {
        attempt: 5,
        orphaned: true,
        adminActionRequired: true,
      },
    });

    const foreignQueueStudy = await createScienceStudy(handle.db, {
      workspaceId: workspaceB.id,
      name: "Foreign admin action queue study",
      createdBy: user.id,
    });
    const foreignQueueArtifact = await createScienceArtifact(handle.db, {
      workspaceId: workspaceB.id,
      studyId: foreignQueueStudy.id,
      logicalName: "foreign-queue.bin",
      kind: "dataset",
      format: "binary",
      createdBy: user.id,
    });
    const foreignQueueUpload = await beginScienceUpload(handle.db, {
      workspaceId: workspaceB.id,
      artifactId: foreignQueueArtifact.id,
      tokenHash: "5".repeat(64),
      expectedSizeBytes: 0,
      expectedSha256: SHA_CHILD,
      quarantineKey: "quarantine/foreign-admin-action-queue",
      expiresAt: new Date(Date.now() + 120_000),
      maxWorkspaceStorageBytes: WORKSPACE_STORAGE_LIMIT,
    });
    await quarantineScienceUpload(handle.db, {
      workspaceId: workspaceB.id,
      tokenHash: foreignQueueUpload.upload.tokenHash,
      error: "foreign queue fixture",
    });

    const actionQueue = await listScienceAdminActionQueue(handle.db, {
      workspaceId: workspaceA.id,
      page: { offset: 0, limit: 200 },
      now: new Date(),
    });
    const actionQueueById = new Map(actionQueue.items.map((item) => [item.id, item]));
    assert.equal(actionQueueById.get(actionRun.run.id)?.kind, "run");
    assert.equal(actionQueueById.get(actionRun.run.id)?.attempts, 5);
    assert.equal(
      actionQueueById.get(quarantinedUpload.upload.id)?.kind,
      "upload_reservation",
    );
    assert.equal(
      actionQueueById.get(uploadProtectedVersions[0].id)?.kind,
      "artifact_version",
    );
    assert.equal(
      actionQueueById.get(terminalRender.session.id)?.kind,
      "render_session",
    );
    assert.equal(
      actionQueueById.has(foreignQueueUpload.upload.id),
      false,
      "action queue must not cross workspace ownership",
    );
    const firstActionPage = await listScienceAdminActionQueue(handle.db, {
      workspaceId: workspaceA.id,
      page: { offset: 0, limit: 2 },
      now: new Date(),
    });
    assert.equal(firstActionPage.items.length, 2);
    assert.equal(firstActionPage.nextOffset, 2);
    const secondActionPage = await listScienceAdminActionQueue(handle.db, {
      workspaceId: workspaceA.id,
      page: { offset: firstActionPage.nextOffset, limit: 2 },
      now: new Date(),
    });
    assert.deepEqual(
      [...firstActionPage.items, ...secondActionPage.items].map((item) => item.id),
      actionQueue.items.map((item) => item.id),
      "global queue pagination must be stable across heterogeneous resource kinds",
    );

    await transitionScienceRun(handle.db, {
      workspaceId: workspaceA.id,
      runId: actionRun.run.id,
      expectedGeneration: actionClaim.executionGeneration,
      leaseOwner: actionLeaseOwner,
      to: "cancelled",
    });
    assert.equal(await deleteExpiredScienceUploadAfterDiscard(handle.db, {
      workspaceId: workspaceA.id,
      uploadId: quarantinedUpload.upload.id,
    }), true);
    assert.ok(await tombstoneTerminalScienceRenderSessionAfterClose(handle.db, {
      workspaceId: workspaceA.id,
      sessionId: terminalRender.session.id,
    }));
    for (const version of uploadProtectedVersions) {
      assert.equal(
        await deleteExpiredScienceArtifactVersionAfterDiscard(handle.db, {
          workspaceId: workspaceA.id,
          versionId: version.id,
        }),
        true,
      );
    }
    const resolvedActionQueue = await listScienceAdminActionQueue(handle.db, {
      workspaceId: workspaceA.id,
      page: { offset: 0, limit: 200 },
      now: new Date(),
    });
    const resolvedActionIds = new Set(resolvedActionQueue.items.map((item) => item.id));
    for (const resolvedId of [
      actionRun.run.id,
      quarantinedUpload.upload.id,
      uploadProtectedVersions[0].id,
      terminalRender.session.id,
    ]) {
      assert.equal(
        resolvedActionIds.has(resolvedId),
        false,
        "resolved or historical action markers must not remain active",
      );
    }

    const pagedStudies = await listScienceStudies(handle.db, {
      workspaceId: workspaceA.id,
      page: { offset: 0, limit: 1 },
    });
    assert.equal(pagedStudies.items.length, 1);
    assert.equal(pagedStudies.nextOffset, null);
    assert.equal((await archiveScienceStudy(handle.db, workspaceA.id, study.id)).status, "archived");
    await expectConflict(
      () =>
        createScienceArtifact(handle.db, {
          workspaceId: workspaceA.id,
          studyId: study.id,
          logicalName: "late-artifact",
          kind: "other",
          format: "application/octet-stream",
          createdBy: user.id,
        }),
      /read-only/,
    );

    assert.equal(
      (await getScienceRunForWorkspace(handle.db, workspaceB.id, createdRun.run.id)),
      null,
    );
    return handle.driver;
  } finally {
    await handle.close();
  }
}

await verifyLegacyUpgrade();
await verifyMigrationRollbackIsAtomic();
await verifyRewrittenV12DriftIsRejected();
const driver = await verifyLifecycle(process.env.SCIENCE_TEST_DATABASE_URL);
console.log(`science lifecycle (${driver}): ok`);
