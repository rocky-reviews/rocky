/**
 * Test helpers for the change map (P5-2): the hostile-label corpus, the structural inertness
 * check and the fixtures. For tests only (the lint rule on the packages' `testing` entry points keeps it
 * out of production code).
 */
export {
  HOSTILE_CORPUS,
  HOSTILE_IDS,
  HOSTILE_PREFIXES,
  type HostileCase,
} from "./hostile-corpus.js";
export {
  assertInert,
  canonical,
  inspectSvg,
  parseXml,
  SVG_NS,
  type InertReport,
  type XmlElement,
  type XmlNode,
} from "./inspect.js";
export { normalised } from "./reference-normalise.js";
export { pr847, withLabels } from "./test-support.js";
