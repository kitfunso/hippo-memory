import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
// UnrealBloomPass removed: bloom was disabled for parchment and the import went dead.
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
import { buildForceLayout, type ForceLayoutHandle, type SettleSource, LAYOUT_BOUND } from "./forceLayout.js";
import { computeProjectAnchors, type AnchorLayout } from "./projectAnchors.js";
import {
  loadProjectAnchorOrder,
  reconcileProjectOrder,
  saveProjectAnchorOrder,
} from "../state/projectAnchorOrder.js";

// Pathological-filter mitigation; module const so it's referenced as HARD_EDGE_CAP without a class prefix.
const HARD_EDGE_CAP = 2000;

/** Edge-count signal from BrainScene.getEdgeCounts(), passed via the populate onComplete callback; drives BottomBar dynamic copy + bail hint. */
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
  /** Ring rendered for fading memories; constant rust color, always-on regardless of hover/dimming, billboarded each frame. Shape disambiguates from the selection sphere-halo. */
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
  // Guards a freeze race on mount: the loop only runs when paused===false; setReducedMotion flips this without depending on rafId-cancel timing.
  private paused = false;
  private onRenderCbs: Array<(camera: THREE.PerspectiveCamera, scene: THREE.Scene) => void> = [];
  private currentColorMode: ColorMode = "layer";
  private tagPalette: Map<string, string> = new Map();
  private pathPalette: Map<string, string> = new Map();
  private sharedTagEdges: THREE.Line[] = [];
  private sharedTagBailed = false;
  private forceLayout: ForceLayoutHandle | null = null;
  private lastSettledPositions: Map<string, { x: number; z: number }> | null = null;
  private settleSubscribers = new Set<(settling: boolean, source: SettleSource) => void>();
  private currentForceUnsubscribe: (() => void) | null = null;
  // Same reference until the next populate() runs (lets LivingMap's useMemo skip rebuilds); replaced each populate as the signal React needs to re-render.
  private projectAnchorLayout: AnchorLayout | null = null;

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
    // Was ACESFilmicToneMapping @ 1.2 (HDR-dark tuned) which crushed the parchment bg to mid-grey; NoToneMapping preserves linear sRGB so parchment renders as authored.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // Explicit clearColor matches scene.background (parchment); defends against initial-frame flash. Acceptance test reads getClearColor().getHex() === COLOR_BG_HEX.
    this.renderer.setClearColor(COLOR_BG_HEX, 1);
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
  }

  private initScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLOR_BG);
    // Fog density halved for parchment: heavy fog reads as fog-of-war on dark but as haze on light.
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

    // Bloom disabled for parchment: UnrealBloomPass whitewashed the bg and merged nodes into a glow cloud. If re-enabling for selected-node emphasis, use strength<=0.2 + threshold>=0.9.
  }

  private initGrid(): void {
    this.gridHelper = new THREE.Group();

    // Parchment grid: warm border, higher opacity than the pre-revamp white-on-dark 0.03, since darker-on-light needs more presence to read.
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

  /** MUST STAY SYNCHRONOUS: useCanvasEngine reads getEdgeCounts() right after this returns; any async-ification here would silently stale-read the counts unless useCanvasEngine also switches to a callback pattern. */
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
    // Disposes both geometry AND material here; the pre-existing tendril/conflictLines material leak is known and deferred separately.
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
      // basePosition.y is layer-Y + jitter only (PCA-y dropped); force layout drives XZ, Y stays layer stratification.
      const y = layerY + (Math.random() - 0.5) * 2;
      const z = pos[2] * SPREAD + (Math.random() - 0.5) * 3;

      const color = hexToColor(LAYER_COLORS[mem.layer]);
      const logRatio = Math.log2(mem.retrieval_count + 1) / Math.log2(maxRetrieval + 1);
      const radius = 0.15 + logRatio * 0.35;

      // Solid parchment-friendly spheres: the pre-revamp emissive-glow dark-bg look blurred into a cyan cloud on parchment; now no emissive, high opacity, matte roughness.
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

      // Halo near-invisible by default (was 0.06+, caused the cloud blob on parchment); hover/select paths still bump opacity for the interaction signal.
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
    this.buildSharedTagEdges(memories);

    // Builds force layout from E3 adjacency, seeded from lastSettledPositions (or jittered basePositions on first populate) so existing memories barely move; tear down prior subscription forwarding first.
    if (this.currentForceUnsubscribe) {
      this.currentForceUnsubscribe();
      this.currentForceUnsubscribe = null;
    }
    const memorySet = new Set(memories.map((m) => m.id));
    // Prune lastSettledPositions of deleted ids.
    if (this.lastSettledPositions) {
      for (const id of [...this.lastSettledPositions.keys()]) {
        if (!memorySet.has(id)) this.lastSettledPositions.delete(id);
      }
    }
    // Seed: lastSettledPositions for existing memories, jittered basePositions for new ones (or all, on first populate).
    const seedPositions = new Map<string, { x: number; z: number }>();
    for (const node of this.nodes) {
      const prior = this.lastSettledPositions?.get(node.id);
      seedPositions.set(
        node.id,
        prior ?? { x: node.basePosition.x, z: node.basePosition.z },
      );
    }
    // Per-project anchor computation: persisted append-only ordering + golden-angle packing keep existing anchors stable when new project tags appear. Runs before buildForceLayout so the result feeds its config.
    const persistedOrder = loadProjectAnchorOrder();
    const allPathTags = new Set<string>();
    for (const m of memories) {
      for (const t of m.tags) if (t.startsWith("path:")) allPathTags.add(t);
    }
    const reconciledOrder = reconcileProjectOrder([...allPathTags], persistedOrder);
    if (reconciledOrder !== persistedOrder) {
      // reconcileProjectOrder returns the same ref when nothing changed, so this only touches localStorage when there's something new.
      saveProjectAnchorOrder(reconciledOrder);
    }
    const projectAnchors = computeProjectAnchors(memories, reconciledOrder, LAYOUT_BOUND);
    this.projectAnchorLayout = projectAnchors;

    this.forceLayout = buildForceLayout(memories, adjacency, seedPositions, {
      projectAnchors: projectAnchors.byMemoryId,
    });
    // Forward forceLayout events to scene-level subscribers + replay current
    // state for any subscriber that attached before this populate.
    this.currentForceUnsubscribe = this.forceLayout.onSettleStateChange((settling, source) => {
      for (const cb of this.settleSubscribers) cb(settling, source);
    });

    // Re-applies the current colorMode at populate's tail so a memory refresh doesn't flash back to layer-color if the user is in tag/path mode.
    this.setColorMode(this.currentColorMode, memories);
  }

  /** Builds explicit shared-tag edges between memory pairs sharing >=2 non-path tags; bails above n=500 (matches buildTendrils). Bounded by HARD_EDGE_CAP=2000 regardless of helper output, against pathological pair explosions. */
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
        // Opacity floor raised from 0.05 to 0.18: 0.05 was sub-perceptual on parchment.
        opacity: 0.18 + p.count * 0.04, // 2-shared 0.26, 6-shared 0.42
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      // Endpoint IDs on userData so setFiltered's both-endpoints-visible check can hide cross-region lines under local view.
      line.userData = { aId: p.a, bId: p.b };
      this.scene.add(line);
      this.sharedTagEdges.push(line);
    }
  }

  /** Consolidated edge-state accessor: returns the edge-count signal in one call so the consumer doesn't sample stale state across getters; drives BottomBar dynamic copy + bail hint. Paired with populate()'s must-stay-synchronous contract, since an async populate would make this getter silently return stale counts. */
  /** Returns the latest AnchorLayout, or null before the first populate(). Same object reference until the next populate() — safe as a React useMemo dep. */
  public getProjectAnchorLayout(): AnchorLayout | null {
    return this.projectAnchorLayout;
  }

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

  /** Recomputes material color for every node in O(N) without rebuilding geometry/tendrils (~1373 calls under 10ms on the live fixture). Tendril color rebuild is skipped: tendrils are layer-agnostic and n>500 bails them out anyway. */
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
      // Halo material is independent; keep it tracking the node color so selection/hover halo reads correctly under the new mode.
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
      // Status encoded in shape (dashed=open, dotted=resolved) rather than opacity, so opacity stays a pure strength signal.
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
      // userData carries status (so getEdgeCounts can count without re-querying) and endpoint IDs (so setFiltered can hide cross-region lines under local view).
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

    // Force-ticks before drift so drift oscillates around fresh basePositions; snapshots settled positions on convergence so the next populate can warm-start.
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
      // Only the basePosition->mesh.position drift offset is gated on forceSettling; selection pulse + fadingRing billboard run unconditionally so a selected node keeps pulsing during settle.
      if (forceSettling) {
        // During settle, mesh tracks basePosition exactly so it doesn't lag a frame behind the force-driven update.
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

      // Billboards fading rings to face camera (cheap, typically <20 nodes); runs unconditionally during settle so rings stay billboarded.
      if (node.fadingRing) {
        node.fadingRing.position.copy(node.mesh.position);
        node.fadingRing.lookAt(this.camera.position);
      }
    }

    // Notifies per-frame subscribers (label overlay); kept as a minimal hot-path insertion.
    if (this.onRenderCbs.length > 0) {
      for (const cb of this.onRenderCbs) cb(this.camera, this.scene);
    }

    this.composer.render();
  };

  /** Freezes or restarts the animation loop; used by E2's freeze-toggle and E5's reduced-motion query. Matches the existing rafId-based loop (not Three.js's setAnimationLoop); freezing snaps particles to basePosition rather than iterating to convergence, since the sin/cos drift never converges. */
  /** Scene-level settling subscription: useCanvasEngine subscribes once, scene forwards from the current (per-populate) forceLayout. Replay-on-subscribe avoids dropping the first settling=true event. */
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
      // Must zero rafId here, or the unfreeze guard below never fires on a subsequent freeze->unfreeze.
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }
      // Finishes force settle (bounded to 80 ticks, ~400ms worst case) before snapping, so the snapped pose is the converged layout, not mid-settle.
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

  /** Returns a node's basePosition by id so LabelOverlay can project it to screen coords without reaching into the private nodes array. */
  getNodePosition(id: string): THREE.Vector3 | null {
    for (const node of this.nodes) {
      if (node.id === id) return node.basePosition;
    }
    return null;
  }

  /** Exposes renderer so LabelOverlay can read canvas size accurately. */
  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  /** Toggles node visibility from a filter set (layout not re-run). filterActive disambiguates "no filter" from "filter matched zero" — do not gate on visibleIds.size alone (see docs/ARCHITECTURE.md for the historical bug this caused). */
  setFiltered(visibleIds: Set<string>, filterActive: boolean): void {
    for (const node of this.nodes) {
      const visible = !filterActive || visibleIds.has(node.id);
      node.mesh.visible = visible;
      node.halo.visible = visible;
    }
    // A line is visible only when both endpoints are visible (no frayed half-lines). Tendrils included defensively for when force-layout eventually populates them with aId/bId.
    for (const line of [...this.conflictLines, ...this.sharedTagEdges, ...this.tendrils]) {
      if (!filterActive) {
        line.visible = true;
        continue;
      }
      const ud = line.userData as { aId?: string; bId?: string };
      if (!ud.aId || !ud.bId) {
        // Lines without endpoint IDs (legacy tendrils today) keep visibility unchanged so we don't accidentally hide them.
        continue;
      }
      line.visible = visibleIds.has(ud.aId) && visibleIds.has(ud.bId);
    }
  }

  /** Registers a per-frame render callback (fires after drift physics, before composer.render()); returns an unsubscribe function. Keep callbacks cheap: ~8ms/frame perf budget at N=1000 nodes for 60fps. */
  onRender(cb: (camera: THREE.PerspectiveCamera, scene: THREE.Scene) => void): () => void {
    this.onRenderCbs.push(cb);
    return () => {
      const i = this.onRenderCbs.indexOf(cb);
      if (i >= 0) this.onRenderCbs.splice(i, 1);
    };
  }

  /** Accessor for the perspective camera (not the wider THREE.Camera base) so consumers can call vector.project() and access .aspect/.updateProjectionMatrix(). */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /** Snaps drifting particles to basePosition (freeze pose): the drift physics is pure sin oscillation with no convergence target other than basePosition itself. */
  private snapParticlesToFinal(): void {
    for (const node of this.nodes) {
      node.mesh.position.copy(node.basePosition);
      node.halo.position.copy(node.basePosition);
    }
    // One final paint so reduced-motion users see the static layout, not the last animated frame.
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
      if (node.fadingRing) {
        node.fadingRing.geometry.dispose();
        (node.fadingRing.material as THREE.Material).dispose();
      }
    }
    // sharedTagEdges included in full-teardown disposal: populate() disposes them between rebuilds, but the unmount/HMR path was leaking them (see docs/ARCHITECTURE.md).
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
