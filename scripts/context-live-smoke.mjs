import {generateKeyPairSync,randomBytes,hkdfSync,createCipheriv} from 'node:crypto';
if(!process.env.LADDER_TOKEN)throw new Error('LADDER_TOKEN missing');
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const salt=randomBytes(32),iv=randomBytes(12),key=hkdfSync('sha256',process.env.LADDER_TOKEN,salt,Buffer.from('context-real-smoke-key-v1'),32);
const c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(privateKey,'utf8'),c.final()]);
console.log('SEALED_TEST_KEY='+JSON.stringify({publicKey,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),sealed:data.toString('base64')}));
