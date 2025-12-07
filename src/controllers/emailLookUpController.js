import AuthoritativeRecord from '../models/AuthoritativeRecord.js';

export async function emailLookUpController  (req, res) {
  try {
    const { aadhar_last4 } = req.body;

    // 1. validate input
    if (!aadhar_last4 || !/^\d{4}$/.test(aadhar_last4)) {
      return res.status(400).json({
        success: false,
        message: 'aadhar_last4 is required and must be 4 digits'
      });
    }

    // 2. find record where:
    //    - doc_type is AADHAAR
    //    - id_masked ends with those 4 digits
    const record = await AuthoritativeRecord.findOne({
      doc_type: 'AADHAAR',
      id_masked: { $regex: `${aadhar_last4}$` } // ends with last4
    }).lean();

    if (!record) {
      return res.status(404).json({
        success: false,
        message: 'No AADHAAR record found for the given last 4 digits'
      });
    }

    if (!record.email) {
      return res.status(404).json({
        success: false,
        message: 'Record found but no email stored'
      });
    }

    // 3. return email (and anything else you want)
    return res.json({
      success: true,
      data: {
        email: record.email,
        canonical_name: record.canonical_name,
        id_masked: record.id_masked,
        doc_type: record.doc_type
      }
    });
  } catch (err) {
    console.error('Error in /api/aadhaar/email-lookup:', err);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}