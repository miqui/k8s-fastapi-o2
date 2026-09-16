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

const MESSAGES_QUERY = `
  query ($limit: Int, $offset: Int) {
    messages(limit: $limit, offset: $offset) {
      totalCount
      items { id title content version author { id name } }
    }
  }
`;

export default function () {
  const res = http.post(BASE_URL, JSON.stringify({
    query: MESSAGES_QUERY,
    variables: { limit: 50, offset: 0 },
  }), { headers: jsonHeaders, tags: { name: 'GetAllMessages' } });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'no errors': (r) => {
      try {
        return !r.json().errors;
      } catch (e) {
        return false;
      }
    },
    'has at least one item': (r) => {
      try {
        return r.json().data.messages.items.length > 0;
      } catch (e) {
        return false;
      }
    },
    'has totalCount': (r) => {
      try {
        return typeof r.json().data.messages.totalCount === 'number';
      } catch (e) {
        return false;
      }
    },
  });

  // Paginate with limit/offset (see the `messages` resolver in src/resolvers.ts): limit is
  // capped at 200 server-side, so a small page should come back exactly that size (never more).
  const pageRes = http.post(BASE_URL, JSON.stringify({
    query: MESSAGES_QUERY,
    variables: { limit: 5, offset: 0 },
  }), { headers: jsonHeaders, tags: { name: 'GetMessagesPage' } });
  check(pageRes, {
    'page: status is 200': (r) => r.status === 200,
    'page: at most 5 items': (r) => {
      try {
        return r.json().data.messages.items.length <= 5;
      } catch (e) {
        return false;
      }
    },
  });

  // Simulate think time between 100ms and 300ms using k6-utils
  sleep(randomIntBetween(1, 3) * 0.1);
}
