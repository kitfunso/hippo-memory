import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
// UnrealBloomPass removed (E1 disabled bloom for parchment; import was dead).
import type { Memory, Conflict } from "../types.js";
import { LAYER_COLORS } from "./types.js";
import {
  COLOR_BG,
  COLOR_BG_HEX,
  COLOR_ACCENT_HEX,
  COLOR_AMBIENT_LIGHT_HEX,
  COLOR_GRID_HEX,
  COLOR_CONFLICT_HEX,
  COLOR_EDGE_HEX,
} from "../tokens.js";
import { isFading, type ColorMode } from "../state/filterState.js";
import { buildPalette, resolveColor, TAG_PALETTE, PATH_PALETTE } from "./tagPalette.js";
import { computeSharedTagPairs } from "./sharedTagPairs.js";
import type { AdjacencyMap } from "./localNeighborhood.js";
import { buildForceLayout, type ForceLayoutHandle, type SettleSource } from "./forceLayout.js";

// v0.28 (E2 real-edges) — pathological-filter mitigation. Module const so
// it's referenced as HARD_EDGE_CAP without a class prefix.
const HARD_EDGE_CAP = 2000;

/** v0.28 — edge-count signal returned by BrainScene.getEdgeCounts() and
 * passed via the populate onComplete callback. Drives BottomBar dynamic
 * affordance copy + bail hint. */
export interface EdgeCounts {
  openConflicts: number;
  resolvedConflicts: number;
  sharedTag: number;
  sharedTagBailed: boolean;
}

const SPREAD = 20;
const LAYER_Y_OFFSET: Record<string, number> = { buffer: 6, episodic: 0, semantic: -6 };

function hexToColor(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

interface MemoryNode {
  id: string;
  memory: Memory;
  mesh: THREE.Mesh;
  basePosition: THREE.Vector3;
  halo: THREE.Mesh;
  phase: number;
  driftSpeed: number;
  /**
   * v0.26.1 — TorusGeometry ring rendered for nodes where isFading(m) is true.
   * Constant 0.5 opacity, rust color, always-on signal independent of hover/
   * search dimming state. Billboarded each frame via lookAt(camera).
   * Shape disambiguates from selection sphere-halo (plan-design-critic R1 HIGH #1).
   */
  fadingRing?: THREE.Mesh;
}

export class BrainScene {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private composer!: EffectComposer;
  private nodes: MemoryNode[] = [];
  private tendrils: THREE.Line[] = [];
  private conflictLines: THREE.Line[] = [];
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private hoveredNode: MemoryNode | null = null;
  private selectedNode: MemoryNode | null = null;
  private highlightedIds: Set<string> = new Set();
  private searchDimmed = false;
  private clock = new THREE.Clock();
  private gridHelper!: THREE.Group;
  private onHoverCb: ((memory: Memory | null, x: number, y: number) => void) | null = null;
  private onClickCb: ((memory: Memory | null) => void) | null = null;
  private disposed = false;
  private rafId = 0;
  /**
   * E4 fix (code-review-critic HIGH #4): freeze race on mount. Constructor
   * used to call `this.animate()` unconditionally, kicking off rAF before
   * useCanvasEngine could observe `frozen` and call setReducedMotion. Now
   * the loop only runs when `paused === false`; setReducedMotion flips this
   * flag without depending on rafId-cancel timing.
   */
  private paused = false;
  /** E1.5: per-frame render callbacks for screen-space label overlay (E4). */
  private onRenderCbs: Array<(camera: THREE.PerspectiveCamera, scene: THREE.Scene) => void> = [];
  /**
   * v0.27 color-by-tag — current view mode + per-mode palette caches.
   * Defaults to "layer" so pre-v0.27 render path is back-compat.
   * Palettes are rebuilt by setColorMode() when memories change or the
   * mode switches.
   */
  private currentColorMode: ColorMode = "layer";
  private tagPalette: Map<string, string> = new Map();
  private pathPalette: Map<string, string> = new Map();
  /**
   * v0.28 (E2 real-edges) — explicit shared-tag edges as faint warm-grey
   * hairlines. Computed by computeSharedTagPairs() (pure helper) and
   * filtered to the n<=500 case via sharedTagBailed flag.
   */
  private sharedTagEdges: THREE.Line[] = [];
  private sharedTagBailed = false;
  /**
   * v0.28+ E4 — force-layout state. Built fresh per populate(). lastSettledPositions
   * caches the final positions for warm-starting subsequent populates so existing
   * memories barely move.
   */
  private forceLayout: ForceLayoutHandle | null = null;
  private lastSettledPositions: Map<string, { x: number; z: number }> | null = null;
  /**
   * v0.28+ E4 — scene-level onSettleStateChange subscribers + forwarding glue.
   * Each populate() builds a new forceLayout, so the scene re-subscribes
   * internally and forwards (settling, source) events to scene-level subscribers.
   * Replay-on-subscribe ensures React-effect-after-paint timing doesn't drop
   * the first settling=true event.
   */
  private settleSubscribers = new Set<(settling: boolean, source: SettleSource) => void>();
  private currentForceUnsubscribe: (() => void) | null = null;

  constructor(private container: HTMLDivElement) {
    this.initRenderer();
    this.initScene();
    this.initCamera();
    this.initControls();
    this.initPostProcessing();
    this.initGrid();
    this.animate();
  }

  private initRenderer(): void {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    // E1 fix: was ACESFilmicToneMapping @ exposure 1.2 — designed for HDR
    // scenes on dark; on parchment it crushed the light bg into mid-grey.
    // NoToneMapping preserves linear sRGB values so the parchment clearColor
    // renders as authored.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // E4 fix: explicit clearColor matches scene.background (parchment). Defense
    // against the initial-frame flash when scene.background hasn't been set
    // yet, or when a render is skipped. Acceptance test reads
    // renderer.getClearColor().getHex() === COLOR_BG_HEX.
    this.renderer.setClearColor(COLOR_BG_HEX, 1);
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
  }

  private initScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLOR_BG);
    // Lighter fog density for parchment bg — heavy fog reads as fog of war on
    // dark, as haze on light; halve density to preserve depth without muddying.
    this.scene.fog = new THREE.FogExp2(COLOR_BG, 0.008);

    // Warmer + brighter ambient for parchment (was 0x111122 @ 0.5 on dark)
    const ambient = new THREE.AmbientLight(COLOR_AMBIENT_LIGHT_HEX, 0.65);
    this.scene.add(ambient);

    const point = new THREE.PointLight(COLOR_ACCENT_HEX, 0.4, 100);
    point.position.set(0, 15, 10);
    this.scene.add(point);
  }

  private initCamera(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 200);
    this.camera.position.set(0, 8, 28);
    this.camera.lookAt(0, 0, 0);
  }

  private initControls(): void {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 80;
    this.controls.maxPolarAngle = Math.PI * 0.85;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.3;
  }

  private initPostProcessing(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // E1 fix: bloom disabled for parchment aesthetic. UnrealBloomPass is
    // designed for "stars in dark sky" — on parchment it whitewashed the
    // bg and merged adjacent nodes into a single glow cloud. The hybrid-v4
    // mockup uses crisp spheres without bloom; matching that. If needed
    // for selected-node emphasis, re-enable with strength <= 0.2 + threshold
    // >= 0.9 (very selective).
    // const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.0, 0.4, 0.95);
    // this.composer.addPass(bloom);
  }

  private initGrid(): void {
    this.gridHelper = new THREE.Group();

    // Parchment grid: warm border color, slightly higher opacity than the
    // pre-revamp 0xffffff/0.03 (white on dark) since darker-on-light needs
    // more presence to read at the same visual weight.
    const gridMaterial = new THREE.LineBasicMaterial({ color: COLOR_GRID_HEX, transparent: true, opacity: 0.06 });
    const size = 40;
    const divisions = 20;
    const step = size / divisions;

    for (let i = -size / 2; i <= size / 2; i += step) {
      const geoX = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(i, -10, -size / 2),
        new THREE.Vector3(i, -10, size / 2),
      ]);
      this.gridHelper.add(new THREE.Line(geoX, gridMaterial));

      const geoZ = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-size / 2, -10, i),
        new THREE.Vector3(size / 2, -10, i),
      ]);
      this.gridHelper.add(new THREE.Line(geoZ, gridMaterial));
    }

    this.scene.add(this.gridHelper);
  }

  setCallbacks(
    onHover: (memory: Memory | null, x: number, y: number) => void,
    onClick: (memory: Memory | null) => void,
  ): void {
    this.onHoverCb = onHover;
    this.onClickCb = onClick;
  }

  /**
   * **MUST STAY SYNCHRONOUS.** useCanvasEngine reads `getEdgeCounts()`
   * immediately after this returns to update React state without a race;
   * any async-ification here (rAF, promise, microtask) would silently
   * stale-read the counts. If a future change needs async work, change
   * useCanvasEngine to a callback pattern AT THE SAME TIME.
   */
  populate(
    memories: Memory[],
    positions: Record<string, [number, number, number]>,
    conflicts: Conflict[],
    adjacency: AdjacencyMap,
  ): void {
    for (const node of this.nodes) {
      this.scene.remove(node.mesh);
      this.scene.remove(node.halo);
      node.mesh.geometry.dispose();
      node.halo.geometry.dispose();
      // v0.26.1 — dispose fading ring if present (plan-eng-critic R2 MED).
      if (node.fadingRing) {
        this.scene.remove(node.fadingRing);
        node.fadingRing.geometry.dispose();
        (node.fadingRing.material as THREE.Material).dispose();
      }
    }
    for (const line of this.tendrils) {
      this.scene.remove(line);
      line.geometry.dispose();
    }
    for (const line of this.conflictLines) {
      this.scene.remove(line);
      line.geometry.dispose();
    }
    // v0.28 (E2): dispose BOTH geometry AND material for shared-tag edges.
    // (Pre-existing tendril/conflictLines material-leak deferred to a separate
    // ticket per plan-eng-critic R1 reconciliation.)
    for (const line of this.sharedTagEdges) {
      this.scene.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.nodes = [];
    this.tendrils = [];
    this.conflictLines = [];
    this.sharedTagEdges = [];

    const maxRetrieval = memories.reduce((m, mem) => Math.max(m, mem.retrieval_count), 1);

    for (const mem of memories) {
      const pos = positions[mem.id] ?? [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
      const layerY = LAYER_Y_OFFSET[mem.layer] ?? 0;

      const x = pos[0] * SPREAD + (Math.random() - 0.5) * 3;
      // v0.28+ E4 — drop PCA-y contribution; basePosition.y is layer-Y + jitter ONLY.
      // Force layout drives XZ-plane positioning (S2(a) plan v3); Y stays as layer
      // stratification per E1+E5.
      const y = layerY + (Math.random() - 0.5) * 2;
      const z = pos[2] * SPREAD + (Math.random() - 0.5) * 3;

      const color = hexToColor(LAYER_COLORS[mem.layer]);
      const logRatio = Math.log2(mem.retrieval_count + 1) / Math.log2(maxRetrieval + 1);
      const radius = 0.15 + logRatio * 0.35;

      // E1 fix: solid parchment-friendly spheres. Pre-revamp had emissive
      // glow + transparency designed for dark-bg "stars in space" look —
      // on parchment those blurred into a cyan cloud blob. Now: no emissive,
      // high opacity, slightly higher roughness for matte parchment feel.
      const sphereGeo = new THREE.SphereGeometry(radius, 24, 24);
      const sphereMat = new THREE.MeshStandardMaterial({
        color,
        emissiveIntensity: 0,
        roughness: 0.55,
        metalness: 0.05,
        transparent: true,
        opacity: 0.78 + mem.strength * 0.22,
      });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      sphere.position.set(x, y, z);
      sphere.userData = { memoryId: mem.id };
      this.scene.add(sphere);

      // E1 fix: halo near-invisible by default (was 0.06+ which created the
      // cloud blob on parchment). Hover/select paths still bump opacity in
      // applyDimming() / hover handlers for the interaction signal.
      const haloGeo = new THREE.SphereGeometry(radius * 2.2, 16, 16);
      const haloMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.015 + mem.strength * 0.025,
        side: THREE.BackSide,
        depthWrite: false,
      });
      const halo = new THREE.Mesh(haloGeo, haloMat);
      halo.position.copy(sphere.position);
      this.scene.add(halo);

      // v0.26.1 — fading ring (TorusGeometry) for at-risk memories. Constant
      // 0.5 opacity rust ring; shape (ring) disambiguates from sphere-halo
      // selection emphasis. Plan-design-critic R1 HIGH #1.
      let fadingRing: THREE.Mesh | undefined;
      if (isFading(mem)) {
        const ringGeo = new THREE.RingGeometry(radius * 1.4, radius * 1.7, 32);
        const ringMat = new THREE.MeshBasicMaterial({
          color: COLOR_CONFLICT_HEX,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
        });
        fadingRing = new THREE.Mesh(ringGeo, ringMat);
        fadingRing.position.copy(sphere.position);
        fadingRing.lookAt(this.camera.position); // initial billboard
        this.scene.add(fadingRing);
      }

      this.nodes.push({
        id: mem.id,
        memory: mem,
        mesh: sphere,
        halo,
        basePosition: sphere.position.clone(),
        phase: Math.random() * Math.PI * 2,
        driftSpeed: 0.2 + Math.random() * 0.3,
        fadingRing,
      });
    }

    this.buildTendrils();
    this.buildConflictLines(conflicts);
    // v0.28 (E2 real-edges) — build shared-tag edges. Bails on n>500 with
    // the sharedTagBailed flag so BottomBar can surface a hint.
    this.buildSharedTagEdges(memories);

    // v0.28+ E4 — build force layout from E3 adjacency. Seeds from POST-jitter
    // basePositions (first populate) OR lastSettledPositions (subsequent), so
    // existing memories barely move and there's no first-frame snap.
    // Tear down previous subscription forwarding before rebuilding.
    if (this.currentForceUnsubscribe) {
      this.currentForceUnsubscribe();
      this.currentForceUnsubscribe = null;
    }
    const memorySet = new Set(memories.map((m) => m.id));
    // Prune lastSettledPositions of deleted ids (AC20).
    if (this.lastSettledPositions) {
      for (const id of [...this.lastSettledPositions.keys()]) {
        if (!memorySet.has(id)) this.lastSettledPositions.delete(id);
      }
    }
    // Assemble seed: lastSettledPositions for existing memories, jittered
    // basePositions for new ones (or all of them on first populate).
    const seedPositions = new Map<string, { x: number; z: number }>();
    for (const node of this.nodes) {
      const prior = this.lastSettledPositions?.get(node.id);
      seedPositions.set(
        node.id,
        prior ?? { x: node.basePosition.x, z: node.basePosition.z },
      );
    }
    this.forceLayout = buildForceLayout(memories, adjacency, seedPositions);
    // Forward forceLayout events to scene-level subscribers + replay current
    // state for any subscriber that attached before this populate.
    this.currentForceUnsubscribe = this.forceLayout.onSettleStateChange((settling, source) => {
      for (const cb of this.settleSubscribers) cb(settling, source);
    });

    // v0.27 color-by-tag: re-apply the current colorMode at populate tail.
    // Single source of truth for the populate-vs-setColorMode race fix
    // (plan-eng-critic R2 HIGH #5): when memories refresh and rebuild nodes
    // via populate(), the current view mode is automatically re-applied so
    // the user doesn't see a layer-color flash if they're in tag/path mode.
    this.setColorMode(this.currentColorMode, memories);
  }

  /**
   * v0.28 (E2 real-edges) — build explicit shared-tag edges between memory
   * pairs sharing >=2 non-path tags. Bails on n>500 (matches buildTendrils
   * proximity bail; live fixture currently 1373 = no edges, but filtering
   * to a subset under 500 reveals structure).
   *
   * Bounded by HARD_EDGE_CAP (2000) regardless of helper output — protects
   * against adversarial filters yielding pathological pair explosions.
   */
  private buildSharedTagEdges(memories: Memory[]): void {
    const n = this.nodes.length;
    if (n > 500) {
      this.sharedTagBailed = true;
      return;
    }
    this.sharedTagBailed = false;

    const pairs = computeSharedTagPairs(memories, {
      excludePrefix: "path:",
      softCap: 50,
      hardCap: 300,
      perTagTopK: 15,
      minShared: 2,
    });

    const nodeMap = new Map<string, MemoryNode>();
    for (const node of this.nodes) nodeMap.set(node.id, node);

    for (const p of pairs) {
      if (this.sharedTagEdges.length >= HARD_EDGE_CAP) break;
      const a = nodeMap.get(p.a);
      const b = nodeMap.get(p.b);
      if (!a || !b) continue;
      const geo = new THREE.BufferGeometry().setFromPoints([a.basePosition, b.basePosition]);
      const mat = new THREE.LineBasicMaterial({
        color: COLOR_EDGE_HEX,
        transparent: true,
        // Opacity floor raised from v1's 0.05 to v2's 0.18 baseline
        // (plan-design-critic R1 CRIT #2 — sub-perceptual on parchment).
        opacity: 0.18 + p.count * 0.04, // 2-shared 0.26, 6-shared 0.42
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      // v0.28+ (E3) — endpoint IDs on userData so setFiltered's
      // both-endpoints-visible check can hide cross-region lines under
      // local view.
      line.userData = { aId: p.a, bId: p.b };
      this.scene.add(line);
      this.sharedTagEdges.push(line);
    }
  }

  /**
   * v0.28 (E2 real-edges) — consolidated edge-state accessor. Returns the
   * scene's edge-count signal in one call so the consumer doesn't sample
   * stale state across multiple getters. Drives BottomBar dynamic copy
   * + bail hint.
   *
   * **PAIRED WITH `populate()`'s MUST-STAY-SYNCHRONOUS contract.** The
   * useCanvasEngine effect calls populate() then this method back-to-back
   * to feed React state. If populate ever becomes async, this getter will
   * silently return stale counts — change the consumer to a callback
   * pattern at the same time.
   */
  public getEdgeCounts(): EdgeCounts {
    let open = 0;
    let resolved = 0;
    for (const line of this.conflictLines) {
      const status = (line.userData as { status?: string }).status;
      if (status === "open") open++;
      else if (status === "resolved") resolved++;
    }
    return {
      openConflicts: open,
      resolvedConflicts: resolved,
      sharedTag: this.sharedTagEdges.length,
      sharedTagBailed: this.sharedTagBailed,
    };
  }

  /**
   * v0.27 color-by-tag — recompute material color for every node in O(N)
   * without rebuilding geometry or tendrils.
   *
   * Performance: ~1373 calls to material.color.set() targeted under 10ms
   * on the live fixture. Tendril color rebuild is SKIPPED — tendrils
   * represent spatial proximity (layer-agnostic), AND scene.ts's n>500
   * early bail in buildTendrils means tendrils are not drawn on the live
   * fixture anyway. Plan v3 S3 + AC3.
   */
  setColorMode(mode: ColorMode, memories: readonly Memory[]): void {
    if (mode === "tag") {
      this.tagPalette = buildPalette(memories, {
        excludePrefix: "path:",
        topN: 10,
        palette: TAG_PALETTE,
      });
    }
    if (mode === "path") {
      this.pathPalette = buildPalette(memories, {
        includePrefix: "path:",
        topN: 8,
        palette: PATH_PALETTE,
      });
    }
    this.currentColorMode = mode;
    for (const node of this.nodes) {
      const hex = resolveColor(node.memory, mode, this.tagPalette, this.pathPalette);
      const color = hexToColor(hex);
      (node.mesh.material as THREE.MeshStandardMaterial).color.copy(color);
      // Halo material is independent — keep it tracking the node color too
      // so selection/hover halo reads correctly under the new mode.
      (node.halo.material as THREE.MeshBasicMaterial).color.copy(color);
      // Tendrils intentionally NOT updated. See class-level comment.
    }
  }

  private buildTendrils(): void {
    const n = this.nodes.length;
    if (n > 500) return;

    const maxDist = 6;
    const maxDistSq = maxDist * maxDist;

    for (let i = 0; i < n; i++) {
      const a = this.nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.nodes[j];
        const dx = a.basePosition.x - b.basePosition.x;
        const dy = a.basePosition.y - b.basePosition.y;
        const dz = a.basePosition.z - b.basePosition.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > maxDistSq) continue;

        const dist = Math.sqrt(distSq);
        const fade = 1 - dist / maxDist;

        const mid = new THREE.Vector3().lerpVectors(a.basePosition, b.basePosition, 0.5);
        mid.y += (Math.random() - 0.5) * 1.5;

        const curve = new THREE.QuadraticBezierCurve3(a.basePosition, mid, b.basePosition);
        const points = curve.getPoints(12);
        const geo = new THREE.BufferGeometry().setFromPoints(points);

        const colA = hexToColor(a.mesh.userData.color ?? LAYER_COLORS[a.memory.layer]);
        const colB = hexToColor(b.mesh.userData.color ?? LAYER_COLORS[b.memory.layer]);
        const mixedColor = colA.clone().lerp(colB, 0.5);

        const mat = new THREE.LineBasicMaterial({
          color: mixedColor,
          transparent: true,
          opacity: fade * fade * 0.15,
          depthWrite: false,
        });

        const line = new THREE.Line(geo, mat);
        this.scene.add(line);
        this.tendrils.push(line);
      }
    }
  }

  private buildConflictLines(conflicts: Conflict[]): void {
    const nodeMap = new Map<string, MemoryNode>();
    for (const node of this.nodes) nodeMap.set(node.id, node);

    for (const c of conflicts) {
      const a = nodeMap.get(c.memory_a_id);
      const b = nodeMap.get(c.memory_b_id);
      if (!a || !b) continue;

      const mid = new THREE.Vector3().lerpVectors(a.basePosition, b.basePosition, 0.5);
      mid.y += 1;

      const curve = new THREE.QuadraticBezierCurve3(a.basePosition, mid, b.basePosition);
      const points = curve.getPoints(16);
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      // v0.28 (E2 real-edges) — encode status in SHAPE (open = dashed,
      // resolved = dotted) rather than opacity, so opacity stays a strength
      // signal (plan-design-critic R1 HIGH on differentiation).
      const isResolved = c.status === "resolved";
      const mat = new THREE.LineDashedMaterial({
        color: COLOR_CONFLICT_HEX,
        transparent: true,
        opacity: 0.3 + c.score * 0.4,
        dashSize: isResolved ? 0.05 : 0.3,
        gapSize: isResolved ? 0.15 : 0.2,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      // v0.28 (E2) — stash status on userData so getEdgeCounts() can count
      // open vs resolved without re-querying the source array.
      // v0.28+ (E3) — also stash endpoint IDs so setFiltered's
      // both-endpoints-visible check can hide cross-region lines under
      // local view.
      line.userData = { status: c.status, aId: c.memory_a_id, bId: c.memory_b_id };
      this.scene.add(line);
      this.conflictLines.push(line);
    }
  }

  setHighlighted(ids: Set<string>): void {
    this.highlightedIds = ids;
    this.searchDimmed = ids.size > 0;
    this.applyDimming();
  }

  clearHighlight(): void {
    this.highlightedIds.clear();
    this.searchDimmed = false;
    this.applyDimming();
  }

  private applyDimming(): void {
    for (const node of this.nodes) {
      const mat = node.mesh.material as THREE.MeshStandardMaterial;
      const haloMat = node.halo.material as THREE.MeshBasicMaterial;

      if (this.searchDimmed && !this.highlightedIds.has(node.id)) {
        mat.opacity = 0.05;
        mat.emissiveIntensity = 0.1;
        haloMat.opacity = 0.01;
      } else {
        mat.opacity = 0.3 + node.memory.strength * 0.7;
        mat.emissiveIntensity = 0.6 + node.memory.strength * 0.8;
        haloMat.opacity = 0.06 + node.memory.strength * 0.08;
      }
    }
  }

  handleMouseMove(event: MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = this.nodes.map((n) => n.mesh);
    const intersects = this.raycaster.intersectObjects(meshes);

    const prevHovered = this.hoveredNode;

    if (intersects.length > 0) {
      const hit = intersects[0].object;
      const memId = hit.userData.memoryId as string;
      this.hoveredNode = this.nodes.find((n) => n.id === memId) ?? null;
      this.renderer.domElement.style.cursor = "pointer";

      if (this.hoveredNode && this.onHoverCb) {
        this.onHoverCb(this.hoveredNode.memory, event.clientX, event.clientY);
      }
    } else {
      this.hoveredNode = null;
      this.renderer.domElement.style.cursor = "grab";
      if (prevHovered && this.onHoverCb) {
        this.onHoverCb(null, 0, 0);
      }
    }

    if (prevHovered && prevHovered !== this.hoveredNode) {
      const mat = prevHovered.mesh.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.6 + prevHovered.memory.strength * 0.8;
      prevHovered.mesh.scale.setScalar(1);
      (prevHovered.halo.material as THREE.MeshBasicMaterial).opacity =
        0.06 + prevHovered.memory.strength * 0.08;
    }

    if (this.hoveredNode) {
      const mat = this.hoveredNode.mesh.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 2.0;
      this.hoveredNode.mesh.scale.setScalar(1.4);
      (this.hoveredNode.halo.material as THREE.MeshBasicMaterial).opacity = 0.2;
    }
  }

  handleClick(): void {
    if (this.hoveredNode) {
      if (this.selectedNode && this.selectedNode !== this.hoveredNode) {
        this.selectedNode.mesh.scale.setScalar(1);
      }
      this.selectedNode = this.hoveredNode;
      if (this.onClickCb) this.onClickCb(this.hoveredNode.memory);
    } else {
      if (this.selectedNode) this.selectedNode.mesh.scale.setScalar(1);
      this.selectedNode = null;
      if (this.onClickCb) this.onClickCb(null);
    }
  }

  deselect(): void {
    if (this.selectedNode) this.selectedNode.mesh.scale.setScalar(1);
    this.selectedNode = null;
    if (this.onClickCb) this.onClickCb(null);
  }

  resize(width: number, height: number): void {
    if (width === 0 || height === 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
  }

  private animate = (): void => {
    if (this.disposed || this.paused) return;
    this.rafId = requestAnimationFrame(this.animate);

    const elapsed = this.clock.getElapsedTime();
    this.controls.update();

    // v0.28+ E4 — force-tick BEFORE drift so drift oscillates around the
    // freshly-set basePositions. Snapshot settled positions when convergence
    // happens this frame so next populate can warm-start from them.
    const forceSettling = this.forceLayout !== null && !this.forceLayout.done();
    if (forceSettling) {
      this.forceLayout!.tick();
      for (const node of this.nodes) {
        const p = this.forceLayout!.position(node.id);
        if (!p) continue;
        node.basePosition.x = p.x;
        node.basePosition.z = p.z;
        // basePosition.y intentionally UNCHANGED (layer-Y preserved per S2a).
      }
      if (this.forceLayout!.done()) {
        this.lastSettledPositions = this.forceLayout!.settledPositions();
      }
    }

    for (const node of this.nodes) {
      // v0.28+ E4 — drift offset gated on forceSettling per plan v3 S2(b) +
      // R4 must-fix #3 clarification: ONLY the basePosition->mesh.position
      // drift offset is gated. Selection pulse + fadingRing billboard run
      // unconditionally so a selected node keeps pulsing during settle.
      if (forceSettling) {
        // During settle: mesh tracks basePosition exactly (no drift offset)
        // so the rendered mesh doesn't lag a frame behind the force-driven
        // basePosition update.
        node.mesh.position.copy(node.basePosition);
      } else {
        const drift = Math.sin(elapsed * node.driftSpeed + node.phase);
        const driftY = Math.cos(elapsed * node.driftSpeed * 0.7 + node.phase * 1.3);
        node.mesh.position.x = node.basePosition.x + drift * 0.15;
        node.mesh.position.y = node.basePosition.y + driftY * 0.1;
        node.mesh.position.z = node.basePosition.z + Math.sin(elapsed * node.driftSpeed * 0.5 + node.phase * 0.7) * 0.12;
      }
      node.halo.position.copy(node.mesh.position);

      if (node === this.selectedNode) {
        const pulse = 1.3 + 0.1 * Math.sin(elapsed * 3 + node.phase);
        node.mesh.scale.setScalar(pulse);
      }

      // v0.26.1 — billboard fading rings to face camera. Cheap (≤at_risk
      // nodes total, typically <20). Position follows drifting mesh.
      // Runs unconditionally during settle so rings stay billboarded.
      if (node.fadingRing) {
        node.fadingRing.position.copy(node.mesh.position);
        node.fadingRing.lookAt(this.camera.position);
      }
    }

    // E1.5: notify per-frame subscribers (E4's label overlay). Single-line
    // hot-path insertion per plan v2 round-2 LOW #7 carve-out. Refactoring
    // this loop is out of scope; only the forEach is in-scope here.
    if (this.onRenderCbs.length > 0) {
      for (const cb of this.onRenderCbs) cb(this.camera, this.scene);
    }

    this.composer.render();
  };

  // -------------------------------------------------------------------------
  // E1.5 — Engine surface API extensions for E2 (freeze), E4 (label overlay),
  // and E5 (prefers-reduced-motion + drawer mirror).
  //
  // Internals (layout algorithm, particle physics, render order) remain
  // out of scope. Only single-line insertions in animate() are in-scope
  // per plan v2 round-2 LOW #7 carve-out.
  // -------------------------------------------------------------------------

  /**
   * Freeze or restart the animation loop. Used by E2's freeze-toggle and E5's
   * prefers-reduced-motion media query.
   *
   * Implementation note (round-2 HIGH #1 + round-3 HIGH #1 fixes): matches
   * scene.ts's existing rafId-based loop. Does NOT use Three.js's
   * setAnimationLoop API (which scene.ts never adopted). When freezing,
   * snaps particles to their basePosition rather than iterating to convergence
   * (the sin/cos drift physics at L423-L435 never converges).
   */
  /**
   * v0.28+ E4 — scene-level settling subscription. useCanvasEngine subscribes
   * once; scene forwards from the current forceLayout (rebuilt per populate).
   * Replay-on-subscribe ensures React-effect-after-paint timing doesn't drop
   * the first settling=true event (plan-eng R4 must-fix #2).
   */
  onSettleStateChange(cb: (settling: boolean, source: SettleSource) => void): () => void {
    this.settleSubscribers.add(cb);
    if (this.forceLayout?.isSettling()) cb(true, "tick");
    return () => {
      this.settleSubscribers.delete(cb);
    };
  }

  setReducedMotion(reduced: boolean): void {
    this.paused = reduced;
    if (reduced) {
      // PRESERVE rAF cleanup (plan-eng R3 catch). Without zeroing rafId,
      // unfreeze guard below never fires on subsequent freeze->unfreeze.
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }
      // v0.28+ E4 — finish force settle (bounded to 80 ticks ~= 400ms main-thread
      // block worst case, sub-perceptual per RAIL) BEFORE snapping so the snapped
      // pose is the converged layout, not a mid-settle interim.
      if (this.forceLayout && !this.forceLayout.done()) {
        this.forceLayout.runToCompletion(80);
        for (const node of this.nodes) {
          const p = this.forceLayout.position(node.id);
          if (!p) continue;
          node.basePosition.x = p.x;
          node.basePosition.z = p.z;
        }
        if (this.forceLayout.done()) {
          this.lastSettledPositions = this.forceLayout.settledPositions();
        }
      }
      this.snapParticlesToFinal();
    } else if (!this.rafId) {
      this.animate(); // animate() bails immediately if paused, so safe to call
    }
  }

  /**
   * E4 marquee feature support — returns the node's basePosition by id so
   * the LabelOverlay can project it to screen coords each frame without
   * reaching into the private nodes array.
   */
  getNodePosition(id: string): THREE.Vector3 | null {
    for (const node of this.nodes) {
      if (node.id === id) return node.basePosition;
    }
    return null;
  }

  /** E4: expose renderer so LabelOverlay can read canvas size accurately. */
  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  /**
   * Toggle node visibility based on a filter set. Used by E3's FilterPanel.
   * Layout is NOT re-run; filtered nodes are hidden in place.
   *
   * **filterActive disambiguates** (round-2 code-review-critic HIGH #1):
   *   - filterActive=false → no filter; show all (visibleIds ignored).
   *   - filterActive=true + empty set → filter matched zero; hide all.
   *   - filterActive=true + populated set → show only ids in set.
   *
   * The old `size > 0` gate collapsed cases 1 and 2 into the same behavior
   * (show all), creating a silent UI/engine state divergence when filters
   * matched zero rows.
   */
  setFiltered(visibleIds: Set<string>, filterActive: boolean): void {
    for (const node of this.nodes) {
      const visible = !filterActive || visibleIds.has(node.id);
      node.mesh.visible = visible;
      node.halo.visible = visible;
    }
    // v0.28+ (E3 local view) — Obsidian default: a line is visible ONLY
    // when both endpoints are visible. No "frayed half-lines" — eliminates
    // the reads-as-bug ambiguity flagged by plan-design-critic R1.
    // Tendrils included for defensive future-proofing (currently bailed at
    // n>500 so never built; when E4 force-layout populates them with
    // aId/bId on userData, this filter just works).
    for (const line of [...this.conflictLines, ...this.sharedTagEdges, ...this.tendrils]) {
      if (!filterActive) {
        line.visible = true;
        continue;
      }
      const ud = line.userData as { aId?: string; bId?: string };
      if (!ud.aId || !ud.bId) {
        // Lines without endpoint IDs (legacy tendrils today) — keep
        // visibility unchanged so we don't accidentally hide them.
        continue;
      }
      line.visible = visibleIds.has(ud.aId) && visibleIds.has(ud.bId);
    }
  }

  /**
   * Register a per-frame render callback. Used by E4's LabelOverlay to
   * project node world-coords to screen-coords each frame.
   *
   * Returns an unsubscribe function. Callbacks fire once per animate()
   * tick AFTER drift physics + BEFORE composer.render(). Keep them cheap;
   * with N=1000 nodes the perf budget is ~8ms/frame to hold 60fps.
   */
  onRender(cb: (camera: THREE.PerspectiveCamera, scene: THREE.Scene) => void): () => void {
    this.onRenderCbs.push(cb);
    return () => {
      const i = this.onRenderCbs.indexOf(cb);
      if (i >= 0) this.onRenderCbs.splice(i, 1);
    };
  }

  /**
   * Accessor for the perspective camera. Used by E4's LabelOverlay so it
   * can call `vector.project(camera)` without reaching into private fields.
   *
   * Returns the actual PerspectiveCamera (not the wider THREE.Camera base)
   * so consumers can access `.aspect`, `.updateProjectionMatrix()`, etc.
   * (round-3 LOW #4 fix.)
   */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /**
   * Snap drifting particles to their basePosition (freeze pose). Called by
   * setReducedMotion(true). The drift physics is pure sin oscillation
   * (L423-L435 of animate) — there is no convergence target other than
   * basePosition itself, so we copy it directly.
   */
  private snapParticlesToFinal(): void {
    for (const node of this.nodes) {
      node.mesh.position.copy(node.basePosition);
      node.halo.position.copy(node.basePosition);
    }
    // One final paint so reduced-motion users see the static layout, not
    // the last animated frame.
    this.composer.render();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.controls.dispose();

    for (const node of this.nodes) {
      node.mesh.geometry.dispose();
      (node.mesh.material as THREE.Material).dispose();
      node.halo.geometry.dispose();
      (node.halo.material as THREE.Material).dispose();
      // v0.26.1 — clean up fading ring resources on full teardown.
      if (node.fadingRing) {
        node.fadingRing.geometry.dispose();
        (node.fadingRing.material as THREE.Material).dispose();
      }
    }
    // v0.28 (E2 real-edges) — include sharedTagEdges in full-teardown
    // disposal. populate() already disposes them between rebuilds; this
    // is the unmount/HMR path that independent-review-critic R1 caught
    // as a real leak (bounded by HARD_EDGE_CAP=2000 LineBasicMaterial +
    // BufferGeometry per dashboard unmount cycle).
    for (const line of [...this.tendrils, ...this.conflictLines, ...this.sharedTagEdges]) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }

    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
