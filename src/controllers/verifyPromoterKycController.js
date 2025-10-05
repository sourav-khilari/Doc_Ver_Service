// src/controllers/verifyPromoterKycController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import levenshtein from 'fast-levenshtein';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/verify/promoter-kyc
 *
 * Notes:
 * - prefer id_hash (sha256 of normalized id) from main backend
 * - can optionally upsert the authoritative people record if `make_authoritative:true` (use carefully)
 */
export async function verifyPromoterKycHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    const {
      name, id_type, id_no_masked, id_hash: client_hash, dob,
      address, contact, ocr_confidence, make_authoritative
    } = extracted;

    const verification_id = `ver-${uuidv4()}`;
    const checks = { format_check: 0, db_match_score: 0, ocr_confidence: (ocr_confidence ?? 0) };

    // Format check: presence of name and at least one id hint or dob
    if (name && (client_hash || id_no_masked || dob)) checks.format_check = 1;
    else if (name) checks.format_check = 0.6;
    else checks.format_check = 0;

    // 1) Exact lookup by client-supplied id_hash
    let matchedRecord = null;
    if (client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'PROMOTER_KYC', id_hash: client_hash }).lean();
      if (rec) {
        matchedRecord = { record: rec, match_type: 'exact_id_hash' };
        checks.db_match_score = 1.0;
      }
    }

    // 2) Exact lookup by masked id (if present)
    if (!matchedRecord && id_no_masked) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'PROMOTER_KYC', id_masked: id_no_masked }).lean();
      if (rec) {
        matchedRecord = { record: rec, match_type: 'exact_id_masked' };
        checks.db_match_score = 1.0;
      }
    }

    // 3) Fuzzy lookup by name + dob
    if (!matchedRecord && name) {
      // Search candidates w/ doc_type PROMOTER_KYC or PAN if you want a broader set
      const candidates = await AuthoritativeRecord.find({ doc_type: { $in: ['PROMOTER_KYC', 'PAN', 'TECH_CERT'] } })
        .limit(300).lean();

      if (candidates && candidates.length > 0) {
        const canonical = normalizeName(name);
        const scored = candidates.map(c => {
          const candName = c.canonical_name || (c.raw && c.raw.name) || '';
          const dist = levenshtein.get(canonical, normalizeName(candName || ''));
          const maxLen = Math.max(canonical.length, (candName||'').length, 1);
          const similarity = 1 - (dist / maxLen);
          // factor dob exact match if available (boost similarity)
          let dobBoost = 0;
          if (dob && c.dob) {
            try {
              const a = new Date(dob).toISOString().slice(0,10);
              const b = new Date(c.dob).toISOString().slice(0,10);
              if (a === b) dobBoost = 0.25; // boost when DOB matches exactly
            } catch (e) { /* ignore */ }
          }
          const score = Math.min(1, similarity + dobBoost);
          return { record: c, score };
        });
        scored.sort((a,b) => b.score - a.score);
        const best = scored[0];
        if (best && best.score >= 0.65) {
          matchedRecord = { record: best.record, match_type: 'fuzzy_name_dob', score: best.score };
          checks.db_match_score = best.score;
        }
      }
    }

    // Optionally upsert the canonical person into AuthoritativeRecord (DEV / controlled only)
    if (!matchedRecord && make_authoritative === true) {
      // create a new authoritative person record for PROMOTER_KYC
      const rawIdForSeed = id_no_masked || `${name}|${dob || ''}|${Date.now()}`;
      const normalized = normalizeId(rawIdForSeed);
      const computedHash = sha256Hex(normalized);
      const newRec = await AuthoritativeRecord.create({
        doc_type: 'PROMOTER_KYC',
        lookup_key: `PROM-${computedHash.slice(0,8)}`,
        id_hash: computedHash,
        id_masked: id_no_masked || null,
        canonical_name: normalizeName(name),
        dob: dob ? new Date(dob) : null,
        address: address || null,
        raw: { name, id_type, contact },
        source: 'ingest_make_authoritative',
      });
      matchedRecord = { record: newRec, match_type: 'upserted' };
      checks.db_match_score = 1.0;
    }

    // Compute final confidence and status
    const final_confidence = computeFinalConfidence({ db_match_score: checks.db_match_score, format_check: checks.format_check, ocr_confidence: checks.ocr_confidence });
    const status = decideStatus(final_confidence);

    // Persist verification audit
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'PROMOTER_KYC',
      extracted,
      checks,
      matched_record_id: matchedRecord?.record?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedRecord)
    });

    // Response: include matched record id + masked fields only
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_record: matchedRecord?.record ? {
        record_id: matchedRecord.record._id,
        match_type: matchedRecord.match_type,
        id_masked: matchedRecord.record.id_masked || null,
        name: matchedRecord.record.canonical_name || null,
        dob: matchedRecord.record.dob || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyPromoterKycHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}

function buildReasons(checks, matchedRecord) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push('name_and_id_hint_present');
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}
