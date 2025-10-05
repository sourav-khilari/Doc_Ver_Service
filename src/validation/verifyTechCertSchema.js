// src/validation/verifyTechCertSchema.js
import Joi from 'joi';

export const verifyTechCertSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('TECH_CERT').required(),
  extracted: Joi.object({
    name: Joi.string().required(),
    registration_no: Joi.string().optional(),   // council reg no (if OCR extracted)
    id_hash: Joi.string().hex().length(64).optional(), // preferred
    council_name: Joi.string().required(),
    qualification: Joi.string().optional(),
    issue_date: Joi.date().iso().optional(),
    valid_upto: Joi.date().iso().optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
