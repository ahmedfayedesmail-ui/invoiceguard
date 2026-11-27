// Browser stand-in for node:crypto in the local-engine bundle. The local page never hashes or caches (the PDF cache is not used there).
export const createHash = () => { throw new Error('createHash is not available in the browser bundle'); };
