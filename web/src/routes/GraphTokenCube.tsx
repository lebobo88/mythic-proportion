import { useEffect, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import type { Mesh, MeshStandardMaterial } from "three";
import { subscribeGraphColors } from "../lib/graph-colors";

// Throwaway proof, per the Phase 1 testing strategy ("design-system-curator
// sign-off that --graph-* tokens resolve into THREE.Color in a throwaway R3F
// cube"): a cube whose material color is driven entirely by
// `--graph-node-entity`, re-read on every theme change via
// `subscribeGraphColors`. Not part of the eventual Phase 5 graph renderer.
function Cube() {
  const meshRef = useRef<Mesh>(null);

  useEffect(() => {
    return subscribeGraphColors((colors) => {
      const material = meshRef.current?.material as MeshStandardMaterial | undefined;
      material?.color.copy(colors.node.entity.color);
    });
  }, []);

  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.4;
    }
  });

  return (
    <mesh ref={meshRef}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial />
    </mesh>
  );
}

export function GraphTokenCube() {
  return (
    <div style={{ height: 200, borderRadius: "var(--radius-md)", overflow: "hidden" }}>
      <Canvas camera={{ position: [2.2, 2.2, 2.2] }}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 5, 5]} intensity={0.8} />
        <Cube />
      </Canvas>
    </div>
  );
}
