/**
 * Every verifier kind, registered. Importing this module loads the
 * implementations that register themselves, then re-exports the registry.
 */

import "./verify.js";
import "./everval.js";

export * from "./verify.js";
export { evervalStatus, evervalBin, changedFiles, type EvervalStatus } from "./everval.js";
