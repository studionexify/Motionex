// Thumbnails of the cut types: each joint is really built on a small rod (so the picture is exactly what the cut
// does), cut open down the middle and drawn with every piece in its own colour.
import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { cylinder, initKernel } from '../csg';
import { buildFlexi, newCut } from '../flexi';
import { fitFor } from '../fit';
import { JOINTS, defaultJoint, type JointKind } from '../joints';

const thumbs = new Map<JointKind, string>();
const listeners = new Set<() => void>();
let started = false, version = 0;
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
export const useJointThumbs = () => { useSyncExternalStore(subscribe, () => version); ensureJointThumbs(); return thumbs; };

const PIECE = ['#4c8bf5', '#f2b84b', '#46c28f'];

export function ensureJointThumbs(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  void (async () => {
    await initKernel();
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.setSize(176, 132, false);
    renderer.localClippingEnabled = true;
    const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    const cam = new THREE.PerspectiveCamera(32, 176 / 132, 1, 500);
    cam.up.set(0, 0, 1);
    for (const j of JOINTS) {
      try {
        const rod = cylinder(11, 11, -24, 24, 36);
        const spec = defaultJoint(j.id);
        const res = buildFlexi(rod, [newCut('1', [0, 0, 0], [0, 0, 1], spec)], fitFor(0.4));
        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.5));
        const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(40, 60, 90); scene.add(key);
        // pieces from the bottom up
        const order = res.pieces.map((p, i) => ({ i, z: Math.max(...Array.from({ length: p.vertices.length / 3 }, (_, k) => p.vertices[k * 3 + 2])) })).sort((a, b) => a.z - b.z);
        order.forEach(({ i }, rank) => {
          const p = res.pieces[i], g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(p.vertices, 3)); g.setIndex(new THREE.BufferAttribute(p.indices, 1));
          const flat = g.toNonIndexed(); flat.computeVertexNormals();
          scene.add(new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ color: PIECE[rank % 3], roughness: 0.5, side: THREE.DoubleSide, clippingPlanes: [clip] })));
        });
        cam.position.set(34, 52, 30); cam.lookAt(0, 0, 0);
        renderer.render(scene, cam);
        thumbs.set(j.id, renderer.domElement.toDataURL('image/png'));
        scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
      } catch { /* a thumbnail is only decoration */ }
      version++; listeners.forEach((l) => l());
    }
    renderer.dispose();
  })();
}
