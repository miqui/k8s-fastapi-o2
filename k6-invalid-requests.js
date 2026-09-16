import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 10,
  duration: __ENV.DURATION || '10s',
  thresholds: {
    // Every request here intentionally triggers a GraphQL-level error, and GraphQL always
    // answers HTTP 200 with an errors[] array (see src/errors.ts) - http_req_failed isn't a
    // useful signal for this scenario. `checks` passing is: did the API return the *correct*
    // error shape (extensions.code / invalidParams) every time.
    checks: ['rate>0.99'],
    http_req_duration: ['p(95)<500'],  // 95% of requests below 500ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost/graphql';
const jsonHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

const CREATE_MESSAGE_MUTATION = `
  mutation ($input: CreateMessageInput!) { createMessage(input: $input) { id } }
`;
const GET_MESSAGE_QUERY = `query ($id: ID!) { message(id: $id) { id } }`;

export default function () {
  // Invalid create: blank title/content/authorId should return a BAD_USER_INPUT error with
  // per-field invalidParams (see src/validation.ts).
  const invalidRes = http.post(BASE_URL, JSON.stringify({
    query: CREATE_MESSAGE_MUTATION,
    variables: { input: { title: '', content: ' ', authorId: '' } },
  }), { headers: jsonHeaders, tags: { name: 'CreateInvalidMessage' } });
  check(invalidRes, {
    'invalid create: status is 200': (r) => r.status === 200,
    'invalid create: BAD_USER_INPUT': (r) => {
      try {
        return r.json().errors[0].extensions.code === 'BAD_USER_INPUT';
      } catch (e) {
        return false;
      }
    },
    'invalid create: has invalidParams': (r) => {
      try {
        const params = r.json().errors[0].extensions.invalidParams;
        return Array.isArray(params) && params.length > 0;
      } catch (e) {
        return false;
      }
    },
  });

  // Non-existent id: should return a NOT_FOUND error
  const missingId = `non-existent-${randomIntBetween(1, 1000000)}`;
  const notFoundRes = http.post(BASE_URL, JSON.stringify({
    query: GET_MESSAGE_QUERY,
    variables: { id: missingId },
  }), { headers: jsonHeaders, tags: { name: 'GetMissingMessage' } });
  check(notFoundRes, {
    'not found: status is 200': (r) => r.status === 200,
    'not found: NOT_FOUND': (r) => {
      try {
        return r.json().errors[0].extensions.code === 'NOT_FOUND';
      } catch (e) {
        return false;
      }
    },
  });

  // Missing required variable: `id` is a non-null `ID!` GraphQL argument, so omitting it
  // entirely fails at query-validation time, before any resolver runs. Per the GraphQL-over-
  // HTTP spec, a request error like this one answers 400 - unlike NOT_FOUND/BAD_USER_INPUT
  // above, which are execution-time errors thrown from inside a resolver and so still answer
  // 200 (see src/errors.ts).
  const missingVarRes = http.post(BASE_URL, JSON.stringify({
    query: GET_MESSAGE_QUERY,
    variables: {},
  }), {
    headers: jsonHeaders,
    tags: { name: 'GetMessageMissingVariable' },
    responseCallback: http.expectedStatuses(400),
  });
  check(missingVarRes, {
    'missing variable: status is 400': (r) => r.status === 400,
    'missing variable: has errors, no data': (r) => {
      try {
        const body = r.json();
        return Array.isArray(body.errors) && body.errors.length > 0 && !body.data;
      } catch (e) {
        return false;
      }
    },
  });

  // Simulate think time between 100ms and 300ms using k6-utils
  sleep(randomIntBetween(1, 3) * 0.1);
}
