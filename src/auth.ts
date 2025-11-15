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
    // Baserow might send the secret directly in the header (simple auth)
    // OR compute an HMAC signature
    // Check if it's just the secret first (simple string comparison)
    const trimmedSignature = signature.trim();
    if (trimmedSignature === env.WEBHOOK_SECRET) {
      console.log("Signature matches secret directly (simple auth)");
      return true;
    }
    
    // If not a direct match, try HMAC signature verification
    // Baserow might send signature in format: "t=timestamp,v1=signature" or just "signature"
    // Extract the actual signature value
    let actualSignature = trimmedSignature;
    
    // Check if it's in the format "t=timestamp,v1=signature"
    if (actualSignature.includes("v1=")) {
      const v1Match = actualSignature.match(/v1=([^,]+)/);
      if (v1Match && v1Match[1]) {
        actualSignature = v1Match[1].trim();
        console.log("Extracted signature from v1= format");
      }
    }
    
    // Use the extracted signature for verification
    signature = actualSignature;
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
    
    // Convert ArrayBuffer to Uint8Array
    const signatureArray = new Uint8Array(signatureBuffer);
    
    // Try hex format first
    const computedSignatureHex = Array.from(signatureArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Try base64 format
    const computedSignatureBase64 = btoa(String.fromCharCode(...signatureArray));

    // Normalize received signature - handle common formats
    // Baserow might send: "sha256=...", "sha256:...", or just the hex/base64
    let normalizedSignature = signature.trim();
    
    // Remove common prefixes
    if (normalizedSignature.startsWith("sha256=")) {
      normalizedSignature = normalizedSignature.substring(7);
    } else if (normalizedSignature.startsWith("sha256:")) {
      normalizedSignature = normalizedSignature.substring(7);
    }
    
    // Remove any dashes (UUID format) and convert to lowercase
    normalizedSignature = normalizedSignature.replace(/-/g, "").toLowerCase();
    const normalizedHex = computedSignatureHex.toLowerCase();
    
    // Log for debugging
    console.log("Signature verification", {
      receivedLength: signature.length,
      receivedPrefix: signature.substring(0, 20),
      normalizedLength: normalizedSignature.length,
      normalizedPrefix: normalizedSignature.substring(0, 20),
      computedHexLength: computedSignatureHex.length,
      computedHexPrefix: computedSignatureHex.substring(0, 20),
      computedBase64Length: computedSignatureBase64.length,
      computedBase64Prefix: computedSignatureBase64.substring(0, 20),
    });
    
    // Constant-time comparison for hex (full 64 chars)
    if (normalizedSignature.length === normalizedHex.length) {
      let match = true;
      for (let i = 0; i < normalizedSignature.length; i++) {
        if (normalizedSignature[i] !== normalizedHex[i]) {
          match = false;
        }
      }
      if (match) {
        console.log("Signature verified (hex, full length)");
        return true;
      }
    }

    // Try truncated hex (first 32 chars = 16 bytes) - some systems truncate
    if (normalizedSignature.length === 32 && normalizedHex.length >= 32) {
      const truncatedHex = normalizedHex.substring(0, 32);
      let match = true;
      for (let i = 0; i < 32; i++) {
        if (normalizedSignature[i] !== truncatedHex[i]) {
          match = false;
        }
      }
      if (match) {
        console.log("Signature verified (hex, truncated 32 chars)");
        return true;
      }
    }

    // Try base64 comparison (exact match)
    if (signature === computedSignatureBase64) {
      console.log("Signature verified (base64)");
      return true;
    }
    
    // Try base64 comparison (normalized)
    const normalizedBase64 = computedSignatureBase64.toLowerCase();
    if (normalizedSignature === normalizedBase64) {
      console.log("Signature verified (base64, normalized)");
      return true;
    }

    // Log for debugging
    console.warn("Signature mismatch", {
      received: signature.substring(0, 40) + "...",
      normalized: normalizedSignature.substring(0, 40) + "...",
      computedHex: computedSignatureHex.substring(0, 40) + "...",
      computedBase64: computedSignatureBase64.substring(0, 40) + "...",
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

