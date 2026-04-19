// Storage Keys
export const STORAGE_KEYS = {
  SETTINGS: 'oneagent.settings.v1',
  MODEL_CONFIG_CACHE: 'oneagent.model-config-cache.v1',
  MODEL_MODELS_CACHE: 'oneagent.model-metadata-cache.v1',
  MODEL_SELECTION_CACHE: 'oneagent.model-selection-cache.v1',
  MODE_CACHE: 'oneagent.mode-metadata-cache.v1',
  MODE_SELECTION_CACHE: 'oneagent.mode-selection-cache.v1',
} as const;

// Polling / Sync Configuration
export const SYNC_CONFIG = {
  POLL_INTERVAL_MS: 500,
  MAX_POLL_ATTEMPTS: 1200,
  GRACE_POLLS: 4,
} as const;

// Attachment Limits
export const ATTACHMENT_LIMITS = {
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  MAX_EMBEDDED_TEXT_BYTES: 128 * 1024,
  MAX_EMBEDDED_MEDIA_BYTES: 10 * 1024 * 1024,
} as const;

// UI Display Limits
export const DISPLAY_LIMITS = {
  MAX_CONTENT_PREVIEW: 200,
  MAX_JSON_PREVIEW: 300,
  MAX_PARAM_PREVIEW: 100,
  COLLAPSIBLE_DEFAULT_MAX_HEIGHT: 240,
  TERMINAL_DISPLAY_MAX_HEIGHT: 300,
} as const;

// Timing Constants
export const TIMING = {
  THOUGHT_UPDATE_INTERVAL_MS: 100,
  SCROLL_BOTTOM_THRESHOLD_PX: 50,
  SMOOTH_SCROLL_RESET_DELAY_MS: 300,
  AUTO_SCROLL_RESET_DELAY_MS: 80,
  COPY_FEEDBACK_DURATION_MS: 1500,
  HEIGHT_CHECK_DEBOUNCE_MS: 100,
} as const;

// Tauri Event Names
export const EVENTS = {
  AGENT_PROFILE_PROBED: 'agent:profile_probed',
  CONVERSATION_CONFIG_UPDATED: 'conversation:config_updated',
  CONVERSATION_STATE_CHANGED: 'conversation:state_changed',
  CONVERSATION_MESSAGE_APPENDED: 'conversation:message_appended',
  CONVERSATION_MESSAGE_UPDATED: 'conversation:message_updated',
  CONVERSATION_TURN_FINISHED: 'conversation:turn_finished',
  CONVERSATION_PERMISSION_REQUESTED: 'conversation:permission_requested',
  CONVERSATION_PERMISSION_RESOLVED: 'conversation:permission_resolved',
  CONVERSATION_TOOL_CALL_CHANGED: 'conversation:tool_call_changed',
  CONVERSATION_TERMINAL_OUTPUT: 'conversation:terminal_output',
  TASK_RUN_STATE_CHANGED: 'task_run:state_changed',
  CONVERSATION_DELETED: 'conversation:deleted',
} as const;

// Config IDs
export const CONFIG_IDS = {
  MODE_OVERRIDE: '__mode_override__',
} as const;
