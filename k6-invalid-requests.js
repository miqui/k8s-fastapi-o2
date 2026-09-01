import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 10,
  duration: __ENV.DURATION || '10s',
  thresholds: {
    // Every request here intentionally triggers a 4xx response, so http_req_failed
    // (which k6 marks true for any non-2xx/3xx) is expected to be ~100% - it isn't
    // a useful signal for this scenario. `checks` passing is: did the API return
    // the *correct* error response (status + RFC 9457 body) every time.
    checks: ['rate>0.99'],
    http_req_duration: ['p(95)<500'],  // 95% of requests below 500ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost/api/messages';
const jsonHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

export default function () {
  // Invalid create: blank title/content/sender should return 400 with RFC 9457 problem details
  const invalidPayload = JSON.stringify({ title: '', content: ' ', sender: '' });
  const invalidRes = http.post(BASE_URL, invalidPayload, {
    headers: jsonHeaders,
    tags: { name: 'CreateInvalidMessage' },
  });
  check(invalidRes, {
    'invalid create: status is 400': (r) => r.status === 400,
    'invalid create: is problem+json': (r) => (r.headers['Content-Type'] || '').includes('application/problem+json'),
    'invalid create: has invalidParams': (r) => {
      try {
        const body = r.json();
        return Array.isArray(body.invalidParams) && body.invalidParams.length > 0;
      } catch (e) {
        return false;
      }
    },
  });

  // Non-existent id: should return 404 with RFC 9457 problem details
  const missingId = `non-existent-${randomIntBetween(1, 1000000)}`;
  const notFoundRes = http.get(`${BASE_URL}/${missingId}`, {
    headers: { 'Accept': 'application/json' },
    tags: { name: 'GetMissingMessage' },
  });
  check(notFoundRes, {
    'not found: status is 404': (r) => r.status === 404,
    'not found: is problem+json': (r) => (r.headers['Content-Type'] || '').includes('application/problem+json'),
  });

  // Blank id path variable ("   "): should return 400 via bean validation
  const blankIdRes = http.get(`${BASE_URL}/%20%20%20`, {
    headers: { 'Accept': 'application/json' },
    tags: { name: 'GetBlankIdMessage' },
  });
  check(blankIdRes, {
    'blank id: status is 400': (r) => r.status === 400,
  });

  // Simulate think time between 100ms and 300ms using k6-utils
  sleep(randomIntBetween(1, 3) * 0.1);
}
