// src/validation/verifyAadhaarSchema.js
import Joi from 'joi';

export const verifyAadhaarSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('AADHAAR').required(),
  extracted: Joi.object({
    // full aadhaar is sensitive — accept only if main backend policy allows
    aadhaar: Joi.string().pattern(/^[0-9]{12}$/).optional(),
    // preferred: id_hash = sha256(normalized aadhaar)
    id_hash: Joi.string().hex().length(64).optional(),
    aadhaar_last4: Joi.string().pattern(/^[0-9]{4}$/).optional(),
    name: Joi.string().required(),
    dob: Joi.date().iso().required(),
    pincode: Joi.string().pattern(/^[0-9]{6}$/).optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
