#!/usr/bin/env python3
"""Submit a synthetic FA(3) invoice to the KSeF **TEST** environment (api-test.ksef.mf.gov.pl).
Result is TEST-ENVIRONMENT verification with synthetic data. It is NOT production verification.
Refuses any other base URL. Usage: ksef_test_submit.py FA3.xml [NIP]  (NIP must be the seller NIP in the XML)"""
import sys, json, base64, hashlib, datetime, os, random, time, re
import requests
from lxml import etree
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding as sympad

BASE = 'https://api-test.ksef.mf.gov.pl/v2'
assert 'api-test.ksef.mf.gov.pl' in BASE
DS = 'http://www.w3.org/2000/09/xmldsig#'; XA = 'http://uri.etsi.org/01903/v1.3.2#'
NS_AUTH = 'http://ksef.mf.gov.pl/auth/token/2.0'

def synthetic_nip():
    w = [6,5,7,2,3,4,5,6,7]
    while True:
        d = [random.randint(1,9)] + [random.randint(0,9) for _ in range(8)]
        c = sum(a*b for a,b in zip(d,w)) % 11
        if c != 10: return ''.join(map(str,d))+str(c)

def make_cert(nip):
    key = rsa.generate_private_key(65537, 2048)
    name = x509.Name([x509.NameAttribute(NameOID.GIVEN_NAME,'A'), x509.NameAttribute(NameOID.SURNAME,'R'),
        x509.NameAttribute(NameOID.SERIAL_NUMBER,'TINPL-'+nip), x509.NameAttribute(NameOID.COMMON_NAME,'A R'),
        x509.NameAttribute(NameOID.COUNTRY_NAME,'PL')])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=30))
        .add_extension(x509.KeyUsage(True,True,False,False,False,False,False,False,False), critical=True)
        .sign(key, hashes.SHA256()))
    return key, cert

def c14n(el): return etree.tostring(el, method='c14n', exclusive=True, with_comments=False)
def b64(b): return base64.b64encode(b).decode()
def sha(b): return hashlib.sha256(b).digest()

def sign_xades(xml_bytes, key, cert):
    root = etree.fromstring(xml_bytes)
    root_digest = b64(sha(c14n(root)))
    now = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    cert_der = cert.public_bytes(serialization.Encoding.DER)
    issuer = cert.issuer.rfc4514_string()
    sig_xml = f'''<Signature xmlns="{DS}" Id="Signature"><SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><DigestValue>{root_digest}</DigestValue></Reference><Reference URI="#SignedProperties" Type="http://uri.etsi.org/01903#SignedProperties"><Transforms><Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><DigestValue>PLACEHOLDER</DigestValue></Reference></SignedInfo><SignatureValue>PLACEHOLDER</SignatureValue><KeyInfo><X509Data><X509Certificate>{b64(cert_der)}</X509Certificate></X509Data></KeyInfo><Object><xades:QualifyingProperties xmlns:xades="{XA}" Target="#Signature"><xades:SignedProperties Id="SignedProperties"><xades:SignedSignatureProperties><xades:SigningTime>{now}</xades:SigningTime><xades:SigningCertificate><xades:Cert><xades:CertDigest><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><DigestValue>{b64(sha(cert_der))}</DigestValue></xades:CertDigest><xades:IssuerSerial><X509IssuerName>{issuer}</X509IssuerName><X509SerialNumber>{cert.serial_number}</X509SerialNumber></xades:IssuerSerial></xades:Cert></xades:SigningCertificate></xades:SignedSignatureProperties></xades:SignedProperties></xades:QualifyingProperties></Object></Signature>'''
    sig = etree.fromstring(sig_xml)
    root.append(sig)
    sp = root.find('.//{%s}SignedProperties' % XA)
    refs = sig.findall('.//{%s}DigestValue' % DS)
    # the two Reference digests are the first two DigestValue elements in SignedInfo
    si = sig.find('{%s}SignedInfo' % DS)
    si.findall('{%s}Reference' % DS)[1].find('{%s}DigestValue' % DS).text = b64(sha(c14n(sp)))
    sv = key.sign(c14n(si), padding.PKCS1v15(), hashes.SHA256())
    sig.find('{%s}SignatureValue' % DS).text = b64(sv)
    return etree.tostring(root, xml_declaration=True, encoding='UTF-8')

def jr(r):
    try: return r.json()
    except Exception: return {'raw': r.text[:500]}

def main():
    xml = open(sys.argv[1], 'rb').read()
    nip = re.search(rb'<NIP>(\d{10})</NIP>', xml).group(1).decode()
    if len(sys.argv) > 2 and sys.argv[2] != nip and sys.argv[2] != '-': sys.exit('NIP argument does not match the seller NIP in the XML')
    s = requests.Session(); out = {'environment': 'KSeF TEST (synthetic data), not production', 'nip': nip}
    r = s.post(f'{BASE}/auth/challenge'); out['challenge_status'] = r.status_code; ch = jr(r)['challenge']
    req = f'<?xml version="1.0" encoding="UTF-8"?><AuthTokenRequest xmlns="{NS_AUTH}"><Challenge>{ch}</Challenge><ContextIdentifier><Nip>{nip}</Nip></ContextIdentifier><SubjectIdentifierType>certificateSubject</SubjectIdentifierType></AuthTokenRequest>'
    key, cert = make_cert(nip)
    signed = sign_xades(req.encode(), key, cert)
    r = s.post(f'{BASE}/auth/xades-signature', data=signed, headers={'Content-Type': 'application/xml'})
    out['auth_status'] = r.status_code; j = jr(r)
    if r.status_code != 202: out['error'] = j; print(json.dumps(out, indent=1)); sys.exit(2)
    ref, atok = j['referenceNumber'], j['authenticationToken']['token']
    h = {'Authorization': 'Bearer ' + atok}
    for _ in range(30):
        st = jr(s.get(f'{BASE}/auth/{ref}', headers=h))
        if st.get('status', {}).get('code') != 100: break
        time.sleep(1)
    out['auth_result'] = st.get('status')
    if st.get('status', {}).get('code') != 200: print(json.dumps(out, indent=1)); sys.exit(3)
    r = s.post(f'{BASE}/auth/token/redeem', headers=h); tk = jr(r)
    acc = tk['accessToken']['token']; H = {'Authorization': 'Bearer ' + acc}
    certs = jr(s.get(f'{BASE}/security/public-key-certificates'))
    pk = [c for c in certs if 'SymmetricKeyEncryption' in c['usage']][0]
    mf = x509.load_der_x509_certificate(base64.b64decode(pk['certificate']))
    aes_key, iv = os.urandom(32), os.urandom(16)
    enc_key = mf.public_key().encrypt(aes_key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    r = s.post(f'{BASE}/sessions/online', headers=H, json={'formCode': {'systemCode': 'FA (3)', 'schemaVersion': '1-0E', 'value': 'FA'},
        'encryption': {'encryptedSymmetricKey': b64(enc_key), 'initializationVector': b64(iv)}})
    out['session_open_status'] = r.status_code; sj = jr(r)
    if r.status_code != 201: out['error'] = sj; print(json.dumps(out, indent=1)); sys.exit(4)
    sref = sj['referenceNumber']
    def send(xml):
        pad = sympad.PKCS7(128).padder(); data = pad.update(xml) + pad.finalize()
        enc = Cipher(algorithms.AES(aes_key), modes.CBC(iv)).encryptor(); ct = enc.update(data) + enc.finalize()
        r = s.post(f'{BASE}/sessions/online/{sref}/invoices', headers=H, json={'invoiceHash': b64(sha(xml)), 'invoiceSize': len(xml),
            'encryptedInvoiceHash': b64(sha(ct)), 'encryptedInvoiceSize': len(ct), 'encryptedInvoiceContent': b64(ct)})
        ij = jr(r)
        if r.status_code != 202: out['error'] = ij; out['send_status'] = r.status_code; print(json.dumps(out, indent=1)); sys.exit(5)
        iref = ij['referenceNumber']
        for _ in range(40):
            ist = jr(s.get(f'{BASE}/sessions/{sref}/invoices/{iref}', headers=H))
            if ist.get('status', {}).get('code', 0) >= 200: break
            time.sleep(2)
        return ist
    results = []
    ist = send(xml); results.append({'invoice': 'original', 'status': ist.get('status'), 'ksefNumber': ist.get('ksefNumber')})
    code = 0 if ist.get('status', {}).get('code') == 200 else 6
    if len(sys.argv) > 3 and code == 0:
        kor = open(sys.argv[3], 'rb').read().replace(b'KSEF_NUMBER_PLACEHOLDER', ist['ksefNumber'].encode())
        k = send(kor); results.append({'invoice': 'correction (KOR)', 'status': k.get('status'), 'ksefNumber': k.get('ksefNumber')})
        if k.get('status', {}).get('code') != 200: code = 7
    out['results'] = results
    s.post(f'{BASE}/sessions/online/{sref}/close', headers=H)
    for _ in range(40):
        ss = jr(s.get(f'{BASE}/sessions/{sref}', headers=H))
        if ss.get('upo') or ss.get('status', {}).get('code', 0) >= 200 and ss.get('status', {}).get('code') != 170: break
        time.sleep(2)
    out['session_status'] = ss.get('status'); out['invoiceCount'] = ss.get('invoiceCount'); out['successfulInvoiceCount'] = ss.get('successfulInvoiceCount')
    upo = ss.get('upo') or {}; pages = upo.get('pages') or []
    out['upo_pages'] = len(pages)
    if pages:
        u = pages[0].get('downloadUrl'); r = requests.get(u)
        open('/tmp/ksef_upo.xml', 'wb').write(r.content); out['upo_http'] = r.status_code; out['upo_saved'] = '/tmp/ksef_upo.xml'; out['upo_head'] = r.text[:300]
    print(json.dumps(out, indent=1, ensure_ascii=False))
    sys.exit(code)
main()
