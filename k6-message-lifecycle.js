import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 10,
  duration: __ENV.DURATION || '10s',
  thresholds: {
    http_req_failed: ['rate<0.01'],    // Error rate under 1%
    http_req_duration: ['p(95)<500'],  // 95% of requests below 500ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost/graphql';
const jsonHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

const CREATE_AUTHOR_MUTATION = `mutation CreateAuthor($input: CreateAuthorInput!) { createAuthor(input: $input) { id } }`;
const CREATE_MESSAGE_MUTATION = `
  mutation CreateMessage($input: CreateMessageInput!) { createMessage(input: $input) { id } }
`;
const GET_MESSAGE_QUERY = `query GetMessage($id: ID!) { message(id: $id) { id } }`;
const UPDATE_MESSAGE_MUTATION = `
  mutation UpdateMessage($id: ID!, $input: UpdateMessageInput!) { updateMessage(id: $id, input: $input) { id version } }
`;
const DELETE_MESSAGE_MUTATION = `mutation DeleteMessage($id: ID!) { deleteMessage(id: $id) }`;

export function setup() {
  const res = http.post(BASE_URL, JSON.stringify({
    query: CREATE_AUTHOR_MUTATION,
    variables: { input: { name: 'k6-message-lifecycle', email: `k6-message-lifecycle-${Date.now()}@example.com` } },
  }), { headers: jsonHeaders });

  if (res.status !== 200 || res.json().errors) {
    throw new Error(`setup: failed to create author, status ${res.status}, body ${res.body}`);
  }
  return { authorId: res.json().data.createAuthor.id };
}

export default function (data) {
  // Create
  const createRes = http.post(BASE_URL, JSON.stringify({
    query: CREATE_MESSAGE_MUTATION,
    variables: {
      input: {
        title: `Lifecycle message ${randomIntBetween(1, 1000000)}`,
        content: 'Created by k6-message-lifecycle.js',
        authorId: data.authorId,
      },
    },
  }), { headers: jsonHeaders, tags: { name: 'CreateMessage' } });
  const created = check(createRes, {
    'create: status is 200, no errors': (r) => r.status === 200 && !r.json().errors,
  });
  if (!created) {
    sleep(randomIntBetween(1, 3) * 0.1);
    return;
  }
  const id = createRes.json().data.createMessage.id;

  // Read
  const getRes = http.post(BASE_URL, JSON.stringify({
    query: GET_MESSAGE_QUERY,
    variables: { id },
  }), { headers: jsonHeaders, tags: { name: 'GetMessageById' } });
  check(getRes, {
    'read: status is 200, no errors': (r) => r.status === 200 && !r.json().errors,
    'read: id matches': (r) => r.json().data.message.id === id,
  });

  // Update - version 0 matches the just-created message (see UpdateMessageInput.version in
  // src/schema.ts / updateMessage in src/resolvers.ts: the server rejects a stale version
  // with a CONFLICT error).
  const updateRes = http.post(BASE_URL, JSON.stringify({
    query: UPDATE_MESSAGE_MUTATION,
    variables: {
      id,
      input: { title: 'Updated by k6-message-lifecycle.js', content: 'Updated content', version: 0 },
    },
  }), { headers: jsonHeaders, tags: { name: 'UpdateMessage' } });
  check(updateRes, {
    'update: status is 200, no errors': (r) => r.status === 200 && !r.json().errors,
  });

  // Delete
  const deleteRes = http.post(BASE_URL, JSON.stringify({
    query: DELETE_MESSAGE_MUTATION,
    variables: { id },
  }), { headers: jsonHeaders, tags: { name: 'DeleteMessage' } });
  check(deleteRes, {
    'delete: status is 200, no errors': (r) => r.status === 200 && !r.json().errors,
    'delete: returned true': (r) => r.json().data.deleteMessage === true,
  });

  // Simulate think time between 100ms and 300ms using k6-utils
  sleep(randomIntBetween(1, 3) * 0.1);
}
