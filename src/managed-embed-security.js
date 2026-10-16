/**
 * Helmet protects all panel pages against framing by default.
 * Only the session-protected /bot-services/:id/live and /stats fragments are
 * intentionally embedded inside the same-origin management page. Override the
 * response headers on those fragments only; never relax the global policy.
 */
export function allowSameOriginManagedFrame(res) {
  const csp = String(res.getHeader('Content-Security-Policy') || '');
  const directives = csp.split(';').map((part) => part.trim()).filter(Boolean)
    .filter((part) => !/^frame-ancestors(?:\s|$)/i.test(part));
  directives.push("frame-ancestors 'self'");
  res.setHeader('Content-Security-Policy', directives.join('; '));
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}
