import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';

export type ViewMode = 'touch' | 'camera';
export type PresetName = 'front' | 'side' | 'back' | 'face' | 'full';

export interface EngineCallbacks {
  onProgress?: (ratio: number) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

interface OrbitState {
  theta: number;
  phi: number;
  radius: number;
  target: THREE.Vector3;
}

// ポケットポーズは「ポーズデータ方式」(VRM Posing Desktop 等のポーズ素材や
// VRChat の待機アニメーションと同じ、ボーン回転でポーズを定義する前例) で実装する。
// 下の回転値は、このモデル (v0.2.0) で IK 収束させた姿勢から採取したローカル回転。
// モデルを作り替えたら再採取が必要。
const POCKET_POSE = {
  right: {
    upper: [0.0266, -0.0393, 0.5287, 0.8474],
    lower: [-0.0304, 0.3499, 0.3858, 0.8532],
    fingers: [
      [-0.1741, 0, 0, 0.9847],
      [-0.0998, 0, 0, 0.995],
    ],
  },
  left: {
    upper: [0.0266, 0.0393, -0.5287, 0.8474],
    lower: [-0.0304, -0.3499, -0.3858, 0.8532],
    fingers: [
      [-0.1741, 0, 0, 0.9847],
      [-0.0998, 0, 0, 0.995],
    ],
  },
} as const;

type PoseSet = {
  upper: THREE.Quaternion;
  lower: THREE.Quaternion;
  hand: THREE.Quaternion;
  fingers: THREE.Quaternion[];
};

type ArmRig = {
  side: -1 | 1; // right = -1 (world -x side), left = +1
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
  tip: THREE.Object3D;
  fingers: THREE.Object3D[];
  fingerRest: THREE.Quaternion[];
  rawHand: THREE.Object3D | null;
  l1: number;
  l2: number;
  restHandQuat: THREE.Quaternion;
  restWrist: THREE.Vector3;
  restTip: THREE.Vector3;
  restTipOffset: THREE.Vector3;
  restSet: PoseSet;
  pocketSet: PoseSet;
  xFrom: PoseSet;
  xTo: PoseSet;
  xT: number;
  homeKind: 'pocket' | 'rest';
  needCrossfade: boolean;
  grabBaseUpper: THREE.Quaternion;
  grabBaseLower: THREE.Quaternion;
  pole: THREE.Vector3;
  mode: 'idle' | 'grabbed';
  blend: number;
  point: THREE.Vector3;
  pointVel: THREE.Vector3;
  tipOffset: THREE.Vector3;
};

export class Engine {
  private canvas: HTMLCanvasElement;
  private callbacks: EngineCallbacks;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private raf = 0;
  private resizeObserver: ResizeObserver;
  private disposed = false;

  private vrm: VRM | null = null;
  private modelHeight = 1.5;
  private mode: ViewMode = 'touch';
  private currentPreset: PresetName = 'full';
  private wasPortrait = false;

  private orbit: OrbitState = {
    theta: 0,
    phi: 1.42,
    radius: 3.1,
    target: new THREE.Vector3(0, 0.8, 0),
  };
  private orbitGoal: OrbitState = {
    theta: 0,
    phi: 1.42,
    radius: 3.1,
    target: new THREE.Vector3(0, 0.8, 0),
  };

  private lookTarget = new THREE.Object3D();
  private gazeGoal = new THREE.Vector3(0, 1.35, 0.6);
  private raycaster = new THREE.Raycaster();
  private gazePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.55);

  private pointers = new Map<number, { x: number; y: number; button: number }>();
  private pinchDist = 0;

  private elapsed = 0;
  private nextBlinkAt = 1.4;
  private blinkStart = -1;
  private breathBones: { node: THREE.Object3D; baseX: number; amp: number; phase: number }[] = [];

  // ---- touch / arm / reactions (Phase 2-3) ----
  private armR: ArmRig | null = null;
  private arms: ArmRig[] = [];
  private idlePose: 'pocket' | 'down' = 'pocket';
  private hipsNode: THREE.Object3D | null = null;
  private grabPoint = new THREE.Vector3();
  private grabPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.15);
  private headNode: THREE.Object3D | null = null;
  private chestNode: THREE.Object3D | null = null;
  private spineNode: THREE.Object3D | null = null;
  private spineBase = new THREE.Euler();
  private touchPointerId: number | null = null;
  private patting = false;
  private patAcc = 0;
  private patLastX = 0;
  private patLastY = 0;
  private patLeanZ = 0;
  private expr: Record<'happy' | 'relaxed' | 'surprised', number> = { happy: 0, relaxed: 0, surprised: 0 };
  private exprTarget: Record<'happy' | 'relaxed' | 'surprised', number> = { happy: 0, relaxed: 0, surprised: 0 };
  private exprUntil: Record<'happy' | 'relaxed' | 'surprised', number> = { happy: 0, relaxed: 0, surprised: 0 };
  private lean = { x: 0, z: 0, tx: 0, tz: 0 };
  private hearts: {
    sprite: THREE.Sprite;
    vel: THREE.Vector3;
    life: number;
    maxLife: number;
    baseScale: number;
  }[] = [];
  private lastInteractAt = -10;
  private nextWanderAt = 6;
  private pokeCooldownUntil = 0;

  constructor(canvas: HTMLCanvasElement, callbacks: EngineCallbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);

    const hemi = new THREE.HemisphereLight(0xdcefff, 0x141a2c, 1.1);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(1.6, 2.6, 2.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -1.4;
    key.shadow.camera.right = 1.4;
    key.shadow.camera.top = 2.4;
    key.shadow.camera.bottom = -0.4;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 8;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x38b6e8, 1.1);
    rim.position.set(-2.0, 1.6, -1.8);
    this.scene.add(rim);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(1.6, 48),
      new THREE.ShadowMaterial({ opacity: 0.3 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0.001;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.scene.add(this.lookTarget);
    this.lookTarget.position.copy(this.gazeGoal);

    this.attachInput();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    if (canvas.parentElement) this.resizeObserver.observe(canvas.parentElement);
    this.resize();
    this.loop();
  }

  async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    try {
      const gltf = await loader.loadAsync(url, (event) => {
        if (event.total > 0) this.callbacks.onProgress?.(event.loaded / event.total);
      });
      const vrm = gltf.userData.vrm as VRM;
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
      VRMUtils.combineSkeletons(vrm.scene);
      vrm.scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          obj.castShadow = true;
          obj.frustumCulled = false;
        }
      });
      const box = new THREE.Box3().setFromObject(vrm.scene);
      this.modelHeight = Math.max(0.5, box.max.y - box.min.y);
      vrm.scene.position.y -= box.min.y;
      this.vrm = vrm;
      this.scene.add(vrm.scene);
      if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;
      this.setupBreathBones();
      this.applyRestPose();
      this.setupTouchRig();
      this.gazeGoal.set(0, this.modelHeight * 0.88, 0.6);
      this.goToPreset('full', true);
      this.callbacks.onProgress?.(1);
      this.callbacks.onReady?.();
    } catch (err) {
      console.error(err);
      this.callbacks.onError?.('モデルの読み込みに失敗しました。通信環境を確認して、もう一度開いてみてください。');
    }
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.pointers.clear();
    if (mode === 'camera') this.endTouchInteraction();
    if (mode === 'touch') {
      this.gazeGoal.set(0, this.modelHeight * 0.88, 0.6);
    }
  }

  getMode(): ViewMode {
    return this.mode;
  }

  private isPortrait(): boolean {
    return (this.camera.aspect || 1) < 0.9;
  }

  // 縦長画面ではモデルが画面からはみ出しやすいので、その分だけカメラを引く
  private frameScale(): number {
    const a = this.camera.aspect || 1;
    if (a >= 0.9) return 1;
    return Math.min(1.6, Math.max(1, 0.68 / a));
  }

  goToPreset(name: PresetName, instant = false): void {
    this.currentPreset = name;
    const h = this.modelHeight;
    const s = this.frameScale();
    const base = { phi: 1.34, radius: h * 1.3 * Math.pow(s, 0.6), targetY: h * 0.56 };
    const presets: Record<PresetName, Partial<OrbitState> & { targetY?: number }> = {
      full: { theta: 0, phi: 1.42, radius: h * 2.05 * s, targetY: h * (this.isPortrait() ? 0.58 : 0.5) },
      front: { theta: 0, ...base },
      side: { theta: Math.PI / 2, ...base },
      back: { theta: Math.PI, ...base },
      face: { theta: 0, phi: 1.24, radius: h * 0.52 * Math.min(s, 1.2), targetY: h * 0.86 },
    };
    const p = presets[name];
    this.orbitGoal.theta = p.theta ?? this.orbitGoal.theta;
    this.orbitGoal.phi = p.phi ?? this.orbitGoal.phi;
    this.orbitGoal.radius = p.radius ?? this.orbitGoal.radius;
    if (p.targetY !== undefined) this.orbitGoal.target.set(0, p.targetY, 0);
    if (instant) {
      this.orbit.theta = this.orbitGoal.theta;
      this.orbit.phi = this.orbitGoal.phi;
      this.orbit.radius = this.orbitGoal.radius;
      this.orbit.target.copy(this.orbitGoal.target);
    }
  }

  resetCamera(): void {
    this.goToPreset('full');
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.detachInput();
    this.renderer.dispose();
  }

  // ---- internal ----

  private applyRestPose(): void {
    if (!this.vrm) return;
    const humanoid = this.vrm.humanoid;
    // Tポーズの腕を自然に下ろした休止姿勢にする (Phase 2 の IK はこの姿勢を基準に足す)
    const upper = THREE.MathUtils.degToRad(68);
    const fore = THREE.MathUtils.degToRad(10);
    const set = (name: string, z: number) => {
      const node = humanoid.getNormalizedBoneNode(name as never);
      if (node) node.rotation.z = z;
    };
    set('leftUpperArm', -upper);
    set('rightUpperArm', upper);
    set('leftLowerArm', -fore);
    set('rightLowerArm', fore);
  }

  private setupBreathBones(): void {
    if (!this.vrm) return;
    const defs: [string, number][] = [
      ['chest', 0.02],
      ['upperChest', 0.011],
    ];
    for (const [name, amp] of defs) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(name as never);
      if (node) this.breathBones.push({ node, baseX: node.rotation.x, amp, phase: 0 });
    }
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const portrait = this.isPortrait();
    if (portrait !== this.wasPortrait) {
      this.wasPortrait = portrait;
      if (this.vrm) this.goToPreset(this.currentPreset, true);
    }
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.elapsed += dt;
    this.updateOrbit(dt);
    this.updateGaze(dt);
    this.updateBlink();
    this.updateArms(dt);
    this.updateReactions(dt);
    this.updateBody(dt);
    this.vrm?.update(dt);
    this.updateParticles(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private updateOrbit(dt: number): void {
    const k = 1 - Math.exp(-dt * 7);
    this.orbit.theta = angleLerp(this.orbit.theta, this.orbitGoal.theta, k);
    this.orbit.phi += (this.orbitGoal.phi - this.orbit.phi) * k;
    this.orbit.radius += (this.orbitGoal.radius - this.orbit.radius) * k;
    this.orbit.target.lerp(this.orbitGoal.target, k);
    const sph = new THREE.Spherical(this.orbit.radius, this.orbit.phi, this.orbit.theta);
    this.camera.position.setFromSpherical(sph).add(this.orbit.target);
    this.camera.lookAt(this.orbit.target);
  }

  private updateGaze(dt: number): void {
    if (!this.vrm) return;
    // 放置中はたまに視線を外して、また正面に戻る
    if (
      this.mode === 'touch' &&
      this.touchPointerId === null &&
      this.elapsed - this.lastInteractAt > 3.5 &&
      this.elapsed >= this.nextWanderAt
    ) {
      const h = this.modelHeight;
      if (Math.random() < 0.45) {
        this.gazeGoal.set(0, h * 0.88, 0.6);
      } else {
        this.gazeGoal.set((Math.random() - 0.5) * h * 0.9, h * (0.68 + Math.random() * 0.35), 0.55);
      }
      this.nextWanderAt = this.elapsed + 3 + Math.random() * 4;
    }
    const k = 1 - Math.exp(-dt * 9);
    this.lookTarget.position.lerp(this.gazeGoal, k);
  }

  private updateBlink(): void {
    const mgr = this.vrm?.expressionManager;
    if (!mgr) return;
    const t = this.elapsed;
    if (this.blinkStart < 0 && t >= this.nextBlinkAt) this.blinkStart = t;
    if (this.blinkStart >= 0) {
      const p = (t - this.blinkStart) / 0.18;
      if (p >= 1) {
        mgr.setValue('blink', 0);
        this.blinkStart = -1;
        this.nextBlinkAt = t + 2.2 + Math.random() * 2.6;
      } else {
        mgr.setValue('blink', Math.sin(Math.PI * p));
      }
    }
  }

  private updateBody(dt: number): void {
    const s = Math.sin(this.elapsed * ((Math.PI * 2) / 4.6));
    for (const b of this.breathBones) {
      b.node.rotation.x = b.baseX + s * b.amp;
    }
    // 体の傾き (掴んだ手を伸ばす / 撫でられて寄る) をなめらかに反映
    const k = 1 - Math.exp(-dt * 6);
    this.lean.x += (this.lean.tx - this.lean.x) * k;
    this.lean.z += (this.lean.tz - this.lean.z) * k;
    if (this.spineNode) {
      this.spineNode.rotation.x = this.spineBase.x + this.lean.x;
      this.spineNode.rotation.z = this.spineBase.z + this.lean.z;
    }
  }

  // ---- touch rig / arm IK / reactions ----

  private tA = new THREE.Vector3();
  private tB = new THREE.Vector3();
  private tC = new THREE.Vector3();
  private tS = new THREE.Vector3();
  private tD = new THREE.Vector3();
  private tDir = new THREE.Vector3();
  private tPole = new THREE.Vector3();
  private tE = new THREE.Vector3();
  private tE2 = new THREE.Vector3();
  private tTmp = new THREE.Vector3();
  private tTmp2 = new THREE.Vector3();
  private tDesired = new THREE.Vector3();
  private tWrist = new THREE.Vector3();
  private tQ0 = new THREE.Quaternion();
  private tAxisX = new THREE.Vector3(1, 0, 0);
  private tQ1 = new THREE.Quaternion();
  private tQ2 = new THREE.Quaternion();

  private setupTouchRig(): void {
    if (!this.vrm) return;
    this.scene.updateMatrixWorld(true);
    const humanoid = this.vrm.humanoid;
    const right = this.makeRig('right', -1);
    const left = this.makeRig('left', 1);
    this.armR = right;
    this.arms = [right, left].filter((r): r is ArmRig => r !== null);
    this.hipsNode = humanoid.getNormalizedBoneNode('hips' as never);
    this.headNode = humanoid.getNormalizedBoneNode('head' as never);
    this.chestNode =
      humanoid.getNormalizedBoneNode('upperChest' as never) ?? humanoid.getNormalizedBoneNode('chest' as never);
    this.spineNode = humanoid.getNormalizedBoneNode('spine' as never);
    if (this.spineNode) this.spineBase.copy(this.spineNode.rotation);

    const heartTexture = this.createHeartTexture();
    for (let i = 0; i < 20; i++) {
      const mat = new THREE.SpriteMaterial({ map: heartTexture, transparent: true, opacity: 0, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.scene.add(sprite);
      this.hearts.push({ sprite, vel: new THREE.Vector3(), life: 0, maxLife: 1, baseScale: 0.05 });
    }
  }

  private makeRig(prefix: 'right' | 'left', side: -1 | 1): ArmRig | null {
    if (!this.vrm) return null;
    const humanoid = this.vrm.humanoid;
    const upper = humanoid.getNormalizedBoneNode(`${prefix}UpperArm` as never);
    const lower = humanoid.getNormalizedBoneNode(`${prefix}LowerArm` as never);
    const hand = humanoid.getNormalizedBoneNode(`${prefix}Hand` as never);
    const tip = humanoid.getNormalizedBoneNode(`${prefix}IndexDistal` as never);
    if (!upper || !lower || !hand || !tip) return null;
    // 手を消す処理は raw ボーン側でないとスキニングに効かない (normalized は回転のみ転写される)
    const rawHand = humanoid.getRawBoneNode(`${prefix}Hand` as never);
    const fingers: THREE.Object3D[] = [];
    const fingerRest: THREE.Quaternion[] = [];
    for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
      for (const j of ['Proximal', 'Intermediate']) {
        const node = humanoid.getNormalizedBoneNode(`${prefix}${f}${j}` as never);
        if (node) {
          fingers.push(node);
          fingerRest.push(node.quaternion.clone());
        }
      }
    }
    const s = upper.getWorldPosition(new THREE.Vector3());
    const e = lower.getWorldPosition(new THREE.Vector3());
    const w = hand.getWorldPosition(new THREE.Vector3());
    const t = tip.getWorldPosition(new THREE.Vector3());
    const pose = POCKET_POSE[prefix];
    const q = (a: readonly number[]) => new THREE.Quaternion(a[0], a[1], a[2], a[3]);
    const pocketFingers = fingers.map((_, i) => q(pose.fingers[i % 2]));
    const mkSet = (
      u: THREE.Quaternion,
      l: THREE.Quaternion,
      h: THREE.Quaternion,
      f: THREE.Quaternion[],
    ): PoseSet => ({ upper: u, lower: l, hand: h, fingers: f });
    const restSet = mkSet(
      upper.quaternion.clone(),
      lower.quaternion.clone(),
      hand.quaternion.clone(),
      fingerRest.map((x) => x.clone()),
    );
    const pocketSet = mkSet(q(pose.upper), q(pose.lower), hand.quaternion.clone(), pocketFingers);
    const cloneSet = (src: PoseSet): PoseSet =>
      mkSet(
        src.upper.clone(),
        src.lower.clone(),
        src.hand.clone(),
        src.fingers.map((x) => x.clone()),
      );
    return {
      side, upper, lower, hand, tip, fingers, fingerRest, rawHand,
      l1: s.distanceTo(e),
      l2: e.distanceTo(w),
      restHandQuat: hand.quaternion.clone(),
      restWrist: w.clone(),
      restTip: t.clone(),
      restTipOffset: t.clone().sub(w),
      restSet,
      pocketSet,
      xFrom: cloneSet(restSet),
      xTo: cloneSet(restSet),
      xT: 1,
      homeKind: 'rest',
      needCrossfade: false,
      grabBaseUpper: upper.quaternion.clone(),
      grabBaseLower: lower.quaternion.clone(),
      pole: new THREE.Vector3(side * 0.4, -1, -0.35),
      mode: 'idle',
      blend: 0,
      point: t.clone(),
      pointVel: new THREE.Vector3(),
      tipOffset: t.clone().sub(w),
    };
  }

  private createHeartTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.translate(64, 66);
    ctx.scale(3.2, 3.2);
    ctx.beginPath();
    ctx.moveTo(0, 11);
    ctx.bezierCurveTo(-17, -3, -11, -17, 0, -8);
    ctx.bezierCurveTo(11, -17, 17, -3, 0, 11);
    ctx.closePath();
    ctx.fillStyle = '#ff8fc7';
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#ffd3ea';
    ctx.stroke();
    return new THREE.CanvasTexture(c);
  }

  private endTouchInteraction(): void {
    if (this.armR && this.armR.mode === 'grabbed') {
      this.armR.mode = 'idle';
      // 離した位置から現在のホームポーズへクロスフェードさせる
      this.armR.needCrossfade = true;
    }
    this.patting = false;
    this.touchPointerId = null;
  }

  private pulse(name: 'happy' | 'relaxed' | 'surprised', value: number, dur: number): void {
    if (this.elapsed < this.exprUntil[name] && this.exprTarget[name] > value) {
      this.exprUntil[name] = Math.max(this.exprUntil[name], this.elapsed + dur);
      return;
    }
    this.exprTarget[name] = value;
    this.exprUntil[name] = this.elapsed + dur;
  }

  private updateReactions(dt: number): void {
    const mgr = this.vrm?.expressionManager;
    if (mgr) {
      (Object.keys(this.expr) as (keyof typeof this.expr)[]).forEach((name) => {
        const goal = this.elapsed < this.exprUntil[name] ? this.exprTarget[name] : 0;
        const rate = goal > this.expr[name] ? 9 : 3.2;
        this.expr[name] += (goal - this.expr[name]) * (1 - Math.exp(-dt * rate));
        mgr.setValue(name, clamp(this.expr[name], 0, 1));
      });
    }
    if (!this.armR || this.armR.mode !== 'grabbed') {
      this.lean.tz = this.patLeanZ;
      this.lean.tx = 0;
    }
    this.patLeanZ *= Math.exp(-dt * 2.2);
  }

  private spawnHearts(origin: THREE.Vector3, n: number): void {
    let spawned = 0;
    for (const p of this.hearts) {
      if (spawned >= n) break;
      if (p.life > 0) continue;
      p.maxLife = 0.9 + Math.random() * 0.5;
      p.life = p.maxLife;
      p.baseScale = this.modelHeight * (0.03 + Math.random() * 0.02);
      p.sprite.visible = true;
      p.sprite.position.set(
        origin.x + (Math.random() - 0.5) * 0.05,
        origin.y + Math.random() * 0.02,
        origin.z + (Math.random() - 0.5) * 0.05,
      );
      p.vel.set((Math.random() - 0.5) * 0.06, 0.2 + Math.random() * 0.12, (Math.random() - 0.5) * 0.04);
      spawned++;
    }
  }

  private updateParticles(dt: number): void {
    for (const p of this.hearts) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        continue;
      }
      p.sprite.position.addScaledVector(p.vel, dt);
      p.vel.y += 0.1 * dt;
      const mat = p.sprite.material as THREE.SpriteMaterial;
      mat.opacity = 0.95 * clamp(p.life / (p.maxLife * 0.55), 0, 1);
      const s = p.baseScale * (1 + (1 - p.life / p.maxLife) * 0.5);
      p.sprite.scale.set(s, s, 1);
    }
  }

  setIdlePose(pose: 'pocket' | 'down'): void {
    this.idlePose = pose;
  }

  private updateArms(dt: number): void {
    if (!this.vrm) return;
    // 反応中・掴み中でもポケットから手は出さない (待機ポーズの切替のみで手が出入りする)
    for (const rig of this.arms) this.updateRig(rig, dt);
    const arm = this.armR;
    if (arm && arm.mode === 'grabbed') {
      const s = arm.upper.getWorldPosition(this.tTmp2);
      this.lean.tz = clamp(-(arm.point.x - s.x) * 0.3, -0.13, 0.13);
      this.lean.tx = clamp((s.y - arm.point.y) * 0.1, -0.02, 0.1);
      this.pulse('happy', 0.3, 0.3);
    }
  }

  // ---- ポーズのクロスフェード (前例のポーズデータ方式) ----

  private snapshotPose(rig: ArmRig, into: PoseSet): void {
    into.upper.copy(rig.upper.quaternion);
    into.lower.copy(rig.lower.quaternion);
    into.hand.copy(rig.hand.quaternion);
    for (let i = 0; i < rig.fingers.length; i++) into.fingers[i].copy(rig.fingers[i].quaternion);
  }

  private copyPoseSet(from: PoseSet, into: PoseSet): void {
    into.upper.copy(from.upper);
    into.lower.copy(from.lower);
    into.hand.copy(from.hand);
    for (let i = 0; i < from.fingers.length; i++) into.fingers[i].copy(from.fingers[i]);
  }

  private applyPose(rig: ArmRig, set: PoseSet): void {
    rig.upper.quaternion.copy(set.upper);
    rig.lower.quaternion.copy(set.lower);
    rig.hand.quaternion.copy(set.hand);
    for (let i = 0; i < rig.fingers.length; i++) rig.fingers[i].quaternion.copy(set.fingers[i]);
  }

  private startCrossfade(rig: ArmRig, kind: 'pocket' | 'rest'): void {
    this.snapshotPose(rig, rig.xFrom);
    this.copyPoseSet(kind === 'pocket' ? rig.pocketSet : rig.restSet, rig.xTo);
    rig.xT = 0;
    rig.homeKind = kind;
  }

  private updateRig(rig: ArmRig, dt: number): void {
    if (rig.mode === 'grabbed') {
      // 掴んでいる間だけ IK (ポケットポーズ自体はポーズデータ方式)
      rig.blend = Math.min(1, rig.blend + dt * 6);
      rig.pointVel.addScaledVector(this.tTmp.copy(this.grabPoint).sub(rig.point), 120 * dt);
      rig.pointVel.multiplyScalar(Math.exp(-15 * dt));
      rig.point.addScaledVector(rig.pointVel, dt);
      const wrist = this.tWrist.copy(rig.point).sub(rig.tipOffset);
      this.solveArm(rig, wrist);
      if (rig.blend < 1) {
        rig.upper.quaternion.slerp(rig.grabBaseUpper, 1 - rig.blend);
        rig.lower.quaternion.slerp(rig.grabBaseLower, 1 - rig.blend);
      }
      // 指と手首は通常の形へ戻す
      const k = 1 - Math.exp(-dt * 6);
      rig.hand.quaternion.slerp(rig.restHandQuat, k);
      rig.rawHand?.scale.setScalar(1);
      for (let i = 0; i < rig.fingers.length; i++) rig.fingers[i].quaternion.slerp(rig.fingerRest[i], k);
      return;
    }
    const want: 'pocket' | 'rest' = this.idlePose === 'pocket' ? 'pocket' : 'rest';
    if (want !== rig.homeKind || rig.needCrossfade) {
      this.startCrossfade(rig, want);
      rig.needCrossfade = false;
    }
    if (rig.xT < 1) {
      rig.xT = Math.min(1, rig.xT + dt / 0.55);
      const t = rig.xT;
      const w = t * t * (3 - 2 * t);
      rig.upper.quaternion.slerpQuaternions(rig.xFrom.upper, rig.xTo.upper, w);
      rig.lower.quaternion.slerpQuaternions(rig.xFrom.lower, rig.xTo.lower, w);
      rig.hand.quaternion.slerpQuaternions(rig.xFrom.hand, rig.xTo.hand, w);
      for (let i = 0; i < rig.fingers.length; i++) {
        rig.fingers[i].quaternion.slerpQuaternions(rig.xFrom.fingers[i], rig.xTo.fingers[i], w);
      }
      if (rig.xT >= 1) this.applyPose(rig, rig.xTo);
    } else if (rig.homeKind === 'pocket') {
      this.applyPose(rig, rig.pocketSet);
    }
    // ポケットに完全に入っている間は、手 (掌と指) をスケール 0 にして消す。
    // どの角度から見てもはみ出さないようにするための保険 (アバター改変でよくある「手を消す」処理)
    const hideHand = rig.homeKind === 'pocket' && rig.xT >= 1;
    rig.rawHand?.scale.setScalar(hideHand ? 0.001 : 1);
  }

  private solveArm(arm: ArmRig, wrist: THREE.Vector3): void {
    const S = arm.upper.getWorldPosition(this.tS);
    wrist.z = Math.max(wrist.z, -0.02);
    wrist.y = Math.max(wrist.y, 0.03);
    const d = this.tD.copy(wrist).sub(S);
    let dist = d.length();
    const maxLen = (arm.l1 + arm.l2) * 0.985;
    if (dist > maxLen) {
      d.multiplyScalar(maxLen / dist);
      dist = maxLen;
    }
    if (dist < 0.05) {
      d.setLength(0.05);
      dist = 0.05;
    }
    const dir = this.tDir.copy(d).divideScalar(dist);
    const a = (arm.l1 * arm.l1 - arm.l2 * arm.l2 + dist * dist) / (2 * dist);
    const hh = Math.sqrt(Math.max(arm.l1 * arm.l1 - a * a, 0));
    // 肘の向きは rig.pole で決める (通常は下・少し外・少し後ろ、ポケット時は体の近く)
    const perp = this.tPole.copy(arm.pole);
    perp.addScaledVector(dir, -perp.dot(dir));
    if (perp.lengthSq() < 1e-6) perp.set(0, -1, 0).addScaledVector(dir, dir.y);
    perp.normalize();
    const E = this.tE.copy(S).addScaledVector(dir, a).addScaledVector(perp, hh);
    this.alignBone(arm.upper, arm.lower, this.tTmp.copy(E).sub(S));
    arm.upper.updateWorldMatrix(false, true);
    const E2 = arm.lower.getWorldPosition(this.tE2);
    this.alignBone(arm.lower, arm.hand, this.tTmp.copy(S).add(d).sub(E2));
  }

  private alignBone(node: THREE.Object3D, child: THREE.Object3D, desiredDir: THREE.Vector3): void {
    const nodePos = node.getWorldPosition(this.tA);
    const childPos = child.getWorldPosition(this.tB);
    const cur = this.tC.copy(childPos).sub(nodePos);
    if (cur.lengthSq() < 1e-8) return;
    cur.normalize();
    const des = this.tTmp2.copy(desiredDir).normalize();
    const q = this.tQ0.setFromUnitVectors(cur, des);
    const worldQ = node.getWorldQuaternion(this.tQ1);
    const parentQ = node.parent ? node.parent.getWorldQuaternion(this.tQ2) : this.tQ2.identity();
    node.quaternion.copy(parentQ.invert().multiply(q).multiply(worldQ));
  }

  // ---- input ----

  private setRayFromPointer(e: PointerEvent): boolean {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return true;
  }

  private planePointFromPointer(e: PointerEvent, out: THREE.Vector3, plane: THREE.Plane = this.gazePlane): boolean {
    if (!this.setRayFromPointer(e)) return false;
    return this.raycaster.ray.intersectPlane(plane, out) !== null;
  }

  private toScreenPx(v: THREE.Vector3): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const p = this.tTmp.copy(v).project(this.camera);
    return {
      x: rect.left + ((p.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - p.y) / 2) * rect.height,
    };
  }

  private headCenter(out: THREE.Vector3): THREE.Vector3 {
    this.headNode!.getWorldPosition(out);
    out.y += this.modelHeight * 0.05;
    return out;
  }

  private tryStartGrab(e: PointerEvent): boolean {
    const arm = this.armR;
    if (!arm) return false;
    // ポケットに入れている間は指先を掴めない (手が出ていないので掴む対象がない)
    if (this.idlePose === 'pocket') return false;
    const tipPx = this.toScreenPx(arm.tip.getWorldPosition(this.tA));
    const handPx = this.toScreenPx(arm.hand.getWorldPosition(this.tB));
    const d = Math.min(
      Math.hypot(e.clientX - tipPx.x, e.clientY - tipPx.y),
      Math.hypot(e.clientX - handPx.x, e.clientY - handPx.y),
    );
    if (d > 80) return false;
    const tipW = arm.tip.getWorldPosition(this.tA);
    const wristW = arm.hand.getWorldPosition(this.tB);
    arm.tipOffset.copy(tipW).sub(wristW);
    arm.point.copy(tipW);
    arm.pointVel.set(0, 0, 0);
    arm.grabBaseUpper.copy(arm.upper.quaternion);
    arm.grabBaseLower.copy(arm.lower.quaternion);
    arm.rawHand?.scale.setScalar(1);
    arm.blend = 0;
    arm.xT = 1;
    arm.mode = 'grabbed';
    // 掴んだ瞬間の指先の奥行きに平面を合わせると、指先がカーソルに吸着して見える
    this.grabPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), tipW);
    if (this.planePointFromPointer(e, this.tC, this.grabPlane)) this.setGrabPoint(this.tC);
    else this.grabPoint.copy(tipW);
    this.pulse('surprised', 0.45, 0.35);
    this.pulse('happy', 0.45, 1);
    this.spawnHearts(tipW, 3);
    return true;
  }

  private setGrabPoint(p: THREE.Vector3): void {
    const h = this.modelHeight;
    this.grabPoint.set(clamp(p.x, -h * 0.95, h * 0.95), clamp(p.y, h * 0.08, h * 1.32), p.z);
  }

  private onPoke(at: THREE.Vector3): void {
    if (this.elapsed < this.pokeCooldownUntil) return;
    this.pokeCooldownUntil = this.elapsed + 0.5;
    this.pulse('surprised', 0.85, 0.4);
    this.pulse('happy', 0.5, 1.1);
    this.spawnHearts(at, 2);
  }

  private onPatStroke(dx: number): void {
    this.pulse('happy', 0.65, 1);
    this.pulse('relaxed', 0.55, 1);
    if (Math.abs(dx) > 2) {
      this.patLeanZ = clamp(this.patLeanZ - Math.sign(dx) * 0.045, -0.09, 0.09);
    }
    if (this.headNode) {
      const top = this.headCenter(this.tA);
      top.y += this.modelHeight * 0.1;
      this.spawnHearts(top, 3);
    }
  }

  private updateCursorHint(e: PointerEvent): void {
    if (!this.armR || this.idlePose === 'pocket') {
      this.canvas.style.cursor = '';
      return;
    }
    const tipPx = this.toScreenPx(this.armR.tip.getWorldPosition(this.tA));
    const d = Math.hypot(e.clientX - tipPx.x, e.clientY - tipPx.y);
    this.canvas.style.cursor = d < 80 ? 'grab' : '';
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    if (this.mode !== 'touch') return;
    this.lastInteractAt = this.elapsed;
    this.updateGazeFromPointer(e);
    if (this.touchPointerId !== null) return;
    if (this.tryStartGrab(e)) {
      this.touchPointerId = e.pointerId;
      return;
    }
    if (this.headNode && this.setRayFromPointer(e)) {
      const h = this.modelHeight;
      const center = this.headCenter(this.tA);
      if (this.raycaster.ray.distanceToPoint(center) < h * 0.15) {
        this.patting = true;
        this.patAcc = 0;
        this.patLastX = e.clientX;
        this.patLastY = e.clientY;
        this.touchPointerId = e.pointerId;
        this.pulse('relaxed', 0.45, 0.5);
        return;
      }
      const q = this.headNode.getWorldQuaternion(this.tQ0);
      for (const sgn of [-1, 1]) {
        const cheek = this.tB
          .set(sgn * h * 0.045, -h * 0.005, h * 0.062)
          .applyQuaternion(q)
          .add(center);
        if (this.raycaster.ray.distanceToPoint(cheek) < h * 0.05) {
          this.touchPointerId = e.pointerId;
          this.onPoke(cheek);
          return;
        }
      }
    }
    if (this.chestNode && this.setRayFromPointer(e)) {
      const c = this.chestNode.getWorldPosition(this.tA);
      if (this.raycaster.ray.distanceToPoint(c) < this.modelHeight * 0.13) {
        this.touchPointerId = e.pointerId;
        this.onPoke(c);
      }
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.mode === 'touch') {
      this.lastInteractAt = this.elapsed;
      if (this.touchPointerId === e.pointerId && this.armR?.mode === 'grabbed') {
        if (this.planePointFromPointer(e, this.tC, this.grabPlane)) this.setGrabPoint(this.tC);
      } else if (this.touchPointerId === e.pointerId && this.patting) {
        const dx = e.clientX - this.patLastX;
        const dy = e.clientY - this.patLastY;
        this.patLastX = e.clientX;
        this.patLastY = e.clientY;
        this.patAcc += Math.hypot(dx, dy);
        if (this.headNode) {
          const c = this.headCenter(this.tA);
          const hp = this.toScreenPx(c);
          const tp = this.toScreenPx(this.tB.set(c.x, c.y + this.modelHeight * 0.15, c.z));
          const radiusPx = Math.abs(hp.y - tp.y);
          if (Math.hypot(e.clientX - hp.x, e.clientY - hp.y) > radiusPx * 1.9 + 30) {
            this.patting = false;
          }
        }
        if (this.patting && this.patAcc > 130) {
          this.patAcc = 0;
          this.onPatStroke(dx);
        }
      } else if (this.touchPointerId === null) {
        this.updateCursorHint(e);
      }
      this.updateGazeFromPointer(e);
      return;
    }
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0 && dist > 0) {
        this.orbitGoal.radius = clamp(
          this.orbitGoal.radius * (this.pinchDist / dist),
          this.modelHeight * 0.3,
          this.modelHeight * 3.6,
        );
      }
      this.pinchDist = dist;
      this.panBy(dx * 0.5, dy * 0.5);
      return;
    }
    if (prev.button === 2 || e.shiftKey) {
      this.panBy(dx, dy);
    } else {
      this.orbitGoal.theta -= dx * 0.0052;
      this.orbitGoal.phi = clamp(this.orbitGoal.phi - dy * 0.0052, 0.12, 1.53);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.pinchDist = 0;
    if (e.pointerId === this.touchPointerId) this.endTouchInteraction();
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.mode !== 'camera') return;
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.0011);
    this.orbitGoal.radius = clamp(
      this.orbitGoal.radius * factor,
      this.modelHeight * 0.3,
      this.modelHeight * 3.6,
    );
  };

  private onContextMenu = (e: Event): void => e.preventDefault();

  private panBy(dx: number, dy: number): void {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const scale = this.orbitGoal.radius * 0.0016;
    this.orbitGoal.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
    this.orbitGoal.target.x = clamp(this.orbitGoal.target.x, -0.9, 0.9);
    this.orbitGoal.target.y = clamp(this.orbitGoal.target.y, 0.15, this.modelHeight * 1.05);
    this.orbitGoal.target.z = clamp(this.orbitGoal.target.z, -0.5, 0.5);
  }

  private updateGazeFromPointer(e: PointerEvent): void {
    if (!this.setRayFromPointer(e)) return;
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.gazePlane, hit)) {
      const h = this.modelHeight;
      hit.x = clamp(hit.x, -h * 0.75, h * 0.75);
      hit.y = clamp(hit.y, h * 0.25, h * 1.12);
      hit.z = 0.55;
      this.gazeGoal.copy(hit);
    }
  }

  private attachInput(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  private detachInput(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }
}
