// Synthetic acceptance peer only. Output contains PUBLIC keys, never seeds.
const fs=require('node:fs'),path=require('node:path');
const {ed25519,x25519}=require('@noble/curves/ed25519');
const {sha256}=require('@noble/hashes/sha256');
const {bytesToHex,hexToBytes,concatBytes}=require('@noble/hashes/utils');
const QRCode=require('qrcode-generator');
const destination=process.argv[2];fs.mkdirSync(destination,{recursive:true});
const identity={signingKey:bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(41))),encryptionKey:bytesToHex(x25519.getPublicKey(new Uint8Array(32).fill(42)))};
// Derivation is checked against the application's exported fingerprint by tests.
const id='pm1:'+bytesToHex(sha256(concatBytes(new TextEncoder().encode('PalMesh identity v1'),hexToBytes(identity.signingKey),hexToBytes(identity.encryptionKey))));
const envelope={type:'palmesh-public-identity',version:1,id,publicIdentity:identity};
const qr=QRCode(0,'M');qr.addData(JSON.stringify(envelope),'Byte');qr.make();
fs.writeFileSync(path.join(destination,'PalMeshPublicContact.gif'),Buffer.from(qr.createDataURL(6,24).split(',')[1],'base64'));
fs.writeFileSync(path.join(destination,'public-identity.json'),JSON.stringify(envelope));
