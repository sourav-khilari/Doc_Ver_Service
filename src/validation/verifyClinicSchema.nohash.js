// src/validation/verifyClinicSchema.nohash.js
import Joi from "joi";

const sectors = ["AYURVEDA","YOGA_NATURO","UNANI","SIDDHA","HOMOEOPATHY"];

export const verifyClinicSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid("CLINIC").required(),
  extracted: Joi.object({
    sector: Joi.string().valid(...sectors).required(),
    clinic_type: Joi.string().valid("CLINIC","HOSPITAL","WELLNESS_CENTRE").required(),

    // Clinical registration details (human-readable)
    clinical_registration_no: Joi.string().optional(),
    clinical_registration_form_name: Joi.string().optional(),

    // Entity KYC (optional)
    incorporation_no: Joi.string().optional(),
    pan_of_entity_masked: Joi.string().optional(),
    gst_no: Joi.string().optional(),

    // Premises KYC
    premises_ownership_type: Joi.string().valid("OWNERSHIP","LEASE").optional(),
    premises_address: Joi.string().required(),
    occupancy_certificate_no: Joi.string().optional(),
    latest_utility_bill_date: Joi.date().iso().optional(),

    // Practitioners (array)
    practitioners: Joi.array().items(
      Joi.object({
        name: Joi.string().required(),
        registration_no_masked: Joi.string().optional(), // e.g., "BAMS-XXXX-1234" masked
        council_name: Joi.string().optional(), // e.g., "State Ayurvedic Council"
        qualification: Joi.string().optional(),
        dob: Joi.date().iso().optional()
      })
    ).min(1).required(),

    // Facility / equipment / SOPs
    equipment_list: Joi.array().items(Joi.string()).optional(),
    sops_present: Joi.boolean().optional(),
    consent_template_present: Joi.boolean().optional(),

    // Statutory NOCs
    bio_med_waste_authorization_no: Joi.string().optional(),
    fire_noc_no: Joi.string().optional(),

    // OCR confidence / metadata
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
