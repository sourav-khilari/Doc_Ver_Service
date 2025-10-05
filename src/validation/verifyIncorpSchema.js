// src/validation/verifyIncorpSchema.js
import Joi from 'joi';

export const verifyIncorpSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('INCORP').required(),
  extracted: Joi.object({
    reg_no: Joi.string().optional(), // e.g., CIN / LLPIN / registration number
    id_hash: Joi.string().hex().length(64).optional(), // preferred
    entity_name: Joi.string().required(),
    entity_type: Joi.string().valid('Private Limited','Public Limited','LLP','Partnership','Proprietorship','OPC','Society','Trust').optional(),
    date_of_incorporation: Joi.date().iso().optional(),
    registered_office_address: Joi.string().optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
