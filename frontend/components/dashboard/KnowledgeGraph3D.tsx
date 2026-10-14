'use client';
/* eslint-disable @typescript-eslint/no-explicit-any -- react-force-graph-3d node/link objects and three.js callbacks are untyped at this boundary */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SpriteText from 'three-spritetext';
import { Maximize2, RotateCw } from 'lucide-react';
import type { GraphData, GraphNode } from './KnowledgeGraph';

// Resolved hex for the WebGL materials (three can't read our CSS vars at runtime).
const HEX = {
  accent: '#8468ff',
  cyan: '#38dceb',
  lead: '#38c8f8',
  prospect: '#a78bfa',
  customer: '#34d399',
  neutral: '#8a93b0',
  dim: '#2a3047', // links/nodes faded out when something else is hovered
};

const TYPE_LABEL: Record<string, string> = {
  hub: 'Your book',
  org: 'Organization',
  person: 'Person',
  interaction: 'Interaction',
};
const STAGE_LABEL: Record<string, string> = {
  LEAD: 'Lead',
  PROSPECT: 'Prospect',
  CUSTOMER: 'Customer',
};

function colorFor(n: { type?: string; stage?: string }): string {
  if (n.type === 'hub') return HEX.accent;
  if (n.type === 'interaction') return HEX.cyan;
  if (n.stage === 'LEAD') return HEX.lead;
  if (n.stage === 'PROSPECT') return HEX.prospect;
  if (n.stage === 'CUSTOMER') return HEX.customer;
  return HEX.neutral;
}

// Base visual weight per node type (drives sphere radius via nodeVal).
function baseVal(n: { type?: string }): number {
  return n.type === 'hub' ? 11 : n.type === 'org' ? 6 : n.type === 'interaction' ? 1.6 : 3;
}

/** Escape user/contact-derived strings before they go into a tooltip's innerHTML. */
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  ));
}

export interface Graph3DProps {
  data: GraphData;
  /** Auto-rotate, no drag/zoom, no labels — the glanceable dashboard view. */
  preview?: boolean;
  /** Show the fit-to-view / re-frame control (ignored in preview). Default true. */
  controls?: boolean;
  onNodeClick?: (n: GraphNode) => void;
  onNodeDoubleClick?: (n: GraphNode) => void;
}

/** KnowledgeGraph3D — the immersive WebGL relationship constellation. Nodes glow
 *  (UnrealBloom), colored by funnel stage. Hovering lights up a node and its
 *  immediate links and dims the rest; click inspects, double-click drills. */
export function KnowledgeGraph3D({
  data,
  preview = false,
  controls = true,
  onNodeClick,
  onNodeDoubleClick,
}: Graph3DProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const lastClick = useRef<{ id: string | null; t: number }>({ id: null, t: 0 });
  const [FG, setFG] = useState<any>(null);
  const [size, setSize] = useState({ w: 640, h: 380 });

  // Reduced-motion: kill auto-rotate, particle motion, hover-grow tweens, and use
  // instant camera moves. Read once on mount + react to the media query changing.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduceMotion(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  // Hover highlight state lives in refs so the accessors below never force the
  // <FG> element to remount (which would reset the camera). We repaint via
  // fgRef.current.refresh() instead of React re-rendering the canvas.
  const hoverNodeId = useRef<string | null>(null);
  const highlightNodes = useRef<Set<string>>(new Set());
  const highlightLinks = useRef<Set<any>>(new Set());
  const [, bumpChrome] = useState(0); // re-renders only the lightweight overlay chrome

  // Client-only load of the force-graph component (keeps three out of SSR), with
  // a real ref to the forwardRef component so camera/bloom/controls are reachable.
  useEffect(() => {
    let alive = true;
    import('react-force-graph-3d').then((m) => { if (alive) setFG(() => m.default); });
    return () => { alive = false; };
  }, []);

  // Build the renderable graph + a node/neighbour adjacency index for hover
  // highlighting. We key links by a stable string so they can live in a Set.
  const { graphData, adjacency } = useMemo(() => {
    const nodes = data.nodes.map((n) => ({ ...n }));
    const links = data.edges.map((e) => ({ source: e.from, target: e.to, __id: `${e.from}->${e.to}` }));
    const adj = new Map<string, { nodes: Set<string>; links: Set<any> }>();
    const ensure = (id: string) => {
      let a = adj.get(id);
      if (!a) { a = { nodes: new Set(), links: new Set() }; adj.set(id, a); }
      return a;
    };
    for (const l of links) {
      const a = ensure(l.source);
      const b = ensure(l.target);
      a.nodes.add(l.target); a.links.add(l);
      b.nodes.add(l.source); b.links.add(l);
    }
    return { graphData: { nodes, links }, adjacency: adj };
  }, [data]);

  // A node is "active" (full color/size) when nothing is hovered, or it's the
  // hovered node / one of its neighbours. Everything else dims back.
  const isActive = useCallback((id: string) => {
    if (!hoverNodeId.current) return true;
    return id === hoverNodeId.current || highlightNodes.current.has(id);
  }, []);

  const linkId = (l: any) => (typeof l === 'object' && l.__id) ? l.__id : `${l?.source}->${l?.target}`;
  const targetOf = (l: any) => (typeof l.target === 'object' ? l.target : { });

  const applyHighlight = useCallback((node: any | null) => {
    highlightNodes.current.clear();
    highlightLinks.current.clear();
    hoverNodeId.current = node ? node.id : null;
    if (node) {
      const a = adjacency.get(node.id);
      if (a) {
        a.nodes.forEach((n) => highlightNodes.current.add(n));
        a.links.forEach((l) => highlightLinks.current.add(linkId(l)));
      }
    }
    // Pointer affordance + repaint the WebGL styling.
    const el = wrapRef.current;
    if (el) el.style.cursor = node ? 'pointer' : 'grab';
    try { fgRef.current?.refresh(); } catch { /* not mounted yet */ }
    bumpChrome((n) => n + 1);
  }, [adjacency]);

  const onNodeHover = useCallback((node: any | null) => {
    if ((node?.id ?? null) === hoverNodeId.current) return;
    applyHighlight(node ?? null);
  }, [applyHighlight]);

  const onLinkHover = useCallback((link: any | null) => {
    // Hovering a link lights both its endpoints + the link itself.
    highlightNodes.current.clear();
    highlightLinks.current.clear();
    if (link) {
      const s = typeof link.source === 'object' ? link.source.id : link.source;
      const t = typeof link.target === 'object' ? link.target.id : link.target;
      hoverNodeId.current = s; // anchor the dim test on an endpoint
      highlightNodes.current.add(s);
      highlightNodes.current.add(t);
      highlightLinks.current.add(linkId(link));
    } else {
      hoverNodeId.current = null;
    }
    const el = wrapRef.current;
    if (el) el.style.cursor = link ? 'pointer' : 'grab';
    try { fgRef.current?.refresh(); } catch { /* ignore */ }
    bumpChrome((n) => n + 1);
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [FG]);

  // Bloom glow + forces + camera + (preview) auto-rotate, once the instance
  // exists. Bloom is tuned to read as a halo, not a blown-out blob.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const t = setTimeout(async () => {
      try {
        const THREE = await import('three');
        const { UnrealBloomPass } = await import('three/examples/jsm/postprocessing/UnrealBloomPass.js');
        const composer = fg.postProcessingComposer();
        // Guard against double-adding the pass across hot effect re-runs.
        if (!composer.__coBloom) {
          // strength 0.85 (moderate), radius 0.55 (soft falloff), threshold 0.28
          // (only the brighter cores bloom → cleaner than a uniform wash).
          const bloom = new UnrealBloomPass(new THREE.Vector2(size.w || 640, size.h || 380), 0.85, 0.55, 0.28);
          composer.addPass(bloom);
          composer.__coBloom = bloom;
        } else {
          composer.__coBloom.resolution.set(size.w || 640, size.h || 380);
        }
      } catch { /* bloom is a nice-to-have */ }
      try {
        // A touch of ambient + directional light so the dimmed (non-bloom) nodes
        // still read as solid spheres rather than flat discs.
        const THREE = await import('three');
        const scene = fg.scene();
        if (scene && !scene.__coLit) {
          scene.add(new THREE.AmbientLight(0xffffff, 0.55));
          const dir = new THREE.DirectionalLight(0xbfd0ff, 0.7);
          dir.position.set(1, 1, 1);
          scene.add(dir);
          scene.__coLit = true;
        }
      } catch { /* ignore */ }
      try {
        // Spread the layout so the centre doesn't collapse into a blob.
        fg.d3Force('charge')?.strength(-240);
        fg.d3Force('link')?.distance(54);
        fg.d3ReheatSimulation?.();
      } catch { /* ignore */ }
      try {
        const ctrls = fg.controls();
        ctrls.autoRotate = preview && !reduceMotion;
        ctrls.autoRotateSpeed = 0.8;
        ctrls.enableZoom = !preview;
        ctrls.enableDamping = !reduceMotion;
        ctrls.dampingFactor = 0.12;
        fg.cameraPosition({ z: preview ? 330 : 300 });
      } catch { /* ignore */ }
    }, 80);
    return () => clearTimeout(t);
  }, [FG, preview, reduceMotion, size.w, size.h]);

  // Frame the graph whenever the level changes (initial mount + each drill). The
  // delay lets the force sim settle so the fit is tight, not premature.
  const fitToView = useCallback((durationMs = 700) => {
    const fg = fgRef.current;
    if (!fg) return;
    try { fg.zoomToFit(reduceMotion ? 0 : durationMs, 64); } catch { /* ignore */ }
  }, [reduceMotion]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    // Clear any stale hover from the previous level so the new graph starts clean.
    hoverNodeId.current = null;
    highlightNodes.current.clear();
    highlightLinks.current.clear();
    const t = setTimeout(() => fitToView(700), 650);
    return () => clearTimeout(t);
  }, [FG, graphData, fitToView]);

  // Gentle click-to-focus: ease the camera toward the clicked node along the
  // current view direction, stopping a comfortable distance away (not jammed
  // into the node). Skipped in preview (no manual camera there).
  const focusNode = useCallback((node: any) => {
    const fg = fgRef.current;
    if (!fg || preview) return;
    if (node.x == null || node.y == null || node.z == null) return;
    const dist = 140; // comfortable stand-off; avoids the over-zoom feel
    const r = Math.hypot(node.x, node.y, node.z) || 1;
    const k = (r + dist) / r;
    try {
      fg.cameraPosition(
        { x: node.x * k, y: node.y * k, z: node.z * k },
        { x: node.x, y: node.y, z: node.z },
        reduceMotion ? 0 : 600,
      );
    } catch { /* ignore */ }
  }, [preview, reduceMotion]);

  const handleClick = useCallback((node: any) => {
    const now = Date.now();
    if (lastClick.current.id === node.id && now - lastClick.current.t < 350) {
      lastClick.current = { id: null, t: 0 };
      onNodeDoubleClick?.(node);
      return;
    }
    lastClick.current = { id: node.id, t: now };
    onNodeClick?.(node);
    focusNode(node);
  }, [onNodeClick, onNodeDoubleClick, focusNode]);

  // ── Styling accessors (read the highlight refs; repainted via refresh()) ──
  const nodeColor = useCallback((n: any) => (isActive(n.id) ? colorFor(n) : HEX.dim), [isActive]);
  const nodeVal = useCallback((n: any) => {
    const v = baseVal(n);
    // Subtle hover-grow on the focused node (disabled under reduced motion).
    return !reduceMotion && n.id === hoverNodeId.current ? v * 1.45 : v;
  }, [reduceMotion]);
  const linkColor = useCallback((l: any) => {
    if (hoverNodeId.current && !highlightLinks.current.has(linkId(l))) return HEX.dim;
    return colorFor(targetOf(l));
  }, []);
  const linkWidth = useCallback((l: any) => (
    highlightLinks.current.has(linkId(l)) ? 1.8 : 0.7
  ), []);
  // Link opacity stays constant — the highlighted links pop via full color + wider
  // width + particles against the dark (HEX.dim) dimmed links, so we never have to
  // globally brighten the faded edges (which would undo the "dim the rest" effect).
  const linkOpacity = 0.34;
  const linkParticles = useCallback((l: any) => {
    if (preview) return 0;
    // Interaction edges always carry a particle (they're the "signal"); on hover
    // the lit links get a denser stream. Reduced motion → none.
    if (reduceMotion) return 0;
    const isHot = highlightLinks.current.has(linkId(l));
    const isInteraction = targetOf(l).type === 'interaction';
    if (isHot) return 4;
    return isInteraction ? 2 : 0;
  }, [preview, reduceMotion]);

  const nodeLabel = useCallback((n: any) => {
    if (preview) return ''; // no tooltips in the glanceable dashboard view
    const kind = TYPE_LABEL[n.type] ?? 'Entity';
    const stage = n.stage ? STAGE_LABEL[n.stage] ?? n.stage : null;
    const dot = colorFor(n);
    const stageRow = stage
      ? `<div style="margin-top:3px;display:flex;align-items:center;gap:6px;font-size:11px;color:#aeb6cd">
           <span style="width:7px;height:7px;border-radius:9999px;background:${dot}"></span>${esc(stage)}</div>`
      : '';
    return `
      <div style="
        font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;
        background:rgba(15,17,25,0.92);border:1px solid rgba(132,104,255,0.35);
        border-radius:10px;padding:8px 11px;backdrop-filter:blur(8px);
        box-shadow:0 8px 24px -8px rgba(0,0,0,0.6);max-width:230px;pointer-events:none">
        <div style="font-size:13px;font-weight:600;color:#f1f3fa;letter-spacing:-0.01em">${esc(n.label ?? '')}</div>
        <div style="margin-top:1px;font-size:10px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#8c94aa">${esc(kind)}</div>
        ${stageRow}
      </div>`;
  }, [preview]);

  const showControls = controls && !preview;

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      {showControls && FG && (
        <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => fitToView()}
            title="Fit graph to view"
            aria-label="Fit graph to view"
            className="grid h-8 w-8 place-items-center rounded-token border border-subtle bg-surface-raised/80 text-tertiary backdrop-blur transition-colors hover:text-primary"
          >
            <Maximize2 className="h-4 w-4" strokeWidth={2.2} />
          </button>
          {!reduceMotion && (
            <button
              type="button"
              onClick={() => {
                const fg = fgRef.current;
                try {
                  const c = fg?.controls();
                  if (c) { c.autoRotate = !c.autoRotate; bumpChrome((n) => n + 1); }
                } catch { /* ignore */ }
              }}
              title="Toggle slow orbit"
              aria-label="Toggle slow orbit"
              className="grid h-8 w-8 place-items-center rounded-token border border-subtle bg-surface-raised/80 text-tertiary backdrop-blur transition-colors hover:text-primary"
            >
              <RotateCw className="h-4 w-4" strokeWidth={2.2} />
            </button>
          )}
        </div>
      )}

      {FG && (
        <FG
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          nodeLabel={nodeLabel}
          nodeColor={nodeColor}
          nodeOpacity={0.92}
          nodeVal={nodeVal}
          nodeRelSize={4}
          nodeResolution={18}
          nodeThreeObjectExtend={true}
          nodeThreeObject={(n: GraphNode) => {
            if (n.type !== 'hub' && n.type !== 'org') return undefined;
            const s = new SpriteText(n.label);
            s.color = '#eef1f8';
            s.textHeight = n.type === 'hub' ? 7.5 : 5;
            s.fontWeight = '600';
            s.position.set(0, n.type === 'hub' ? 17 : 11, 0);
            (s.material as { depthWrite: boolean }).depthWrite = false;
            return s;
          }}
          linkColor={linkColor}
          linkOpacity={linkOpacity}
          linkWidth={linkWidth}
          linkDirectionalParticles={linkParticles}
          linkDirectionalParticleWidth={1.7}
          linkDirectionalParticleSpeed={0.006}
          linkHoverPrecision={6}
          enableNodeDrag={!preview}
          onNodeClick={handleClick}
          onNodeHover={preview ? undefined : onNodeHover}
          onLinkHover={preview ? undefined : onLinkHover}
        />
      )}
    </div>
  );
}
