// src/controllers/verifyIncorpController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { exactLookupById, fuzzyLookupByNameDob } from '../services/matchingService.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/verify/incorporation
 */
export async function verifyIncorpHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    const { reg_no, id_hash: client_hash, entity_name, entity_type, date_of_incorporation, registered_office_address, ocr_confidence } = extracted;

    const verification_id = `ver-${uuidv4()}`;
    const checks = { format_check: 0, db_match_score: 0, ocr_confidence: (ocr_confidence ?? 0) };

    // Basic format check for reg_no if provided
    if (reg_no) {
      // Basic heuristic: alphanumeric, length between 6 and 30
      const cleaned = reg_no.toString().trim();
      if (/^[A-Za-z0-9\-\/\s]{6,40}$/.test(cleaned)) checks.format_check = 1;
      else checks.format_check = 0;
    } else {
      checks.format_check = 0; // no id -> rely on fuzzy name+date
    }

    // Plausibility: incorporation date not in future
    if (date_of_incorporation) {
      const incDate = new Date(date_of_incorporation);
      const now = new Date();
      if (incDate > now) {
        // impossible future date -> lower confidence
        checks.format_check = Math.min(checks.format_check, 0.2);
      }
    }

    // Exact lookup using id_hash (preferred) or reg_no
    let matchedRecord = null;

    if (client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'INCORP', id_hash: client_hash }).lean();
      if (rec) {
        matchedRecord = { record: rec, match_type: 'exact_id_hash' };
        checks.db_match_score = 1.0;
      }
    } else if (reg_no) {
      const norm = normalizeId(reg_no);
      const hash = sha256Hex(norm);
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'INCORP', id_hash: hash }).lean();
      if (rec) {
        matchedRecord = { record: rec, match_type: 'exact_id_hash' };
        checks.db_match_score = 1.0;
      }
    }

    // Fuzzy fallback: entity_name + date_of_incorporation
    if (!matchedRecord && entity_name) {
      // reuse fuzzyLookupByNameDob; treat date_of_incorporation as dob param
      const fuzzy = await fuzzyLookupByNameDob('INCORP', entity_name, date_of_incorporation);
      if (fuzzy) {
        matchedRecord = { record: fuzzy.record, match_type: 'fuzzy_name_date', score: fuzzy.score };
        checks.db_match_score = fuzzy.score || 0;
      }
    }

    // Compute final confidence and status
    const final_confidence = computeFinalConfidence(checks);
    const status = decideStatus(final_confidence);

    // Persist verification audit
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'INCORP',
      extracted,
      checks,
      matched_record_id: matchedRecord?.record?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedRecord)
    });

    // Response shape - mask sensitive fields
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_record: matchedRecord?.record ? {
        record_id: matchedRecord.record._id,
        match_type: matchedRecord.match_type,
        id_masked: matchedRecord.record.id_masked || null,
        entity_name: matchedRecord.record.canonical_name || null,
        date_of_incorporation: matchedRecord.record.dob || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyIncorpHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}

function buildReasons(checks, matchedRecord) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push('regno_format_ok');
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}
