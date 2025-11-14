/**
 * Baserow webhook authentication
 */

import type { Env } from "./types";

/**
 * Verify Baserow webhook signature
 * Baserow uses HMAC-SHA256 for webhook signatures
 */
export async function verifyWebhookSignature(
  request: Request,
  env: Env
): Promise<boolean> {
  if (!env.WEBHOOK_SECRET) {
    console.warn("WEBHOOK_SECRET not configured, skipping signature verification");
    return true; // Allow if secret not configured (for development)
  }

  const signature = request.headers.get("X-Baserow-Signature");
  if (!signature) {
    console.warn("Missing X-Baserow-Signature header");
    return false;
  }

  // Get request body
  const body = await request.clone().text();

  // Compute HMAC-SHA256
  const encoder = new TextEncoder();
  const keyData = encoder.encode(env.WEBHOOK_SECRET);
  const messageData = encoder.encode(body);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  const computedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Compare signatures (constant-time comparison)
  if (signature.length !== computedSignature.length) {
    return false;
  }

  let match = true;
  for (let i = 0; i < signature.length; i++) {
    if (signature[i] !== computedSignature[i]) {
      match = false;
    }
  }

  return match;
}

/**
 * Verify webhook request and return parsed body
 */
export async function verifyAndParseWebhook<T>(
  request: Request,
  env: Env
): Promise<{ verified: boolean; body: T }> {
  const verified = await verifyWebhookSignature(request, env);
  const body = await request.json() as T;
  return { verified, body };
}

