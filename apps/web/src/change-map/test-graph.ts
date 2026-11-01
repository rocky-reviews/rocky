/** Shared by this folder's tests: pr-847's graph through the real parser. */
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { type AnalysisDocument, type Graph, parseAnalysisDocument } from "@rocky-reviews/schema";

export const pr847Doc = (): AnalysisDocument => {
  const parsed = parseAnalysisDocument(structuredClone(pr847));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

export const pr847Graph = (): Graph => {
  const graph = pr847Doc().graph;
  if (graph === undefined) throw new Error("pr-847 has a graph");
  return graph;
};
