import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

// `collab/encryption.ts` 는 브라우저의 `window.crypto` 를 쓴다.
// vitest 는 node 환경이라 Node 의 WebCrypto 를 window 로 노출해 준다.
beforeAll(() => {
  const globalAny = globalThis as unknown as { window?: unknown; crypto?: unknown };
  if (!globalAny.crypto) globalAny.crypto = webcrypto;
  globalAny.window = globalThis;
});

const load = () => import("./encryption");

describe("collab/encryption", () => {
  it("생성한 키는 base64url 22자 (AES-GCM 128bit) 다", async () => {
    const { generateEncryptionKey } = await load();
    const key = await generateEncryptionKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("암호화한 데이터를 같은 키로 복호화하면 원본이 나온다", async () => {
    const { encryptData, decryptData, generateEncryptionKey } = await load();
    const key = await generateEncryptionKey();
    const payload = JSON.stringify({ type: "SCENE_UPDATE", payload: { elements: [1, 2, 3] } });

    const { encryptedBuffer, iv } = await encryptData(key, new TextEncoder().encode(payload));
    const decrypted = await decryptData(iv, encryptedBuffer, key);

    expect(new TextDecoder().decode(new Uint8Array(decrypted))).toBe(payload);
  });

  it("문자열도 그대로 암호화·복호화된다", async () => {
    const { encryptData, decryptData, generateEncryptionKey } = await load();
    const key = await generateEncryptionKey();
    const { encryptedBuffer, iv } = await encryptData(key, "안녕하세요 협업");
    const decrypted = await decryptData(iv, encryptedBuffer, key);
    expect(new TextDecoder().decode(new Uint8Array(decrypted))).toBe("안녕하세요 협업");
  });

  it("IV 는 매번 달라진다", async () => {
    const { encryptData, generateEncryptionKey } = await load();
    const key = await generateEncryptionKey();
    const a = await encryptData(key, "same");
    const b = await encryptData(key, "same");
    expect(Buffer.from(a.iv).toString("hex")).not.toBe(Buffer.from(b.iv).toString("hex"));
    // 같은 평문이라도 IV 가 다르므로 암호문도 다르다.
    expect(Buffer.from(a.encryptedBuffer).toString("hex")).not.toBe(
      Buffer.from(b.encryptedBuffer).toString("hex"),
    );
  });

  it("다른 키로는 복호화되지 않는다", async () => {
    const { encryptData, decryptData, generateEncryptionKey } = await load();
    const key = await generateEncryptionKey();
    const otherKey = await generateEncryptionKey();
    const { encryptedBuffer, iv } = await encryptData(key, "secret");
    await expect(decryptData(iv, encryptedBuffer, otherKey)).rejects.toBeTruthy();
  });

  it("서버가 만든 룸 키(base64url 16바이트)로도 왕복된다", async () => {
    const { encryptData, decryptData } = await load();
    // backend/src/ids.ts 의 newRoomKey() 와 같은 형식
    const roomKey = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    expect(roomKey).toHaveLength(22);

    const { encryptedBuffer, iv } = await encryptData(roomKey, "룸 브로드캐스트");
    const decrypted = await decryptData(iv, encryptedBuffer, roomKey);
    expect(new TextDecoder().decode(new Uint8Array(decrypted))).toBe("룸 브로드캐스트");
  });
});
