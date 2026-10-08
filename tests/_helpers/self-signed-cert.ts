// A throwaway self-signed certificate for 127.0.0.1 and localhost, made fresh per call so no key is ever committed.
// node:crypto signs but cannot build a certificate, so the X.509 DER is assembled here by hand.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

export interface TestCertificate {
  /** PEM certificate; also the CA a test client trusts. */
  cert: string;
  /** PEM private key of a pair that exists only for this test run. */
  key: string;
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length = body.length < 0x80 ? [body.length]
    : body.length < 0x100 ? [0x81, body.length]
    : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts);
const oid = (hex: string): Buffer => der(0x06, Buffer.from(hex, 'hex'));
const utcTime = (at: Date): Buffer => der(0x17, Buffer.from(`${at.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'ascii'));

const ECDSA_WITH_SHA256 = sequence(oid('2a8648ce3d040302'));
const COMMON_NAME = oid('550403');
const SUBJECT_ALT_NAME = oid('551d11');
const BASIC_CONSTRAINTS = oid('551d13');
const DAY_MS = 86_400_000;

export function makeTestCertificate(): TestCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = sequence(der(0x31, sequence(COMMON_NAME, der(0x0c, Buffer.from('hippo test only', 'utf8')))));
  // DER wants the shortest positive form: top bit clear and a first byte that is never zero.
  const serialBytes = randomBytes(8);
  serialBytes.writeUInt8((serialBytes.readUInt8(0) & 0x3f) | 0x40, 0);
  const serial = der(0x02, serialBytes);
  const altNames = sequence(der(0x82, Buffer.from('localhost', 'ascii')), der(0x87, Buffer.from([127, 0, 0, 1])));
  const extensions = sequence(
    sequence(SUBJECT_ALT_NAME, der(0x04, altNames)),
    // CA:TRUE, so the client can trust this one certificate as its own issuer.
    sequence(BASIC_CONSTRAINTS, der(0x01, Buffer.from([0xff])), der(0x04, sequence(der(0x01, Buffer.from([0xff]))))),
  );
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    serial,
    ECDSA_WITH_SHA256,
    name,
    sequence(utcTime(new Date(Date.now() - DAY_MS)), utcTime(new Date(Date.now() + DAY_MS))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, extensions),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = sequence(tbs, ECDSA_WITH_SHA256, der(0x03, Buffer.from([0]), signature));
  const lines = certificate.toString('base64').match(/.{1,64}/g) ?? [];
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
