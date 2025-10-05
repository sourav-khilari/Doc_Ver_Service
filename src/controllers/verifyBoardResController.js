// src/controllers/verifyBoardResController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { exactLookupById, fuzzyLookupByNameDob } from '../services/matchingService.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/verify/board-resolution
 */
export async function verifyBoardResHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    const { resolution_no, resolution_date, purpose, authorized_person, document_hash, id_hash: client_doc_hash, ocr_confidence } = extracted;

    const verification_id = `ver-${uuidv4()}`;

    // checks object
    const checks = {
      format_check: 0,               // resolution date & presence
      doc_match_score: 0,           // exact doc hash match
      auth_person_match_score: 0,   // 0..1
      date_validity: 0,             // 1 if date not future
      ocr_confidence: (ocr_confidence ?? 0)
    };

    // Format/presence check: resolution_date exists (validated), authorized_person present
    if (resolution_date && authorized_person && authorized_person.name) checks.format_check = 1;
    else checks.format_check = 0.5;

    // Date validity: ensure resolution_date is not in future
    const now = new Date();
    const resDate = new Date(resolution_date);
    checks.date_validity = resDate <= now ? 1 : 0;

    // Exact document match by document_hash
    let matchedDocRecord = null;
    if (document_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'BOARD_RES', id_hash: document_hash }).lean();
      if (rec) {
        matchedDocRecord = rec;
        checks.doc_match_score = 1.0;
      }
    }

    // Try client-provided doc id_hash (composite)
    if (!matchedDocRecord && client_doc_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'BOARD_RES', id_hash: client_doc_hash }).lean();
      if (rec) {
        matchedDocRecord = rec;
        checks.doc_match_score = 1.0;
      }
    }

    // Authorized person matching:
    // Try exact by id_hash -> look into PROMOTER_KYC, PAN, TECH_CERT records
    let authMatched = null;
    if (authorized_person.id_hash) {
      const rec = await AuthoritativeRecord.findOne({
        doc_type: { $in: ['PROMOTER_KYC', 'PAN', 'TECH_CERT'] },
        id_hash: authorized_person.id_hash
      }).lean();
      if (rec) {
        authMatched = { record: rec, match_type: 'exact_id_hash' };
        checks.auth_person_match_score = 1.0;
      }
    }

    // Exact by id_no_masked (if provided)
    if (!authMatched && authorized_person.id_no_masked) {
      const rec = await AuthoritativeRecord.findOne({
        doc_type: { $in: ['PROMOTER_KYC', 'PAN'] },
        id_masked: authorized_person.id_no_masked
      }).lean();
      if (rec) {
        authMatched = { record: rec, match_type: 'exact_id_masked' };
        checks.auth_person_match_score = 1.0;
      }
    }

    // Fuzzy fallback: name + dob against PROMOTER_KYC / PAN / TECH_CERT
    if (!authMatched && authorized_person.name) {
      // prefer PROMOTER_KYC for persons associated with company; else PAN
      let fuzzy = await fuzzyLookupByNameDob('PROMOTER_KYC', authorized_person.name, authorized_person.dob);
      if (!fuzzy) fuzzy = await fuzzyLookupByNameDob('PAN', authorized_person.name, authorized_person.dob);
      if (!fuzzy) fuzzy = await fuzzyLookupByNameDob('TECH_CERT', authorized_person.name, authorized_person.dob);
      if (fuzzy) {
        authMatched = { record: fuzzy.record, match_type: 'fuzzy_name_dob', score: fuzzy.score };
        checks.auth_person_match_score = fuzzy.score || 0;
      }
    }

    // Compose DB match score for overall doc: combine doc_match_score and auth_person_match_score
    // Conservative approach: require both for highest confidence; we'll take max but penalize when one missing
    const db_composite = Math.max(checks.doc_match_score, checks.auth_person_match_score);

    // Compute final confidence: use scoringService
    const final_confidence = computeFinalConfidence({
      db_match_score: db_composite,
      format_check: (checks.format_check + checks.date_validity) / 2,
      ocr_confidence: checks.ocr_confidence
    });

    const status = decideStatus(final_confidence);

    // Persist verification with verbose authorized person result for manual review
    const auth_person_summary = authMatched ? {
      match_type: authMatched.match_type,
      record_id: authMatched.record._id,
      id_masked: authMatched.record.id_masked || null,
      score: checks.auth_person_match_score
    } : { match_type: null, score: 0 };

    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'BOARD_RES',
      extracted,
      checks,
      matched_record_id: matchedDocRecord?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedDocRecord, authMatched),
      authorized_person_result: auth_person_summary
    });

    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_doc: matchedDocRecord ? {
        record_id: matchedDocRecord._id,
        id_masked: matchedDocRecord.id_masked || null
      } : null,
      authorized_person: auth_person_summary,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyBoardResHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}

function buildReasons(checks, matchedDocRecord, authMatched) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push('board_resolution_fields_present');
  if (checks.date_validity === 1) reasons.push('resolution_date_ok');
  else reasons.push('resolution_date_in_future');

  if (checks.doc_match_score === 1.0) reasons.push('exact_doc_match');
  if (checks.auth_person_match_score === 1.0) reasons.push('authorized_person_exact_match');
  else if (checks.auth_person_match_score > 0) reasons.push(`authorized_person_fuzzy_${(checks.auth_person_match_score).toFixed(2)}`);
  if (!matchedDocRecord && checks.doc_match_score === 0) reasons.push('no_doc_match_found');
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  return reasons;
}
