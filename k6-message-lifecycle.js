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

const BASE_URL = __ENV.BASE_URL || 'http://localhost/api/messages';
const jsonHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

export default function () {
  // Create
  const createPayload = JSON.stringify({
    title: `Lifecycle message ${randomIntBetween(1, 1000000)}`,
    content: 'Created by k6-message-lifecycle.js',
    sender: `k6-vu-${__VU}`,
  });
  const createRes = http.post(BASE_URL, createPayload, {
    headers: jsonHeaders,
    tags: { name: 'CreateMessage' },
  });
  const created = check(createRes, {
    'create: status is 201': (r) => r.status === 201,
  });
  if (!created) {
    sleep(randomIntBetween(1, 3) * 0.1);
    return;
  }
  const id = createRes.json('id');

  // Read
  const getRes = http.get(`${BASE_URL}/${id}`, {
    headers: { 'Accept': 'application/json' },
    tags: { name: 'GetMessageById' },
  });
  check(getRes, {
    'read: status is 200': (r) => r.status === 200,
    'read: id matches': (r) => r.json('id') === id,
  });

  // Update - version 0 matches the just-created message (see Message.version() /
  // UpdateMessageRequest.version(): the server rejects a stale version with 409).
  const updatePayload = JSON.stringify({
    title: 'Updated by k6-message-lifecycle.js',
    content: 'Updated content',
    version: 0,
  });
  const updateRes = http.put(`${BASE_URL}/${id}`, updatePayload, {
    headers: jsonHeaders,
    tags: { name: 'UpdateMessage' },
  });
  check(updateRes, {
    'update: status is 200': (r) => r.status === 200,
  });

  // Delete
  const deleteRes = http.del(`${BASE_URL}/${id}`, null, {
    tags: { name: 'DeleteMessage' },
  });
  check(deleteRes, {
    'delete: status is 204': (r) => r.status === 204,
  });

  // Simulate think time between 100ms and 300ms using k6-utils
  sleep(randomIntBetween(1, 3) * 0.1);
}
