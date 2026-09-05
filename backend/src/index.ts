import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// 저장소 루트의 .env 와 backend/.env 를 모두 읽는다 (이미 설정된 환경변수가 우선).
loadDotenv({ path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../.env")], quiet: true });

const config = loadConfig();

/** SIGTERM 뒤 이 시간이 지나도 닫히지 않으면 강제 종료한다 (도커 기본 유예는 10초). */
const SHUTDOWN_TIMEOUT_MS = 8_000;

try {
  const app = await buildServer();
  await app.listen({ port: config.port, host: process.env.HOST ?? "0.0.0.0" });
  app.log.info(`백엔드가 http://localhost:${config.port} 에서 실행 중입니다.`);

  /**
   * 정상 종료. `docker stop` / Container Manager 의 중지는 SIGTERM 을 보낸다.
   * `app.close()` 는 (1) 새 연결을 막고 (2) 열린 WebSocket·협업 소켓을 닫고
   * (3) onClose 훅에서 SQLite 를 닫아 WAL 을 체크포인트한다.
   * 이 과정을 거치지 않고 죽으면 `app.db-wal` 이 남아 다음 기동 때 복구를 거친다.
   */
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} 수신 — 정상 종료를 시작합니다.`);

    // 닫히지 않는 소켓 때문에 컨테이너가 SIGKILL 을 맞는 일이 없게 상한을 둔다.
    const forceExit = setTimeout(() => {
      app.log.error("정상 종료가 시간 안에 끝나지 않아 강제 종료합니다.");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    app.close().then(
      () => {
        clearTimeout(forceExit);
        app.log.info("정상 종료 완료.");
        process.exit(0);
      },
      (error: unknown) => {
        clearTimeout(forceExit);
        app.log.error({ err: error }, "종료 중 오류");
        process.exit(1);
      },
    );
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      shutdown(signal);
    });
  }
} catch (error) {
  console.error("[backend] 기동 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
}
