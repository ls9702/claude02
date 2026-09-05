# room — 실시간 협업 릴레이

업스트림 [`excalidraw-room`](https://github.com/excalidraw/excalidraw-room) (MIT) 의
`src/index.ts` 를 그대로 벤더링했다. 라이선스 원문은 `LICENSE`.

프로토콜(이벤트 이름·volatile 브로드캐스트·follow 룸)은 업스트림과 동일하다.
실행 환경만 바꿨다: CommonJS→ESM, `dotenv`/`debug` 의존성 제거.

## 실행

```
npm run dev -w @ds118/room     # tsx watch, 기본 127.0.0.1:3002
npm run build -w @ds118/room   # tsc → dist/
npm run start -w @ds118/room   # node dist/index.js
```

## 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3002 (`NODE_ENV=development`), 그 외 80 | 리슨 포트 |
| `HOST` | `127.0.0.1` | 리슨 주소 |
| `CORS_ORIGIN` | `*` | socket.io CORS origin |
| `ROOM_DEBUG` | — | `1` 이면 디버그 로그 출력 |

브라우저는 room 에 **직접 접속하지 않는다**. 항상 app(백엔드)의 `/socket.io`
프록시를 거치므로 room 은 루프백에만 바인딩하면 된다.
