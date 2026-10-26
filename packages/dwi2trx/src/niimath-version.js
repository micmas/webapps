// The version of the niimath build this package pins, for provenance. Browsers (through Vite) and
// Node both read it from the package's own package.json, which its `./package.json` export opens.
import niimathPackage from '@niivue/niimath/package.json' with { type: 'json' };

export const NIIMATH_VERSION = niimathPackage.version;
