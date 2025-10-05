// src/controllers/verifyNocController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import levenshtein from 'fast-levenshtein';
import { v4 as uuidv4 } from 'uuid';

/**
 * Generic NOC verifier for FIRE_NOC / POLLUTION_NOC / BIO_NOC
 * Expects validated body per verifyNocSchema
 */
export async function verifyNocHandler(req, res) {
  try {
    const { request_id, submitted_by, doc_type, extracted } = req.body;
    const { authority_name, certificate_no, id_hash: client_hash, issue_date, valid_upto, address, ocr_confidence } = extracted;

    const verification_id = `ver-${uuidv4()}`;
    const checks = { format_check: 0, db_match_score: 0, date_validity: 0, ocr_confidence: (ocr_confidence ?? 0) };

    // Format: certificate_no if present — basic alnum/punct check
    if (certificate_no && /^[A-Za-z0-9\-\/\s\._]{3,60}$/.test(certificate_no)) checks.format_check = 1;
    else if (!certificate_no) checks.format_check = 0.5; // partial info ok
    else checks.format_check = 0;

    // Date validity: if valid_upto present, check not expired
    const now = new Date();
    if (valid_upto) {
      const vu = new Date(valid_upto);
      checks.date_validity = vu >= now ? 1 : 0;
    } else {
      checks.date_validity = 0.5; // unknown
    }

    // Exact lookup by id_hash or certificate_no (normalized -> hash)
    let matchedRecord = null;
    if (client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type, id_hash: client_hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_id_hash' }; checks.db_match_score = 1.0; }
    } else if (certificate_no) {
      const norm = normalizeId(certificate_no);
      const hash = sha256Hex(norm);
      const rec = await AuthoritativeRecord.findOne({ doc_type, id_hash: hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_cert_hash' }; checks.db_match_score = 1.0; }
    }

    // Fuzzy fallback: authority_name + address similarity
    if (!matchedRecord && authority_name) {
      const fuzzy = await fuzzyLookupNoc(doc_type, authority_name, address);
      if (fuzzy) {
        matchedRecord = { record: fuzzy.record, match_type: 'fuzzy_authority_address', score: fuzzy.score };
        checks.db_match_score = fuzzy.score || 0;
      }
    }

    // Compute final confidence and status
    // For NOCs we weigh date_validity & db match more (config via scoringService)
    // We'll combine format & date into format_check_avg
    const format_check_avg = (checks.format_check + checks.date_validity) / 2;
    const final_confidence = computeFinalConfidence({ db_match_score: checks.db_match_score, format_check: format_check_avg, ocr_confidence: checks.ocr_confidence });
    const status = decideStatus(final_confidence);

    // Persist verification audit
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type,
      extracted,
      checks,
      matched_record_id: matchedRecord?.record?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedRecord)
    });

    // Response (mask sensitive details)
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_record: matchedRecord?.record ? {
        record_id: matchedRecord.record._id,
        match_type: matchedRecord.match_type,
        id_masked: matchedRecord.record.id_masked || null,
        authority_name: matchedRecord.record.canonical_name || null,
        valid_upto: matchedRecord.record.valid_upto || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyNocHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}

/**
 * fuzzyLookupNoc: search AuthoritativeRecord for given docType by authority_name and optional address
 * returns {record, score} or null
 */
async function fuzzyLookupNoc(docType, authorityName, address) {
  const canonical = normalizeName(authorityName || '');
  const query = { doc_type: docType };
  if (address) {
    // try to filter by address words for better candidates
    const addrFrag = address.toString().trim().split(/\s+/).slice(0,4).join(' ');
    query.address = { $regex: addrFrag, $options: 'i' };
  }

  let candidates = await AuthoritativeRecord.find(query).limit(200).lean();
  if (!candidates || candidates.length === 0) {
    // broaden search to all same doc_type
    candidates = await AuthoritativeRecord.find({ doc_type: docType }).limit(200).lean();
  }
  if (!candidates || candidates.length === 0) return null;

  const scored = candidates.map(c => {
    const candName = c.canonical_name || (c.raw && c.raw.authority_name) || '';
    const nameDist = levenshtein.get(canonical, normalizeName(candName || ''));
    const nameMax = Math.max(canonical.length, (candName||'').length, 1);
    const nameSim = 1 - (nameDist / nameMax);

    let addrSim = 0;
    if (address && c.address) {
      const addrDist = levenshtein.get(address.toString().toLowerCase(), (c.address||'').toLowerCase());
      const addrMax = Math.max(address.length, (c.address||'').length, 1);
      addrSim = 1 - (addrDist / addrMax);
    }
    // choose weights: authority name 0.7, address 0.3
    const combined = (0.7 * nameSim) + (0.3 * addrSim);
    return { record: c, score: combined };
  });

  scored.sort((a,b) => b.score - a.score);
  const best = scored[0];
  if (best && best.score >= 0.60) return { record: best.record, score: best.score };
  return null;
}



function buildReasons(checks, matchedRecord) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push('cert_format_ok');
  else if (checks.format_check > 0) reasons.push('partial_cert_info');
  if (checks.date_validity === 1) reasons.push('validity_ok');
  else if (checks.date_validity === 0) reasons.push('validity_expired');
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}

