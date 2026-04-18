import { describe, it, expect } from 'vitest';
import { STORAGE_KEYS, SYNC_CONFIG, ATTACHMENT_LIMITS, DISPLAY_LIMITS, TIMING, EVENTS, CONFIG_IDS } from '../../constants';

describe('Constants', () => {
  describe('STORAGE_KEYS', () => {
    it('should have correct storage key format', () => {
      expect(STORAGE_KEYS.SETTINGS).toMatch(/^oneagent\./);
      expect(STORAGE_KEYS.MODEL_CONFIG_CACHE).toMatch(/^oneagent\./);
      expect(STORAGE_KEYS.MODEL_MODELS_CACHE).toMatch(/^oneagent\./);
      expect(STORAGE_KEYS.MODEL_SELECTION_CACHE).toMatch(/^oneagent\./);
      expect(STORAGE_KEYS.MODE_CACHE).toMatch(/^oneagent\./);
      expect(STORAGE_KEYS.MODE_SELECTION_CACHE).toMatch(/^oneagent\./);
    });

    it('should have unique keys', () => {
      const values = Object.values(STORAGE_KEYS);
      const uniqueValues = new Set(values);
      expect(uniqueValues.size).toBe(values.length);
    });
  });

  describe('SYNC_CONFIG', () => {
    it('should have reasonable poll interval', () => {
      expect(SYNC_CONFIG.POLL_INTERVAL_MS).toBeGreaterThan(0);
      expect(SYNC_CONFIG.POLL_INTERVAL_MS).toBeLessThan(5000);
    });

    it('should have reasonable max attempts', () => {
      expect(SYNC_CONFIG.MAX_POLL_ATTEMPTS).toBeGreaterThan(100);
    });

    it('should have reasonable grace polls', () => {
      expect(SYNC_CONFIG.GRACE_POLLS).toBeGreaterThan(0);
      expect(SYNC_CONFIG.GRACE_POLLS).toBeLessThan(20);
    });
  });

  describe('ATTACHMENT_LIMITS', () => {
    it('should have correct text limit', () => {
      expect(ATTACHMENT_LIMITS.MAX_EMBEDDED_TEXT_BYTES).toBe(128 * 1024);
    });

    it('should have correct media limit', () => {
      expect(ATTACHMENT_LIMITS.MAX_EMBEDDED_MEDIA_BYTES).toBe(10 * 1024 * 1024);
    });

    it('should have media limit larger than text limit', () => {
      expect(ATTACHMENT_LIMITS.MAX_EMBEDDED_MEDIA_BYTES).toBeGreaterThan(
        ATTACHMENT_LIMITS.MAX_EMBEDDED_TEXT_BYTES
      );
    });
  });

  describe('DISPLAY_LIMITS', () => {
    it('should have positive preview limits', () => {
      expect(DISPLAY_LIMITS.MAX_CONTENT_PREVIEW).toBeGreaterThan(0);
      expect(DISPLAY_LIMITS.MAX_JSON_PREVIEW).toBeGreaterThan(0);
      expect(DISPLAY_LIMITS.MAX_PARAM_PREVIEW).toBeGreaterThan(0);
    });

    it('should have positive max height values', () => {
      expect(DISPLAY_LIMITS.COLLAPSIBLE_DEFAULT_MAX_HEIGHT).toBeGreaterThan(0);
      expect(DISPLAY_LIMITS.TERMINAL_DISPLAY_MAX_HEIGHT).toBeGreaterThan(0);
    });

    it('should have JSON preview larger than param preview', () => {
      expect(DISPLAY_LIMITS.MAX_JSON_PREVIEW).toBeGreaterThan(
        DISPLAY_LIMITS.MAX_PARAM_PREVIEW
      );
    });
  });

  describe('TIMING', () => {
    it('should have reasonable thought update interval', () => {
      expect(TIMING.THOUGHT_UPDATE_INTERVAL_MS).toBeGreaterThan(0);
      expect(TIMING.THOUGHT_UPDATE_INTERVAL_MS).toBeLessThan(1000);
    });

    it('should have reasonable scroll threshold', () => {
      expect(TIMING.SCROLL_BOTTOM_THRESHOLD_PX).toBeGreaterThan(0);
      expect(TIMING.SCROLL_BOTTOM_THRESHOLD_PX).toBeLessThan(200);
    });

    it('should have positive reset delays', () => {
      expect(TIMING.SMOOTH_SCROLL_RESET_DELAY_MS).toBeGreaterThan(0);
      expect(TIMING.AUTO_SCROLL_RESET_DELAY_MS).toBeGreaterThan(0);
    });

    it('should have reasonable copy feedback duration', () => {
      expect(TIMING.COPY_FEEDBACK_DURATION_MS).toBeGreaterThan(500);
      expect(TIMING.COPY_FEEDBACK_DURATION_MS).toBeLessThan(5000);
    });
  });

  describe('EVENTS', () => {
    it('should have correct event name format', () => {
      const eventValues = Object.values(EVENTS);
      eventValues.forEach((event) => {
        expect(event).toMatch(/^[a-z_]+:[a-z_]+$/);
      });
    });

    it('should have unique event names', () => {
      const values = Object.values(EVENTS);
      const uniqueValues = new Set(values);
      expect(uniqueValues.size).toBe(values.length);
    });

    it('should include conversation events', () => {
      expect(EVENTS.CONVERSATION_STATE_CHANGED).toContain('conversation');
      expect(EVENTS.CONVERSATION_MESSAGE_APPENDED).toContain('conversation');
      expect(EVENTS.CONVERSATION_TURN_FINISHED).toContain('conversation');
    });
  });

  describe('CONFIG_IDS', () => {
    it('should have mode override constant', () => {
      expect(CONFIG_IDS.MODE_OVERRIDE).toBe('__mode_override__');
    });
  });
});
