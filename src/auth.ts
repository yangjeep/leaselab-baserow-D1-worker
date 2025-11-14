/**
 * Baserow webhook authentication
 */

import type { Env } from "./types";

/**
 * Verify Baserow webhook signature
 * Baserow uses HMAC-SHA256 for webhook signatures
 * Supports both hex and base64 encoded signatures
 */
export async function verifyWebhookSignature(
  bodyText: string,
  signature: string | null,
  env: Env
): Promise<boolean> {
  if (!env.WEBHOOK_SECRET) {
    console.warn("WEBHOOK_SECRET not configured, skipping signature verification");
    return true; // Allow if secret not configured (for development)
  }

  if (!signature) {
    console.warn("Missing X-Baserow-Signature header");
    return false;
  }

  try {
    // Compute HMAC-SHA256
    const encoder = new TextEncoder();
    const keyData = encoder.encode(env.WEBHOOK_SECRET);
    const messageData = encoder.encode(bodyText);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
    
    // Try hex format first
    const computedSignatureHex = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Try base64 format
    // Convert Uint8Array to base64
    const bytes = new Uint8Array(signatureBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const computedSignatureBase64 = btoa(binary);

    // Compare signatures - try both hex and base64
    // Remove any dashes from signature (UUID format)
    const normalizedSignature = signature.replace(/-/g, "").toLowerCase();
    const normalizedHex = computedSignatureHex.toLowerCase();
    
    // Constant-time comparison for hex (full 64 chars)
    if (normalizedSignature.length === normalizedHex.length) {
      let match = true;
      for (let i = 0; i < normalizedSignature.length; i++) {
        if (normalizedSignature[i] !== normalizedHex[i]) {
          match = false;
        }
      }
      if (match) return true;
    }

    // Try truncated hex (first 32 chars = 16 bytes) - Baserow might truncate
    if (normalizedSignature.length === 32 && normalizedHex.length >= 32) {
      const truncatedHex = normalizedHex.substring(0, 32);
      let match = true;
      for (let i = 0; i < 32; i++) {
        if (normalizedSignature[i] !== truncatedHex[i]) {
          match = false;
        }
      }
      if (match) return true;
    }

    // Try base64 comparison
    if (signature === computedSignatureBase64) {
      return true;
    }

    // Log for debugging (remove dashes for comparison)
    console.warn("Signature mismatch", {
      received: signature.substring(0, 20) + "...",
      computedHex: computedSignatureHex.substring(0, 20) + "...",
      computedBase64: computedSignatureBase64.substring(0, 20) + "...",
    });

    return false;
  } catch (error) {
    console.error("Error verifying webhook signature:", error);
    return false;
  }
}

/**
 * Verify webhook request and return parsed body
 */
export async function verifyAndParseWebhook<T>(
  request: Request,
  env: Env
): Promise<{ verified: boolean; body: T }> {
  console.log("verifyAndParseWebhook: starting");
  try {
    // Read body once as text for signature verification
    console.log("verifyAndParseWebhook: reading body");
    const bodyText = await request.text();
    console.log("verifyAndParseWebhook: body read", { length: bodyText.length });
    
    // Get signature from headers
    const signature = request.headers.get("X-Baserow-Signature");
    
    // Verify signature using the body text
    const verified = await verifyWebhookSignature(bodyText, signature, env);
    
    // Parse body as JSON
    let body: T;
    try {
      body = JSON.parse(bodyText) as T;
    } catch (parseError) {
      throw new Error(`Invalid JSON in webhook body: ${parseError instanceof Error ? parseError.message : "Unknown error"}`);
    }
    
    return { verified, body };
  } catch (error) {
    console.error("Error parsing webhook:", error);
    // If JSON parsing fails, return error
    throw new Error(`Failed to parse webhook body: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

