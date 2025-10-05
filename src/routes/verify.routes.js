// src/routes/verify.js
import express from 'express';
import validate from '../middleware/validate.js';
// import apiKeyAuth from '../middleware/apiKeyAuth.js';
import { verifyPanHandler } from '../controllers/verifyPanController.js';
import { verifyPanSchema } from '../validation/schemas.js';
import { verifyAadhaarHandler } from '../controllers/verifyAadhaarController.js';
import { verifyAadhaarSchema } from '../validation/verifyAadhaarSchema.js';
import { verifyIncorpHandler } from '../controllers/verifyIncorpController.js';
import { verifyIncorpSchema } from '../validation/verifyIncorpSchema.js';
import { verifyGstHandler } from '../controllers/verifyGstController.js';
import { verifyGstSchema } from '../validation/verifyGstSchema.js';
import { verifyLeaseHandler } from '../controllers/verifyLeaseController.js';
import { verifyLeaseSchema } from '../validation/verifyLeaseSchema.js';
import { verifyNocHandler } from '../controllers/verifyNocController.js';
import { verifyNocSchema } from '../validation/verifyNocSchema.js';
import { verifyTechCertHandler } from '../controllers/verifyTechCertController.js';
import { verifyTechCertSchema } from '../validation/verifyTechCertSchema.js';
import { verifyGmpHandler } from '../controllers/verifyGmpController.js';
import { verifyGmpSchema } from '../validation/verifyGmpSchema.js';
import { verifyProductHandler } from '../controllers/verifyProductController.js';
import { verifyProductSchema } from '../validation/verifyProductSchema.js';
import { verifyMoaHandler } from '../controllers/verifyMoaController.js';
import { verifyMoaSchema } from '../validation/verifyMoaSchema.js';
import { verifyBoardResHandler } from '../controllers/verifyBoardResController.js';
import { verifyBoardResSchema } from '../validation/verifyBoardResSchema.js';

const router = express.Router();

// Protect all verify routes with API key

router.post('/verify/pan', validate(verifyPanSchema), verifyPanHandler);
router.post('/verify/aadhaar', validate(verifyAadhaarSchema), verifyAadhaarHandler);
router.post('/verify/incorporation', validate(verifyIncorpSchema), verifyIncorpHandler);
router.post('/verify/gst', validate(verifyGstSchema), verifyGstHandler);
router.post('/verify/lease', validate(verifyLeaseSchema), verifyLeaseHandler);
router.post('/verify/fire-noc', validate(verifyNocSchema), (req, res, next) => { req.body.doc_type = 'FIRE_NOC'; return verifyNocHandler(req, res, next); });
router.post('/verify/pollution-noc', validate(verifyNocSchema), (req, res, next) => { req.body.doc_type = 'POLLUTION_NOC'; return verifyNocHandler(req, res, next); });
router.post('/verify/bio-noc', validate(verifyNocSchema), (req, res, next) => { req.body.doc_type = 'BIO_NOC'; return verifyNocHandler(req, res, next); });
router.post('/verify/tech-cert', validate(verifyTechCertSchema), verifyTechCertHandler);
router.post('/verify/gmp', validate(verifyGmpSchema), verifyGmpHandler);
router.post('/verify/product-dossier', validate(verifyProductSchema), verifyProductHandler);
router.post('/verify/moa', validate(verifyMoaSchema), verifyMoaHandler);
router.post('/verify/board-resolution', validate(verifyBoardResSchema), verifyBoardResHandler);

// Export router to mount in app.js
export default router;



