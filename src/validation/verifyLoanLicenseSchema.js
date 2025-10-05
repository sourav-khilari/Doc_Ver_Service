// src/validation/verifyLoanLicenseSchema.nohash.js
import Joi from "joi";

export const verifyLoanLicenseSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid("LOAN_LICENSE").required(),
  extracted: Joi.object({
    // applicant references (human-readable ids)
    applicant_incorporation_no: Joi.string().optional(),
    applicant_gst_no: Joi.string().optional(),

    // executed agreement (human-readable agreement number / title)
    agreement_number: Joi.string().optional(),
    agreement_title: Joi.string().optional(),

    // contract manufacturer fields (human-readable)
    cm_incorporation_no: Joi.string().optional(),
    cm_gst_no: Joi.string().optional(),
    cm_manufacturer_license_no: Joi.string().optional(),
    cm_gmp_certificate_no: Joi.string().optional(),

    // products: product codes or names extracted by OCR
    product_codes: Joi.array().items(Joi.string()).optional(),
    product_names: Joi.array().items(Joi.string()).optional(),

    // technical staff: can be PAN masked / name / registration nos
    tech_staff_pan_masked: Joi.array().items(Joi.string()).optional(),
    tech_staff_names: Joi.array().items(Joi.string()).optional(),

    // agreement dates / metadata
    agreement_signed_date: Joi.date().iso().optional(),
    agreement_effective_from: Joi.date().iso().optional(),
    agreement_effective_to: Joi.date().iso().optional(),

    // overall OCR confidence for the bundle
    bundle_ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
