import { query } from '../infrastructure/postgres.js';
import { recordAuditEvent } from './audit-service.js';
export async function createUploadedEvidenceRecord(actor, input) {
    const result = await query(`
      INSERT INTO evidence_files (
        organization_id,
        case_id,
        original_file_name,
        mime_type,
        file_size,
        storage_provider,
        storage_bucket,
        storage_key,
        storage_url,
        uploaded_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, original_file_name, mime_type, storage_key, storage_url, created_at
    `, [
        actor.organizationId,
        input.caseId ?? null,
        input.fileName,
        input.mimeType,
        input.size,
        input.provider,
        input.bucket,
        input.storageKey,
        input.storageUrl,
        actor.userId,
    ]);
    const evidence = result.rows[0];
    await recordAuditEvent({
        actor,
        action: 'evidence.upload',
        entityType: 'evidence_file',
        entityId: evidence.id,
        metadata: {
            fileName: input.fileName,
            mimeType: input.mimeType,
            size: input.size,
            storageKey: input.storageKey,
        },
    });
    return evidence;
}
