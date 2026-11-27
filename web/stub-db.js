// Stand-in for src/db.js in the local-engine bundle: no database, no numbering. Documents get a SAMPLE number.
export const nextNumber = () => { throw new Error('numbering is not available in the local engine'); };
