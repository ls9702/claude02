/**
 * excalidraw-room 릴레이 서버.
 *
 * 출처: https://github.com/excalidraw/excalidraw-room (`src/index.ts`, MIT).
 * 라이선스 원문은 이 디렉터리의 `LICENSE` 에 그대로 두었다.
 *
 * 업스트림에서 바꾼 것은 실행 환경에 관한 것뿐이며 **프로토콜은 동일하다**:
 *  - CommonJS(`require`) → ESM `import`
 *  - `dotenv` 제거 (환경변수를 그대로 읽는다)
 *  - `debug` 패키지 제거 (`ROOM_DEBUG=1` 일 때만 찍는 console 래퍼)
 *  - SIGTERM/SIGINT 정상 종료 (도커 stop 에서 열린 소켓을 닫고 나간다)
 * 이벤트 이름(`join-room`·`server-broadcast`·`server-volatile-broadcast`·
 * `user-follow`·`room-user-change`·`first-in-room`·`new-user`·
 * `user-follow-room-change`·`broadcast-unfollow`), volatile 브로드캐스트,
 * follow 룸(`follow@<socketId>`) 규칙은 업스트림 그대로다.
 */
import http from "node:http";
import express from "express";
import { Server as SocketIO } from "socket.io";

type UserToFollow = {
  socketId: string;
  username: string;
};
type OnUserFollowedPayload = {
  userToFollow: UserToFollow;
  action: "FOLLOW" | "UNFOLLOW";
};

/** 업스트림의 `debug("server"|"io"|"socket")` 대체 — ROOM_DEBUG=1 일 때만 출력한다. */
const makeDebug =
  (scope: string) =>
  (...args: unknown[]): void => {
    if (process.env.ROOM_DEBUG === "1") console.log(`[${scope}]`, ...args);
  };

const serverDebug = makeDebug("server");
const ioDebug = makeDebug("io");
const socketDebug = makeDebug("socket");

const app = express();
const port = process.env.PORT || (process.env.NODE_ENV !== "development" ? 80 : 3002); // default port to listen
const host = process.env.HOST || "127.0.0.1";

app.use(express.static("public"));

app.get("/", (_req, res) => {
  res.send("Excalidraw collaboration server is up :)");
});

const server = http.createServer(app);

server.listen(Number(port), host, () => {
  // 기동 확인은 헬스체크(webServer.url)에도 쓰이므로 항상 찍는다.
  console.log(`room: listening on ${host}:${port}`);
  serverDebug(`listening on port: ${port}`);
});

try {
  const io = new SocketIO(server, {
    transports: ["websocket", "polling"],
    cors: {
      allowedHeaders: ["Content-Type", "Authorization"],
      origin: process.env.CORS_ORIGIN || "*",
      credentials: true,
    },
    allowEIO3: true,
  });

  io.on("connection", (socket) => {
    ioDebug("connection established!");
    io.to(`${socket.id}`).emit("init-room");
    socket.on("join-room", async (roomID) => {
      socketDebug(`${socket.id} has joined ${roomID}`);
      await socket.join(roomID);
      const sockets = await io.in(roomID).fetchSockets();
      if (sockets.length <= 1) {
        io.to(`${socket.id}`).emit("first-in-room");
      } else {
        socketDebug(`${socket.id} new-user emitted to room ${roomID}`);
        socket.broadcast.to(roomID).emit("new-user", socket.id);
      }

      io.in(roomID).emit(
        "room-user-change",
        sockets.map((socket) => socket.id),
      );
    });

    socket.on(
      "server-broadcast",
      (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socketDebug(`${socket.id} sends update to ${roomID}`);
        socket.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
      },
    );

    socket.on(
      "server-volatile-broadcast",
      (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socketDebug(`${socket.id} sends volatile update to ${roomID}`);
        socket.volatile.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
      },
    );

    socket.on("user-follow", async (payload: OnUserFollowedPayload) => {
      const roomID = `follow@${payload.userToFollow.socketId}`;

      switch (payload.action) {
        case "FOLLOW": {
          await socket.join(roomID);

          const sockets = await io.in(roomID).fetchSockets();
          const followedBy = sockets.map((socket) => socket.id);

          io.to(payload.userToFollow.socketId).emit("user-follow-room-change", followedBy);

          break;
        }
        case "UNFOLLOW": {
          await socket.leave(roomID);

          const sockets = await io.in(roomID).fetchSockets();
          const followedBy = sockets.map((socket) => socket.id);

          io.to(payload.userToFollow.socketId).emit("user-follow-room-change", followedBy);

          break;
        }
      }
    });

    socket.on("disconnecting", async () => {
      socketDebug(`${socket.id} has disconnected`);
      for (const roomID of Array.from(socket.rooms)) {
        const otherClients = (await io.in(roomID).fetchSockets()).filter(
          (_socket) => _socket.id !== socket.id,
        );

        const isFollowRoom = roomID.startsWith("follow@");

        if (!isFollowRoom && otherClients.length > 0) {
          socket.broadcast.to(roomID).emit(
            "room-user-change",
            otherClients.map((socket) => socket.id),
          );
        }

        if (isFollowRoom && otherClients.length === 0) {
          const socketId = roomID.replace("follow@", "");
          io.to(socketId).emit("broadcast-unfollow");
        }
      }
    });

    socket.on("disconnect", () => {
      socket.removeAllListeners();
      socket.disconnect();
    });
  });
} catch (error) {
  console.error(error);
}

/**
 * 정상 종료 — `docker stop` 은 SIGTERM 을 보낸다.
 * socket.io 연결은 keep-alive 라 `server.close()` 만으로는 끝나지 않아
 * `closeAllConnections()` 로 열린 소켓을 함께 닫는다. 릴레이는 무상태라 저장할 것이 없다.
 */
let closing = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (closing) return;
  closing = true;
  console.log(`room: ${signal} 수신 — 정상 종료`);
  const force = setTimeout(() => process.exit(1), 5_000);
  force.unref();
  server.close(() => {
    clearTimeout(force);
    process.exit(0);
  });
  server.closeAllConnections();
};

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    shutdown(signal);
  });
}
