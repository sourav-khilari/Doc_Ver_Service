// src/validation/verifyPromoterKycSchema.js
import Joi from 'joi';

const idTypes = ['PAN','AADHAAR','PASSPORT','OTHER'];

export const verifyPromoterKycSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('PROMOTER_KYC').required(),
  extracted: Joi.object({
    name: Joi.string().required(),
    id_type: Joi.string().valid(...idTypes).optional(),
    id_no_masked: Joi.string().optional(),
    id_hash: Joi.string().hex().length(64).optional(), // preferred (sha256 of normalized id)
    dob: Joi.date().iso().optional(),
    address: Joi.string().optional(),
    contact: Joi.object({
      phone: Joi.string().optional(),
      email: Joi.string().email().optional()
    }).optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional(),
    make_authoritative: Joi.boolean().optional() // if true, create/upsert authoritative record (dev only; protect in prod)
  }).required(),
  metadata: Joi.object().optional()
});
