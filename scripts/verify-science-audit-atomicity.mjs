#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import {
  SCHEMA_MIGRATIONS,
  createDb,
  migrate,
  setScienceWorkspaceAdmission,
  withScienceAuditContext,
} from "../packages/db/dist/index.js";

const SCIENCE_DOMAIN_TABLES = [
  "science_artifact_versions",
  "science_artifacts",
  "science_compute_profiles",
  "science_domain_validation_heads",
  "science_domain_validations",
  "science_render_sessions",
  "science_run_artifacts",
  "science_run_events",
  "science_runs",
  "science_studies",
  "science_uploads",
  "science_workspace_admissions",
];

function rows(result) {
  return result.rows ?? result;
}

async function scalar(db, statement, field) {
  const result = await db.execute(statement);
  return rows(result)[0]?.[field];
}

async function verifyMigrationAndMutationAtomicity() {
  const handle = await createDb({ ephemeral: true });
  const originalMigrations = [...SCHEMA_MIGRATIONS];
  const auditMigration = originalMigrations.find((migration) => migration.version === 5);
  const auditReplacementMigration = originalMigrations.find(
    (migration) => migration.version === 6,
  );
  const finalizationFenceMigration = originalMigrations.find(
    (migration) => migration.version === 7,
  );
  const cleanupRetryMigration = originalMigrations.find(
    (migration) => migration.version === 8,
  );
  const transferFenceMigration = originalMigrations.find((migration) => migration.version === 9);
  const actorAuditMigration = originalMigrations.find(
    (migration) => migration.version === 10,
  );
  const workspaceAdmissionMigration = originalMigrations.find(
    (migration) => migration.version === 11,
  );
  const domainValidationMigration = originalMigrations.find(
    (migration) => migration.version === 12,
  );
  const domainValidationHeadMigration = originalMigrations.find(
    (migration) => migration.version === 13,
  );
  assert.ok(auditMigration, "atomic Science audit migration must be version 5");
  assert.ok(
    auditReplacementMigration?.statements.some((statement) =>
      statement.includes("CREATE OR REPLACE FUNCTION science_audit_domain_mutation()")
    ),
    "version 6 must replace the audit function for databases that already installed version 5",
  );
  assert.ok(
    finalizationFenceMigration?.statements.some((statement) =>
      statement.includes("finalization_lease_id")
    ) && finalizationFenceMigration.statements.some((statement) =>
      statement.includes("CREATE OR REPLACE FUNCTION science_audit_domain_mutation()")
    ),
    "version 7 must add the finalizer fence and reapply bounded heartbeat auditing",
  );
  assert.ok(
    cleanupRetryMigration?.statements.some((statement) =>
      statement.includes("cleanup_not_before")
    ) && cleanupRetryMigration.statements.some((statement) =>
      statement.includes("CREATE OR REPLACE FUNCTION science_audit_domain_mutation()")
    ),
    "version 8 must add durable cleanup backoff and reapply bounded operational auditing",
  );
  assert.ok(
    transferFenceMigration?.statements.some((statement) =>
      statement.includes("transfer_lease_id")
    ),
    "version 9 must add the renewable upload-transfer ownership fence",
  );
  assert.ok(
    actorAuditMigration?.statements.some((statement) =>
      statement.includes("current_setting('puppetmaster.science_actor_kind', true)")
    ),
    "version 10 must replace the trigger with transaction-local actor attribution",
  );

  assert.ok(
    workspaceAdmissionMigration?.statements.some((statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS science_workspace_admissions")
    ) && workspaceAdmissionMigration.statements.some((statement) =>
      statement.includes("BEFORE INSERT OR UPDATE OR DELETE ON science_workspace_admissions")
    ) && workspaceAdmissionMigration.statements.some((statement) =>
      statement.includes("CREATE OR REPLACE FUNCTION science_audit_domain_mutation()")
    ),
    "version 11 must install default-deny workspace admission with its atomic audit trigger",
  );
  assert.ok(
    domainValidationMigration?.statements.some((statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS science_domain_validations")
        && statement.includes("UNIQUE (run_id, revision)")
        && statement.includes("CHECK (revision > 0)")
    ) && domainValidationMigration.statements.some((statement) =>
      statement.includes("science domain validation records are append-only")
        && statement.includes("expected_revision")
        && statement.includes("FOR UPDATE OF run")
        && statement.includes("NEW.created_at := transaction_timestamp()")
    ) && domainValidationMigration.statements.some((statement) =>
      statement.includes("BEFORE INSERT OR UPDATE OR DELETE ON science_domain_validations")
    ) && domainValidationMigration.statements.some((statement) =>
      statement.includes("baseline_run_id, kind, revision DESC")
    ) && domainValidationMigration.statements.some((statement) =>
      statement.includes("CREATE OR REPLACE FUNCTION science_audit_domain_mutation()")
    ),
    "version 12 must install serialized per-run revisions, guarded append-only records, and atomic audit",
  );
  assert.ok(
    domainValidationHeadMigration?.statements.some((statement) =>
      statement.includes("science migration 13 schema drift")
        && statement.includes("science_domain_validations_run_revision_unique")
        && statement.includes("science_domain_validations_revision_check")
    ) && domainValidationHeadMigration.statements.some((statement) =>
      statement.includes("CREATE TABLE science_domain_validation_heads")
        && statement.includes("UNIQUE (workspace_id, run_id, kind, scope_baseline_run_id)")
        && statement.includes("validation_id uuid NOT NULL UNIQUE")
    ) && domainValidationHeadMigration.statements.some((statement) =>
      statement.includes("science domain validation heads advance monotonically")
        && statement.includes("latest exact-scope revision")
        && statement.includes("science-domain-validation-head-v1")
    ) && domainValidationHeadMigration.statements.some((statement) =>
      statement.includes("BEFORE INSERT OR UPDATE OR DELETE ON science_domain_validation_heads")
    ) && domainValidationHeadMigration.statements.some((statement) =>
      statement.includes("SELECT DISTINCT ON")
        && statement.includes("revision DESC")
        && statement.includes("sha256")
    ),
    "version 13 must reject v12 drift and install exact-scope monotonic hash-anchored audited heads",
  );


  try {
    SCHEMA_MIGRATIONS.splice(
      0,
      SCHEMA_MIGRATIONS.length,
      ...originalMigrations.filter((migration) => migration.version < 5),
    );
    await migrate(handle);

    const failingAuditMigration = {
      ...auditMigration,
      statements: [
        ...auditMigration.statements,
        "SELECT * FROM science_audit_deliberate_missing_relation",
      ],
    };
    SCHEMA_MIGRATIONS.push(failingAuditMigration);
    await assert.rejects(
      () => migrate(handle),
      /science_audit_deliberate_missing_relation/,
      "a failing statement must abort the complete trigger migration",
    );

    assert.equal(
      Number(await scalar(
        handle.db,
        sql.raw("SELECT count(*) AS copies FROM schema_migrations WHERE version = 5"),
        "copies",
      )),
      0,
      "a failed audit migration must not be recorded",
    );
    assert.equal(
      await scalar(
        handle.db,
        sql.raw("SELECT to_regclass('public.audit_subject_scope')::text AS relation"),
        "relation",
      ),
      null,
      "support DDL before the deliberate failure must roll back",
    );

    SCHEMA_MIGRATIONS.splice(
      0,
      SCHEMA_MIGRATIONS.length,
      ...originalMigrations.filter((migration) => migration.version <= 5),
    );
    await Promise.all(Array.from({ length: 6 }, () => migrate(handle)));
    assert.equal(
      Number(await scalar(
        handle.db,
        sql.raw("SELECT count(*) AS copies FROM schema_migrations WHERE version = 5"),
        "copies",
      )),
      1,
      "concurrent migration calls must serialize to one version-5 ledger row",
    );

    // Emulate a database that installed the original version-5 trigger before
    // bounded high-frequency auditing was introduced. Version 6 must replace
    // the function even though the triggers and version-5 ledger row exist.
    await handle.db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION science_audit_domain_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $legacy_science_audit_domain_mutation$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END
      $legacy_science_audit_domain_mutation$
    `));
    SCHEMA_MIGRATIONS.splice(0, SCHEMA_MIGRATIONS.length, ...originalMigrations);
    await Promise.all(Array.from({ length: 6 }, () => migrate(handle)));
    assert.equal(
      Number(await scalar(
        handle.db,
        sql.raw("SELECT count(*) AS copies FROM schema_migrations WHERE version = 6"),
        "copies",
      )),
      1,
      "concurrent upgrades must serialize to one version-6 audit replacement",
    );
    assert.equal(
      Number(await scalar(
        handle.db,
        sql.raw("SELECT count(*) AS copies FROM schema_migrations WHERE version = 10"),
        "copies",
      )),
      1,
      "the actor-attributed audit replacement must be installed exactly once",
    );

    assert.equal(
      Number(await scalar(
        handle.db,
        sql.raw("SELECT count(*) AS copies FROM schema_migrations WHERE version = 11"),
        "copies",
      )),
      1,
      "workspace admission and its audit trigger must be installed exactly once",
    );
    assert.equal(
      Number(await scalar(
        handle.db,
        sql.raw("SELECT count(*) AS copies FROM schema_migrations WHERE version = 12"),
        "copies",
      )),
      1,
      "append-only domain validation and its audit trigger must be installed exactly once",
    );
    assert.equal(
      Number(await scalar(
        handle.db,
        sql.raw("SELECT count(*) AS copies FROM schema_migrations WHERE version = 13"),
        "copies",
      )),
      1,
      "validation scope heads and their audit trigger must be installed exactly once",
    );

    const triggerResult = await handle.db.execute(sql.raw(
      `SELECT relation.relname AS table_name
         FROM pg_trigger AS trigger
         JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
        WHERE trigger.tgname = 'science_domain_audit_mutation'
          AND NOT trigger.tgisinternal
        ORDER BY relation.relname`,
    ));
    assert.deepEqual(
      rows(triggerResult).map((row) => row.table_name),
      SCIENCE_DOMAIN_TABLES,
      "every current Science domain table must have exactly one generic audit trigger",
    );

    const workspaceId = randomUUID();
    const userId = randomUUID();
    await handle.db.execute(sql`
      INSERT INTO workspaces (id, name)
      VALUES (${workspaceId}, 'Science atomic audit verification')
    `);
    await handle.db.execute(sql`
      INSERT INTO users (id, email, name, password_hash)
      VALUES (
        ${userId},
        ${`science-audit-${userId}@example.test`},
        'Science Audit Verifier',
        'not-a-real-password-hash'
      )
    `);

    const admissionReason = "atomic admission verifier";
    const admission = await withScienceAuditContext(
      handle.db,
      {
        actorKind: "user",
        actorId: userId,
        actorLabel: "Science Audit Verifier",
        action: "science.workspace.admission.update",
        reason: admissionReason,
      },
      (scoped) => setScienceWorkspaceAdmission(scoped, {
        workspaceId,
        admitted: true,
        updatedBy: userId,
      }),
    );
    assert.ok(admission.id);
    const admissionAudits = rows(await handle.db.execute(sql`
      SELECT actor_kind, actor_id, actor_label, action, target, detail
        FROM audit_log
       WHERE target = ${`science_workspace_admissions:${admission.id}`}
    `));
    assert.deepEqual(admissionAudits, [{
      actor_kind: "user",
      actor_id: userId,
      actor_label: "Science Audit Verifier",
      action: "science.workspace.admission.update",
      target: `science_workspace_admissions:${admission.id}`,
      detail: {
        admitted: true,
        operation: "insert",
        reason: admissionReason,
        table: "science_workspace_admissions",
      },
    }], "one admission change must commit exactly one actor-attributed atomic audit row");
    await withScienceAuditContext(
      handle.db,
      {
        actorKind: "user",
        actorId: userId,
        action: "science.workspace.admission.update",
        reason: "atomic admission update verifier",
      },
      (scoped) => setScienceWorkspaceAdmission(scoped, {
        workspaceId,
        admitted: false,
        updatedBy: userId,
      }),
    );
    assert.equal(Number(await scalar(handle.db, sql`
      SELECT count(*) AS copies FROM audit_log
       WHERE target = ${`science_workspace_admissions:${admission.id}`}
    `, "copies")), 2, "explicit UPDATE must add one audit row, not an UPSERT insert/update pair");

    const attributedStudyId = randomUUID();
    await withScienceAuditContext(
      handle.db,
      {
        actorKind: "user",
        actorId: userId,
        actorLabel: "Science Audit Verifier",
        action: "science.study.create",
        reason: "atomic verifier",
      },
      async (scoped) => {
        await scoped.execute(sql`
          INSERT INTO science_studies (
            id, workspace_id, name, description, status, classification, created_by
          )
          VALUES (
            ${attributedStudyId},
            ${workspaceId},
            'Attributed commit probe',
            '',
            'active',
            'non_regulated',
            ${userId}
          )
        `);
      },
    );
    const attributedAudit = rows(await handle.db.execute(sql`
      SELECT actor_kind, actor_id, actor_label, action, target, detail
        FROM audit_log
       WHERE target = ${`science_studies:${attributedStudyId}`}
    `));
    assert.deepEqual(attributedAudit, [{
      actor_kind: "user",
      actor_id: userId,
      actor_label: "Science Audit Verifier",
      action: "science.study.create",
      target: `science_studies:${attributedStudyId}`,
      detail: {
        operation: "insert",
        reason: "atomic verifier",
        state: "active",
        table: "science_studies",
      },
    }], "the domain mutation and initiating-user attribution must commit atomically");

    const rolledBackStudyId = randomUUID();
    await assert.rejects(
      () => withScienceAuditContext(
        handle.db,
        {
          actorKind: "user",
          actorId: userId,
          action: "science.study.rollback-probe",
          reason: "must roll back",
        },
        async (tx) => {
        await tx.execute(sql`
          INSERT INTO science_studies (
            id, workspace_id, name, description, status, classification, created_by
          )
          VALUES (
            ${rolledBackStudyId},
            ${workspaceId},
            'Rollback probe',
            '',
            'active',
            'non_regulated',
            ${userId}
          )
        `);
        assert.equal(
          Number(await scalar(
            tx,
            sql`
              SELECT count(*) AS copies
                FROM audit_log
               WHERE target = ${`science_studies:${rolledBackStudyId}`}
            `,
            "copies",
          )),
          1,
          "the trigger audit must be visible inside the mutation transaction",
        );
        throw new Error("deliberate science mutation rollback");
      }),
      /deliberate science mutation rollback/,
    );
    assert.equal(
      Number(await scalar(
        handle.db,
        sql`
          SELECT count(*) AS copies
            FROM science_studies
           WHERE id = ${rolledBackStudyId}
        `,
        "copies",
      )),
      0,
      "the deliberate domain mutation must roll back",
    );
    assert.equal(
      Number(await scalar(
        handle.db,
        sql`
          SELECT count(*) AS copies
            FROM audit_log
           WHERE target = ${`science_studies:${rolledBackStudyId}`}
        `,
        "copies",
      )),
      0,
      "the trigger audit must roll back with its domain mutation",
    );
    assert.equal(
      Number(await scalar(
        handle.db,
        sql`
          SELECT count(*) AS copies
            FROM audit_subject_scope
           WHERE domain_table = 'science_studies'
             AND target_id = ${rolledBackStudyId}
        `,
        "copies",
      )),
      0,
      "the workspace scope mapping must roll back with its domain mutation",
    );

    const studyId = randomUUID();
    const artifactId = randomUUID();
    const missionId = randomUUID();
    const profileId = randomUUID();
    const runId = randomUUID();
    const eventId = randomUUID();
    const uploadId = randomUUID();
    const uploadLeaseId = randomUUID();
    await handle.db.execute(sql`
      INSERT INTO science_studies (
        id, workspace_id, name, description, status, classification, created_by
      )
      VALUES (
        ${studyId},
        ${workspaceId},
        'Committed probe',
        '',
        'active',
        'non_regulated',
        ${userId}
      )
    `);
    const studyInsertAudit = rows(await handle.db.execute(sql`
      SELECT actor_kind, actor_id, action, target, detail
        FROM audit_log
       WHERE target = ${`science_studies:${studyId}`}
         AND action = 'science.db.insert'
    `));
    assert.equal(studyInsertAudit.length, 1);
    assert.deepEqual(studyInsertAudit[0], {
      actor_kind: "system",
      actor_id: "science-db",
      action: "science.db.insert",
      target: `science_studies:${studyId}`,
      detail: {
        operation: "insert",
        state: "active",
        table: "science_studies",
      },
    });

    await handle.db.execute(sql`
      UPDATE science_studies
         SET name = 'Committed probe updated',
             updated_at = now()
       WHERE id = ${studyId}
    `);
    assert.equal(
      Number(await scalar(
        handle.db,
        sql`
          SELECT count(*) AS copies
            FROM audit_log
           WHERE target = ${`science_studies:${studyId}`}
             AND action = 'science.db.update'
        `,
        "copies",
      )),
      1,
      "a successful update must append its generic audit in the same commit",
    );

    await handle.db.execute(sql`
      INSERT INTO science_compute_profiles (
        id, workspace_id, name, provider_kind, image_digest, kernel_name,
        resource_bounds, config, enabled
      )
      VALUES (
        ${profileId},
        ${workspaceId},
        'Atomic audit profile',
        'local_container',
        ${`sha256:${"a".repeat(64)}`},
        'python3',
        ${JSON.stringify({
          cpuMillicores: 1_000,
          memoryMb: 2_048,
          gpuCount: 0,
          wallTimeSeconds: 300,
        })}::jsonb,
        '{}'::jsonb,
        true
      )
    `);
    await handle.db.execute(sql`
      INSERT INTO missions (id, workspace_id, kind, subject_id, status)
      VALUES (${missionId}, ${workspaceId}, 'science.run', ${studyId}, 'queued')
    `);
    await handle.db.execute(sql`
      INSERT INTO science_runs (
        id, study_id, mission_id, compute_profile_id, profile_snapshot,
        resource_request, state, idempotency_key, parameters, created_by
      )
      VALUES (
        ${runId},
        ${studyId},
        ${missionId},
        ${profileId},
        ${JSON.stringify({ providerKind: "local_container" })}::jsonb,
        ${JSON.stringify({
          cpuMillicores: 1_000,
          memoryMb: 2_048,
          gpuCount: 0,
          wallTimeSeconds: 300,
        })}::jsonb,
        'draft',
        'atomic-audit-run',
        '{}'::jsonb,
        ${userId}
      )
    `);

    await handle.db.execute(sql`
      UPDATE science_runs
         SET lease_owner = 'atomic-audit-worker',
             lease_expires_at = now() + interval '1 minute',
             heartbeat_at = now(),
             updated_at = now()
       WHERE id = ${runId}
    `);
    assert.equal(
      Number(await scalar(
        handle.db,
        sql`
          SELECT count(*) AS copies
            FROM audit_log
           WHERE target = ${`science_runs:${runId}`}
             AND action = 'science.db.update'
        `,
        "copies",
      )),
      0,
      "lease/heartbeat-only run updates must not amplify generic audit storage",
    );

    await handle.db.execute(sql`
      UPDATE science_runs
         SET state = 'queued',
             updated_at = now()
       WHERE id = ${runId}
    `);
    assert.equal(
      Number(await scalar(
        handle.db,
        sql`
          SELECT count(*) AS copies
            FROM audit_log
           WHERE target = ${`science_runs:${runId}`}
             AND action = 'science.db.update'
        `,
        "copies",
      )),
      1,
      "semantic run-state updates must retain same-transaction generic audit evidence",
    );

    await handle.db.execute(sql`
      INSERT INTO science_run_events (
        id, workspace_id, study_id, run_id, mission_id, sequence,
        event_type, execution_generation, state, payload
      )
      VALUES (
        ${eventId}, ${workspaceId}, ${studyId}, ${runId}, ${missionId}, 1,
        'science.run.progress', 0, 'queued', '{}'::jsonb
      )
    `);
    assert.equal(
      Number(await scalar(
        handle.db,
        sql`SELECT count(*) AS copies FROM science_run_events WHERE id = ${eventId}`,
        "copies",
      )),
      1,
      "the append-only run event must remain durable domain evidence",
    );
    assert.equal(
      Number(await scalar(
        handle.db,
        sql`
          SELECT count(*) AS copies
            FROM audit_log
           WHERE target = ${`science_run_events:${eventId}`}
             AND action = 'science.db.insert'
        `,
        "copies",
      )),
      0,
      "append-only run events must not create duplicate generic audit rows",
    );

    await handle.db.execute(sql`
      INSERT INTO science_artifacts (
        id, study_id, logical_name, kind, format, status, created_by
      )
      VALUES (
        ${artifactId},
        ${studyId},
        'cascade-probe',
        'dataset',
        'application/octet-stream',
        'active',
        ${userId}
      )
    `);
    await handle.db.execute(sql`
      INSERT INTO science_uploads (
        id, workspace_id, artifact_id, token_hash, expected_size_bytes,
        expected_sha256, quarantine_key, received_bytes, state, expires_at
      )
      VALUES (
        ${uploadId}, ${workspaceId}, ${artifactId}, ${"b".repeat(64)}, 0,
        ${"c".repeat(64)}, ${`.quarantine/${uploadId}`}, 0, 'uploading',
        now() + interval '5 minutes'
      )
    `);
    await handle.db.execute(sql`
      UPDATE science_uploads
         SET state = 'finalizing',
             finalization_lease_id = ${uploadLeaseId},
             expires_at = now() + interval '5 minutes',
             updated_at = now()
       WHERE id = ${uploadId}
    `);
    assert.equal(
      Number(await scalar(
        handle.db,
        sql`
          SELECT count(*) AS copies
            FROM audit_log
           WHERE target = ${`science_uploads:${uploadId}`}
             AND action = 'science.db.update'
        `,
        "copies",
      )),
      1,
      "the semantic upload finalization claim must retain generic audit evidence",
    );
    await handle.db.execute(sql`
      UPDATE science_uploads
         SET expires_at = now() + interval '10 minutes',
             updated_at = now()
       WHERE id = ${uploadId}
         AND finalization_lease_id = ${uploadLeaseId}
    `);
    assert.equal(
      Number(await scalar(
        handle.db,
        sql`
          SELECT count(*) AS copies
            FROM audit_log
           WHERE target = ${`science_uploads:${uploadId}`}
             AND action = 'science.db.update'
        `,
        "copies",
      )),
      1,
      "pure upload-finalizer heartbeats must not amplify generic audit storage",
    );
    await handle.db.execute(sql`
      UPDATE science_uploads
         SET cleanup_attempts = cleanup_attempts + 1,
             cleanup_not_before = now() + interval '1 minute',
             updated_at = now()
       WHERE id = ${uploadId}
    `);
    assert.equal(
      Number(await scalar(
        handle.db,
        sql`
          SELECT count(*) AS copies
            FROM audit_log
           WHERE target = ${`science_uploads:${uploadId}`}
             AND action = 'science.db.update'
        `,
        "copies",
      )),
      1,
      "cleanup-backoff-only updates must not amplify generic audit storage",
    );
    await handle.db.execute(sql`
      DELETE FROM science_studies WHERE id = ${studyId}
    `);
    const deleteAuditResult = await handle.db.execute(sql`
      SELECT target, action
        FROM audit_log
       WHERE target IN (
         ${`science_studies:${studyId}`},
         ${`science_artifacts:${artifactId}`}
       )
         AND action = 'science.db.delete'
       ORDER BY target
    `);
    assert.deepEqual(rows(deleteAuditResult), [
      { target: `science_artifacts:${artifactId}`, action: "science.db.delete" },
      { target: `science_studies:${studyId}`, action: "science.db.delete" },
    ], "cascading child deletion must retain workspace-safe generic audits");
    assert.equal(
      Number(await scalar(
        handle.db,
        sql`
          SELECT count(*) AS copies
            FROM audit_subject_scope
           WHERE (domain_table = 'science_studies' AND target_id = ${studyId})
              OR (domain_table = 'science_artifacts' AND target_id = ${artifactId})
        `,
        "copies",
      )),
      0,
      "deleted domain rows must not leave stale workspace scope mappings",
    );
  } finally {
    SCHEMA_MIGRATIONS.splice(0, SCHEMA_MIGRATIONS.length, ...originalMigrations);
    await handle.close();
  }
}

await verifyMigrationAndMutationAtomicity();
console.log(
  "SCIENCE ATOMIC AUDIT PASS: migration rollback/serialization, 12 table triggers including append-only validation plus monotonic scope heads, actor-attributed workspace admission and commit/rollback/context reset, bounded event/run/upload-lease/cleanup auditing, and committed semantic insert/update/cascade-delete audits",
);
