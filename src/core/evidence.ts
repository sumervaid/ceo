/**
 * Everything that joins the attempt pipeline by registering itself:
 * verifier kinds, attempt gates and promote hooks. Each entry point that
 * starts attempts imports this module once, so no gate or verifier is
 * silently missing from one path and present in another.
 */

import "./verify.js";
import "./outcomes.js";

import "./everval.js";
import "./gates.js";
