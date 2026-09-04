import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// 저장소 루트의 .env 와 backend/.env 를 모두 읽는다 (이미 설정된 환경변수가 우선).
loadDotenv({ path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../.env")], quiet: true });

const config = loadConfig();

try {
  const app = await buildServer();
  await app.listen({ port: config.port, host: process.env.HOST ?? "0.0.0.0" });
  app.log.info(`백엔드가 http://localhost:${config.port} 에서 실행 중입니다.`);
} catch (error) {
  console.error("[backend] 기동 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
}
