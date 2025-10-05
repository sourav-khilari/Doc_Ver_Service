// src/controllers/verifyProductController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import levenshtein from 'fast-levenshtein';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/verify/product-dossier
 */
export async function verifyProductHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    const {
      product_name, product_code, id_hash: client_hash, category, dosage_form,
      pack_size, pharmacopoeia_ref, mfr_formula_ref, label_key_claims = [], ocr_confidence
    } = extracted;

    const verification_id = `ver-${uuidv4()}`;
    // checks: format_check (presence of required dossier fields),
    // claim_check (label claims allowedness), db_match_score, ocr_confidence
    const checks = { format_check: 0, claim_check: 1, db_match_score: 0, ocr_confidence: (ocr_confidence ?? 0) };

    // Format check: require mfr_formula_ref and at least one of pharmacopoeia_ref or dosage_form
    const hasFormula = Boolean(mfr_formula_ref);
    const hasPharmOrDosage = Boolean(pharmacopoeia_ref) || Boolean(dosage_form);
    checks.format_check = (hasFormula && hasPharmOrDosage) ? 1 : (hasFormula ? 0.6 : 0.0);

    // Simple label-claims check: disallow egregious medical guarantees or banned keywords
    const bannedKeywords = ['cure', 'guarantee', 'prevent cancer', 'treat cancer', 'instant', 'miracle'];
    const claimsText = (label_key_claims || []).join(' ').toLowerCase();
    const hasBanned = bannedKeywords.some(k => claimsText.includes(k));
    checks.claim_check = hasBanned ? 0 : 1;

    // DB exact lookup by id_hash (preferred) or product_code normalized
    let matchedRecord = null;
    if (client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'PRODUCT_DOSSIER', id_hash: client_hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_id_hash' }; checks.db_match_score = 1.0; }
    } else if (product_code) {
      const hash = sha256Hex(normalizeId(product_code));
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'PRODUCT_DOSSIER', id_hash: hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_product_code' }; checks.db_match_score = 1.0; }
    }

    // Fuzzy fallback on product_name
    if (!matchedRecord && product_name) {
      const candidate = await fuzzyLookupProduct(product_name);
      if (candidate) {
        matchedRecord = { record: candidate.record, match_type: 'fuzzy_name', score: candidate.score };
        checks.db_match_score = candidate.score || 0;
      }
    }

    // Final confidence: include claim_check as part of format_check composite
    const compositeFormat = (checks.format_check + checks.claim_check) / 2;
    const final_confidence = computeFinalConfidence({ db_match_score: checks.db_match_score, format_check: compositeFormat, ocr_confidence: checks.ocr_confidence });
    const status = decideStatus(final_confidence);

    // Persist verification
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'PRODUCT_DOSSIER',
      extracted,
      checks,
      matched_record_id: matchedRecord?.record?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedRecord)
    });

    // Response (masking)
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_record: matchedRecord?.record ? {
        record_id: matchedRecord.record._id,
        match_type: matchedRecord.match_type,
        id_masked: matchedRecord.record.id_masked || matchedRecord.record.product_code || null,
        product_name: matchedRecord.record.product_name || matchedRecord.record.canonical_name || null,
        category: matchedRecord.record.category || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyProductHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}

async function fuzzyLookupProduct(productName) {
  const canonical = normalizeName(productName || '');
  const candidates = await AuthoritativeRecord.find({ doc_type: 'PRODUCT_DOSSIER' }).limit(500).lean();
  if (!candidates || candidates.length === 0) return null;

  const scored = candidates.map(c => {
    const cand = c.product_name || c.canonical_name || (c.raw && c.raw.product_name) || '';
    const dist = levenshtein.get(canonical, normalizeName(cand || ''));
    const maxLen = Math.max(canonical.length, (cand||'').length, 1);
    const similarity = 1 - (dist / maxLen);
    return { record: c, score: similarity };
  });

  scored.sort((a,b) => b.score - a.score);
  const best = scored[0];
  if (best && best.score >= 0.65) return { record: best.record, score: best.score };
  return null;
}


function buildReasons(checks, matchedRecord) {
  const reasons = [];
  if (checks.format_check === 1) reasons.push('dossier_fields_ok');
  else if (checks.format_check > 0) reasons.push('partial_dossier_fields');
  if (checks.claim_check === 0) reasons.push('banned_label_claims_detected');
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}
