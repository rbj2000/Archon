import { describe, expect, test } from 'bun:test';
import { agentInstallCredentials } from './process-provider';

describe('agentInstallCredentials', () => {
  const host = { CLAUDE_CODE_OAUTH_TOKEN: 'token', DATABASE_URL: 'db', OTHER: 'x' };

  test('Claude receives its own credential and nothing else', () => {
    expect(agentInstallCredentials('claude', host)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'token' });
  });
  test('another provider does not receive the Claude credential', () => {
    expect(agentInstallCredentials('pi', host)).toEqual({});
  });
  test('an empty value is not delivered', () => {
    expect(agentInstallCredentials('claude', { CLAUDE_API_KEY: '' })).toEqual({});
  });
});
