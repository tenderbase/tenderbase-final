const Module = require('module');
const originalLoad = Module._load;

const STATUS_VALUES = new Set(['Published', 'Closed', 'Cancelled', 'Awarded']);
const API_PREFIX = '/api/v1/';

function bad(reply, message, field) {
  return reply.code(400).send({ error: message, field });
}

function validateRequest(request, reply) {
  if (!request.url.startsWith(API_PREFIX)) return;
  const q = request.query && typeof request.query === 'object' ? request.query : {};

  for (const name of ['page', 'limit']) {
    if (q[name] !== undefined) {
      const value = String(q[name]);
      if (!/^\d+$/.test(value) || Number(value) < 1) return bad(reply, `${name} must be a positive integer`, name);
      if (name === 'limit' && Number(value) > 100) return bad(reply, 'limit must be between 1 and 100', name);
    }
  }

  for (const name of ['publishedFrom', 'publishedTo', 'closingBefore', 'since', 'until']) {
    if (q[name] !== undefined) {
      const value = String(q[name]);
      if (!value || Number.isNaN(Date.parse(value))) return bad(reply, `${name} must be a valid ISO date-time`, name);
    }
  }

  if (q.status !== undefined && !STATUS_VALUES.has(String(q.status))) {
    return bad(reply, 'status must be one of Published, Closed, Cancelled, Awarded', 'status');
  }

  if (request.url.startsWith('/api/v1/tenders/search')) {
    if (q.q === undefined || String(q.q).trim() === '') return bad(reply, 'q is required and must not be empty', 'q');
    if (String(q.q).length > 250) return bad(reply, 'q must be 250 characters or fewer', 'q');
  }
}

Module._load = function(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);
  if (request !== 'fastify' || typeof exported !== 'function' || exported.__tenderbaseHardening) return exported;

  const wrapped = function(...args) {
    const app = exported(...args);
    app.addHook('preValidation', async (request, reply) => validateRequest(request, reply));
    app.setErrorHandler((error, request, reply) => {
      if (error && error.statusCode === 404) return reply.code(404).send({ error: 'Not found' });
      request.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    });
    return app;
  };
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(exported));
  Object.assign(wrapped, exported);
  Object.defineProperty(wrapped, '__tenderbaseHardening', { value: true });
  return wrapped;
};
