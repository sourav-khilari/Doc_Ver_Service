import crypto from 'crypto';
import {Jimp} from 'jimp';
import QrCodeReader from 'qrcode-reader';

const PRODUCTS = {
  "PROD-ASH-001": {
    name: "Ashwagandha 60 caps",
    sec_pass: "s3cr3tP@ssw0rd",
    batch: "BATCH-202509"
  },
  
};

function canonicalString({ productId, batch = '', issuedAt = '', exp = '', nonce = '' }) {
  return `${productId}|${batch}|${issuedAt}|${exp}|${nonce}`;
}

// Utility: compute HMAC-SHA256 base64 signature using secret
function computeHmacBase64(secret, canonical) {
  return crypto.createHmac('sha256', secret).update(canonical).digest('base64');
}


export async function verifyProductQrHandler (req, res){
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'image file required' });

    const buffer = req.file.buffer;
    const image = await Jimp.read(buffer);
    const qr = new QrCodeReader();

    qr.callback = function(err, value) {
      if (err || !value) {
        return res.status(400).json({ ok: false, error: 'QR decode failed' });
      }
      try {
        const qrContent = value.result; // the base64 encoded JSON string we encoded earlier
        // Reuse verify-payload logic by calling inline:
        const decodedJson = Buffer.from(qrContent, 'base64').toString('utf8');
        const obj = JSON.parse(decodedJson);
        const { productId, batch, issuedAt, exp, nonce, sig } = obj;
        if (!productId || !sig) return res.status(400).json({ ok: false, error: 'invalid payload' });

        const product = PRODUCTS[productId];
        if (!product) return res.status(400).json({ ok: false, error: 'unknown productId' });

        const canonical = canonicalString({ productId, batch, issuedAt, exp, nonce });
        const expectedSig = computeHmacBase64(product.sec_pass, canonical);
        if (expectedSig !== sig) return res.status(401).json({ ok: false, verified: false, reason: 'signature mismatch' });

        if (exp && Number(exp) > 0 && Date.now() > Number(exp)) {
          return res.status(400).json({ ok: false, verified: false, reason: 'expired' });
        }

        return res.json({
          ok: true,
          verified: true,
          product: { id: productId, name: product.name, batch },
          meta: { issuedAt, exp, nonce }
        });
      } catch (e) {
        console.error('verify error', e);
        return res.status(400).json({ ok: false, error: 'invalid payload or verification error' });
      }
    };

    // decode the image bitmap
    qr.decode(image.bitmap);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
}