#!/usr/bin/env python3
"""Offline XSD validation. usage: validate_xsd.py fa3|fatturapa FILE.xml
Result is SCHEMA-VALID only. Not accepted by KSeF or SDI; schema validity is not tax correctness."""
import sys, os, json
from lxml import etree
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'schemas')
S = {'fa3': 'FA3.xsd', 'fatturapa': 'FatturaPA_1.2.2.xsd'}
kind, f = sys.argv[1], sys.argv[2]
schema = etree.XMLSchema(etree.parse(os.path.join(D, S[kind])))
try:
    doc = etree.parse(f)
except Exception as e:
    print(json.dumps({'schemaValid': False, 'errors': [str(e)]})); sys.exit(1)
ok = schema.validate(doc)
print(json.dumps({'schemaValid': ok, 'scope': 'schema-valid only, not accepted by KSeF/SDI',
  'errors': [{'line': e.line, 'message': e.message[:300]} for e in schema.error_log]}))
sys.exit(0 if ok else 1)
