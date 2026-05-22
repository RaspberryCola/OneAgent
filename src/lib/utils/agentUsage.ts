import { STORAGE_KEYS } from '../constants';
import type * as Types from '../backend/types';

export function recordAgentUsage(agentId: string): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.AGENT_USAGE);
    const usage = raw ? JSON.parse(raw) : {};
    usage[agentId] = Date.now();
    window.localStorage.setItem(STORAGE_KEYS.AGENT_USAGE, JSON.stringify(usage));
  } catch (error) {
    console.error('Failed to record agent usage', error);
  }
}

export function getSortedAgentProfiles(profiles: Types.AgentProfile[]): Types.AgentProfile[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.AGENT_USAGE);
    const usage: Record<string, number> = raw ? JSON.parse(raw) : {};
    
    return [...profiles].sort((a, b) => {
      const timeA = usage[a.id] ?? 0;
      const timeB = usage[b.id] ?? 0;
      
      if (timeA !== timeB) {
        return timeB - timeA; // Descending order (most recent first)
      }
      
      // Fallback: sort alphabetically by name
      return a.name.localeCompare(b.name);
    });
  } catch (error) {
    console.error('Failed to sort agent profiles by usage', error);
    // Fallback: sort alphabetically by name
    return [...profiles].sort((a, b) => a.name.localeCompare(b.name));
  }
}
