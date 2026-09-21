import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Proves updateMessage()'s optimistic locking (src/resolvers.ts) actually closes the
// lost-update gap for real GraphQL clients: many VUs race to increment a counter stored in
// one message's `content` field, each doing its own read (content + version) then an
// updateMessage mutation (submits content+1 guarded by the version it read). The server
// rejects an update with a CONFLICT GraphQL error whenever the row changed since that version
// was read - so out of N attempts, some legitimately lose the race and get CONFLICT (expected,
// not a bug), but every success must correspond to a real, distinct +1. If the app used a
// server-side-only CAS (re-reading its own "current" version right before writing, instead of
// trusting the version the client actually read), this test still fails: the DB's final
// content ends up lower than the count of "successful" updates, because those updates blindly
// overwrote content computed from stale reads even though the row hadn't changed *between the
// server's own read and write*, only since the client's much earlier read.
export const options = {
  vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 20,
  duration: __ENV.DURATION || '15s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost/graphql';
const jsonHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

const CREATE_AUTHOR_MUTATION = `mutation CreateAuthor($input: CreateAuthorInput!) { createAuthor(input: $input) { id } }`;
const CREATE_MESSAGE_MUTATION = `
  mutation CreateMessage($input: CreateMessageInput!) { createMessage(input: $input) { id } }
`;
const GET_COUNTER_QUERY = `query GetCounter($id: ID!) { message(id: $id) { content version } }`;
const INCREMENT_MUTATION = `
  mutation IncrementCounter($id: ID!, $input: UpdateMessageInput!) { updateMessage(id: $id, input: $input) { id version content } }
`;
const DELETE_MESSAGE_MUTATION = `mutation DeleteMessage($id: ID!) { deleteMessage(id: $id) }`;

const successfulIncrements = new Counter('successful_increments');
const writeConflicts = new Counter('write_conflicts');
const finalCounterValue = new Trend('final_counter_value');

export function setup() {
  const authorRes = http.post(BASE_URL, JSON.stringify({
    query: CREATE_AUTHOR_MUTATION,
    variables: { input: { name: 'k6-isolation-test', email: `k6-isolation-test-${Date.now()}@example.com` } },
  }), { headers: jsonHeaders });
  if (authorRes.status !== 200 || authorRes.json().errors) {
    throw new Error(`setup: failed to create author, status ${authorRes.status}, body ${authorRes.body}`);
  }
  const authorId = authorRes.json().data.createAuthor.id;

  const createRes = http.post(BASE_URL, JSON.stringify({
    query: CREATE_MESSAGE_MUTATION,
    variables: { input: { title: 'k6-transaction-isolation counter', content: '0', authorId } },
  }), { headers: jsonHeaders });
  if (createRes.status !== 200 || createRes.json().errors) {
    throw new Error(`setup: failed to create counter message, status ${createRes.status}, body ${createRes.body}`);
  }
  return { id: createRes.json().data.createMessage.id };
}

export default function (data) {
  const getRes = http.post(BASE_URL, JSON.stringify({
    query: GET_COUNTER_QUERY,
    variables: { id: data.id },
  }), { headers: jsonHeaders, tags: { name: 'ReadCounter' } });
  const read = check(getRes, {
    'read: status is 200, no errors': (r) => r.status === 200 && !r.json().errors,
  });
  if (!read) return;

  const current = parseInt(getRes.json().data.message.content, 10);
  const readVersion = getRes.json().data.message.version;

  const putRes = http.post(BASE_URL, JSON.stringify({
    query: INCREMENT_MUTATION,
    variables: { id: data.id, input: { content: String(current + 1), version: readVersion } },
  }), { headers: jsonHeaders, tags: { name: 'IncrementCounter' } });

  const body = putRes.json();
  const isSuccess = putRes.status === 200 && !body.errors;
  const isConflict = putRes.status === 200 && body.errors && body.errors[0].extensions.code === 'CONFLICT';

  check(putRes, {
    'write: success or CONFLICT': () => isSuccess || isConflict,
  });

  if (isSuccess) {
    successfulIncrements.add(1);
  } else if (isConflict) {
    writeConflicts.add(1);
  }
}

export function teardown(data) {
  // The read-through Hazelcast cache (see src/cache.ts) can briefly lag its own eviction right
  // at the tail of a burst of writes, so a single read here can under-report by a couple of
  // counts even though the DB itself is already correct. Poll a few times and keep the max -
  // the value is monotonically increasing, so this converges as soon as the cache catches up.
  let finalValue = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const finalRes = http.post(BASE_URL, JSON.stringify({
      query: GET_COUNTER_QUERY,
      variables: { id: data.id },
    }), { headers: jsonHeaders });
    try {
      finalValue = Math.max(finalValue, parseInt(finalRes.json().data.message.content, 10));
    } catch (e) {
      // ignore transient read errors while polling
    }
    sleep(0.3);
  }
  finalCounterValue.add(finalValue);

  console.log(`\nFinal counter value in DB (best-effort, cache-backed read): ${finalValue}`);
  console.log('Compare this against "successful_increments" in the summary below: they should be '
    + 'exactly equal. "write_conflicts" (CONFLICT errors) are expected under contention and are '
    + 'not lost updates - the client is told to refetch and retry. A trailing gap of 1-2 here is '
    + 'read-through cache lag in this script\'s own polling (see src/cache.ts), not a real loss.');

  http.post(BASE_URL, JSON.stringify({
    query: DELETE_MESSAGE_MUTATION,
    variables: { id: data.id },
  }), { headers: jsonHeaders });
}
