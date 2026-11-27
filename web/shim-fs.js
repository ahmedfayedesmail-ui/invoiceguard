// Browser stand-in for node:fs, used ONLY by the local-engine bundle: rules.js reads rules/*.json at import, so the JSON files are inlined here.
import AMAZON from '../rules/AMAZON.json'; import DE from '../rules/DE.json'; import ES from '../rules/ES.json'; import EU from '../rules/EU.json';
import FR from '../rules/FR.json'; import IT from '../rules/IT.json'; import NL from '../rules/NL.json'; import PL from '../rules/PL.json';
const FILES = { 'AMAZON.json': AMAZON, 'DE.json': DE, 'ES.json': ES, 'EU.json': EU, 'FR.json': FR, 'IT.json': IT, 'NL.json': NL, 'PL.json': PL };
export const readdirSync = () => Object.keys(FILES);
export const readFileSync = (u) => JSON.stringify(FILES[String(u).split('/').pop()]);
