// src/controllers/verifyLoanLicenseController.nohash.js
import AuthoritativeRecord from "../models/AuthoritativeRecord.js";
import Verification from "../models/Verification.js";
import { computeFinalConfidence, decideStatus } from "../services/scoringService.js";
import levenshtein from "fast-levenshtein";
import { v4 as uuidv4 } from "uuid";

/**
 * POST /api/verify/loan-license  (no-hash variant)
 *
 * This version uses only visible identifiers:
 * - incorporation no, GST no, licence no, GMP cert no, agreement number/title,
 * - masked PANs, product codes/names, and names for fuzzy matching.
 *
 * All exact matches look up by fields stored in AuthoritativeRecord.raw (certificate_no, registration_no, id_masked).
 */
export async function verifyLoanLicenseHandler(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    const {
      applicant_incorporation_no, applicant_gst_no,
      agreement_number, agreement_title,
      cm_incorporation_no, cm_gst_no, cm_manufacturer_license_no, cm_gmp_certificate_no,
      product_codes = [], product_names = [],
      tech_staff_pan_masked = [], tech_staff_names = [],
      agreement_signed_date, agreement_effective_from, agreement_effective_to,
      bundle_ocr_confidence
    } = extracted;

    const verification_id = `ver-${uuidv4()}`;

    const components = {
      applicant_incorp: { required: true, matched: false, score: 0, record:null },
      applicant_gst: { required: false, matched: false, score: 0, record:null },
      agreement: { required: true, matched: false, score: 0, record:null },
      cm_incorp: { required: true, matched: false, score: 0, record:null },
      cm_gst: { required: false, matched: false, score: 0, record:null },
      cm_manufacturer_license: { required: true, matched: false, score: 0, record:null },
      cm_gmp: { required: true, matched: false, score: 0, record:null },
      products: { required: true, matched: false, score: 0, matched_count: 0, records: [] },
      tech_staff: { required: true, matched: false, score: 0, matched_count: 0, records: [] }
    };

    // Helper: exact lookup by a known certificate/registration number or masked id
    async function exactLookupByField(docType, fieldName, value) {
      if (!value) return null;
      const q = { doc_type: docType };
      // search common stored places: raw.certificate_no, raw.registration_no, id_masked
      q["$or"] = [
        { "raw.certificate_no": value },
        { "raw.registration_no": value },
        { "id_masked": value }
      ];
      return await AuthoritativeRecord.findOne(q).lean();
    }

    // Helper: fuzzy search by name (returns best candidate with score)
    async function fuzzyLookupByName(docTypes, name, opt = {}) {
      if (!name) return null;
      const types = Array.isArray(docTypes) ? docTypes : [docTypes];
      const candidates = await AuthoritativeRecord.find({ doc_type: { $in: types } }).limit(500).lean();
      if (!candidates || candidates.length === 0) return null;
      const nameCanon = name.toString().toLowerCase().trim();
      const scored = candidates.map(c => {
        const cand = (c.canonical_name || (c.raw && c.raw.name) || "").toString().toLowerCase();
        const dist = levenshtein.get(nameCanon, cand);
        const maxLen = Math.max(nameCanon.length, cand.length, 1);
        const sim = 1 - (dist / maxLen);
        return { record: c, score: sim };
      });
      scored.sort((a,b) => b.score - a.score);
      const best = scored[0];
      if (best && best.score >= (opt.threshold || 0.62)) return best;
      return null;
    }

    // 1) Applicant incorporation (exact by incorporation_no)
    if (applicant_incorporation_no) {
      const rec = await exactLookupByField("INCORP", "registration_no", applicant_incorporation_no);
      if (rec) { components.applicant_incorp.matched = true; components.applicant_incorp.score = 1; components.applicant_incorp.record = rec; }
    }

    // 2) Applicant GST (optional)
    if (applicant_gst_no) {
      const rec = await exactLookupByField("GST", "registration_no", applicant_gst_no);
      if (rec) { components.applicant_gst.matched = true; components.applicant_gst.score = 1; components.applicant_gst.record = rec; }
    }

    // 3) Agreement (match by agreement_number exact OR by title fuzzy)
    if (agreement_number) {
      const rec = await exactLookupByField("LOAN_AGREEMENT", "agreement_no", agreement_number) || await exactLookupByField("MOA","registration_no", agreement_number);
      if (rec) { components.agreement.matched = true; components.agreement.score = 1; components.agreement.record = rec; }
    }
    if (!components.agreement.matched && agreement_title) {
      const fuzzy = await fuzzyLookupByName("LOAN_AGREEMENT", agreement_title, { threshold: 0.58 });
      if (fuzzy) { components.agreement.matched = true; components.agreement.score = fuzzy.score; components.agreement.record = fuzzy.record; }
    }

    // 4) Contract manufacturer incorporation & GST
    if (cm_incorporation_no) {
      const rec = await exactLookupByField("INCORP", "registration_no", cm_incorporation_no);
      if (rec) { components.cm_incorp.matched = true; components.cm_incorp.score = 1; components.cm_incorp.record = rec; }
    }
    if (cm_gst_no) {
      const rec = await exactLookupByField("GST", "registration_no", cm_gst_no);
      if (rec) { components.cm_gst.matched = true; components.cm_gst.score = 1; components.cm_gst.record = rec; }
    }

    // 5) Contract manufacturer licence and GMP (exact by certificate numbers)
    if (cm_manufacturer_license_no) {
      const rec = await exactLookupByField("MANUFACTURING_LICENSE", "raw.certificate_no", cm_manufacturer_license_no) ||
                  await exactLookupByField("GMP", "raw.certificate_no", cm_manufacturer_license_no);
      if (rec) { components.cm_manufacturer_license.matched = true; components.cm_manufacturer_license.score = 1; components.cm_manufacturer_license.record = rec; }
    }
    if (cm_gmp_certificate_no) {
      const rec = await exactLookupByField("GMP", "raw.certificate_no", cm_gmp_certificate_no);
      if (rec) { components.cm_gmp.matched = true; components.cm_gmp.score = 1; components.cm_gmp.record = rec; }
    }

    // 6) Products: match product_codes exact, else fuzzy product_names
    let productMatches = 0;
    for (const code of (product_codes || [])) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: "PRODUCT_DOSSIER", $or: [{ "raw.product_code": code }, { "raw.product_code": { $regex: `^${escapeRegex(code)}$`, $options: "i" } }] }).lean();
      if (rec) { productMatches++; components.products.records.push(rec); }
    }
    if (productMatches === 0 && (product_names || []).length > 0) {
      for (const name of product_names) {
        const fuzzy = await fuzzyLookupByName("PRODUCT_DOSSIER", name, { threshold: 0.65 });
        if (fuzzy) { productMatches++; components.products.records.push(fuzzy.record); }
      }
    }
    components.products.matched_count = productMatches;
    components.products.score = Math.min(1, productMatches / 1);
    components.products.matched = productMatches >= 1;

    // 7) Tech staff: exact by masked PAN first, then fuzzy by name
    let techMatched = 0;
    for (const panMasked of (tech_staff_pan_masked || [])) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: "PROMOTER_KYC", id_masked: panMasked }).lean();
      if (rec) { techMatched++; components.tech_staff.records.push(rec); }
    }
    if (techMatched === 0 && (tech_staff_names || []).length) {
      for (const name of tech_staff_names) {
        const fuzzy = await fuzzyLookupByName(["TECH_CERT","PROMOTER_KYC","PAN"], name, { threshold: 0.64 });
        if (fuzzy) { techMatched++; components.tech_staff.records.push(fuzzy.record); }
      }
    }
    components.tech_staff.matched_count = techMatched;
    components.tech_staff.score = Math.min(1, techMatched / 1);
    components.tech_staff.matched = techMatched >= 1;

    // 8) Agreement dates plausibility
    let agreementDateScore = 0.5;
    try {
      if (agreement_signed_date) {
        const now = new Date();
        const signed = new Date(agreement_signed_date);
        if (signed <= now) agreementDateScore = 1;
      }
      if (agreement_effective_from && agreement_effective_to) {
        const from = new Date(agreement_effective_from);
        const to = new Date(agreement_effective_to);
        if (from <= to) agreementDateScore = Math.min(1, agreementDateScore + 0.1);
      }
    } catch (e) { /* ignore parsing problems */ }

    // 9) Compose DB score with sensible weights
    const weights = {
      applicant_incorp: 0.18, applicant_gst: 0.07, agreement: 0.25,
      cm_incorp: 0.10, cm_gst: 0.05, cm_license: 0.15, cm_gmp: 0.10,
      product: 0.06, tech: 0.04
    };
    const rawDb = (
      (components.applicant_incorp.score * weights.applicant_incorp) +
      (components.applicant_gst.score * weights.applicant_gst) +
      (components.agreement.score * weights.agreement) +
      (components.cm_incorp.score * weights.cm_incorp) +
      (components.cm_gst.score * weights.cm_gst) +
      (components.cm_manufacturer_license.score * weights.cm_license) +
      (components.cm_gmp.score * weights.cm_gmp) +
      (components.products.score * weights.product) +
      (components.tech_staff.score * weights.tech)
    );
    const weightSum = Object.values(weights).reduce((a,b)=>a+b,0);
    let normalized_db_score = rawDb / weightSum;
    normalized_db_score = Math.min(1, normalized_db_score + (agreementDateScore * 0.02));

    // Format check
    const essentialOk = components.applicant_incorp.matched && components.agreement.matched && components.cm_manufacturer_license.matched && components.cm_gmp.matched && components.products.matched;
    const format_check = essentialOk ? 1 : 0.25;

    const final_confidence = computeFinalConfidence({
      db_match_score: normalized_db_score,
      format_check,
      ocr_confidence: bundle_ocr_confidence ?? 0
    });
    const status = decideStatus(final_confidence);

    // Persist
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: "LOAN_LICENSE",
      extracted,
      checks: { db_score: normalized_db_score, format_check, agreementDateScore, ocr_confidence: bundle_ocr_confidence ?? 0 },
      components,
      final_confidence,
      status,
      reasons: buildReasons(components, normalized_db_score, final_confidence)
    });

    // Response: summarize and include matched fields (masked) and references
    const response = {
      verification_id,
      status,
      final_confidence: Number(final_confidence.toFixed(4)),
      db_score: Number(normalized_db_score.toFixed(4)),
      components: mapComponentsForResponse(components),
      reasons: verDoc.reasons,
      timestamp: verDoc.created_at
    };

    return res.status(200).json(response);

  } catch (err) {
    console.error("verifyLoanLicenseHandlerNoHash error", err);
    return res.status(500).json({ error: "internal_server_error" });
  }
}

// small helpers
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildReasons(components, dbScore, finalConfidence) {
  const reasons = [];
  if (!components.applicant_incorp.matched) reasons.push("missing_applicant_incorp");
  if (!components.agreement.matched) reasons.push("missing_agreement");
  if (!components.cm_manufacturer_license.matched) reasons.push("missing_cm_manufacturer_license");
  if (!components.cm_gmp.matched) reasons.push("missing_cm_gmp");
  if (!components.products.matched) reasons.push("no_product_dossier_found");
  if (!components.tech_staff.matched) reasons.push("insufficient_technical_staff");
  reasons.push(`db_score_${dbScore.toFixed(3)}`);
  reasons.push(`final_confidence_${finalConfidence.toFixed(3)}`);
  return reasons;
}

function mapComponentsForResponse(components) {
  const out = {};
  for (const k of Object.keys(components)) {
    const c = components[k];
    out[k] = {
      required: c.required,
      matched: !!c.matched,
      score: Number((c.score || 0).toFixed(3)),
      // include minimal reference info for reviewer (record id & masked fields)
      records: (c.records || (c.record ? [c.record] : [])).map(r => r ? {
        record_id: r._id,
        id_masked: r.id_masked || r.raw?.certificate_no || r.raw?.registration_no || null,
        canonical_name: r.canonical_name || (r.raw && (r.raw.name || r.raw.lab_name || r.raw.product_name)) || null
      } : null)
    };
  }
  return out;
}
