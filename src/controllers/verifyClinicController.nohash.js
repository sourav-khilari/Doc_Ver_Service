// src/controllers/verifyClinicController.nohash.js
import AuthoritativeRecord from "../models/AuthoritativeRecord.js";
import Verification from "../models/Verification.js";
import { computeFinalConfidence, decideStatus } from "../services/scoringService.js";
import levenshtein from "fast-levenshtein";
import { v4 as uuidv4 } from "uuid";

/**
 * POST /api/verify/clinic  (no-hash)
 *
 * Uses human-readable numbers and masked IDs for exact lookup.
 */
export async function verifyClinicHandlerNoHash(req, res) {
  try {
    const { request_id, submitted_by, extracted } = req.body;
    const {
      sector, clinic_type, clinical_registration_no, clinical_registration_form_name,
      incorporation_no, pan_of_entity_masked, gst_no,
      premises_ownership_type, premises_address, occupancy_certificate_no, latest_utility_bill_date,
      practitioners = [],
      equipment_list = [], sops_present = false, consent_template_present = false,
      bio_med_waste_authorization_no, fire_noc_no,
      ocr_confidence
    } = extracted;

    const verification_id = `ver-${uuidv4()}`;

    // Components
    const components = {
      clinical_registration: { required: true, matched:false, score:0, record:null },
      entity_kyc: { required:false, matched:false, score:0, record:null },
      premises: { required:true, matched:false, score:0, record:null },
      practitioners: { required:true, matched:false, score:0, matched_count:0, records:[] },
      facility: { required:true, matched:false, score:0 },
      statutory: { required:true, matched:false, score:0, records:[] }
    };

    // Helpers
    async function exactLookupByField(docType, value) {
      if (!value) return null;
      const q = { doc_type: docType };
      q["$or"] = [
        { "raw.certificate_no": value },
        { "raw.registration_no": value },
        { "id_masked": value },
        { "raw.form_no": value }
      ];
      return await AuthoritativeRecord.findOne(q).lean();
    }

    async function fuzzyLookupByName(docTypes, name, threshold = 0.62) {
      if (!name) return null;
      const types = Array.isArray(docTypes) ? docTypes : [docTypes];
      const candidates = await AuthoritativeRecord.find({ doc_type: { $in: types } }).limit(400).lean();
      if (!candidates || candidates.length === 0) return null;
      const nameCanon = name.toString().toLowerCase().trim();
      const scored = candidates.map(c => {
        const cand = (c.canonical_name || (c.raw && (c.raw.name || c.raw.practitioner_name) ) || "").toString().toLowerCase();
        const dist = levenshtein.get(nameCanon, cand);
        const maxLen = Math.max(nameCanon.length, cand.length, 1);
        const sim = 1 - (dist / maxLen);
        return { record: c, score: sim };
      });
      scored.sort((a,b)=>b.score - a.score);
      const best = scored[0];
      if (best && best.score >= threshold) return best;
      return null;
    }

    // 1) Clinical registration exact by registration no or form name
    if (clinical_registration_no) {
      const rec = await exactLookupByField("CLINICAL_REG", clinical_registration_no);
      if (rec) { components.clinical_registration.matched = true; components.clinical_registration.score = 1; components.clinical_registration.record = rec; }
    }
    if (!components.clinical_registration.matched && clinical_registration_form_name) {
      const fuzzy = await fuzzyLookupByName("CLINICAL_REG", clinical_registration_form_name, 0.58);
      if (fuzzy) { components.clinical_registration.matched = true; components.clinical_registration.score = fuzzy.score; components.clinical_registration.record = fuzzy.record; }
    }

    // 2) Entity KYC (optional): incorporation or masked PAN
    if (incorporation_no) {
      const rec = await exactLookupByField("INCORP", incorporation_no);
      if (rec) { components.entity_kyc.matched = true; components.entity_kyc.score = 1; components.entity_kyc.record = rec; }
    } else if (pan_of_entity_masked) {
      const rec = await AuthoritativeRecord.findOne({ doc_type: "PROMOTER_KYC", id_masked: pan_of_entity_masked }).lean();
      if (rec) { components.entity_kyc.matched = true; components.entity_kyc.score = 1; components.entity_kyc.record = rec; }
    } else if (gst_no) {
      const rec = await exactLookupByField("GST", gst_no);
      if (rec) { components.entity_kyc.matched = true; components.entity_kyc.score = 1; components.entity_kyc.record = rec; }
    }

    // 3) Premises: occupancy certificate or utility check & address fuzzy match
    let premisesScore = 0;
    if (occupancy_certificate_no) {
      const rec = await exactLookupByField("OCCUPANCY", occupancy_certificate_no);
      if (rec) { components.premises.matched = true; components.premises.score = 1; components.premises.record = rec; premisesScore = 1; }
    }
    if (!components.premises.matched && premises_address) {
      // fuzzy find utility or lease with similar address
      const addrFrag = premises_address.toString().split(/\s+/).slice(0,4).join(" ");
      const candidates = await AuthoritativeRecord.find({ doc_type: { $in: ["LEASE","UTILITY","INCORP"] }, address: { $regex: addrFrag, $options: "i" } }).limit(200).lean();
      if (candidates && candidates.length) {
        // compute address/name similarity
        let bestSim = 0;
        for (const c of candidates) {
          const candAddr = (c.address || (c.raw && (c.raw.registered_office_address || ""))).toString().toLowerCase();
          const dist = levenshtein.get(premises_address.toLowerCase(), candAddr || "");
          const maxLen = Math.max(premises_address.length, (candAddr||"").length, 1);
          const sim = 1 - (dist / maxLen);
          if (sim > bestSim) { bestSim = sim; components.premises.record = c; }
        }
        if (bestSim >= 0.62) { components.premises.matched = true; components.premises.score = bestSim; premisesScore = bestSim; }
      }
    }
    components.premises.score = premisesScore;

    // 4) Practitioners: for each practitioner -> exact by masked reg no OR fuzzy by name + council
    let matchedPractCnt = 0;
    for (const p of practitioners) {
      let matched = null;
      if (p.registration_no_masked) {
        // search PROMOTER_KYC, TECH_CERT, or PAN records for id_masked
        const rec = await AuthoritativeRecord.findOne({ doc_type: { $in: ["TECH_CERT","PROMOTER_KYC","PAN"] }, id_masked: p.registration_no_masked }).lean();
        if (rec) matched = { rec, method: "exact_masked" };
      }
      if (!matched && p.name) {
        const fuzzy = await fuzzyLookupByName(["TECH_CERT","PROMOTER_KYC","PAN"], p.name, 0.62);
        if (fuzzy) matched = { rec: fuzzy.record, method: "fuzzy_name", score: fuzzy.score };
      }
      if (matched) {
        matchedPractCnt++;
        components.practitioners.records.push({
          input_name: p.name,
          matched_id_masked: matched.rec.id_masked || matched.rec.raw?.registration_no || null,
          canonical_name: matched.rec.canonical_name || matched.rec.raw?.name || null,
          match_method: matched.method,
          score: matched.score || 1
        });
      } else {
        components.practitioners.records.push({ input_name: p.name, matched: false, reasons: ["no_match_found"] });
      }
    }
    components.practitioners.matched_count = matchedPractCnt;
    // required practitioners may depend on clinic_type/sector (simple rule: >=1 practitioner)
    const requiredPract = (clinic_type === "HOSPITAL") ? 2 : 1;
    components.practitioners.score = Math.min(1, matchedPractCnt / requiredPract);
    components.practitioners.matched = matchedPractCnt >= requiredPract;

    // 5) Facility/equipment & SOPs
    const requiredEquipmentBySector = {
      AYURVEDA: ["panchakarma table","sudation steam","panchakarma equipment"],
      YOGA_NATURO: ["yoga hall","hydrotherapy setup"],
      UNANI: ["treatment beds","herbal processing kit"],
      SIDDHA: ["panchakarma table","special therapy equipment"],
      HOMOEOPATHY: ["consultation table","medicine storage"]
    };
    const requiredEquip = requiredEquipmentBySector[sector] || [];
    let equipScore = 0;
    if (requiredEquip.length === 0) equipScore = sops_present ? 0.8 : 0.5;
    else {
      const presentCount = requiredEquip.filter(req => equipment_list.map(e=>e.toLowerCase()).some(x => x.includes(req.split(" ")[0].toLowerCase()))).length;
      equipScore = presentCount / requiredEquip.length;
    }
    // SOPs & consent boost
    let facilityScore = equipScore;
    if (sops_present) facilityScore = Math.min(1, facilityScore + 0.1);
    if (consent_template_present) facilityScore = Math.min(1, facilityScore + 0.05);
    components.facility.score = Number(facilityScore.toFixed(3));
    components.facility.matched = facilityScore >= 0.6;

    // 6) Statutory NOCs: check bio-med waste & fire NOC presence via exact lookup by certificate no
    let statMatched = 0;
    if (bio_med_waste_authorization_no) {
      const rec = await exactLookupByField("BIO_NOC", bio_med_waste_authorization_no);
      if (rec) { components.statutory.records.push(rec); statMatched++; }
    }
    if (fire_noc_no) {
      const rec = await exactLookupByField("FIRE_NOC", fire_noc_no);
      if (rec) { components.statutory.records.push(rec); statMatched++; }
    }
    // if both required, require both; else partial score
    const requiredStatCount = 1; // at least 1 (bio-med or fire depending on treatments). tune per sector.
    components.statutory.matched_count = statMatched;
    components.statutory.score = Math.min(1, statMatched / Math.max(1, requiredStatCount));
    components.statutory.matched = components.statutory.score >= 1;

    // 7) Compose DB score (weights)
    const weights = { clinical_reg:0.25, entity_kyc:0.08, premises:0.22, practitioners:0.25, facility:0.12, statutory:0.08 };
    const rawDb = (
      (components.clinical_registration.score || 0) * weights.clinical_reg +
      (components.entity_kyc.score || 0) * weights.entity_kyc +
      (components.premises.score || 0) * weights.premises +
      (components.practitioners.score || 0) * weights.practitioners +
      (components.facility.score || 0) * weights.facility +
      (components.statutory.score || 0) * weights.statutory
    );
    const weightSum = Object.values(weights).reduce((a,b)=>a+b,0);
    const normalized_db_score = rawDb / weightSum;

    // format_check: presence of minimal attachments (premises, practitioners, facility)
    const format_check = (components.premises.matched && components.practitioners.matched && components.facility.matched) ? 1 : 0.3;

    const final_confidence = computeFinalConfidence({ db_match_score: normalized_db_score, format_check, ocr_confidence: ocr_confidence ?? 0 });
    const status = decideStatus(final_confidence);

    // Persist verification (include practitioners records for reviewer)
    const verDoc = await Verification.create({
      verification_id,
      request_id,
      submitted_by,
      doc_type: "CLINIC",
      extracted,
      checks: { db_score: normalized_db_score, format_check, ocr_confidence: ocr_confidence ?? 0 },
      components,
      final_confidence,
      status,
      reasons: buildReasons(components, normalized_db_score, final_confidence)
    });

    // Response: compact components for client
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
    console.error("verifyClinicHandlerNoHash error", err);
    return res.status(500).json({ error: "internal_server_error" });
  }
}

function buildReasons(components, dbScore, finalConfidence) {
  const reasons = [];
  if (!components.clinical_registration.matched) reasons.push("no_clinical_registration");
  if (!components.premises.matched) reasons.push("premises_not_verified");
  if (!components.practitioners.matched) reasons.push("practitioners_insufficient");
  if (!components.facility.matched) reasons.push("facility_insufficient");
  if (!components.statutory.matched) reasons.push("missing_statutory_nocs");
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
      matched_count: c.matched_count || 0,
      records: (c.records || (c.record ? [c.record] : [])).map(r => r ? ({
        record_id: r._id,
        id_masked: r.id_masked || r.raw?.certificate_no || r.raw?.registration_no || null,
        canonical_name: r.canonical_name || (r.raw && (r.raw.name || r.raw.practitioner_name || r.raw.lab_name || r.raw.product_name)) || null
      }) : null)
    };
  }
  return out;
}
