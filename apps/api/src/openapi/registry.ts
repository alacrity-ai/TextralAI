// Shared OpenAPI response definitions. Every route reuses these so
// envelope-shaped errors never drift across endpoints.

import { ErrorEnvelopeSchema } from './components.js';

const errorContent = {
  'application/json': { schema: ErrorEnvelopeSchema },
} as const;

export const Responses = {
  unauthorized: {
    description: 'Missing or invalid X-Textral-Api-Key.',
    content: errorContent,
  },
  forbiddenAdmin: {
    description: 'Missing or invalid X-Admin-Bootstrap-Token.',
    content: errorContent,
  },
  notFound: {
    description: 'Resource not found (or not visible to the caller).',
    content: errorContent,
  },
  badRequest: {
    description: 'Request body or path parameter failed validation.',
    content: errorContent,
  },
  conflict: {
    description: 'Resource conflict (e.g., duplicate slug or label).',
    content: errorContent,
  },
  validationFailed: {
    description: 'Provider-key validation failed (returns ok:false).',
    content: errorContent,
  },
  noContent: {
    description: 'No content.',
  },
  forbidden: {
    description: 'Caller is authenticated but lacks the required scope.',
    content: errorContent,
  },
  rateLimited: {
    description: 'Rate limit exceeded.',
    content: errorContent,
  },
  accepted: {
    description: 'Accepted for asynchronous processing.',
  },
  gone: {
    description:
      'Resource existed but the requested artifact is no longer available (e.g., mirrored answer reaped or never written).',
    content: errorContent,
  },
  serviceUnavailable: {
    description:
      'Operator-side configuration prevents the request from being served (e.g. Mailgun unconfigured in prod).',
    content: errorContent,
  },
} as const;
