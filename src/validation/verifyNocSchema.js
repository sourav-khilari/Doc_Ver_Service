// src/validation/verifyNocSchema.js
import Joi from 'joi';

const nocTypes = ['FIRE_NOC', 'POLLUTION_NOC', 'BIO_NOC'];

export const verifyNocSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  // doc_type should match the route but validate allowed types
  doc_type: Joi.string().valid(...nocTypes).required(),
  extracted: Joi.object({
    authority_name: Joi.string().required(),
    certificate_no: Joi.string().optional(), // may be absent on some scans
    id_hash: Joi.string().hex().length(64).optional(), // preferred when provided
    issue_date: Joi.date().iso().optional(),
    valid_upto: Joi.date().iso().optional(),
    address: Joi.string().optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
