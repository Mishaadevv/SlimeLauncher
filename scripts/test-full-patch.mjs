import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import zlib from 'node:zlib';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const pubKeyBase64 = publicKey.toString('base64');
console.log('Generated RSA 4096 key, DER length:', publicKey.length, 'base64 length:', pubKeyBase64.length);

const testPayload = Buffer.from(JSON.stringify({
  timestamp: Date.now(),
  profileId: '33837371-c213-45d2-b552-ea31cd4692b1',
  profileName: 'Sigmultra452',
  textures: {
    SKIN: { url: 'http://127.0.0.1:12345/textures/33837371c21345d2b552ea31cd4692b1' }
  }
})).toString('base64');

const sign = crypto.createSign('RSA-SHA1');
sign.update(testPayload);
const signature = sign.sign(privateKey, 'base64');
console.log('Signature base64 length:', signature.length);

// Verify with public key
const verify = crypto.createVerify('RSA-SHA1');
verify.update(testPayload);
const ok = verify.verify(crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' }), signature, 'base64');
console.log('Signature verification check in Node:', ok);
