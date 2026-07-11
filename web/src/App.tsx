import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";

// Placeholder scaffold page — proves the Vite + React + TypeScript + React
// Three Fiber toolchain builds and renders end to end. Real views (Wiki /
// Search / Ask / Graph / Ingest / Lint / Settings) land in Phase 1+ on top
// of the design-system tokens.
function App() {
  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "1rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Mythic Proportion — 3D GraphRAG (scaffold)</h1>
        <p>Phase 0 scaffold: Vite + React + TypeScript + React Three Fiber toolchain proof.</p>
      </header>
      <div style={{ flex: 1 }}>
        <Canvas camera={{ position: [3, 3, 3] }}>
          <ambientLight intensity={0.6} />
          <directionalLight position={[5, 5, 5]} intensity={0.8} />
          <mesh>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color="orange" />
          </mesh>
          <OrbitControls />
        </Canvas>
      </div>
    </main>
  );
}

export default App;
