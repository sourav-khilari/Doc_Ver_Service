// src/validation/verifyGmpSchema.js
import Joi from 'joi';

export const verifyGmpSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('GMP').required(),
  extracted: Joi.object({
    certificate_no: Joi.string().optional(),
    id_hash: Joi.string().hex().length(64).optional(),
    scheme_name: Joi.string().required(),         // e.g., "Schedule T"
    lab_name: Joi.string().required(),
    equipment_list: Joi.array().items(Joi.string()).optional(),
    issue_date: Joi.date().iso().optional(),
    valid_upto: Joi.date().iso().optional(),
    scope: Joi.string().optional(),
    site_plan_id: Joi.string().optional(),
    qc_lab_details: Joi.object().optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
