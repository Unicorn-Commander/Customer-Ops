/**
 * Sample graph re-export for the no-auth /graph-preview demo route.
 *
 * The live relationship graph (and its drill-down / node-detail) now comes from
 * the backend FalkorDB surface in `./graph-api` — there is no client-side graph
 * fabrication anymore. This module only re-exports the sample root so
 * /graph-preview (and the dashboard preview) keep rendering a constellation with
 * no backend.
 */
import { SAMPLE_GRAPH } from './sample';

export const ROOT_GRAPH = SAMPLE_GRAPH;

/** The live node-inspection shape, owned by the graph-api data layer. */
export type { NodeDetail } from './graph-api';
