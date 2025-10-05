import Joi from 'joi';

export const verifyLeaseSchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid('LEASE').required(),
  extracted: Joi.object({
    lessor_name: Joi.string().required(),
    lessee_name: Joi.string().required(),
    premises_address: Joi.string().required(),
    start_date: Joi.date().iso().required(),
    end_date: Joi.date().iso().required(),
 
    document_hash: Joi.string().hex().length(64).optional(),

    id_hash: Joi.string().hex().length(64).optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
