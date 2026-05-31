import { describe, expect, it } from 'vitest';

import {
  extractSlashInfo,
  isCommandContent,
  isCommandOutputContent,
  parseTaskNotifications,
  sanitizeDisplayContent,
} from '../../../src/shared/utils/contentSanitizer';

describe('contentSanitizer', () => {
  describe('isCommandContent', () => {
    it('detects built-in command payloads', () => {
      expect(isCommandContent('<command-name>/model</command-name>')).toBe(true);
    });

    it('detects skill command payloads that start with command-message', () => {
      expect(
        isCommandContent(
          '<command-message>improve-codebase-architecture</command-message><command-name>/improve-codebase-architecture</command-name>'
        )
      ).toBe(true);
    });

    it('returns false for plain content', () => {
      expect(isCommandContent('normal user content')).toBe(false);
    });
  });

  describe('isCommandOutputContent', () => {
    it('detects stdout payloads', () => {
      expect(isCommandOutputContent('<local-command-stdout>done</local-command-stdout>')).toBe(
        true
      );
    });

    it('detects stderr payloads', () => {
      expect(isCommandOutputContent('<local-command-stderr>failed</local-command-stderr>')).toBe(
        true
      );
    });

    it('returns false for non-command output', () => {
      expect(isCommandOutputContent('<command-name>/model</command-name>')).toBe(false);
    });
  });

  describe('sanitizeDisplayContent', () => {
    it('extracts command stdout content', () => {
      expect(
        sanitizeDisplayContent('<local-command-stdout>\nhello world\n</local-command-stdout>')
      ).toBe('hello world');
    });

    it('extracts command stderr content when stdout is absent', () => {
      expect(
        sanitizeDisplayContent('<local-command-stderr>\npermission denied\n</local-command-stderr>')
      ).toBe('permission denied');
    });

    it('renders slash commands from command payloads regardless of tag order', () => {
      const content =
        '<command-message>model</command-message><command-name>/model</command-name><command-args>sonnet</command-args>';

      expect(sanitizeDisplayContent(content)).toBe('/model sonnet');
    });

    it('removes noise tags, command tags, and trailing task output instructions from mixed content', () => {
      const content = [
        'Visible line',
        '<system-reminder>ignore me</system-reminder>',
        '<command-name>/compact</command-name>',
        '<command-message>compact</command-message>',
        '<command-args>now</command-args>',
        '<task-notification><task-id>t1</task-id></task-notification>',
        'Read the output file to retrieve the result: /tmp/task-output.txt',
      ].join('\n');

      expect(sanitizeDisplayContent(content)).toBe('Visible line');
    });
  });

  describe('extractSlashInfo', () => {
    it('extracts slash name, message, and args', () => {
      expect(
        extractSlashInfo(
          '<command-name>/model</command-name><command-message>model</command-message><command-args>sonnet</command-args>'
        )
      ).toEqual({
        name: 'model',
        message: 'model',
        args: 'sonnet',
      });
    });

    it('returns null for non-command content', () => {
      expect(extractSlashInfo('plain text')).toBeNull();
    });
  });

  describe('parseTaskNotifications', () => {
    it('parses multiple task notification blocks', () => {
      const content = [
        '<task-notification>',
        '<task-id>task-1</task-id>',
        '<status>completed</status>',
        '<summary>Generated report</summary>',
        '<output-file>/tmp/task-1.txt</output-file>',
        '</task-notification>',
        '<task-notification>',
        '<task-id>task-2</task-id>',
        '<status>failed</status>',
        '<summary>',
        '  Second task summary  ',
        '</summary>',
        '<output-file>/tmp/task-2.txt</output-file>',
        '</task-notification>',
      ].join('\n');

      expect(parseTaskNotifications(content)).toEqual([
        {
          taskId: 'task-1',
          status: 'completed',
          summary: 'Generated report',
          outputFile: '/tmp/task-1.txt',
        },
        {
          taskId: 'task-2',
          status: 'failed',
          summary: 'Second task summary',
          outputFile: '/tmp/task-2.txt',
        },
      ]);
    });

    it('returns an empty array when there are no task notifications', () => {
      expect(parseTaskNotifications('normal content')).toEqual([]);
    });
  });
});
