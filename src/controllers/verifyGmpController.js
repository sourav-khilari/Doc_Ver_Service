// src/controllers/verifyGmpController.js
import AuthoritativeRecord from '../models/AuthoritativeRecord.js';
import Verification from '../models/Verification.js';
import { computeFinalConfidence, decideStatus } from '../services/scoringService.js';
import { normalizeId, normalizeName, sha256Hex } from '../utils/hash.js';
import levenshtein from 'fast-levenshtein';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/verify/gmp
 */
export async function verifyGmpHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    const {
      certificate_no, id_hash: client_hash, scheme_name, lab_name,
      equipment_list = [], issue_date, valid_upto, scope, site_plan_id, qc_lab_details, ocr_confidence
    } = extracted;

    const verification_id = `ver-${uuidv4()}`;
    const checks = {
      format_check: 0,
      db_match_score: 0,
      date_validity: 0,
      equipment_coverage: 0,
      ocr_confidence: (ocr_confidence ?? 0)
    };

    // Format check: certificate_no permissive; if absent lower format score
    if (certificate_no && /^[A-Za-z0-9\-\_\/]{4,60}$/.test(certificate_no)) checks.format_check = 1;
    else if (!certificate_no) checks.format_check = 0.5;
    else checks.format_check = 0;

    // Date validity: check valid_upto
    const now = new Date();
    if (valid_upto) {
      const vu = new Date(valid_upto);
      checks.date_validity = vu >= now ? 1 : 0;
    } else {
      checks.date_validity = 0.5; // unknown
    }

    // Equipment coverage: check presence of a small required set per scheme_name
    const requiredByScheme = getRequiredEquipmentForScheme(scheme_name);
    if (requiredByScheme.length === 0) {
      checks.equipment_coverage = 0.5; // unknown requirement
    } else {
      const presentCount = requiredByScheme.filter(req => equipment_list.map(e => e.toLowerCase()).some(x => x.includes(req.toLowerCase()))).length;
      checks.equipment_coverage = presentCount / requiredByScheme.length; // 0..1
    }

    // Exact lookup: id_hash (preferred), else hash(certificate_no)
    let matchedRecord = null;
    if (client_hash) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'GMP', id_hash: client_hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_id_hash' }; checks.db_match_score = 1.0; }
    } else if (certificate_no) {
      const hash = sha256Hex(normalizeId(certificate_no));
      const rec = await AuthoritativeRecord.findOne({ doc_type: 'GMP', id_hash: hash }).lean();
      if (rec) { matchedRecord = { record: rec, match_type: 'exact_cert_hash' }; checks.db_match_score = 1.0; }
    }

    // Fuzzy fallback: lab_name + scheme_name
    if (!matchedRecord && lab_name) {
      const fuzzy = await fuzzyLookupGmp(lab_name, scheme_name);
      if (fuzzy) {
        matchedRecord = { record: fuzzy.record, match_type: 'fuzzy_lab_scheme', score: fuzzy.score };
        checks.db_match_score = fuzzy.score || 0;
      }
    }

    // Compute final confidence: include equipment_coverage as part of format_check composite
    const compositeFormat = (checks.format_check + checks.date_validity + checks.equipment_coverage) / 3;
    const final_confidence = computeFinalConfidence({ db_match_score: checks.db_match_score, format_check: compositeFormat, ocr_confidence: checks.ocr_confidence });
    const status = decideStatus(final_confidence);

    // Persist verification audit
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: 'GMP',
      extracted,
      checks,
      matched_record_id: matchedRecord?.record?._id ?? null,
      final_confidence,
      status,
      reasons: buildReasons(checks, matchedRecord)
    });

    // Response (mask PII)
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      scores: checks,
      matched_record: matchedRecord?.record ? {
        record_id: matchedRecord.record._id,
        match_type: matchedRecord.match_type,
        id_masked: matchedRecord.record.id_masked || null,
        lab_name: matchedRecord.record.canonical_name || null,
        valid_upto: matchedRecord.record.valid_upto || null,
        scope: matchedRecord.record.scope || null
      } : null,
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('verifyGmpHandler error', err);
    return res.status(500).json({ error: 'internal_server_error' });
  }
}

// small helper: required equipment per scheme (tuneable)
function getRequiredEquipmentForScheme(scheme) {
  const map = {
    'Schedule T': ['stainless steel tanks', 'autoclave', 'weighing balance', 'mixer', 'drying oven'],
    'Homeopathy GMP': ['potency room', 'sterile storage', 'glassware', 'weighing balance'],
    'General GMP': ['weighing balance', 'QC lab', 'autoclave']
  };
  return map[scheme] || [];
}

// fuzzy candidate scoring using lab_name & scheme_name similarity
async function fuzzyLookupGmp(labName, schemeName) {
  const canonicalLab = normalizeName(labName);
  const query = { doc_type: 'GMP' };
  // attempt to filter by scheme_name if present (stored in scope or raw)
  if (schemeName) query.scope = { $regex: schemeName.split(' ').slice(0,3).join(' '), $options: 'i' };

  let candidates = await AuthoritativeRecord.find(query).limit(200).lean();
  if (!candidates || candidates.length === 0) {
    candidates = await AuthoritativeRecord.find({ doc_type: 'GMP' }).limit(200).lean();
  }
  if (!candidates || candidates.length === 0) return null;

  const scored = candidates.map(c => {
    const candName = c.canonical_name || (c.raw && c.raw.lab_name) || '';
    const nameDist = levenshtein.get(canonicalLab, normalizeName(candName || ''));
    const nameMax = Math.max(canonicalLab.length, (candName||'').length, 1);
    const nameSim = 1 - (nameDist / nameMax);

    let schemeSim = 0;
    if (schemeName && (c.scope || c.raw?.scheme_name)) {
      const candScheme = c.scope || c.raw.scheme_name || '';
      const schemeDist = levenshtein.get(schemeName.toLowerCase(), candScheme.toLowerCase());
      const schemeMax = Math.max(schemeName.length, (candScheme||'').length, 1);
      schemeSim = 1 - (schemeDist / schemeMax);
    }
    // weight lab name 0.7, scheme 0.3
    const combined = (0.7 * nameSim) + (0.3 * schemeSim);
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
  if (checks.equipment_coverage > 0.75) reasons.push('equipment_coverage_good');
  else if (checks.equipment_coverage > 0) reasons.push(`equipment_coverage_${(checks.equipment_coverage*100).toFixed(0)}%`);
  if (checks.db_match_score === 1.0) reasons.push('exact_db_match');
  else if (checks.db_match_score > 0) reasons.push(`fuzzy_db_match_score_${(checks.db_match_score).toFixed(2)}`);
  if (checks.ocr_confidence && checks.ocr_confidence < 0.6) reasons.push('low_ocr_confidence');
  if (!matchedRecord) reasons.push('no_db_match_found');
  return reasons;
}
