import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  // React 사본이 둘 이상이면 훅이 깨진다 (Excalidraw 가 끌어오는 radix-ui 의 peer 때문).
  resolve: { dedupe: ["react", "react-dom"] },
  // dev 서버 첫 요청 중 재최적화(504 Outdated Optimize Dep)가 나지 않도록 미리 선언한다.
  optimizeDeps: {
    include: ["react", "react-dom", "react-dom/client", "react-router-dom", "@excalidraw/excalidraw"],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: false },
      "/files": { target: BACKEND, changeOrigin: false },
      "/ws": { target: BACKEND, changeOrigin: false, ws: true },
      // 협업 릴레이는 항상 app(백엔드)을 거친다 — 프로덕션 경로와 같게 유지한다.
      // app 이 다시 room(3002)으로 프록시하며, 그 경계에서 쿠키 인증을 검사한다.
      "/socket.io": { target: BACKEND, changeOrigin: false, ws: true },
    },
  },
  build: {
    // Excalidraw 번들이 커서 기본 경고 한도를 올린다.
    chunkSizeWarningLimit: 2000,
  },
});
