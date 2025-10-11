// src/validation/verifyElectricitySchema.nohash.js
import Joi from "joi";

export const verifyElectricitySchema = Joi.object({
  request_id: Joi.string().required(),
  submitted_by: Joi.string().optional(),
  doc_type: Joi.string().valid("ELECTRICITY_BILL").required(),
  extracted: Joi.object({
    consumer_name: Joi.string().required(),
    consumer_account_no_masked: Joi.string().optional(), // e.g., "XXXXXX1234"
    service_connection_no: Joi.string().optional(),      // sometimes available
    meter_no: Joi.string().optional(),
    distributor_name: Joi.string().optional(),           // DISCOM name
    billing_date: Joi.date().iso().required(),
    billing_period_from: Joi.date().iso().optional(),
    billing_period_to: Joi.date().iso().optional(),
    due_date: Joi.date().iso().optional(),
    bill_amount: Joi.number().optional(),
    energy_kwh: Joi.number().optional(),                 // energy consumption for period
    sanctioned_load_kw: Joi.number().optional(),         // for industrial/commercial
    consumer_category: Joi.string().optional(),          // e.g., "LT Commercial", "HT Industrial"
    address: Joi.string().optional(),
    account_status: Joi.string().valid("paid","unpaid","partial","unknown").optional(),
    bill_number: Joi.string().optional(),
    document_pages: Joi.number().optional(),
    ocr_confidence: Joi.number().min(0).max(1).optional()
  }).required(),
  metadata: Joi.object().optional()
});
