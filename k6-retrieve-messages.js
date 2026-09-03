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

export default function () {
  const params = {
    headers: {
      'Accept': 'application/json',
    },
    tags: { name: 'GetAllMessages' },
  };

  const res = http.get(BASE_URL, params);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response received': (r) => r.body && r.body.length > 0,
    'is valid JSON array': (r) => {
      try {
        const data = r.json();
        return Array.isArray(data) && data.length > 0;
      } catch (e) {
        return false;
      }
    },
    'has X-Total-Count header': (r) => !!r.headers['X-Total-Count'],
  });

  // Paginate with limit/offset (see MessageController#getAllMessages): limit is capped at 200
  // server-side, so a small page should come back exactly that size (never more).
  const pageRes = http.get(`${BASE_URL}?limit=5&offset=0`, {
    headers: { 'Accept': 'application/json' },
    tags: { name: 'GetMessagesPage' },
  });
  check(pageRes, {
    'page: status is 200': (r) => r.status === 200,
    'page: at most 5 items': (r) => {
      try {
        return r.json().length <= 5;
      } catch (e) {
        return false;
      }
    },
  });

  // Simulate think time between 100ms and 300ms using k6-utils
  sleep(randomIntBetween(1, 3) * 0.1);
}
