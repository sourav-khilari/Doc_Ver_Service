// src/controllers/verifyTechCertController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { exactLookupById, fuzzyLookupByNameDob } from '../services/matchingService.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import levenshtein from 'fast-levenshtein';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/verify/tech-cert
 */
export async function verifyTechCertHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    let { name, registration_no, id_hash: client_hash, council_name, qualification, issue_date, valid_upto, ocr_confidence } = extracted;

    const verification_id = `ver-${uuidv4()}`;
    const checks = { format_check: 0, db_match_score: 0, date_validity: 0, ocr_confidence: (ocr_confidence ?? 0) };

    // Normalize name & council
    const nameCanon = normalizeName(name);
    const councilCanon = normalizeName(council_name || '');

    // Format check: registration_no basic heuristic if provided
    if (registration_no) {
      const cleaned = registration_no.toString().trim();
      // allow alnum + punctuation; length 4..50
      checks.format_check = /^[A-Za-z0-9\-\/\.]{4,50}$/.test(cleaned) ? 1 : 0;
    } else {
      // no reg no, lower format score
      checks.format_check = 0.4;
    }

    // Date validity: if valid_upto provided, ensure not expired
    const now = new Date();
    if (valid_upto) {
      const vu = new Date(valid_upto);
      checks.date_validity = vu >= now ? 1 : 0;
    } else {
      checks.date_validity = 0.5; // unknown
    }

    // Exact lookup via client-supplied id_hash
    let matchedRecord = null;
    if (client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'TECH_CERT', id_hash: client_hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_id_hash' }; checks.db_match_score = 1.0; }
    }

    // If reg no provided, compute hash & lookup
    if (!matchedRecord && registration_no) {
      const hash = sha256Hex(normalizeId(registration_no));
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'TECH_CERT', id_hash: hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_reg_no' }; checks.db_match_score = 1.0; }
    }

    // Fuzzy fallback: name + council_name (and qualification lightly)
    if (!matchedRecord && name) {
      // Search candidates by council_name to reduce set
      const query = { doc_type: 'TECH_CERT' };
      if (council_name) query['raw.council_name'] = { $regex: council_name.split(' ').slice(0,4).join(' '), $options: 'i' };
      const candidates = await AuthoritativeRecord.find(query).limit(200).lean();
      const effectiveCandidates = (candidates && candidates.length) ? candidates : await AuthoritativeRecord.find({ doc_type: 'TECH_CERT' }).limit(200).lean();

      const scored = effectiveCandidates.map(c => {
        const candName = c.canonical_name || (c.raw && c.raw.name) || '';
        const candCouncil = (c.raw && c.raw.council_name) || c.canonical_name || '';
        const nameDist = levenshtein.get(nameCanon, normalizeName(candName || ''));
        const nameMax = Math.max(nameCanon.length, (candName||'').length, 1);
        const nameSim = 1 - (nameDist / nameMax);

        const councilDist = levenshtein.get(councilCanon, normalizeName(candCouncil || ''));
        const councilMax = Math.max(councilCanon.length, (candCouncil||'').length, 1);
        const councilSim = 1 - (councilDist / councilMax);

        // weight name heavier
        const combined = (0.7 * nameSim) + (0.3 * councilSim);
        return { record: c, score: combined };
      });

      scored.sort((a,b) => b.score - a.score);
      const best = scored[0];
      if (best && best.score >= 0.66) {
        matchedRecord = { record: best.record, match_type: 'fuzzy_name_council', score: best.score };
        checks.db_match_score = best.score;
      }
    }

    // Build final confidence (consider date_validity as part of format)
    const combinedFormat = (checks.format_check + checks.date_validity) / 2;
    const final_confidence = computeFinalConfidence({ db_match_score: checks.db_match_score, format_check: combinedFormat, ocr_confidence: checks.ocr_confidence });
    const status = decideStatus(final_confidence);

    // Persist verification
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'TECH_CERT',
      extracted,
      checks,
      matched_record_id: matchedRecord?.record?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedRecord)
    });

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
        council_name: (matchedRecord.record.raw && matchedRecord.record.raw.council_name) || null,
        valid_upto: matchedRecord.record.valid_upto || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyTechCertHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}


function buildReasons(checks, matchedRecord) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push('regno_format_ok');
  else reasons.push('no_regno_or_bad_format');
  if (checks.date_validity === 1) reasons.push('validity_ok');
  else if (checks.date_validity === 0) reasons.push('validity_expired');
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}
