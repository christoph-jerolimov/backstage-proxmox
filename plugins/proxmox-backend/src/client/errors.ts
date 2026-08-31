import {
  AuthenticationError,
  ConflictError,
  InputError,
  NotAllowedError,
  NotFoundError,
} from '@backstage/errors';

/**
 * Removes secret material from a string.
 *
 * Proxmox echoes request parameters back in some error messages, and a failing
 * request is logged as well as surfaced to the caller, so every message that
 * leaves this plugin passes through here.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  return secrets
    .filter(secret => secret.length > 0)
    .reduce(
      (acc, secret) => acc.split(secret).join('[REDACTED]'),
      text,
    );
}

/** Extracts the most useful message Proxmox returned for a failed request. */
export function proxmoxErrorMessage(status: number, statusText: string, body: unknown): string {
  if (typeof body === 'string' && body.trim()) {
    return body.trim();
  }
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (errors && typeof errors === 'object') {
    const parts = Object.entries(errors as Record<string, unknown>).map(
      ([field, message]) => `${field}: ${message}`,
    );
    if (parts.length) {
      return parts.join('; ');
    }
  }
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message) {
    return message;
  }
  return statusText || `HTTP ${status}`;
}

/**
 * Maps a Proxmox API failure onto a Backstage error type, preserving the
 * status and the message Proxmox returned.
 */
export function proxmoxError(options: {
  status: number;
  statusText: string;
  body: unknown;
  operation: string;
  connectionTitle: string;
  secrets: string[];
}): Error {
  const { status, statusText, body, operation, connectionTitle } = options;
  const detail = redactSecrets(
    proxmoxErrorMessage(status, statusText, body),
    options.secrets,
  );
  const where = `${operation} on Proxmox connection "${connectionTitle}"`;

  switch (status) {
    case 400:
      return new InputError(`Proxmox rejected ${where}: ${detail}`);
    case 401:
      return new AuthenticationError(
        `Proxmox rejected the credentials for connection "${connectionTitle}" (HTTP 401): ${detail}`,
      );
    case 403:
      return new NotAllowedError(
        `The configured Proxmox credentials are not permitted to perform ${where} (HTTP 403): ${detail}`,
      );
    case 404:
      return new NotFoundError(
        `Proxmox has no resource for ${where} (HTTP 404): ${detail}`,
      );
    case 409:
      return new ConflictError(`Proxmox reported a conflict for ${where}: ${detail}`);
    default:
      return new Error(`Proxmox request failed for ${where} (HTTP ${status}): ${detail}`);
  }
}
