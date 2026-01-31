/**
 * Group ID Converter for Signal CLI
 *
 * Signal CLI WebSocket events contain INTERNAL group IDs, but the
 * /v2/send API requires EXTERNAL group IDs. This utility handles
 * the conversion by fetching group metadata from the Signal CLI API.
 */

import axios from 'axios';
import { getSignalCliConfig } from '../config-loader.js';

// Cache for group ID conversions (internal -> external)
const groupIdCache = new Map<string, string>();

/**
 * Convert internal group ID to external group ID
 *
 * @param internalId - The internal group ID from WebSocket events
 * @param botPhone - The bot's phone number to query groups for
 * @returns The external group ID, or null if not found
 */
export async function convertGroupId(
  internalId: string,
  botPhone: string
): Promise<string | null> {
  // Check cache first
  const cached = groupIdCache.get(internalId);
  if (cached) {
    return cached;
  }

  const { apiUrl } = getSignalCliConfig();

  try {
    // Fetch all groups for this bot
    const response = await axios.get(`${apiUrl}/v1/groups/${encodeURIComponent(botPhone)}`);
    const groups = response.data;

    if (!Array.isArray(groups)) {
      console.warn('[GroupIdConverter] Unexpected response format from groups API');
      return null;
    }

    // Find the group with matching internal_id
    for (const group of groups) {
      if (group.internal_id === internalId) {
        // Cache and return the external id
        groupIdCache.set(internalId, group.id);
        console.log(`[GroupIdConverter] Converted: ${internalId.substring(0, 20)}... -> ${group.id.substring(0, 20)}...`);
        return group.id;
      }
    }

    // If we get here, the group wasn't found - it might be a new group
    // Try using the internal ID directly (sometimes they match)
    console.warn(`[GroupIdConverter] No external ID found for ${internalId.substring(0, 30)}..., using internal ID`);
    return internalId;
  } catch (error: any) {
    console.error(`[GroupIdConverter] Error fetching groups:`, error.message);
    // Fallback to internal ID
    return internalId;
  }
}

/**
 * Pre-cache group ID conversion
 * Call this during startup to warm the cache
 */
export async function preloadGroupIds(botPhone: string): Promise<number> {
  const { apiUrl } = getSignalCliConfig();

  try {
    const response = await axios.get(`${apiUrl}/v1/groups/${encodeURIComponent(botPhone)}`);
    const groups = response.data;

    if (!Array.isArray(groups)) {
      return 0;
    }

    let cached = 0;
    for (const group of groups) {
      if (group.internal_id && group.id) {
        groupIdCache.set(group.internal_id, group.id);
        cached++;
      }
    }

    return cached;
  } catch (error: any) {
    console.error(`[GroupIdConverter] Error preloading groups:`, error.message);
    return 0;
  }
}

/**
 * Clear the group ID cache
 */
export function clearGroupIdCache(): void {
  groupIdCache.clear();
}
