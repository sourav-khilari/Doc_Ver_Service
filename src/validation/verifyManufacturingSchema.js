// src/validation/verifyManufacturingSchema.js
import Joi from 'joi';

const sectors = ['AYURVEDA','UNANI','SIDDHA','HOMOEOPATHY','YOGA_NATURO'];
const licenseTypes = ['OWN_UNIT','LOAN_LICENSE'];

export const verifyManufacturingSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('MANUFACTURING_LICENSE').required(),
  extracted: Joi.object({
    sector: Joi.string().valid(...sectors).required(),
    license_type: Joi.string().valid(...licenseTypes).required(),

    // references/hints from OCR/main backend (prefer id_hash/document_hash)
    inc_id_hash: Joi.string().hex().length(64).optional(),     // Incorporation
    gst_id_hash: Joi.string().hex().length(64).optional(),     // GST
    lease_id_hash: Joi.string().hex().length(64).optional(),   // Lease/document hash
    gmp_id_hash: Joi.string().hex().length(64).optional(),     // GMP certificate
    tech_staff_ids: Joi.array().items(Joi.string().hex().length(64)).optional(), // array of id_hash for TECH_CERT or PROMOTER_KYC
    product_id_hashes: Joi.array().items(Joi.string().hex().length(64)).optional(),
    noc_id_hashes: Joi.array().items(Joi.string().hex().length(64)).optional(), // Fire / Pollution / BIO
    additional_documents: Joi.array().items(Joi.object()).optional(), // optional raw docs metadata

    // optional OCR confidence for the whole bundle
    bundle_ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
