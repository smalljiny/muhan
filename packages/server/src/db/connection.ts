import { MongoClient, type Db } from 'mongodb'

// 서버 선택 기본 타임아웃(ms). 부팅 fail-fast를 위한 상한이며 옵션으로 재정의 가능하다.
const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 5000

/** SDAM heartbeat 기반 연결 상태. 핸들러를 실제 mongod 타이밍 없이 단위 테스트 가능하게 분리한다. */
export type ConnectionState = {
  isConnected: () => boolean
  onHeartbeatSucceeded: () => void
  onHeartbeatFailed: () => void
}

/**
 * 연결 상태 플래그 팩토리.
 *
 * heartbeat 성공/실패 핸들러를 노출해, 실제 네트워크 단절 타이밍(비결정적·flaky)에
 * 의존하지 않고 "단절 시 플래그 변화"를 직접 검증할 수 있게 한다.
 */
export function createConnectionState(): ConnectionState {
  let connected = false
  return {
    isConnected: () => connected,
    onHeartbeatSucceeded: () => {
      connected = true
    },
    onHeartbeatFailed: () => {
      connected = false
    },
  }
}

/** 연결된 MongoDB 핸들. 이후 스토리의 repo는 생성자 주입으로 `db`를 받는다. */
export type MongoConnection = {
  db: Db
  client: MongoClient
  isConnected: () => boolean
  close: () => Promise<void>
}

/**
 * MongoDB에 연결하고 부팅 시점에 fail-fast 검증한다.
 *
 * 정적 `MongoClient.connect`는 `new MongoClient().connect()`와 동치인데, 초기 handshake
 * heartbeat 이전에 SDAM 리스너를 붙이려고 두 단계로 분리한다. 이로써 connect가 resolve된
 * 직후 `isConnected()`가 결정적으로 true다. 재연결은 드라이버 내장 로직에 맡기고 여기선 감시만 한다.
 */
export async function connectMongo(
  uri: string,
  dbName: string,
  options?: { serverSelectionTimeoutMS?: number },
): Promise<MongoConnection> {
  const state = createConnectionState()
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS:
      options?.serverSelectionTimeoutMS ?? DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
  })

  // connect 이전에 붙여 초기 handshake heartbeat를 놓치지 않는다.
  client.on('serverHeartbeatSucceeded', state.onHeartbeatSucceeded)
  client.on('serverHeartbeatFailed', state.onHeartbeatFailed)

  // 연결 실패는 삼키지 않고 그대로 전파한다(fail-fast). 단, 실패한 client의
  // topology 모니터가 남지 않도록 close 후 원 에러를 다시 던진다.
  // close가 거부해도 원 connect 에러를 가리지 않게 가드한다.
  try {
    await client.connect()
  } catch (err) {
    await client.close().catch(() => {})
    throw err
  }

  const db = client.db(dbName)

  return {
    db,
    client,
    isConnected: state.isConnected,
    close: () => client.close(),
  }
}
